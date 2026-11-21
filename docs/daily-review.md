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

## 2. 原因を調べる（証拠のはしご）

思いつきで検索する前に、**確かな証拠から順に**調べる。上の段で説明がつけば、下の段は裏取りだけでよい。

1. **レポートの「手がかり」を読む**（`data/loop/report.md`。自動で分かること）
   - 両パークが同じ向きに外れた → パーク共通の原因（天気・暦・交通・世の中の出来事）
   - 片方だけ外れた → そのパークだけの原因（休止・貸切・時短・イベント・グッズ）
   - 何日も同じ向きに外れている → 個別の原因ではなく、時期全体の水準のズレ（調べるのは「この時期なぜ」）
   - 同じ日付の過去の年も似ている → 毎年の暦の要因
2. **天気を時間ごとに見る**（`data/weather/maihama.csv`）。来園するかは朝に決まるので、**いつ降ったか**が大事
   - 開園前（0〜9時）の雨 `pre_mm`、午前の雨 `am_hours`、強風 `gust`、前日の雨、前日の予報とのズレ（手がかり欄に出る）
3. **計測そのものを疑う**。混雑度は Queue-Times がアトラクションの待ち時間から計算した指標
   - 人気アトラクションの休止・システム調整で待ち時間が出ない日は、人が多くても低く出る
   - グリーティングやショーに人が集まる日（キャラクターの誕生日など）は、待ち時間に表れにくい
   - 自前の計測（`data/raw/`、`site/data/observed.json`）がある日は、運営中のアトラクション数や平均待ちと見比べる
4. **公式情報**: 運営時間・休止情報・イベント・グッズ発売・チケット販売状況（公式サイトは自動取得できないので Web 検索の結果から）
5. **ネット・ブログ・SNS**: 「東京ディズニーランド 11月18日 混雑」「ディズニー 11/18 空いてる」「ディズニー 入園制限」「京葉線 遅延 11月18日」など。
   混雑予想サイトの事前予想（「空く」と書かれた日に人が集まる、またはその逆）、ニュース（台風・地震・交通の乱れ）、ブログやXのまとめ、現地レポ
6. **仮説を全期間で確かめる**（ここが一番大事）。「〇〇の日は空く」と思ったら、必ず検証ツールで過去の全データに当てる:

   ```bash
   node scripts/loop_probe.js "wx && wx.pre >= 2 && wx.h === 0"
   ```

   - 条件式の書き方は `scripts/loop_probe.js` の先頭にある
   - 該当8日以上・|t| が 2 以上 → 繰り返すパターン。3. の手順で予想式の候補にする
   - はっきりしない → 「その日だけの事情」または「データ不足」として記録するだけ。**予想式には入れない**

分かったことは `data/loop/investigated.csv` に1行ずつ追記（原因が分からなくても「不明」として記録し、同じ日を何度も調べないようにする）:

```
date,park,actual,pred,error,category,cause,source,action
2026-11-18,tdl,26,53,-27,天気,夜中〜朝6時に22mmの雨（推測）、開園前の雨は全期間で−9ポイント,https://open-meteo.com/,予想式に追加
```

- category: 天気 / イベント / 営業 / 交通 / 価格 / 曜日・暦 / 計測 / 水準のズレ / 不明 など
- cause は日本語で短く。推測なら「（推測）」と書く。**検証ツールの結果（該当日数・効果）も書く**。カンマは使わない（読点「、」を使う）
- source は根拠のURL（無ければ空）
- 説明がつかなかった分は正直に「残り〇ポイントは不明」と書く

## 3. 予想式に取り込む（根拠があるときだけ）

- **日付が決まっている出来事**（臨時休止・貸切・グッズ発売・イベント期間など）→ `data/factors/events.csv` に出典つきで追加（書き方は `data/factors/README.md`）。**これからの日付**の出来事も見つけたら追加する
- **グッズの情報は毎回集める**（大ハズレが無い日も）。Web 検索で、直近と今後のグッズ発売日・再入荷（再販）・売り切れを探し、`events.csv` に `merch` / `restock` / `soldout` として出典つきで追加する。過去の発売日（2023年〜）も、見つかった分を1回の点検で5件まで追加してよい。日付があいまいなものは入れない
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
