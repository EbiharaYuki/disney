#!/usr/bin/env bash
# 予想式の採点。変更の前と後に実行して、悪くなっていないかを確かめる（毎朝の点検で使用）。
# 出力: {"backtest": 1か月ずつ予想し直すテストの平均ズレ, "test_tdl": 2026年の答え合わせ(ランド), "test_tds": 同(シー)}
set -euo pipefail
cd "$(dirname "$0")/.."
python3 scripts/build_events.py > /dev/null
node scripts/fit_model.js > /dev/null
node -e 'const m=require("./site/data/model.json");console.log(JSON.stringify({backtest:m.loop.backtest.avg,test_tdl:m.parks.tdl.validationWeather.mae,test_tds:m.parks.tds.validationWeather.mae}))'
