/**
 * Claude Code Hooks — 共有型定義
 *
 * 全フックで共通の入力インターフェースを集約する。
 * Claude Code が stdin 経由でフックに渡す JSON の型定義。
 */

/** PreToolUse / PostToolUse 共通の入力 */
export interface HookInput {
  tool_name: string
  tool_input: Record<string, unknown>
  tool_response?: unknown
  cwd: string
  session_id: string
  hook_event_name: 'PreToolUse' | 'PostToolUse'
  tool_use_id?: string
  transcript_path?: string
  /** サブエージェント・agent 型フックの呼び出しに付く。agent 型フックは `hook-agent-` で始まる */
  agent_id?: string
}

/** Bash ツール用の tool_input 型付き HookInput */
export interface BashHookInput extends Omit<HookInput, 'tool_input'> {
  tool_input: {
    command: string
    description?: string
    timeout?: number
  }
}

/** UserPromptSubmit フック入力 */
export interface UserPromptSubmitInput {
  prompt: string
  cwd: string
  session_id: string
  hook_event_name: 'UserPromptSubmit'
}

/** Stop フック入力 */
export interface StopInput {
  last_assistant_message?: string
  cwd: string
  session_id: string
  hook_event_name: 'Stop'
}

/** MCP レスポンスの content 配列要素 */
export interface McpContentItem {
  type: string
  text?: string
}
