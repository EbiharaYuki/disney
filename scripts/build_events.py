"""要因カレンダーを組み立てて site/data/events.json に書き出す。

入力:
  data/factors/events.csv   手入力の出来事（グッズ発売日・オープン日・イベント期間・時短営業など）
  data/history/{tdl,tds}.csv, {tdl,tds}_future.csv
      Queue-Times の記録と今後の公式カレンダー（イベント絵文字・営業時間）からイベント期間と時短営業を自動抽出

出力 (site/data/events.json):
  {"parks": {"tdl": {"tags": {"YYYY-MM-DD": ["event_first", ...]}, "periods": [...]}, "tds": {...}}}
"""

import csv
import json
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PARKS = ("tdl", "tds")
GAP_DAYS = 14  # GW などで記録が数日途切れても同じイベントとみなす
NORMAL_CLOSE = "20:00"  # これより早く閉まる日を時短営業とみなす
IGNORE = {"🔥", "🕙"}  # イベントではない印（暑さ・時間変更など）
NAMES = {
    "🎄": "ディズニー・クリスマス", "🎃": "ディズニー・ハロウィーン", "🌟": "ニューイヤー",
    "🧢": "夏のイベント", "🍭": "ディズニー・パルパルーザ（ヴァネロペ）", "🐭": "ディズニー・パルパルーザ（ミニー）",
    "🌱": "イッツ・ア・スモールワールド with グルート", "🦆": "ドナルドのイベント", "🐻": "ダッフィー＆フレンズのイベント",
    "🍷": "シーの春のイベント", "🎶": "シーの秋のイベント",
}

D = date.fromisoformat
iso = lambda d: d.isoformat()


def read_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as f:
        return list(csv.DictReader(f))


def derive_from_history(park: str):
    # 過去の実績 ＋ 今日以降の公式カレンダー（営業時間・イベント期間）
    rows = read_csv(ROOT / "data" / "history" / f"{park}.csv") + read_csv(ROOT / "data" / "history" / f"{park}_future.csv")
    rows.sort(key=lambda r: r["date"])
    last_day = rows[-1]["date"] if rows else ""
    by_emoji = defaultdict(list)
    short = []
    for r in rows:
        for e in set(r["event"]):
            if e not in IGNORE and e.strip():
                by_emoji[e].append(D(r["date"]))
        close = r["hours"].split("-")[-1] if r["hours"] else ""
        if close and close < NORMAL_CLOSE:
            short.append(r["date"])
    periods = []
    for e, days in by_emoji.items():
        days.sort()
        seg = [days[0], days[0]]
        for d in days[1:]:
            if (d - seg[1]).days <= GAP_DAYS:
                seg[1] = d
            else:
                periods.append((e, *seg))
                seg = [d, d]
        periods.append((e, *seg))
    out = []
    for e, s, t in periods:
        ongoing = iso(t) >= last_day  # まだ続いている → 終わりの日は不明
        out.append({"name": NAMES.get(e, e), "start": iso(s), "end": None if ongoing else iso(t), "source": "Queue-Times"})
    return out, short


def read_prices() -> dict[str, dict[str, int]]:
    """公式チケット価格（アーカイブ由来 → 手入力で上書き）。{park: {date: price}} と公式の時短営業日"""
    prices = {p: {} for p in PARKS}
    short = {p: set() for p in PARKS}
    for name in ("prices.csv", "prices_manual.csv"):
        for r in read_csv(ROOT / "data" / "official" / name):
            if r.get("park") in prices and r.get("price"):
                prices[r["park"]][r["date"]] = int(float(r["price"]))
            if r.get("park") in short and r.get("close") and r["close"].zfill(5) < NORMAL_CLOSE:
                short[r["park"]].add(r["date"])
    return prices, short


def main() -> None:
    manual = read_csv(ROOT / "data" / "factors" / "events.csv")
    prices, official_short = read_prices()
    result = {}
    shorts = {}
    for park in PARKS:
        periods, short = derive_from_history(park)
        shorts[park] = set(short) | official_short[park]
        result[park] = {"periods": periods, "tags": defaultdict(set), "items": []}

    for r in manual:
        parks = PARKS if r["park"] == "both" else (r["park"],)
        for park in parks:
            if park not in result:
                continue
            item = {"type": r["type"], "name": r["name"], "start": r["start"], "end": r["end"] or r["start"], "source": r["source"]}
            result[park]["items"].append(item)
            if r["type"] == "event":
                # 手入力の期間が自動抽出の期間と重なれば、手入力を優先（終わりの日が分かるので）
                ps = result[park]["periods"]
                ps[:] = [p for p in ps if not (p["start"] <= item["end"] and (p["end"] or "9999") >= item["start"])]
                ps.append({"name": item["name"], "start": item["start"], "end": item["end"], "source": item["source"]})
            elif r["type"] == "short":
                d = D(item["start"])
                while d <= D(item["end"]):
                    shorts[park].add(iso(d))
                    d += timedelta(days=1)

    for park in PARKS:
        tags = result[park]["tags"]

        def tag_range(start: date, days: int, name: str):
            for i in range(days):
                tags[iso(start + timedelta(days=i))].add(name)

        for p in result[park]["periods"]:
            s = D(p["start"])
            tags[iso(s - timedelta(days=1))].add("event_eve")
            tag_range(s, 7, "event_first")
            if p["end"]:
                tag_range(D(p["end"]) - timedelta(days=6), 7, "event_last")
        for it in result[park]["items"]:
            s = D(it["start"])
            if it["type"] == "merch":
                tag_range(s, (D(it["end"]) - s).days + 1, "merch")
            elif it["type"] == "open":
                tag_range(s, 7, "open")
            elif it["type"] == "show":
                tag_range(s, 3, "show")
        for d in shorts[park]:
            tags[d].add("short")
        other = "tds" if park == "tdl" else "tdl"
        for d in shorts[other]:
            tags[d].add("other_short")

    out = {"parks": {}}
    for park in PARKS:
        r = result[park]
        out["parks"][park] = {
            "tags": {d: sorted(v) for d, v in sorted(r["tags"].items())},
            "periods": sorted(r["periods"], key=lambda p: p["start"]),
            "items": sorted(r["items"], key=lambda p: p["start"]),
            "prices": dict(sorted(prices[park].items())),
        }
    path = ROOT / "site" / "data" / "events.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    for park in PARKS:
        counts = defaultdict(int)
        for v in out["parks"][park]["tags"].values():
            for t in v:
                counts[t] += 1
        print(park, len(out["parks"][park]["periods"]), "periods", len(out["parks"][park]["prices"]), "prices", dict(counts))


if __name__ == "__main__":
    main()
