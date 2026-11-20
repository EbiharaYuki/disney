"""data/raw の CSV を日別サマリーにまとめて site/data/observed.json に書き出す。

日別の値:
  avg  ... 10:00〜19:59 (JST) の各取得時点で「運営中アトラクションの平均待ち時間」を出し、その平均 (分)
  peak ... 上の時点平均の最大値 (分)
  n    ... 集計に使った取得回数
"""

import csv
import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import mean

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
OUT = ROOT / "site" / "data" / "observed.json"
JST = timezone(timedelta(hours=9))
MIN_SAMPLES = 6  # これ未満の日は信頼できないので出さない


def summarize(park_dir: Path) -> dict:
    # fetched_at -> 運営中アトラクションの待ち時間リスト
    snapshots: dict[str, list[int]] = defaultdict(list)
    for path in sorted(park_dir.glob("*.csv")):
        with path.open(encoding="utf-8") as f:
            for row in csv.DictReader(f):
                hour = int(row["fetched_at_jst"][11:13])
                if not (10 <= hour < 20) or row["is_open"] != "1":
                    continue
                snapshots[row["fetched_at_jst"]].append(int(row["wait_time"]))

    by_day: dict[str, list[float]] = defaultdict(list)
    for ts, waits in snapshots.items():
        if waits:
            by_day[ts[:10]].append(mean(waits))

    return {
        day: {"avg": round(mean(v), 1), "peak": round(max(v), 1), "n": len(v)}
        for day, v in sorted(by_day.items())
        if len(v) >= MIN_SAMPLES
    }


def main() -> None:
    parks = {}
    for park in ("tdl", "tds"):
        d = RAW_DIR / park
        parks[park] = summarize(d) if d.exists() else {}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {"generated_at": datetime.now(JST).strftime("%Y-%m-%dT%H:%M"), "parks": parks},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    print({k: len(v) for k, v in parks.items()})


if __name__ == "__main__":
    main()
