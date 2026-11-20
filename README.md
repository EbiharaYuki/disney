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

## 予想モデル（v0）

`月の土台 × 曜日の係数 × 期間補正` で 0〜100 の混雑指数を出します。

- 曜日は「休日で翌日も休み（土曜型）」「休日で翌日は平日（日曜型）」「休みの前日（金曜型）」「平日」に分類
- 祝日（振替休日・国民の休日を含む）と年末年始を考慮
- 春休み・GW・夏休み・お盆・年末年始・ハロウィン/クリスマス期間（目安）で補正

土台の数値は公開統計（7・9 月が空き、11 月が最も混む、火曜が空き、土曜が混む）に合わせた仮の値です。
収集データが貯まったら、実測から係数を推定して置き換える予定です。

## はじめに一度だけやること

1. リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にする
2. **Actions** タブで「Deploy site」と「Collect wait times」を **Run workflow** で一度手動実行する

定期実行（cron）は**デフォルトブランチ**でしか動かないので、このブランチがデフォルトでない場合はマージが必要です。

## クレジット

待ち時間データ: [Powered by Queue-Times.com](https://queue-times.com/)

この予想は公式のものではありません。イベント期間・休園日・チケット販売状況は公式サイトで確認してください。
