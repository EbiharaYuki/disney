/* 毎日の答え合わせ。
 * - 記録しておいた予想（data/loop/forecast_log.csv）と実績を比べて、何日前の予想がどれだけ当たったかを測る
 * - Queue-Times 自身の予想（data/history/qt_forecast_log.csv）とも比べる
 * - 最近の大ハズレの日を、その日の状況（天気・要因・価格など）と一緒に洗い出す
 * 出力:
 *   data/loop/report.md   毎朝の点検（Claude）が読むレポート
 *   site/data/loop.json   ページ用
 */
"use strict";
const fs = require("fs");
const path = require("path");
require("../site/model.js");
const M = globalThis.CrowdModel;

const ROOT = path.resolve(__dirname, "..");
const BIG_MISS = 20;     // これ以上外れたら大ハズレ
const RECENT_DAYS = 14;  // 大ハズレを探す期間
const WINDOW = 30;       // 精度を測る期間
const LEADS = [1, 7, 30];
const PARK_JA = { tdl: "ランド", tds: "シー" };

const readJSON = (p, fb) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : fb);
const readCSV = (p) => {
  if (!fs.existsSync(p)) return [];
  const [head, ...lines] = fs.readFileSync(p, "utf8").trim().split("\n");
  const h = head.split(",");
  return lines.filter(Boolean).map((l) => { const c = l.split(","); return Object.fromEntries(h.map((k, i) => [k, c.slice(i, i === h.length - 1 ? undefined : i + 1).join(",")])); });
};
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

const model = readJSON(path.join(ROOT, "site/data/model.json"));
const history = readJSON(path.join(ROOT, "site/data/history.json"), {});
const weather = readJSON(path.join(ROOT, "site/data/weather.json"), { days: {} }).days;
const events = readJSON(path.join(ROOT, "site/data/events.json"), { parks: {} }).parks;
const flog = readCSV(path.join(ROOT, "data/loop/forecast_log.csv"));
const qlog = readCSV(path.join(ROOT, "data/history/qt_forecast_log.csv"));
const investigated = readCSV(path.join(ROOT, "data/loop/investigated.csv"));
const observed = readJSON(path.join(ROOT, "site/data/observed.json"), { parks: {} }).parks || {};
const addDay = (k, n) => M.key(M.addDays(M.parse(k), n));
// 前日に出ていた天気予報（予報が外れた日を見つけるため）: "予報した日|対象日" → {h}
const fcast = new Map();
for (const r of readCSV(path.join(ROOT, "data/weather/forecast_log.csv"))) fcast.set(`${r.fetched_date}|${r.date}`, { h: Number(r.rain_hours) });
const invKey = new Set(investigated.map((r) => `${r.park}|${r.date}`));

// (park|date|lead) → 予想
const ours = new Map(), qt = new Map();
for (const r of flog) ours.set(`${r.park}|${r.date}|${r.lead}`, Number(r.pred));
for (const r of qlog) {
  const lead = Math.round((M.parse(r.date) - M.parse(r.fetched_date)) / 864e5);
  qt.set(`${r.park}|${r.date}|${lead}`, Number(r.qt_forecast));
}
const near = (map, park, date, lead) => { // ちょうどの日が無ければ ±1 日の記録で代用
  for (const l of [lead, lead + 1, lead - 1]) { const v = map.get(`${park}|${date}|${l}`); if (v != null) return v; }
  return null;
};

const out = { generated_at: new Date().toISOString().slice(0, 16), parks: {} };
const report = [];
const lastActual = Object.keys(history.tdl || {}).sort().pop();
report.push(`# 毎日の答え合わせレポート`, ``, `- 作成: ${out.generated_at} UTC`, `- 実績の最終日: ${lastActual}`,
  `- 採用中の設定: ${JSON.stringify(model.loop && model.loop.config)}`,
  `- 1か月ずつ予想し直すテストの平均ズレ: ${model.loop ? JSON.stringify(model.loop.backtest) : "-"}`, ``);

for (const park of ["tdl", "tds"]) {
  const act = history[park] || {};
  const dates = Object.keys(act).sort();
  const recent = dates.slice(-WINDOW);
  const P = model.parks[park];
  const ev = (events[park] || {}).tags || {}, prices = (events[park] || {}).prices || {};

  // 何日前の予想がどれだけ当たったか（記録がある日だけ）
  const acc = {};
  for (const lead of LEADS) {
    const o = [], q = [], both = [];
    for (const d of recent) {
      const a = act[d], po = near(ours, park, d, lead), pq = near(qt, park, d, lead);
      if (po != null) o.push(Math.abs(po - a));
      if (pq != null) q.push(Math.abs(pq - a));
      if (po != null && pq != null) both.push([Math.abs(po - a), Math.abs(pq - a)]);
    }
    acc[lead] = { ours: r1(mean(o)), oursN: o.length, qt: r1(mean(q)), qtN: q.length,
      headToHead: both.length ? { n: both.length, ours: r1(mean(both.map((x) => x[0]))), qt: r1(mean(both.map((x) => x[1]))) } : null };
  }

  // 最近の日ごとの比較と大ハズレ
  const days = [];
  for (const d of dates.slice(-RECENT_DAYS)) {
    const dt = M.parse(d), a = act[d];
    const logged = near(ours, park, d, 1);
    // 記録が無い日は、今のモデルに実際の天気を入れて計算した値（後から計算）で代用
    const back = M.predict(P, dt, weather[d] && !weather[d].f ? weather[d] : null, 1, park, new Set(ev[d] || []), prices[d] ?? null).score;
    const p = logged != null ? logged : back;
    const w = weather[d] || null;
    // 手がかり: 機械的に分かることを先に並べる（点検はここから仮説を立てる）
    const hints = [];
    const other = park === "tdl" ? "tds" : "tdl";
    const oa = (history[other] || {})[d];
    if (oa != null) {
      const op = M.predict(model.parks[other], dt, weather[d] && !weather[d].f ? weather[d] : null, 1, other, new Set(((events[other] || {}).tags || {})[d] || []), ((events[other] || {}).prices || {})[d] ?? null).score;
      if (Math.abs(oa - op) >= 15 && Math.sign(oa - op) === Math.sign(a - p)) hints.push("もう片方のパークも同じ向きに外れた（パーク共通の原因：天気・暦・交通など）");
      else if (Math.abs(a - p) >= BIG_MISS) hints.push("もう片方のパークはほぼ予想通り（このパークだけの原因：休止・貸切・イベントなど）");
    }
    if (w) {
      if ((w.pre || 0) >= 2) hints.push(`開園前（0〜9時）に雨 ${w.pre}mm`);
      if (w.h >= 1 && (w.a || 0) === 0) hints.push("雨は午後だけ");
      if ((w.g || 0) >= 50) hints.push(`強風 ${w.g}km/h`);
      if ((w.py || 0) >= 4 && w.h === 0) hints.push("前日が雨");
    }
    const fc = fcast.get(`${addDay(d, -1)}|${d}`);
    if (fc && w && !w.f) {
      if (fc.h >= 3 && w.h === 0) hints.push(`前日の予報は雨（${fc.h}時間）だったが降らなかった`);
      if (fc.h === 0 && w.h >= 3) hints.push("前日の予報は雨なしだったが降った");
    }
    const prevYears = [1, 2, 3].map((n) => { const k = `${Number(d.slice(0, 4)) - n}${d.slice(4)}`; return act[k] != null ? `${k.slice(0, 4)}年 ${act[k]}%` : null; }).filter(Boolean);
    if (prevYears.length) hints.push(`同じ日付の過去: ${prevYears.join("、")}`);
    const o = (observed[park] || {})[d];
    if (o) hints.push(`自前の計測: 平均待ち ${o.avg}分・ピーク ${o.peak}分`);
    days.push({
      hints,
      date: d, actual: a, pred: p, predKind: logged != null ? "前日の予想" : "後から計算", err: a - p,
      qt: near(qt, park, d, 1), weekday: M.WD[dt.getUTCDay()], holiday: M.holidayName(dt) || "",
      weather: w ? `雨${w.h}時間・${w.r}mm・最高${w.t}℃${(w.pre || 0) >= 2 ? `・開園前の雨${w.pre}mm` : ""}` : "", tags: ev[d] || [], price: prices[d] ?? null,
      investigated: invKey.has(`${park}|${d}`),
    });
  }
  const misses = days.filter((x) => Math.abs(x.err) >= BIG_MISS);
  out.parks[park] = { accuracy: acc, days, misses };

  report.push(`## ${PARK_JA[park]}`, ``, `### 何日前の予想がどれだけ当たったか（直近${WINDOW}日、平均のズレ）`, ``,
    `| 何日前 | このサイト | 日数 | Queue-Times | 日数 | 同じ日だけで比べると（このサイト / QT） |`, `| --- | --- | --- | --- | --- | --- |`);
  for (const lead of LEADS) {
    const x = acc[lead];
    report.push(`| ${lead}日前 | ${x.ours ?? "-"} | ${x.oursN} | ${x.qt ?? "-"} | ${x.qtN} | ${x.headToHead ? `${x.headToHead.ours} / ${x.headToHead.qt}（${x.headToHead.n}日）` : "-"} |`);
  }
  report.push(``, `### 最近${RECENT_DAYS}日の大ハズレ（${BIG_MISS}ポイント以上）`, ``);
  if (!misses.length) report.push(`なし`);
  else {
    report.push(`| 日付 | 実績 | 予想 | ズレ | 予想の種類 | QT | 状況 | 調査済み |`, `| --- | --- | --- | --- | --- | --- | --- | --- |`);
    for (const x of misses) {
      const ctx = [`${x.weekday}曜`, x.holiday, x.weather, x.tags.join("/"), x.price ? `¥${x.price}` : ""].filter(Boolean).join("・");
      report.push(`| ${x.date} | ${x.actual} | ${x.pred} | ${x.err > 0 ? "+" : ""}${x.err} | ${x.predKind} | ${x.qt ?? "-"} | ${ctx} | ${x.investigated ? "済" : "**未**"} |`);
    }
    report.push(``, `#### 手がかり（自動で分かること）`, ``);
    for (const x of misses) report.push(`- **${x.date}**: ${x.hints.length ? x.hints.join(" ／ ") : "特になし"}`);
    // 外れ方のまとまり: 連続して同じ向きに外れているなら、個別の原因ではなく全体の水準のズレ
    const signs = days.slice(-7).map((x) => Math.sign(x.err));
    const neg = signs.filter((v) => v < 0).length, pos = signs.filter((v) => v > 0).length;
    if (neg >= 6 || pos >= 6) report.push(``, `> 直近7日のうち${Math.max(neg, pos)}日が${neg > pos ? "予想より空き" : "予想より混み"}。個別の原因より、全体の水準（時期の傾向）のズレを疑うこと。`);
  }
  report.push(``);
}

// 調査済みの原因（新しい順に10件）をページに
out.investigated = investigated.slice(-10).reverse();
fs.mkdirSync(path.join(ROOT, "data/loop"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "data/loop/report.md"), report.join("\n") + "\n");
fs.writeFileSync(path.join(ROOT, "site/data/loop.json"), JSON.stringify(out));
console.log(report.join("\n"));
