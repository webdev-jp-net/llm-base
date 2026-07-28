/**
 * Claude Code Hooks — 出力ヘルパー
 *
 * hookSpecificOutput の構築と、フックの main 関数ラッパーを提供する。
 * JSON 構造を手動で組み立てるボイラープレートを排除する。
 */

interface PreToolUseBlock {
  hookEventName: 'PreToolUse'
  permissionDecision: 'deny'
  permissionDecisionReason: string
}

interface PreToolUseAllow {
  hookEventName: 'PreToolUse'
  permissionDecision: 'allow'
  permissionDecisionReason: string
  updatedInput?: Record<string, unknown>
}

interface PostToolUseContext {
  hookEventName: 'PostToolUse'
  additionalContext: string
}

interface UserPromptContext {
  hookEventName: 'UserPromptSubmit'
  additionalContext: string
}

type HookOutput = PreToolUseBlock | PreToolUseAllow | PostToolUseContext | UserPromptContext

/** stdout に hookSpecificOutput JSON を書き出す */
export function emitOutput(output: HookOutput): void {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: output }))
}

/** PreToolUse: コマンド/操作をブロック */
export function blockTool(reason: string): void {
  emitOutput({
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  })
}

/** PreToolUse: 許可しつつ情報を通知 */
export function allowWithNote(reason: string, updatedInput?: Record<string, unknown>): void {
  emitOutput({
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    permissionDecisionReason: reason,
    ...(updatedInput && { updatedInput }),
  } as PreToolUseAllow)
}

/** PostToolUse: 追加コンテキストを注入 */
export function postContext(context: string): void {
  emitOutput({
    hookEventName: 'PostToolUse',
    additionalContext: context,
  })
}

/** UserPromptSubmit: 追加コンテキストを注入 */
export function userPromptContext(context: string): void {
  emitOutput({
    hookEventName: 'UserPromptSubmit',
    additionalContext: context,
  })
}

/**
 * フックのエントリーポイントをラップする。
 * エラー発生時はフック自体がツール実行をブロックしないよう exit(0) する。
 */
export function runHook(hookName: string, fn: () => Promise<void>): void {
  fn().catch(e => {
    console.error(`[${hookName}] エラー:`, e instanceof Error ? e.message : e)
    process.exit(0)
  })
}
