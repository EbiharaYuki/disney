# 毎朝の点検の手順（スケジュール実行される Claude 用）

目的: 予想と実績のズレを見て原因を推測し、予想式に取り込んで、日に日に精度を上げる。
**変更は「採点で悪くならなかった時だけ」push する。** 迷ったら変更せず、調べた内容だけ記録する。

## 0. 準備

```bash
cd /home/user/disney 2>/dev/null || cd "$(git rev-parse --show-toplevel)"
git fetch origin claude/disney-crowd-simulator-4t59oq
git checkout claude/disney-crowd-simulator-4t59oq
git pull --rebase origin claude/disney-crowd-simulator-4t59oq
```

## 1. レポートを読む

- `data/loop/report.md`（毎晩・毎朝の自動処理が作る）を読む
- 「最近14日の大ハズレ」で **調査済み = 未** の日が対象（1回の点検で最大5件、ズレが大きい順）

## 2. 原因を調べる

対象の日ごとに、Web 検索で原因を探す。例:
- 「東京ディズニーランド 2026年11月10日 混雑」「ディズニーシー 11月15日 空いてる」
- 公式のお知らせ（臨時休止・運営時間変更・貸切・入園制限）、ニュース（天候・交通の乱れ・台風・地震）、ブログやXのまとめ
- `data/loop/report.md` の「状況」（天気・要因タグ・価格）も手がかりにする。予想が「後から計算」の日は、記録された予想がまだ無い日

分かったことは `data/loop/investigated.csv` に1行ずつ追記（原因が分からなくても「不明」として記録し、同じ日を何度も調べないようにする）:

```
date,park,actual,pred,error,category,cause,source,action
2026-11-10,tdl,24,63,-39,イベント,クリスマス開始前日で…（推測）,https://…,events.csvに追加
```

- category: 天気 / イベント / 営業 / 交通 / 価格 / 曜日・暦 / 不明 など
- cause は日本語で短く。推測なら「（推測）」と書く。カンマは使わない（読点「、」を使う）
- source は根拠のURL（無ければ空）

## 3. 予想式に取り込む（根拠があるときだけ）

- **日付が決まっている出来事**（臨時休止・貸切・グッズ発売・イベント期間など）→ `data/factors/events.csv` に出典つきで追加（書き方は `data/factors/README.md`）。**これからの日付**の出来事も見つけたら追加する
- **繰り返し起きそうなパターン**で、今の要因候補に無いもの → `site/model.js` の `FACTORS` に候補を1つ追加（`src: "点検"`）。効果があるかどうかは学習スクリプトが自動で判定するので、候補を足すだけでよい
- 1回の点検で追加する要因候補は2つまで。既存の要因の削除・採用ルール（`scripts/fit_model.js` の `ADOPT`・`SWITCH_MARGIN`）・ワークフロー・この手順書は変更しない

## 4. 採点して、悪くならなければ push

```bash
git stash            # 変更前の採点のため一時退避
bash scripts/loop_score.sh   # → before
git stash pop
bash scripts/loop_score.sh   # → after
```

- after の `backtest` が before より **0.05 以上悪化** したら、`site/model.js` の変更は元に戻す（events.csv と investigated.csv は残してよい）
- 判断がつかない、またはエラーが出たら、コードの変更は戻して記録だけ残す

## 5. 記録して push

`data/loop/journal.md` の先頭（見出しの下）に、その日の記録を追記:

```
## 2026-11-21
- 調べた日: ランド 11/10（−39）、…
- 推測した原因: …
- 変更: events.csv に〇件、要因候補「…」を追加 / 変更なし
- 採点: backtest 16.41 → 16.38
```

```bash
node scripts/loop_snapshot.js && node scripts/loop_evaluate.js > /dev/null
git add -A data/loop data/factors site
git commit -m "loop: daily review 2026-11-21"   # 日付はその日のものを直接書く（$(...) は使わない）
git pull --rebase origin claude/disney-crowd-simulator-4t59oq && git push origin claude/disney-crowd-simulator-4t59oq
```

- force push はしない。push が失敗したら `git pull --rebase origin claude/disney-crowd-simulator-4t59oq` してもう一度（3回まで）
- コマンドは1行ずつ実行する（`&&` でつなげたり `$(...)` を使ったりしない）。許可されているコマンドは `.claude/settings.json` を参照
- コミットメッセージにモデル名などは書かない
