"""Queue-Times.com の混雑カレンダーから、過去の日別混雑度を取得する。

出力: data/history/{tdl,tds}.csv          過去の日別実績
  date, crowd (0-100 %), hours (営業時間), event (イベント絵文字), holiday (祝日マーク 0/1)
      data/history/{tdl,tds}_future.csv   今日以降（今月＋3か月先）: 公式の営業時間・イベント期間と Queue-Times の混雑予想
      data/history/qt_forecast_log.csv    Queue-Times の予想の記録（あとでこのサイトの予想と精度を比べるため）

サーバー負荷を避けるため 1 リクエストごとに 2 秒待つ。既に取得済みの「過去の月」は取り直さない。
データ提供: Powered by Queue-Times.com (https://queue-times.com/)
"""

import csv
import html
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.request import Request, urlopen

PARKS = {"tdl": 274, "tds": 275}
START = (2023, 1)
JST = timezone(timedelta(hours=9))
ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "history"
FIELDS = ["date", "crowd", "hours", "event", "holiday"]
FUTURE_FIELDS = ["date", "qt_forecast", "hours", "event"]
FUTURE_MONTHS = 3

DAY_RE = re.compile(r'<a class="box[^"]*calendar-day"[^>]*href="[^"]*/calendar/(\d{4})/(\d{2})/(\d{2})"[^>]*>(.*?)</a>', re.S)
EMOJI_RE = re.compile(r"[\U0001F300-\U0001FAFF☀-➿]")
WEATHER = set("☀⛅☁🌧🌦🌩⛈🌨❄🌫🌤🌥")


def fetch(url: str) -> str:
    req = Request(url, headers={"User-Agent": "tdr-crowd-simulator/1.0 (personal, non-commercial)"})
    with urlopen(req, timeout=30) as res:
        return res.read().decode("utf-8")


def parse_month(page: str) -> list[dict]:
    rows = []
    for y, m, d, body in DAY_RE.findall(page):
        text = html.unescape(re.sub(r"<[^>]+>", " ", body))
        crowd = re.search(r"(\d{1,3})\s*%", text)
        if not crowd:
            continue
        hours = re.search(r"(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})", text)
        emojis = [e for e in EMOJI_RE.findall(text) if e not in WEATHER and e != "🕘"]
        rows.append({
            "date": f"{y}-{m}-{d}",
            "crowd": int(crowd.group(1)),
            "hours": f"{hours.group(1)}-{hours.group(2)}" if hours else "",
            "event": "".join(e for e in emojis if e != "🏖"),
            "holiday": 1 if "🏖" in text else 0,
        })
    return rows


def months(until: datetime, start=START):
    y, m = start
    while (y, m) <= (until.year, until.month):
        yield y, m
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def main() -> int:
    today = datetime.now(JST)
    today_s = today.strftime("%Y-%m-%d")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for park, pid in PARKS.items():
        path = OUT_DIR / f"{park}.csv"
        existing: dict[str, dict] = {}
        if path.exists():
            with path.open(encoding="utf-8") as f:
                existing = {r["date"]: r for r in csv.DictReader(f)}
        have_months = {k[:7] for k in existing}
        for y, m in months(today):
            ym = f"{y}-{m:02d}"
            is_current = (y, m) == (today.year, today.month)
            prev_month = (today.replace(day=1) - timedelta(days=1)).strftime("%Y-%m")
            if ym in have_months and not is_current and ym != prev_month:
                continue
            url = f"https://queue-times.com/en-US/parks/{pid}/calendar/{y}/{m:02d}"
            try:
                rows = parse_month(fetch(url))
            except Exception as e:
                print(f"{park} {ym}: failed ({e})", file=sys.stderr)
                time.sleep(2)
                continue
            n = 0
            for r in rows:
                # カレンダーには前後の月の日や未来の予想も出るので、その月の過去日だけ採用
                if r["date"][:7] == ym and r["date"] < today_s:
                    existing[r["date"]] = r
                    n += 1
            print(f"{park} {ym}: {n} days")
            time.sleep(2)
        with path.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=FIELDS)
            w.writeheader()
            for k in sorted(existing):
                w.writerow({fld: existing[k][fld] for fld in FIELDS})
        print(f"{park}: {len(existing)} days total -> {path.relative_to(ROOT)}")

        # 今日以降: 営業時間・イベント期間・Queue-Times の予想
        future: dict[str, dict] = {}
        end = today.replace(day=1) + timedelta(days=32 * FUTURE_MONTHS)
        for y, m in months(end, (today.year, today.month)):
            url = f"https://queue-times.com/en-US/parks/{pid}/calendar/{y}/{m:02d}"
            try:
                for r in parse_month(fetch(url)):
                    if r["date"] >= today_s and r["date"][:7] == f"{y}-{m:02d}":
                        future[r["date"]] = {"date": r["date"], "qt_forecast": r["crowd"], "hours": r["hours"], "event": r["event"]}
            except Exception as e:
                print(f"{park} future {y}-{m:02d}: failed ({e})", file=sys.stderr)
            time.sleep(2)
        if future:
            fpath = OUT_DIR / f"{park}_future.csv"
            with fpath.open("w", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=FUTURE_FIELDS)
                w.writeheader()
                for k in sorted(future):
                    w.writerow(future[k])
            log = OUT_DIR / "qt_forecast_log.csv"
            new = not log.exists()
            with log.open("a", newline="", encoding="utf-8") as f:
                w = csv.writer(f)
                if new:
                    w.writerow(["fetched_date", "park", "date", "qt_forecast"])
                for k in sorted(future):
                    w.writerow([today_s, park, k, future[k]["qt_forecast"]])
            print(f"{park}: {len(future)} future days -> {fpath.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
