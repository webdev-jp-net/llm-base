# llm-base

Claude Codeのエージェント運用ルールと制御機構の基盤。技術スタックに依存しない。

## 構成

| 置き場                    | 役割                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `CLAUDE.md` / `AGENTS.md` | エージェントのエントリーポイント                                                             |
| `_llm-rules/`             | 運用ルール（コアルール・GitHub連携・実装原則・自己改善）                                     |
| `_llm-docs/`              | プロジェクトの仕様書。`project.md` と `operation/dictionary.md` はセッション開始時の必読対象 |
| `_llm-memories/`          | 実行記録。実体は追跡せず、`templates/` だけをバージョン管理する                              |
| `.claude/hooks/`          | 必読ファイルの読了判定（read-gate）とMarkdownの整形・見出し検査                              |
| `.claude/skills/`         | Issue起票・レビュー・リリース・ブランチ後始末などの手順書                                    |
| `.claude/commands/`       | スラッシュコマンド                                                                           |

## 前提

必須のもの。

- **Claude Code** — このリポジトリ全体がその設定
- **Git**
- **bun** — hookの実行に使う
- **jq** — `.claude/settings.json` 内のhookが使う
- **Node.jsとpnpm** — textlint / prettier / tscの実行に使う

該当するスキルを使うときに必要になるもの。

- **GitHub CLI（`gh`）** — Issue・PR・リリースを扱うスキル
- **Codex CLI（`codex`）** — `code-review` / `doc-review`。`_llm-rules/self_improvement.md` は重要な成果物の検証をこれらに委ねているため、実質必須
- **uv（`uvx`）** — `.mcp.json` のSerena

`release` スキルはバージョンを `package.json` で管理する前提で書かれている。それ以外の言語・
ツールチェーンで使う場合は、バージョンの取得元と更新対象をプロジェクトに合わせて読み替える。

`.mcp.json` に定義したMCPサーバーは初回に承認が必要になる。SerenaとPlaywrightはネットワークから取得される。

## 導入

```bash
pnpm install --frozen-lockfile
```

- `_llm-docs/project.md` と `_llm-docs/operation/dictionary.md` を自分のプロジェクトの内容に書き換える
- `_llm-memories/templates/` の3ファイルを `_llm-memories/` 直下へコピーする（記録が1つも無い状態では、read-gateが `_llm-memories/` 配下の作成だけを通す）

## 検査

```bash
pnpm run test:hooks
pnpm run typecheck
pnpm run format
```

## read-gateについて

`.claude/hooks/read-gate.ts` は、`_llm-rules/` 配下のすべての `.md`、`_llm-docs/project.md`、`_llm-docs/operation/dictionary.md`、`_llm-memories/` 直下の記録を読み終えるまで、ファイルの変更操作を拒否する。必読の対象が見つからない場合も拒否する（fail-closed）。

必読の一覧は次のコマンドで確認できる。

```bash
bun run .claude/hooks/read-gate.ts --list
```
