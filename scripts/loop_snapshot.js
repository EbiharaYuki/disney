/* 今日の予想（今日〜60日先）を data/loop/forecast_log.csv に記録する。
 * あとで実績が出たときに「1日前・7日前・30日前の予想がどれだけ当たったか」を測るため。
 * ページと同じ入力（モデル・天気予報・要因カレンダー・チケット価格）で計算する。
 * 同じ日に何度実行しても、その日の記録は最後の1回分だけ残す。
 */
"use strict";
const fs = require("fs");
const path = require("path");
require("../site/model.js");
const M = globalThis.CrowdModel;

const ROOT = path.resolve(__dirname, "..");
const LOG = path.join(ROOT, "data/loop/forecast_log.csv");
const DAYS = 60;
const readJSON = (p, fb) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : fb);

const model = readJSON(path.join(ROOT, "site/data/model.json"));
const weather = readJSON(path.join(ROOT, "site/data/weather.json"), { days: {} }).days;
const events = readJSON(path.join(ROOT, "site/data/events.json"), { parks: {} }).parks;

const jst = new Date(Date.now() + 9 * 3600e3);
const today = M.D(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
const made = M.key(today);

const rows = [];
for (const park of ["tdl", "tds"]) {
  const P = model.parks[park], ev = (events[park] || {}).tags || {}, prices = (events[park] || {}).prices || {};
  for (let lead = 0; lead <= DAYS; lead++) {
    const dt = M.addDays(today, lead), k = M.key(dt);
    const wx = weather[k] || null;
    const w = !wx ? 0 : wx.f ? M.forecastWeight(lead) : 1;
    const p = M.predict(P, dt, wx, w, park, new Set(ev[k] || []), prices[k] ?? null).score;
    rows.push([made, park, k, lead, p].join(","));
  }
}

let old = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n") : ["made,park,date,lead,pred"];
old = old.filter((l, i) => i === 0 || !l.startsWith(made + ","));
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.writeFileSync(LOG, [...old, ...rows].join("\n") + "\n");
console.log(`forecast snapshot ${made}: ${rows.length} rows`);
