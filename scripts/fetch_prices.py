"""公式サイトのチケットカレンダー（1デーパスポートの大人料金・営業時間）を、
インターネットアーカイブ (Wayback Machine) に保存されたページから集める。

公式サイトは自動アクセスを拒否しているため、直接は取りに行かない。
アーカイブのページには日付ごとの JSON が埋め込まれていて、1ページにランドとシーの両方が入っている。

出力: data/official/prices.csv
  date, park, price (大人1デーパスポート, 円), open, close, captured (アーカイブの保存日時)
同じ日付が複数のページにある場合は、いちばん新しく保存されたものを使う。

手入力の価格（公式サイトのスクショから書き写したものなど）は data/official/prices_manual.csv に書くと、こちらが優先される。
GitHub Actions から実行する想定（この作業環境からは web.archive.org に届かないため）。
"""

import csv
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "official" / "prices.csv"
DONE = ROOT / "data" / "official" / "captures_done.txt"
PATTERNS = ["ticket/index", "tdl/ticket/index", "tds/ticket/index", "en/ticket/index", "en/tdl/ticket/index", "en/tds/ticket/index"]
FROM_MONTH = "202301"
FIELDS = ["date", "park", "price", "open", "close", "captured"]
UA = {"User-Agent": "tdr-crowd-simulator/1.0 (personal, non-commercial research)"}

CHUNK_RE = re.compile(r'"(tdl|tds)":\{"date":(\d{8}),"openTime":\{"open":"([^"]*)","close":"([^"]*)"\}')
PRICE_RE = re.compile(r'"ageText":"[^"]*?(?:大人|Adult)[^"0-9]*?([0-9]{1,2},[0-9]{3})')


def get(url: str, tries: int = 4) -> str:
    for i in range(tries):
        try:
            with urlopen(Request(url, headers=UA), timeout=90) as res:
                return res.read().decode("utf-8", errors="replace")
        except Exception as e:
            if i == tries - 1:
                raise
            time.sleep(10 * (i + 1))
    return ""


def list_captures() -> list[tuple[str, str]]:
    """[(timestamp, original_url)]。月ごと・内容ごとに重複を除いた保存ページの一覧"""
    caps = []
    for pat in PATTERNS:
        url = ("https://web.archive.org/cdx/search/cdx?url=" + quote(f"tokyodisneyresort.jp/{pat}/*")
               + "&filter=statuscode:200&collapse=digest&fl=timestamp,original")
        try:
            text = get(url)
        except Exception as e:
            print(f"cdx {pat}: failed ({e})", file=sys.stderr)
            continue
        for line in text.splitlines():
            parts = line.split(" ")
            if len(parts) != 2:
                continue
            ts, orig = parts
            m = re.search(r"/(20\d{4})/?$", orig.split("?")[0])
            if m and m.group(1) >= FROM_MONTH:
                caps.append((ts, orig))
        print(f"cdx {pat}: {len(caps)} captures so far")
        time.sleep(3)
    return sorted(set(caps))


def parse(page: str):
    text = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), page)
    starts = [(m.start(), m.groups()) for m in CHUNK_RE.finditer(text)]
    for i, (pos, (park, ymd, op, cl)) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else pos + 4000
        price = PRICE_RE.search(text, pos, end)
        yield {
            "date": f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:]}",
            "park": park,
            "price": int(price.group(1).replace(",", "")) if price else "",
            "open": op, "close": cl,
        }


def main() -> int:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    rows: dict[tuple[str, str], dict] = {}
    if OUT.exists():
        with OUT.open(encoding="utf-8") as f:
            rows = {(r["date"], r["park"]): r for r in csv.DictReader(f)}
    done = set(DONE.read_text().split()) if DONE.exists() else set()

    caps = [c for c in list_captures() if f"{c[0]}|{c[1]}" not in done]
    print(f"{len(caps)} new captures to read")
    for ts, orig in caps:
        try:
            page = get(f"https://web.archive.org/web/{ts}id_/{orig}")
        except Exception as e:
            print(f"{ts} {orig}: failed ({e})", file=sys.stderr)
            time.sleep(5)
            continue
        n = 0
        for r in parse(page):
            if r["price"] == "":
                continue
            k = (r["date"], r["park"])
            if k not in rows or rows[k]["captured"] <= ts:
                rows[k] = {**r, "captured": ts}
                n += 1
        done.add(f"{ts}|{orig}")
        print(f"{ts} {orig.split('tokyodisneyresort.jp/')[-1]}: {n} dates")
        time.sleep(2)

    with OUT.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        for k in sorted(rows):
            w.writerow({fld: rows[k][fld] for fld in FIELDS})
    DONE.write_text("\n".join(sorted(done)) + "\n")
    print(f"prices: {len(rows)} park-days")
    return 0


if __name__ == "__main__":
    sys.exit(main())
