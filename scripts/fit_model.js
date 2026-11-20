/* 予想モデルの学習・混雑要因の検証・精度テスト。
 *
 * 1. 基本モデル（月・曜日の種類・連休・季節・年・天気）を線形回帰（リッジ）で学習
 * 2. 混雑要因の候補（site/model.js の FACTORS）ごとに、基本モデルの予想と実績の差（残差）を集計して効果を検証
 *    効果がはっきりした要因（日数8日以上、t値2以上、一緒に学習しても向きが同じ、2ポイント以上）だけを採用
 * 3. 採用した要因を加えてもう一度学習 → site/data/model.json
 * 4. 精度テスト: 2025年末までのデータだけで 1〜3 をやり直し、2026年の実績を予想して誤差を測る
 *
 * 入力: data/history/*.csv, site/data/weather.json, site/data/events.json
 * 使い方: node scripts/fit_model.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
require("../site/model.js");
const M = globalThis.CrowdModel;

const ROOT = path.resolve(__dirname, "..");
const TEST_START = "2026-01-01";
const RIDGE = 0.5;
const ADOPT = { minDays: 8, minT: 2, minEffect: 2 };

const readJSON = (p, fallback) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : fallback);
const WX = Object.fromEntries(Object.entries(readJSON(path.join(ROOT, "site/data/weather.json"), { days: {} }).days).filter(([, w]) => !w.f));
const EVENTS = readJSON(path.join(ROOT, "site/data/events.json"), { parks: {} }).parks;
const climFrom = (until) => (Object.keys(WX).length ? M.climatology(Object.fromEntries(Object.entries(WX).filter(([k]) => k < until))) : null);
const BASE = M.FEATURES;

const PRICES = Object.fromEntries(["tdl", "tds"].map((p) => [p, (EVENTS[p] && EVENTS[p].prices) || {}]));
let PRICE_MEAN = {};

function readHistory(park) {
  const lines = fs.readFileSync(path.join(ROOT, "data/history", `${park}.csv`), "utf8").trim().split("\n");
  const head = lines.shift().split(",");
  const tags = (EVENTS[park] && EVENTS[park].tags) || {};
  return lines.map((l) => {
    const c = l.split(",");
    const r = Object.fromEntries(head.map((h, i) => [h, c[i]]));
    return { date: r.date, crowd: Number(r.crowd), hours: r.hours, park, ev: new Set(tags[r.date] || []), price: PRICES[park][r.date] ?? null };
  }).filter((r) => Number.isFinite(r.crowd) && r.hours !== "");
}

const feat = (r, clim) => M.features(M.parse(r.date), undefined, WX[r.date], clim, 1, r.park, r.ev, r.price, PRICE_MEAN[r.park]);

// (XᵀX + λI) β = Xᵀy をガウスの消去法で解く。使う特徴量は names だけ
function fit(rows, latestYear, clim, names) {
  const n = names.length, idx = Object.fromEntries(names.map((f, i) => [f, i]));
  const A = Array.from({ length: n }, () => new Float64Array(n + 1));
  for (const r of rows) {
    const f = feat(r, clim);
    const ids = Object.keys(f).filter((k) => k in idx);
    for (const a of ids) {
      for (const b of ids) A[idx[a]][idx[b]] += f[a] * f[b];
      A[idx[a]][n] += f[a] * r.crowd;
    }
  }
  for (let i = 0; i < n; i++) A[i][i] += RIDGE;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < n; r++) {
      if (r === c || A[r][c] === 0) continue;
      const k = A[r][c] / A[c][c];
      for (let j = c; j <= n; j++) A[r][j] -= k * A[c][j];
    }
  }
  const coefs = {};
  names.forEach((f, i) => (coefs[f] = Math.round((A[i][n] / A[i][i]) * 100) / 100));
  return { coefs, latestYear, clim, priceMean: PRICE_MEAN[rows[0].park] || null };
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
function corr(a, b) {
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  a.forEach((x, i) => { num += (x - ma) * (b[i] - mb); da += (x - ma) ** 2; db += (b[i] - mb) ** 2; });
  return num / Math.sqrt(da * db);
}
const quantile = (arr, q) => { const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const levelOf = (v, th) => { const i = th.findIndex((t) => v < t); return i === -1 ? th.length : i; };
const pred = (model, r, useWeather) => M.predict(model, M.parse(r.date), useWeather ? WX[r.date] : null, 1, r.park, r.ev, r.price).score;

function evaluate(model, rows, thresholds, useWeather) {
  const p = rows.map((r) => pred(model, r, useWeather));
  const act = rows.map((r) => r.crowd);
  const err = p.map((x, i) => Math.abs(x - act[i]));
  const lvP = p.map((x) => levelOf(x, thresholds)), lvA = act.map((a) => levelOf(a, thresholds));
  const quiet = lvP.map((l, i) => [l, lvA[i]]).filter(([l]) => l <= 1);
  return {
    n: rows.length, from: rows[0].date, to: rows[rows.length - 1].date,
    mae: +mean(err).toFixed(1),
    corr: +corr(p, act).toFixed(2),
    levelWithin1: +(lvP.filter((l, i) => Math.abs(l - lvA[i]) <= 1).length / lvP.length).toFixed(2),
    quietPrecision: quiet.length ? +(quiet.filter(([, a]) => a <= 1).length / quiet.length).toFixed(2) : null,
  };
}

/** 要因の検証: 基本モデルの残差を要因ごとに集計し、さらに全候補を一緒に学習して係数も見る */
function analyzeFactors(rows, latestYear, clim) {
  const base = fit(rows, latestYear, clim, BASE);
  const resid = rows.map((r) => r.crowd - M.predict(base, M.parse(r.date), WX[r.date], 1, r.park, r.ev, r.price).score);
  const hits = Object.fromEntries(M.FACTOR_IDS.map((id) => [id, []]));
  const xs = Object.fromEntries(M.FACTOR_IDS.map((id) => [id, []])); // 連続値の要因: [値, 残差]
  rows.forEach((r, i) => {
    const f = feat(r, clim);
    for (const fa of M.FACTORS) {
      if (fa.continuous) { if (fa.id === "p_price" ? r.price != null : f[fa.id]) xs[fa.id].push([f[fa.id] || 0, resid[i]]); }
      else if (f[fa.id]) hits[fa.id].push(resid[i]);
    }
  });
  for (const fa of M.FACTORS) if (fa.continuous) hits[fa.id] = xs[fa.id].map(([, e]) => e);
  const candidates = M.FACTOR_IDS.filter((id) => hits[id].length >= (M.FACTORS.find((f) => f.id === id).continuous ? 30 : 5));
  const joint = fit(rows, latestYear, clim, [...BASE, ...candidates]);
  const factors = M.FACTORS.map((fa) => {
    const h = hits[fa.id], n = h.length;
    if (fa.continuous) {
      // 残差を値で回帰した傾き（1単位あたり何ポイント）
      const pts = xs[fa.id];
      if (pts.length < 30) return { id: fa.id, n: pts.length, status: pts.length ? "データ不足" : "データなし", continuous: true };
      const mx = mean(pts.map((p) => p[0])), my = mean(pts.map((p) => p[1]));
      const sxx = pts.reduce((s, [x]) => s + (x - mx) ** 2, 0);
      const slope = pts.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / sxx;
      const rss = pts.reduce((s, [x, y]) => s + (y - my - slope * (x - mx)) ** 2, 0);
      const se = Math.sqrt(rss / (pts.length - 2) / sxx), t = slope / se;
      const coef = joint.coefs[fa.id];
      const adopted = Math.abs(t) >= ADOPT.minT && coef != null && Math.sign(coef) === Math.sign(slope) && Math.abs(coef) >= 1;
      return { id: fa.id, n: pts.length, effect: +slope.toFixed(1), ci: +(1.96 * se).toFixed(1), t: +t.toFixed(1), coef: coef ?? null, continuous: true,
        status: adopted ? "採用" : Math.abs(t) < ADOPT.minT ? "効果はっきりせず" : "ほかの要因と区別できず" };
    }
    if (n < 2) return { id: fa.id, n, status: n ? "データ不足" : "データなし" };
    const m = mean(h), se = sd(h) / Math.sqrt(n), t = se > 0 ? m / se : 0;
    const coef = joint.coefs[fa.id];
    const adopted = n >= ADOPT.minDays && Math.abs(t) >= ADOPT.minT && coef != null && Math.sign(coef) === Math.sign(m) && Math.abs(coef) >= ADOPT.minEffect;
    const status = adopted ? "採用" : n < ADOPT.minDays ? "データ不足" : Math.abs(t) < ADOPT.minT ? "効果はっきりせず" : "ほかの要因と区別できず";
    return { id: fa.id, n, effect: +m.toFixed(1), ci: +(1.96 * se).toFixed(1), t: +t.toFixed(1), coef: coef != null ? coef : null, status };
  });
  return { factors, adopted: factors.filter((f) => f.status === "採用").map((f) => f.id) };
}

function train(rows, latestYear, clim) {
  const { factors, adopted } = analyzeFactors(rows, latestYear, clim);
  return { model: fit(rows, latestYear, clim, [...BASE, ...adopted]), factors, adopted };
}

const out = { generated_at: new Date().toISOString().slice(0, 16), source: "Queue-Times.com crowd calendar", adoptRule: ADOPT, parks: {} };
const history = {};
for (const park of ["tdl", "tds"]) {
  const pv = Object.values(PRICES[park]);
  PRICE_MEAN[park] = pv.length ? Math.round(mean(pv)) : null;
  const rows = readHistory(park);
  const last = rows[rows.length - 1].date;
  const latestYear = Number(last.slice(0, 4));
  const recent = rows.filter((r) => r.date > `${latestYear - 1}${last.slice(4)}`).map((r) => r.crowd);
  const thresholds = [0.2, 0.4, 0.6, 0.8].map((q) => quantile(recent, q));

  // 精度テスト（2025年末までで学習・要因選び → 2026年を予想）
  const trainRows = rows.filter((r) => r.date < TEST_START), testRows = rows.filter((r) => r.date >= TEST_START);
  const climT = climFrom(TEST_START);
  const baseT = fit(trainRows, latestYear - 1, climT, BASE);
  const withT = train(trainRows, latestYear - 1, climT);
  const validationBase = { noWeather: evaluate(baseT, testRows, thresholds, false), weather: climT ? evaluate(baseT, testRows, thresholds, true) : null };
  const validation = evaluate(withT.model, testRows, thresholds, false);
  const validationWeather = climT ? evaluate(withT.model, testRows, thresholds, true) : null;

  // 本番（全データ）
  const climA = climFrom("9999");
  const { model, factors, adopted } = train(rows, latestYear, climA);
  out.parks[park] = {
    ...model, thresholds, adopted, factors,
    validation, validationWeather, validationBase, adoptedInTest: withT.adopted,
    trained: { from: rows[0].date, to: last, n: rows.length },
  };
  history[park] = Object.fromEntries(rows.map((r) => [r.date, r.crowd]));

  console.log(`\n== ${park}  test MAE: base ${validationBase.noWeather.mae}/${validationBase.weather && validationBase.weather.mae} (no wx / wx)  → with factors ${validation.mae}/${validationWeather && validationWeather.mae}`);
  console.log(`   adopted in test: ${withT.adopted.map((id) => M.LABELS[id]).join(" / ") || "なし"}`);
  console.log(`   adopted (all data): ${adopted.map((id) => M.LABELS[id]).join(" / ") || "なし"}`);
  for (const f of factors) console.log(`   ${f.status.padEnd(10, "　")} n=${String(f.n).padStart(4)} effect=${f.effect ?? "-"}±${f.ci ?? "-"} t=${f.t ?? "-"} coef=${f.coef ?? "-"}  ${M.LABELS[f.id]}`);
}
fs.mkdirSync(path.join(ROOT, "site/data"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "site/data/model.json"), JSON.stringify(out, null, 1));
fs.writeFileSync(path.join(ROOT, "site/data/history.json"), JSON.stringify(history));
