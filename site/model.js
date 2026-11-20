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
  // 天気は「その月の平年との差」で入れる。天気が分からない日は 0（＝平年並み）になる
  const WEATHER_IDS = ["w_rain_hours", "w_rain_hours_off", "w_heavy", "w_hot", "w_cold"];
  const FEATURES = [...MONTH_IDS, ...DAY_IDS, "d_renkyu_mid", "d_renkyu_last", ...PERIODS.map((p) => p.id), ...YEAR_IDS, ...WEATHER_IDS];

  const HEAVY_MM = 10, HOT_C = 32, COLD_C = 8;
  /** 天気の日別データ [{r: 雨量mm, h: 雨の時間数, t: 最高気温}] から月ごとの平年値を作る */
  function climatology(days) {
    const acc = Array.from({ length: 12 }, () => ({ n: 0, h: 0, heavy: 0, hot: 0, cold: 0 }));
    for (const [k, w] of Object.entries(days)) {
      const a = acc[Number(k.slice(5, 7)) - 1];
      a.n++; a.h += w.h; a.heavy += w.r >= HEAVY_MM ? 1 : 0; a.hot += w.t >= HOT_C ? 1 : 0; a.cold += w.t <= COLD_C ? 1 : 0;
    }
    return acc.map((a) => (a.n ? { h: +(a.h / a.n).toFixed(3), heavy: +(a.heavy / a.n).toFixed(3), hot: +(a.hot / a.n).toFixed(3), cold: +(a.cold / a.n).toFixed(3) } : { h: 0, heavy: 0, hot: 0, cold: 0 }));
  }
  /** 予報の信頼度: 先の日ほど平年値に寄せる（lead = 何日先か） */
  const forecastWeight = (lead) => (lead <= 2 ? 1 : lead <= 4 ? 0.7 : lead <= 7 ? 0.4 : 0);

  // ---- 混雑要因の候補 ----
  // ここに並べた要因は、毎日の学習で効果を検証し、統計的にはっきりしたものだけ予想に使う（scripts/fit_model.js）。
  // fn(c) の c = { dt, m (1-12), d, off, prevOff, nextOff, park, ev (その日の要因タグの Set) }
  const md = (c, m1, d1, m2, d2) => inRange(c.dt, m1, d1, m2, d2);
  const LUNAR_NY = ["2023-01-22", "2024-02-10", "2025-01-29", "2026-02-17", "2027-02-06", "2028-01-26"];
  const nearLunarNY = (dt) => LUNAR_NY.some((k) => { const diff = (dt - parse(k)) / 864e5; return diff >= -1 && diff <= 7; });
  const FACTORS = [
    // 暦から計算できるもの
    { id: "f_tobiishi", group: "暦", label: "飛び石連休の中日の平日", src: "ご提案", fn: (c) => !c.off && c.prevOff && c.nextOff },
    { id: "f_after_renkyu", group: "暦", label: "3連休以上が明けた平日", src: "定番", fn: (c) => !c.off && c.prevOff && isOff(addDays(c.dt, -2)) && isOff(addDays(c.dt, -3)) },
    { id: "f_payday", group: "暦", label: "給料日（25日）後の休日", src: "定番", fn: (c) => c.off && c.d >= 25 },
    { id: "f_kenmin", group: "暦", label: "関東の都民・県民の日（平日）", src: "定番", fn: (c) => !c.off && [[6, 15], [10, 1], [10, 28], [11, 13], [11, 14]].some(([m, d]) => c.m === m && c.d === d) },
    { id: "f_summer_end", group: "学校", label: "夏休み最終週の平日", src: "定番", fn: (c) => !c.off && md(c, 8, 25, 8, 31) },
    { id: "f_new_term", group: "学校", label: "新学期直後の平日（4月中旬）", src: "ブログ", fn: (c) => !c.off && md(c, 4, 7, 4, 20) },
    { id: "f_gw_after", group: "学校", label: "GW明けの平日", src: "ブログ", fn: (c) => !c.off && md(c, 5, 7, 5, 16) },
    { id: "f_school_trip", group: "学校", label: "修学旅行シーズンの平日（5月下旬〜6月中旬）", src: "ブログ", fn: (c) => !c.off && md(c, 5, 20, 6, 15) },
    { id: "f_exam", group: "学校", label: "受験シーズンの平日（1月中旬〜2月上旬）", src: "ブログ", fn: (c) => !c.off && md(c, 1, 10, 2, 10) },
    { id: "f_grad_trip", group: "学校", label: "大学生の春休み・卒業旅行シーズンの平日", src: "ブログ", fn: (c) => !c.off && md(c, 2, 11, 3, 19) },
    { id: "f_univ_sep", group: "学校", label: "大学生の夏休み（9月前半の平日）", src: "定番", fn: (c) => !c.off && md(c, 9, 1, 9, 20) },
    { id: "f_dec_first", group: "季節", label: "12月第1週の平日", src: "ブログ", fn: (c) => !c.off && md(c, 12, 1, 12, 7) },
    { id: "f_china_gw", group: "海外", label: "中国の国慶節（10/1〜7）", src: "定番", fn: (c) => md(c, 10, 1, 10, 7) },
    { id: "f_lunar_ny", group: "海外", label: "春節（中華圏の旧正月）", src: "定番", fn: (c) => nearLunarNY(c.dt) },
    { id: "f_mickey_bday", group: "記念日", label: "ミッキー＆ミニーの誕生日（11/18）", src: "ご提案", fn: (c) => c.m === 11 && c.d === 18 },
    { id: "f_char_day", group: "記念日", label: "キャラクターの記念日（ドナルド6/9・スティッチ6/26）", src: "定番", fn: (c) => (c.m === 6 && (c.d === 9 || c.d === 26)) },
    { id: "f_park_anniv", group: "記念日", label: "開園記念日（ランド4/15・シー9/4）", src: "定番", fn: (c) => (c.park === "tdl" ? c.m === 4 && c.d === 15 : c.m === 9 && c.d === 4) },
    // 要因カレンダー（data/factors/events.csv と Queue-Times のイベント記録・営業時間）から
    { id: "e_event_eve", group: "パーク", label: "新イベント開始の前日（スニーク）", src: "ブログ", tag: "event_eve" },
    { id: "e_event_first", group: "パーク", label: "イベント開始から1週間", src: "ブログ", tag: "event_first" },
    { id: "e_event_last", group: "パーク", label: "イベント最終週（駆け込み）", src: "定番", tag: "event_last" },
    { id: "e_merch", group: "パーク", label: "グッズ発売日", src: "ご提案", tag: "merch" },
    { id: "e_open", group: "パーク", label: "アトラクション・エリアのオープンから1週間", src: "ご提案", tag: "open" },
    { id: "e_show", group: "パーク", label: "新パレード・ショーの開始日", src: "定番", tag: "show" },
    { id: "e_short", group: "パーク", label: "時短営業（貸切など）", src: "データ", tag: "short" },
    { id: "e_other_short", group: "パーク", label: "もう片方のパークが時短営業", src: "ブログ", tag: "other_short" },
  ];
  const FACTOR_IDS = FACTORS.map((f) => f.id);

  const LABELS = {
    d_offoff: "休日で翌日も休み", d_offwork: "休日で翌日は平日", d_workoff: "休みの前日",
    d_mon: "平日の月曜", d_tue: "平日の火曜", d_thu: "平日の木曜",
    d_renkyu_mid: "連休の中日", d_renkyu_last: "連休の最終日",
    w_rain_hours: "雨の時間（平年との差）", w_rain_hours_off: "休日の雨（平年との差）",
    w_heavy: "大雨", w_hot: "猛暑（32℃以上）", w_cold: "寒い（8℃以下）",
  };
  PERIODS.forEach((p) => (LABELS[p.id] = p.name));
  FACTORS.forEach((f) => (LABELS[f.id] = f.label));
  MONTH_IDS.forEach((id, i) => (LABELS[id] = `${i + 1}月`));

  /** 日付 → { 特徴量id: 値 }（0 の特徴量は省略）。
   *  yearLevel: 年の特徴量に使う年（未来日は最新年を渡す）
   *  wx: その日の天気 {r, h, t}（無ければ null）、clim: 月ごとの平年値、weight: 天気の信頼度 0〜1 */
  function features(dt, yearLevel, wx, clim, weight = 1, park = "tdl", ev = null) {
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
    const c = { dt, m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), off, prevOff, nextOff, park, ev: ev || new Set() };
    for (const fa of FACTORS) if (fa.tag ? c.ev.has(fa.tag) : fa.fn(c)) f[fa.id] = 1;
    if (wx && clim && weight > 0) {
      const cl = clim[dt.getUTCMonth()];
      const put = (id, v) => { if (Math.abs(v) > 1e-9) f[id] = weight * v; };
      put("w_rain_hours", wx.h - cl.h);
      if (off) put("w_rain_hours_off", wx.h - cl.h);
      put("w_heavy", (wx.r >= HEAVY_MM ? 1 : 0) - cl.heavy);
      put("w_hot", (wx.t >= HOT_C ? 1 : 0) - cl.hot);
      put("w_cold", (wx.t <= COLD_C ? 1 : 0) - cl.cold);
    }
    return f;
  }

  /** model = { coefs, latestYear, clim } → { score, parts: [{id, label, value}] }
   *  wx: その日の天気（実績か予報）、weight: 天気の信頼度（実績なら 1） */
  function predict(model, dt, wx, weight = 1, park = "tdl", ev = null) {
    const y = Math.min(dt.getUTCFullYear(), model.latestYear || dt.getUTCFullYear());
    const f = features(dt, y, wx, model.clim, weight, park, ev);
    let s = 0;
    const parts = [];
    for (const id in f) {
      const c = model.coefs[id] || 0;
      s += c * f[id];
      if (!id.startsWith("y_") && c !== 0) parts.push({ id, label: LABELS[id] || id, value: c * f[id] });
    }
    return { score: Math.max(0, Math.min(100, Math.round(s))), parts };
  }

  root.CrowdModel = { D, key, parse, addDays, WD, holidays, holidayName, isOff, features, predict, climatology, forecastWeight, FEATURES, FACTORS, FACTOR_IDS, LABELS, MONTH_IDS, HEAVY_MM, HOT_C, COLD_C };
})(typeof window !== "undefined" ? window : globalThis);
