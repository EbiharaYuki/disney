"""Open-Meteo から舞浜の天気（実績と予報）を取得する。APIキー不要。

出力:
  data/weather/maihama.csv       日別。実績 (kind=actual) と最新の予報 (kind=forecast)
  data/weather/forecast_log.csv  毎回の予報の記録（あとで予報の当たり具合を検証するため）
  site/data/weather.json         ページ用

日別の値は営業時間帯 9:00〜20:59 (JST) の 12 時間で集計:
  rain_mm    雨量の合計 (mm)
  rain_hours 1時間 0.5mm 以上降った時間数
  tmax       最高気温 (℃)
  pop        降水確率の最大 (%)。予報のみ
来園するかどうかは朝に決まるので、雨の時間帯も分けて持つ（2026-11-18 の大ハズレの調査から追加）:
  pre_mm     開園前 0:00〜8:59 の雨量 (mm)
  am_hours   9:00〜12:59 に 0.5mm 以上降った時間数
  gust       9:00〜20:59 の最大瞬間風速 (km/h)

Weather data by Open-Meteo.com (CC BY 4.0)
"""

import csv
import json
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

LAT, LON = 35.6329, 139.8804  # 舞浜
START = "2023-01-01"
JST = timezone(timedelta(hours=9))
ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "weather"
DAILY = OUT_DIR / "maihama.csv"
LOG = OUT_DIR / "forecast_log.csv"
SITE = ROOT / "site" / "data" / "weather.json"
FIELDS = ["date", "rain_mm", "rain_hours", "tmax", "pop", "kind", "pre_mm", "am_hours", "gust"]
HOURLY = "precipitation,temperature_2m,wind_gusts_10m"


def get(base: str, **params) -> dict:
    params.update(latitude=LAT, longitude=LON, timezone="Asia/Tokyo")
    req = Request(f"{base}?{urlencode(params)}", headers={"User-Agent": "tdr-crowd-simulator/1.0"})
    for attempt in range(5):
        try:
            with urlopen(req, timeout=60) as res:
                return json.load(res)
        except Exception:  # 429 (混雑) や接続リセットは少し待てば通ることが多い
            if attempt == 4:
                raise
            time.sleep(10 * (attempt + 1))


def daily_from_hourly(h: dict) -> dict[str, dict]:
    acc = defaultdict(lambda: {"rain": 0.0, "hours": 0, "t": [], "pop": [], "pre": 0.0, "am": 0, "g": []})
    pops = h.get("precipitation_probability") or [None] * len(h["time"])
    gusts = h.get("wind_gusts_10m") or [None] * len(h["time"])
    for ts, p, t, pop, g in zip(h["time"], h["precipitation"], h["temperature_2m"], pops, gusts):
        hour = int(ts[11:13])
        if p is None or t is None:
            continue
        a = acc[ts[:10]]
        if hour < 9:
            a["pre"] += p
            continue
        if hour > 20:
            continue
        a["rain"] += p
        a["hours"] += 1 if p >= 0.5 else 0
        a["am"] += 1 if (p >= 0.5 and hour <= 12) else 0
        if g is not None:
            a["g"].append(g)
        a["t"].append(t)
        if pop is not None:
            a["pop"].append(pop)
    out = {}
    for d, a in acc.items():
        if len(a["t"]) < 10:  # 欠けている日は使わない
            continue
        out[d] = {
            "rain_mm": round(a["rain"], 1),
            "rain_hours": a["hours"],
            "tmax": round(max(a["t"]), 1),
            "pop": max(a["pop"]) if a["pop"] else "",
            "pre_mm": round(a["pre"], 1),
            "am_hours": a["am"],
            "gust": round(max(a["g"]), 1) if a["g"] else "",
        }
    return out


def main() -> int:
    now = datetime.now(JST)
    today = now.strftime("%Y-%m-%d")
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    rows: dict[str, dict] = {}
    if DAILY.exists():
        with DAILY.open(encoding="utf-8") as f:
            rows = {r["date"]: r for r in csv.DictReader(f) if r["kind"] == "actual"}
        if any("pre_mm" not in r or r["pre_mm"] in ("", None) for r in rows.values()):
            rows = {}  # 列が増えたので全期間を取り直す

    # 実績: アーカイブは数日遅れなので、直近 10 日分は毎回取り直す
    last_actual = max(rows) if rows else None
    start = START if not last_actual else min(last_actual, (now - timedelta(days=10)).strftime("%Y-%m-%d"))
    end = (now - timedelta(days=1)).strftime("%Y-%m-%d")
    try:
        arc = get("https://archive-api.open-meteo.com/v1/archive", start_date=start, end_date=end,
                  hourly=HOURLY)
        for d, v in daily_from_hourly(arc["hourly"]).items():
            rows[d] = {"date": d, **v, "pop": "", "kind": "actual"}
    except Exception as e:
        print(f"archive failed: {e}", file=sys.stderr)

    # 予報（と、アーカイブにまだ無い直近の実績）
    fc = get("https://api.open-meteo.com/v1/forecast", past_days=7, forecast_days=16,
             hourly=HOURLY + ",precipitation_probability")
    fdaily = daily_from_hourly(fc["hourly"])
    log_new = not LOG.exists()
    with LOG.open("a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if log_new:
            w.writerow(["fetched_date", "date", "rain_mm", "rain_hours", "tmax", "pop", "pre_mm", "am_hours", "gust"])
        for d, v in sorted(fdaily.items()):
            if d < today:
                if d not in rows:
                    rows[d] = {"date": d, **v, "pop": "", "kind": "actual"}
            else:
                rows[d] = {"date": d, **v, "kind": "forecast"}
                w.writerow([today, d, v["rain_mm"], v["rain_hours"], v["tmax"], v["pop"], v["pre_mm"], v["am_hours"], v["gust"]])

    with DAILY.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        for d in sorted(rows):
            w.writerow({k: rows[d][k] for k in FIELDS})

    site = {}
    for d in sorted(rows):
        r = rows[d]
        e = {"r": float(r["rain_mm"]), "h": int(r["rain_hours"]), "t": float(r["tmax"]),
             "pre": float(r["pre_mm"]), "a": int(r["am_hours"]), "g": float(r["gust"]) if r["gust"] != "" else 0}
        prev = rows.get((datetime.strptime(d, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d"))
        if prev:
            e["py"] = int(prev["rain_hours"])  # 前日の雨の時間数（雨の翌日に人が流れるかを見るため）
        if r["kind"] == "forecast":
            e["f"] = 1
            if r["pop"] != "":
                e["p"] = int(float(r["pop"]))
        site[d] = e
    SITE.parent.mkdir(parents=True, exist_ok=True)
    SITE.write_text(json.dumps({"fetched": now.strftime("%Y-%m-%dT%H:%M"), "days": site}, separators=(",", ":")), encoding="utf-8")
    n_f = sum(1 for r in rows.values() if r["kind"] == "forecast")
    print(f"weather: {len(rows) - n_f} actual days, {n_f} forecast days")
    return 0


if __name__ == "__main__":
    sys.exit(main())
