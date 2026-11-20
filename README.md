# パーク空き日カレンダー

東京ディズニーランド／シーの「空いてそうな日」を予想する非公式シミュレータです。
iPhone のブラウザで見られる 1 ページのアプリと、待ち時間を自動で集める仕組みでできています。

## しくみ

| 部分 | ファイル | 内容 |
| --- | --- | --- |
| データ収集 | `.github/workflows/collect.yml` → `scripts/collect.py` | JST 8:00〜21:45 に 15 分おき、Queue-Times.com の API から待ち時間を取得して `data/raw/{tdl,tds}/YYYY-MM.csv` に追記 |
| 日別集計 | `scripts/build_stats.py` | 10〜20 時の平均待ち・ピークを日別にまとめて `site/data/observed.json` に出力 |
| 画面 | `site/index.html` | カレンダー・混雑指数・狙い目 TOP5。実測データがあれば表示 |
| 公開 | `.github/workflows/pages.yml` → `scripts/build_site.py` | GitHub Pages に公開（push 時と毎日 JST 22:30） |

## 予想モデル（v1）

| 部分 | ファイル | 内容 |
| --- | --- | --- |
| 過去の実績 | `scripts/fetch_history.py` → `data/history/{tdl,tds}.csv` | Queue-Times の混雑カレンダーから 2023年1月以降の日別混雑度（0〜100%）を取得（2秒間隔） |
| 学習・検証 | `scripts/fit_model.js` → `site/data/model.json` | 線形回帰（リッジ）で各要因の係数を推定。2025年までで学習 → 2026年を予想して精度を測定 |
| モデル本体 | `site/model.js` | 特徴量と予想式。ページと学習スクリプトで共通 |

特徴量：月、曜日の種類（休日で翌日も休み／休日で翌日は平日／休みの前日／平日の月・火・水・木）、
連休の中日・最終日、季節の期間（年末年始・春休み・GW・夏休み・お盆・ハロウィン/クリスマス期間の目安）、年。

### 精度（2026-11-20 時点、2026/1/1〜11/19 を 2025 年までのデータで予想）

| | ランド | シー |
| --- | --- | --- |
| 平均のズレ | ±19.8pt | ±20.0pt |
| 比較：月＋曜日の平均だけ | ±19.9pt | ±22.4pt |
| 5段階で±1段階以内 | 68% | 59% |
| 「空き」予想の的中率（偶然なら約40%） | 55% | 49% |

日付だけでは天気・チケット販売・イベントの影響を読めないため、日ごとのブレは大きいです。候補日を比べる目安として使ってください。

## はじめに一度だけやること

1. リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にする
2. **Actions** タブで「Deploy site」と「Collect wait times」を **Run workflow** で一度手動実行する

定期実行（cron）は**デフォルトブランチ**でしか動かないので、このブランチがデフォルトでない場合はマージが必要です。

## クレジット

待ち時間データ: [Powered by Queue-Times.com](https://queue-times.com/)

この予想は公式のものではありません。イベント期間・休園日・チケット販売状況は公式サイトで確認してください。
