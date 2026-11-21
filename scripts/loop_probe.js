/* 仮説の検証ツール: 「こういう条件の日は、今の予想より混む／空くのでは？」を全期間の実績で確かめる。
 *
 * 使い方: node scripts/loop_probe.js "条件式（JavaScript）"
 *   例: node scripts/loop_probe.js "wx && wx.pre >= 2 && wx.h === 0"      開園前だけ雨が降った日
 *       node scripts/loop_probe.js "!off && prev && prev.h >= 4"            前日が雨だった平日
 *       node scripts/loop_probe.js "m === 11 && d === 18"                   ミッキーの誕生日
 * 条件式で使える変数:
 *   y, m (1-12), d, wd (0=日〜6=土), off (休日か), park ("tdl"/"tds")
 *   wx   その日の天気 {r: 9-21時の雨量mm, h: 雨の時間数, t: 最高気温, pre: 開園前0-9時の雨量mm, a: 午前の雨の時間数, g: 最大瞬間風速km/h}（無い日は null）
 *   prev, next  前日・翌日の天気（同じ形）
 *   ev   その日の要因タグの Set（short, other_short, event_first, merch など）
 *   price チケット価格（円、無ければ null）, crowd 実績
 * 出力: 該当日数、今の予想との差の平均（該当しない日と比べて。＋なら予想より混んだ）、誤差の目安、t値。|t| が 2 以上なら偶然ではなさそう。
 */
"use strict";
const fs = require("fs");
const path = require("path");
require("../site/model.js");
const M = globalThis.CrowdModel;
const ROOT = path.resolve(__dirname, "..");
const expr = process.argv[2];
if (!expr) { console.error('使い方: node scripts/loop_probe.js "条件式"'); process.exit(1); }
const test = new Function("c", `with (c) { return (${expr}); }`);
const J = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const model = J("site/data/model.json"), history = J("site/data/history.json"), weather = J("site/data/weather.json").days, events = J("site/data/events.json").parks;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
for (const park of ["tdl", "tds"]) {
  const P = model.parks[park], tags = events[park].tags || {}, prices = events[park].prices || {};
  const hit = [], dates = [], rest = [];
  for (const [k, crowd] of Object.entries(history[park])) {
    const dt = M.parse(k), wxOf = (x) => { const w = weather[M.key(x)]; return w && !w.f ? w : null; };
    const wx = wxOf(dt), ev = new Set(tags[k] || []), price = prices[k] ?? null;
    const c = { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), wd: dt.getUTCDay(), off: M.isOff(dt), park, wx, prev: wxOf(M.addDays(dt, -1)), next: wxOf(M.addDays(dt, 1)), ev, price, crowd };
    let ok = false;
    try { ok = !!test(c); } catch { ok = false; }
    // 過去の日には「直近のズレ補正」は当てはまらないので外して比べる
    const resid = crowd - (M.predict(P, dt, wx, 1, park, ev, price).score - (P.levelAdj || 0));
    if (!ok) { rest.push(resid); continue; }
    hit.push(resid);
    dates.push(`${k}(${hit[hit.length - 1] > 0 ? "+" : ""}${hit[hit.length - 1]})`);
  }
  if (hit.length < 2) { console.log(`${park}: 該当 ${hit.length} 日（少なすぎて判断できません）`, dates.join(" ")); continue; }
  // 該当しない日の平均との差で見る（予想式全体のクセを差し引くため）
  const base = rest.length ? mean(rest) : 0;
  const mu = mean(hit) - base, se = Math.sqrt(hit.reduce((s, x) => s + (x - mean(hit)) ** 2, 0) / (hit.length - 1) / hit.length);
  console.log(`${park}: 該当 ${hit.length} 日  予想との差 ${mu > 0 ? "+" : ""}${mu.toFixed(1)} ± ${(1.96 * se).toFixed(1)}  t=${(mu / se).toFixed(1)}  ${Math.abs(mu / se) >= 2 && hit.length >= 8 ? "→ はっきりした傾向" : "→ まだはっきりしない"}`);
  console.log(`   最近の該当日: ${dates.slice(-8).join(" ")}`);
}
