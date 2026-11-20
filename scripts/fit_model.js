/* data/history/*.csv（Queue-Times の日別混雑度）から予想モデルを学習し、精度を検証する。
 *
 * 1. 検証: 2025年末までのデータで学習 → 2026年の実績を予想して誤差を測る（未来を当てられるかのテスト）
 * 2. 本番: 全データで学習した係数を site/data/model.json に保存
 * 3. 過去の実績を site/data/history.json に保存（カレンダーの過去日に表示）
 *
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

function readHistory(park) {
  const lines = fs.readFileSync(path.join(ROOT, "data/history", `${park}.csv`), "utf8").trim().split("\n");
  const head = lines.shift().split(",");
  return lines.map((l) => {
    const c = l.split(",");
    const r = Object.fromEntries(head.map((h, i) => [h, c[i]]));
    return { date: r.date, crowd: Number(r.crowd), hours: r.hours };
  }).filter((r) => Number.isFinite(r.crowd) && r.hours !== ""); // 休園日などは除外
}

// (XᵀX + λI) β = Xᵀy をガウスの消去法で解く
function fit(rows, latestYear) {
  const F = M.FEATURES, n = F.length, idx = Object.fromEntries(F.map((f, i) => [f, i]));
  const A = Array.from({ length: n }, () => new Float64Array(n + 1));
  for (const r of rows) {
    const f = M.features(M.parse(r.date));
    const ids = Object.keys(f).map((k) => idx[k]);
    for (const i of ids) {
      for (const j of ids) A[i][j] += f[F[i]] * f[F[j]];
      A[i][n] += f[F[i]] * r.crowd;
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
  F.forEach((f, i) => (coefs[f] = Math.round((A[i][n] / A[i][i]) * 100) / 100));
  return { coefs, latestYear };
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function corr(a, b) {
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  a.forEach((x, i) => { num += (x - ma) * (b[i] - mb); da += (x - ma) ** 2; db += (b[i] - mb) ** 2; });
  return num / Math.sqrt(da * db);
}
const quantile = (arr, q) => { const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const levelOf = (v, th) => th.findIndex((t) => v < t) === -1 ? th.length : th.findIndex((t) => v < t);

function evaluate(model, rows, thresholds) {
  const pred = rows.map((r) => M.predict(model, M.parse(r.date)).score);
  const act = rows.map((r) => r.crowd);
  const err = pred.map((p, i) => Math.abs(p - act[i]));
  const lvP = pred.map((p) => levelOf(p, thresholds)), lvA = act.map((a) => levelOf(a, thresholds));
  // 「空いてる」と予想した日（下位2段階）のうち、実際に下位2段階だった割合
  const quietPred = lvP.map((l, i) => [l, lvA[i]]).filter(([l]) => l <= 1);
  return {
    n: rows.length,
    from: rows[0].date, to: rows[rows.length - 1].date,
    mae: +mean(err).toFixed(1),
    corr: +corr(pred, act).toFixed(2),
    within10: +(err.filter((e) => e <= 10).length / err.length).toFixed(2),
    levelExact: +(lvP.filter((l, i) => l === lvA[i]).length / lvP.length).toFixed(2),
    levelWithin1: +(lvP.filter((l, i) => Math.abs(l - lvA[i]) <= 1).length / lvP.length).toFixed(2),
    quietPrecision: quietPred.length ? +(quietPred.filter(([, a]) => a <= 1).length / quietPred.length).toFixed(2) : null,
  };
}

// 比較用の素朴な予想: 学習期間の「月の平均 + 曜日の平均 − 全体平均」
function naive(train) {
  const all = mean(train.map((r) => r.crowd));
  const by = (fn) => { const g = {}; train.forEach((r) => (g[fn(r)] ||= []).push(r.crowd)); return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, mean(v)])); };
  const mo = by((r) => r.date.slice(5, 7)), wd = by((r) => M.parse(r.date).getUTCDay());
  return (r) => mo[r.date.slice(5, 7)] + wd[M.parse(r.date).getUTCDay()] - all;
}

const out = { generated_at: new Date().toISOString().slice(0, 16), source: "Queue-Times.com crowd calendar", parks: {} };
const history = {};
for (const park of ["tdl", "tds"]) {
  const rows = readHistory(park);
  const last = rows[rows.length - 1].date;
  const latestYear = Number(last.slice(0, 4));
  const recent = rows.filter((r) => r.date > `${latestYear - 1}${last.slice(4)}`).map((r) => r.crowd);
  const thresholds = [0.2, 0.4, 0.6, 0.8].map((q) => quantile(recent, q));

  const train = rows.filter((r) => r.date < TEST_START), test = rows.filter((r) => r.date >= TEST_START);
  const valModel = fit(train, latestYear - 1);
  const validation = evaluate(valModel, test, thresholds);
  const nv = naive(train);
  const naiveErr = mean(test.map((r) => Math.abs(nv(r) - r.crowd)));
  validation.maeNaive = +naiveErr.toFixed(1);

  const model = fit(rows, latestYear);
  const fitAll = evaluate(model, rows, thresholds);
  out.parks[park] = { ...model, thresholds, validation, fitAll, trained: { from: rows[0].date, to: last, n: rows.length } };

  history[park] = Object.fromEntries(rows.map((r) => [r.date, r.crowd]));
  console.log(park, JSON.stringify({ thresholds, validation, fitAllMae: fitAll.mae }));
}
fs.mkdirSync(path.join(ROOT, "site/data"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "site/data/model.json"), JSON.stringify(out, null, 1));
fs.writeFileSync(path.join(ROOT, "site/data/history.json"), JSON.stringify(history));
console.log(JSON.stringify(out.parks.tdl.coefs));
