# STATE.md — セッション実行状態

> このファイルは「いま何がどこまで進んでいるか」の唯一の記録場所。
> 運用ルールは `_llm-rules/self_improvement.md` を参照。
> セッション開始時に必ず読み、フェーズ完了ごとに必ず更新する。

## メタデータ

- **Session ID**: （このチャットセッション。IDなし）
- **開始時刻**:
- **最終更新**:
- **ステータス**: idle <!-- idle / in_progress / blocked / completed -->
- **現在フェーズ**:

## タスク概要

```yaml
goal: ''
issue: ''
branch: ''
deadline: ''
```

## フェーズ進捗

- [ ] phase_1:

## 現在の作業状態

```yaml
current_step: ''
progress: 0%
completed_items: []
pending_items: []
errors_encountered: []
retry_count: 0
```

## チェックポイント

```yaml
last_checkpoint: ''
checkpoint_data:
  next_action: ''
  artifacts: []
```

## 検証結果ログ

| 日時 | 対象 | 検証者 | 判定 | スコア/指摘 | 再試行 |
| ---- | ---- | ------ | ---- | ----------- | ------ |

## 引き継ぎメモ
