---
name: code-review
description: |
  Codex CLIを使用してコードをレビューするユーティリティ。
  他のスキルから呼び出して使う。ユーザーから直接呼び出すことも可。
  $ARGUMENTSにレビュー対象（ファイルパス、内容の説明など）を渡す。
argument-hint: [review-target]
---

# コードレビューユーティリティ

Codex CLIを使用してコードをレビューし、結果を返す。

## 実行コマンド

リクエストは引数ではなく標準入力から渡す。レビュー対象にはバッククォートや `$()` が含まれるため、
シェルの二重引用符に埋め込むと外側のシェルが展開してしまう。

```bash
codex exec --full-auto --sandbox read-only --cd <project_directory> < <request_file>
```

## プロンプトのルール

**重要**: codexに渡すリクエストには、以下の指示を必ず含めること：

> 「確認や質問は不要です。具体的な指摘・修正案・コード例まで自主的に出力してください。」

## ワークフロー

### Step 1: レビュー対象の特定

`$ARGUMENTS`からレビュー対象を特定する：

- ファイルパスや内容の説明が指定されている場合 → それを対象にする
- 指定なしの場合 → `git rev-parse --verify HEAD` でコミットの有無を確かめ、あれば `git diff HEAD` の差分、無ければ `git status --short --untracked-files=all` が挙げた未追跡ファイルの内容を対象にする

### Step 2: リクエストをファイルに書く

Writeツールで `.claude/tmp/review-request.md` に次の内容を書く。対象の中身もここに含める。

```markdown
まず _llm-rules/implementation_principles.md を読み込み、そこに定義された実装原則を理解してください。
その原則を基準として、以下を対象にレビューを行ってください。

対象: {$ARGUMENTS の内容 または Step 1 で取得した差分・ファイル内容}

確認や質問は不要です。具体的な指摘・修正案・コード例まで自主的に出力してください。
```

### Step 3: Codex CLIでレビュー実行

出力は全文をファイルへ保存する。`head` / `tail` で切ると読むべき指摘が消えたことに気づけない。

```bash
codex exec --full-auto --sandbox read-only --cd <project_directory> \
  < .claude/tmp/review-request.md > .claude/tmp/review-result.txt 2>&1
```

### Step 4: 結果を返す

Codexの出力を呼び出し元（ユーザーまたは他のスキル）に返す。
