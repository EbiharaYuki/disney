/* 混雑予想モデル。ページ (site/index.html) と学習スクリプト (scripts/fit_model.mjs) の両方で使う。
 *
 * 混雑度 = Σ 係数 × 特徴量  (線形回帰)
 * 特徴量は日付だけから計算できるもの: 月・曜日の種類・祝日/連休・季節の期間・年。
 */
(function (root) {
  "use strict";

  const D = (y, m, d) => new Date(Date.UTC(y, m, d));
  const key = (dt) => dt.toISOString().slice(0, 10);
  const parse = (k) => new Date(k + "T00:00:00Z");
  const addDays = (dt, n) => D(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate() + n);
  const WD = ["日", "月", "火", "水", "木", "金", "土"];

  // ---- 日本の祝日（振替休日・国民の休日を含む） ----
  const holidayCache = {};
  function nthMonday(y, m, n) {
    const w = D(y, m, 1).getUTCDay();
    return D(y, m, 1 + ((8 - w) % 7) + 7 * (n - 1));
  }
  function holidays(y) {
    if (holidayCache[y]) return holidayCache[y];
    const h = new Map();
    const add = (dt, name) => h.set(key(dt), name);
    [[0, 1, "元日"], [1, 11, "建国記念の日"], [1, 23, "天皇誕生日"], [3, 29, "昭和の日"], [4, 3, "憲法記念日"],
     [4, 4, "みどりの日"], [4, 5, "こどもの日"], [7, 11, "山の日"], [10, 3, "文化の日"], [10, 23, "勤労感謝の日"]]
      .forEach(([m, d, n]) => add(D(y, m, d), n));
    add(nthMonday(y, 0, 2), "成人の日");
    add(nthMonday(y, 6, 3), "海の日");
    add(nthMonday(y, 8, 3), "敬老の日");
    add(nthMonday(y, 9, 2), "スポーツの日");
    const k = y - 1980, leap = Math.floor(k / 4);
    add(D(y, 2, Math.floor(20.8431 + 0.242194 * k - leap)), "春分の日");
    add(D(y, 8, Math.floor(23.2488 + 0.242194 * k - leap)), "秋分の日");
    for (const k1 of [...h.keys()]) {
      const mid = addDays(parse(k1), 1);
      if (!h.has(key(mid)) && h.has(key(addDays(mid, 1))) && mid.getUTCDay() !== 0) add(mid, "国民の休日");
    }
    for (const k1 of [...h.keys()].sort()) {
      const dt = parse(k1);
      if (dt.getUTCDay() !== 0) continue;
      let s = addDays(dt, 1);
      while (h.has(key(s))) s = addDays(s, 1);
      add(s, "振替休日");
    }
    holidayCache[y] = h;
    return h;
  }
  const holidayName = (dt) => holidays(dt.getUTCFullYear()).get(key(dt));
  const isNewYearBreak = (dt) => { const m = dt.getUTCMonth(), d = dt.getUTCDate(); return (m === 11 && d >= 29) || (m === 0 && d <= 3); };
  const isOff = (dt) => { const w = dt.getUTCDay(); return w === 0 || w === 6 || !!holidayName(dt) || isNewYearBreak(dt); };

  // ---- 季節の期間 [開始月, 開始日, 終了月, 終了日]（月は1始まり） ----
  const inRange = (dt, m1, d1, m2, d2) => {
    const v = (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate();
    const a = m1 * 100 + d1, b = m2 * 100 + d2;
    return a <= b ? v >= a && v <= b : v >= a || v <= b;
  };
  const PERIODS = [
    { id: "p_newyear", name: "年末年始", r: [12, 28, 1, 3] },
    { id: "p_spring", name: "春休み（平日）", r: [3, 20, 4, 6], weekdayOnly: true },
    { id: "p_gw", name: "GW", r: [4, 29, 5, 5] },
    { id: "p_summer", name: "夏休み（平日）", r: [7, 20, 8, 31], weekdayOnly: true },
    { id: "p_obon", name: "お盆", r: [8, 10, 8, 16] },
    { id: "p_halloween", name: "ハロウィン期間（目安）", r: [9, 15, 10, 31] },
    { id: "p_xmas", name: "クリスマス期間（目安）", r: [11, 8, 12, 25] },
    { id: "p_xmas_day", name: "クリスマス直前", r: [12, 23, 12, 25] },
  ];

  const MONTH_IDS = Array.from({ length: 12 }, (_, i) => `m_${i + 1}`);
  // 水曜（翌日も平日の水曜）を曜日の基準にする
  const DAY_IDS = ["d_offoff", "d_offwork", "d_workoff", "d_mon", "d_tue", "d_thu"];
  const YEAR_IDS = ["y_2024", "y_2025", "y_2026"]; // 2023 が基準
  const FEATURES = [...MONTH_IDS, ...DAY_IDS, "d_renkyu_mid", "d_renkyu_last", ...PERIODS.map((p) => p.id), ...YEAR_IDS];

  const LABELS = {
    d_offoff: "休日で翌日も休み", d_offwork: "休日で翌日は平日", d_workoff: "休みの前日",
    d_mon: "平日の月曜", d_tue: "平日の火曜", d_thu: "平日の木曜",
    d_renkyu_mid: "連休の中日", d_renkyu_last: "連休の最終日",
  };
  PERIODS.forEach((p) => (LABELS[p.id] = p.name));
  MONTH_IDS.forEach((id, i) => (LABELS[id] = `${i + 1}月`));

  /** 日付 → { 特徴量id: 値 }（0 の特徴量は省略）。yearLevel は年の特徴量に使う年（未来日は最新年を渡す） */
  function features(dt, yearLevel) {
    const f = {};
    f[MONTH_IDS[dt.getUTCMonth()]] = 1;
    const off = isOff(dt), nextOff = isOff(addDays(dt, 1)), prevOff = isOff(addDays(dt, -1));
    const w = dt.getUTCDay();
    if (off && nextOff) f.d_offoff = 1;
    else if (off) f.d_offwork = 1;
    else if (nextOff) f.d_workoff = 1;
    else if (w === 1) f.d_mon = 1;
    else if (w === 2) f.d_tue = 1;
    else if (w === 4) f.d_thu = 1;
    // 3連休以上
    if (off && prevOff && nextOff) f.d_renkyu_mid = 1;
    if (off && prevOff && !nextOff && isOff(addDays(dt, -2))) f.d_renkyu_last = 1;
    for (const p of PERIODS) {
      if (p.weekdayOnly && off) continue;
      if (inRange(dt, ...p.r)) f[p.id] = 1;
    }
    const y = yearLevel || dt.getUTCFullYear();
    const yid = `y_${Math.min(y, 2026)}`;
    if (YEAR_IDS.includes(yid)) f[yid] = 1;
    return f;
  }

  /** model = { coefs: {id: number}, latestYear } → { score, parts: [{id, label, value}] } */
  function predict(model, dt) {
    const y = Math.min(dt.getUTCFullYear(), model.latestYear || dt.getUTCFullYear());
    const f = features(dt, y);
    let s = 0;
    const parts = [];
    for (const id in f) {
      const c = model.coefs[id] || 0;
      s += c * f[id];
      if (!id.startsWith("y_")) parts.push({ id, label: LABELS[id] || id, value: c * f[id] });
    }
    return { score: Math.max(0, Math.min(100, Math.round(s))), parts };
  }

  root.CrowdModel = { D, key, parse, addDays, WD, holidays, holidayName, isOff, features, predict, FEATURES, LABELS, MONTH_IDS };
})(typeof window !== "undefined" ? window : globalThis);
