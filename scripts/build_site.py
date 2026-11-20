"""site/ を GitHub Pages 用の _site/ に組み立てる。

site/index.html は claude.ai の Artifact でもそのまま公開できるよう
<html>/<head> を持たない本文だけのファイルなので、ここで文書の外枠を付ける。
"""

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "site"
OUT = ROOT / "_site"

HEAD = """<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}[hidden]{display:none!important}</style>
</head>
<body>
"""
TAIL = "\n</body>\n</html>\n"


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(SRC, OUT)
    body = (SRC / "index.html").read_text(encoding="utf-8")
    (OUT / "index.html").write_text(HEAD + body + TAIL, encoding="utf-8")
    (OUT / ".nojekyll").write_text("", encoding="utf-8")
    print("built", OUT)


if __name__ == "__main__":
    main()
