"""Queue-Times.com から東京ディズニーリゾートの待ち時間を取得して CSV に追記する。

GitHub Actions から定期実行される想定。標準ライブラリのみ使用。
データ提供: Powered by Queue-Times.com (https://queue-times.com/)
"""

import csv
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.request import Request, urlopen

PARKS = {"tdl": 274, "tds": 275}
JST = timezone(timedelta(hours=9))
ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
HEADER = ["fetched_at_jst", "ride_id", "wait_time", "is_open", "last_updated_utc"]


def fetch(park_id: int) -> dict:
    url = f"https://queue-times.com/parks/{park_id}/queue_times.json"
    req = Request(url, headers={"User-Agent": "tdr-crowd-simulator/1.0 (GitHub Actions)"})
    with urlopen(req, timeout=30) as res:
        return json.load(res)


def iter_rides(data: dict):
    for land in data.get("lands", []):
        for ride in land.get("rides", []):
            yield land.get("name", ""), ride
    for ride in data.get("rides", []):
        yield "", ride


def save(park: str, data: dict, now: datetime) -> int:
    out = RAW_DIR / park / f"{now:%Y-%m}.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    is_new = not out.exists()

    meta_path = RAW_DIR / park / "rides.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}

    rows = 0
    with out.open("a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if is_new:
            writer.writerow(HEADER)
        for land, ride in iter_rides(data):
            rid = str(ride["id"])
            meta[rid] = {"name": ride.get("name", ""), "land": land}
            writer.writerow([
                now.strftime("%Y-%m-%dT%H:%M"),
                rid,
                int(ride.get("wait_time") or 0),
                1 if ride.get("is_open") else 0,
                ride.get("last_updated", ""),
            ])
            rows += 1

    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
    return rows


def main() -> int:
    now = datetime.now(JST)
    ok = 0
    for park, park_id in PARKS.items():
        try:
            rows = save(park, fetch(park_id), now)
            print(f"{park}: {rows} rides saved")
            ok += 1
        except Exception as e:  # 片方のパークが失敗してももう片方は保存する
            print(f"{park}: failed ({e})", file=sys.stderr)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
