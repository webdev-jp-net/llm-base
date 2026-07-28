---
name: gh-issue
description: GitHub Issueを現在のリポジトリに作成する。使用場面：(1) バグ報告 - 「このバグのIssueを作って」「不具合を起票して」、(2) 機能リクエスト - 「機能リクエストのIssue立てて」「この機能をIssueにして」、(3) タスク作成 - 「今の作業からIssue作成して」「タスクをIssueにして」。トリガー例：「Issueを作って」「Issue立てて」「Issue作成して」「起票して」
disable-model-invocation: true
argument-hint: [document-path]
---

# GitHub Issue作成

`$ARGUMENTS` で指定された仕様書・ドキュメントをもとにGitHub Issueを作成する。

## ワークフロー

### Step 1: 与件ドキュメントの読み込み

`$ARGUMENTS` で受け取ったパスのドキュメントをReadツールで読み込む。
パスが指定されていない場合はユーザーに確認する。

### Step 2: タイトルと本文の作成

ドキュメントの内容からIssueのタイトルと本文を構成する。
不明点・解釈が必要な箇所はユーザーに確認する。

### Step 3: 内容の確認

作成前に以下の内容をユーザーに提示し、承認を得る。修正依頼があれば対応してから次のステップへ進む。

- **タイトル**: 〈作成したタイトル〉
- **本文**: 〈作成した本文〉

### Step 4: Issueの作成

承認後、本文をWriteツールで `.claude/tmp/issue-body.md` に書き、ファイルとして渡す。
本文にはバッククォートや `$()` が含まれるため、シェルの文字列に埋め込むと外側のシェルが展開してしまう。

```bash
gh issue create --title "タイトル" --body-file .claude/tmp/issue-body.md
```

### Step 5: 作成確認

作成されたIssueのURLをユーザーに提示する。
