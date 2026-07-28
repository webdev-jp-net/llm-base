---
name: plan-execute
description: Issueへの着手スキル。「{IssueNumber}のIssueに着手します」などユーザーがIssue番号を提示して作業開始を宣言したときに使用。Issueを参照してタスクを開始する前に、ブランチ確認・作成を行う。
argument-hint: [issue-number]
---

# Issueへの着手

`$ARGUMENTS` で指定されたIssue番号を受け取り、作業開始前のブランチ確認・作成を行う。

## ワークフロー

### Step 1: 現在の状況確認

```bash
git branch --show-current
git status
```

### Step 2: IssueのタスクをReadする

```bash
gh issue view [Issue番号]
```

取得したIssueのtitleとbodyからやるべきことを読み込み、タスクを把握する。

### Step 3: ブランチ判定と対応

- **現在のブランチ名に `#[Issue番号]` が含まれる場合**: そのまま継続使用可能。Step 5へスキップ
- **上記以外の場合（`develop`・`main`・別Issueのブランチ）**: 対象Issue番号に対応する既存ブランチを探す

```bash
git branch --all | grep "#[Issue番号]"
```

- **既存ブランチが見つかった場合**: そのブランチへチェックアウトしてStep 5へスキップ

```bash
git checkout [見つかったブランチ名]
```

- **見つからない場合**: Step 4へ進み新規ブランチを作成する

### Step 4: 新規ブランチ作成

下記「ブランチ命名規則」に従いブランチ名を決定し、ユーザーに提案して承認を得てから作成する。
`gh issue develop` を使うのは、ブランチ名にIssue番号を含めるだけではIssueのDevelopmentセクションへ
登録されないため（`_llm-rules/github_integration.md`）。このコマンドはリモートにもブランチを作る。

```bash
gh issue develop [Issue番号] --name "feature/[英語概要]#[Issue番号]" --base develop --checkout
```

### Step 5: 作業開始前の最終確認

```bash
git branch --show-current
git status
```

確認結果をユーザーに提示する。

- **作業ブランチ**: 〈現在のブランチ名〉
- **状態**: 〈クリーン / 未コミットの変更あり〉

---

## ブランチ命名規則

### フォーマット

```
feature/[概要]#[Issue番号]
```

### 必須事項

- **英数字のみ使用**：日本語（2バイト文字）は一切使用禁止
- **ハイフン（-）区切り**：単語間はハイフンで区切る
- **小文字使用**：すべて小文字で記述
- **簡潔な英語表記**：概要部分は5単語以内

### 禁止事項

- 日本語文字の使用（ひらがな、カタカナ、漢字）
- スペースの使用

### 命名例

| 正しい例                  | 誤った例                                   |
| ------------------------- | ------------------------------------------ |
| `feature/initial-setup#1` | `feature/初期セットアップ-#1` — 日本語使用 |
| `feature/user-auth#15`    | `feature/api docs-#23` — スペース使用      |
| `feature/api-docs#23`     |                                            |

### ブランチ命名チェック

ブランチ名を確定する前に以下を確認する：

1. 日本語文字が含まれていないか
2. 命名規約にしたがっているか
3. Issue番号が正しく含まれているか

規約違反が検出された場合は即座に英語版に変換して提案する。
