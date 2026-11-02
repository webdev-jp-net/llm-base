---
name: release
description: |
  リリースフローを実行するスキル。「リリースして」「リリース準備して」「v1.4.0を出したい」
  「リリースノートを作って」などのリクエストで使用。
  リポジトリの状態から「準備フェーズ」と「発行フェーズ」を自動判定して実行する。
---

# リリーススキル

package.jsonのバージョン更新 → リリースブランチ作成 → main向けPR作成 →（ユーザーのマージ後）
リリースノート発行 → developへのback-merge、までを一貫して行う。

## フェーズ判定（起動時に必ず実行）

`--head` はブランチ名の完全一致でしか絞り込めない。リリースブランチは一覧を取得してから
`release/` で始まるものを選ぶ。タグは `v` 付き、package.jsonのversionは `v` なしなので、
比較の前に `v` を落として揃える。

```bash
git fetch origin
# openなback-merge PR
gh pr list --base develop --head main --state open --json number
# openなリリースPR（--limit は jq の絞り込みより先に効くので、取得件数を明示する）
gh pr list --base main --state open --limit 100 --json number,headRefName \
  --jq '[.[] | select(.headRefName | startswith("release/"))]'
# 直近のマージ済みリリースPR（mergedAt の降順で並べ替えてから先頭を取る）
gh pr list --base main --state merged --limit 100 --json number,headRefName,mergedAt \
  --jq '[.[] | select(.headRefName | startswith("release/"))] | sort_by(.mergedAt) | last'
# 最新タグ（v を落として比較に使う）
git tag | sed 's/^v//' | sort -V | tail -1
# main と develop の version
git show origin/main:package.json | grep '"version"'
git show origin/develop:package.json | grep '"version"'
```

上から順に判定し、**最初に該当したもので確定する**（複数の条件が同時に成立しうるため、順序が判定の一部）。

- **openなback-merge PRがある** → マージを待ち、マージ後にStep 7の検証から再開する
- **openなリリースPRがある** → ユーザーに状況を報告し、マージを待つか確認する
- **マージ済みリリースPRがあり、そのバージョンのタグが未作成** → フェーズ2（リリース発行）。ここで得たPR番号とバージョンをStep 5以降へ引き継ぐ
- **mainのversionがdevelopより新しい** → back-merge漏れ。Step 7から実行する（developが新しいのはリリース前の通常状態なので該当しない）
- **上記以外** → フェーズ1（リリース準備）。タグもリリースPRの履歴も無い場合は初回リリースとして扱う

---

## フェーズ1: リリース準備

### Step 1: 変更内容の収集

前回タグ以降にdevelopへ入った変更を収集する。

```bash
git log $(git tag | sort -V | tail -1)..origin/develop --oneline --merges
gh pr list --base develop --state merged --json number,title,mergedAt --limit 30
```

タグが1つも無い場合は、範囲を指定せず `git log origin/develop --oneline --merges` で全件を対象にする。

前回タグ以降にマージされたPRのみを対象に絞り込む。

### Step 2: バージョン番号の提案と承認

変更一覧を以下の基準で分類し、推奨バンプと根拠を提示して**ユーザーの承認を得る**。
機械的に確定しない（最終判断はユーザーの裁量。機能追加をpatchで出す判断もあり得る）。

| 種別              | 基準                                                   | 例                                                    |
| ----------------- | ------------------------------------------------------ | ----------------------------------------------------- |
| メジャー（X.0.0） | 過去の利用結果との互換性が壊れる／体験が根本的に変わる | 保存済みデータや共有URLの非互換変更、全面リニューアル |
| マイナー（x.Y.0） | 互換性を保った機能追加・画面追加                       | 新機能の追加、新しい表示モードの追加                  |
| パッチ（x.y.Z）   | 機能追加を伴わない修正・調整                           | バグ修正、文言・スタイル微調整、依存更新              |

提示フォーマット:

- **前回リリース**: v〈前回バージョン〉
- **今回の変更**: 〈PR/Issueの一覧〉
- **推奨**: 〈minor/patch/major〉 → v〈新バージョン〉（根拠を1行）

### Step 3: リリースブランチ作成とバージョン更新

承認された番号で実行する。

```bash
git checkout develop && git pull --ff-only
git checkout -b release/v[新バージョン]
# package.jsonの"version"を更新（それ以外は変更しない）
git add package.json
git commit -m "Update: [マイナー/パッチ/メジャー]バージョンアップ"
git push -u origin release/v[新バージョン]
```

### Step 4: main向けPR作成

以下のフォーマットで作成内容をユーザーに提示し、**承認後に**作成する。

- タイトル: `Release: v[新バージョン]`
- base: `main` / head: `release/v[新バージョン]`
- 本文:

  ```markdown
  ## v[新バージョン]

  - #[Issue番号] [変更概要]
  - #[Issue番号] [変更概要]
  ```

PR作成後、URLを提示して「マージされたら再度このスキルを起動してください」と案内し、フェーズ1を終了する。

---

## フェーズ2: リリース発行

### Step 5: マージ確認

フェーズ判定で引き継いだPR番号を使う。改めて最新のマージ済みPRを取り直さない（リリースPR以外を拾う）。

```bash
gh pr view [引き継いだPR番号] --json number,headRefName,mergedAt,mergeCommit
```

リリースPRのマージを確認する。未マージなら報告して終了。

### Step 6: リリースノート作成と発行

変更内容（Step 1と同じ収集方法）をもとに、**利用者向けの日本語の平文**でノート原稿を作成する。

- 過去のリリースノートがあれば、その文体に合わせる
- 利用者から見て何がどう変わり、何が良くなるのかを書く（「〈何を〉〈どうした〉ので、〈どう良くなる〉」の形）
- コミット一覧やPR番号の羅列にしない
- 開発者向けの内部変更（リファクタリング等）は利用者に影響がなければ書かない

原稿をユーザーに提示し、**承認後に**発行する。承認済みノートはWriteツールで
`.claude/tmp/release-notes.md`（`mkdir -p .claude/tmp` で置き場を用意）に書き、ファイルとして渡す。
ノートにはバッククォートや `$()` が含まれるため、シェルの文字列に埋め込むと外側のシェルが展開してしまう。

```bash
gh release create v[新バージョン] --target main --title "v[新バージョン]" \
  --notes-file .claude/tmp/release-notes.md
```

### Step 7: developへのback-merge（必須・省略不可）

bumpコミットをdevelopへ反映する。この検証まで完了してリリース完了とする。
**developへ直接pushしない**（変更は必ずPR経由。ブランチ運用ルールに従う）。

以下の内容をユーザーに提示し、**承認後に**back-merge PRを作成する。

- タイトル: `Back-merge: v[新バージョン]`
- base: `develop` / head: `main`

ユーザーのマージ後、developとmainでpackage.jsonのversionが一致することを検証する。

```bash
git fetch origin
git show origin/main:package.json | grep '"version"'
git show origin/develop:package.json | grep '"version"'
```

### Step 8: 後始末

ローカルのリリースブランチ削除をユーザーに確認してから実行する。

```bash
git branch -d release/v[新バージョン]
```

完了報告: バージョン / PR / Release URL / back-merge検証結果を提示する。

---

## 注意事項

- バージョン番号の確定、PR作成、リリース発行、push、ブランチ削除は**必ずユーザーの承認を得てから**実行する
- developへ直接pushしない。back-merge（Step 7）もPR経由で行う
- package.jsonのversion以外のファイルをbumpコミットに含めない
- フェーズ2を実行せずに放置するとdevelopとmainのversionが不一致のままになる。フェーズ判定で検知した場合は必ず案内する
