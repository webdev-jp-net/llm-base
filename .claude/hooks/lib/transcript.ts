/**
 * Claude Code Hooks — transcript 走査の共有ヘルパー
 *
 * transcript は1行1JSONのJSONL。ツール呼び出しとその成否を抽出する。
 */

import { readFileSync } from 'node:fs'

export interface ToolCall {
  name: string
  input: Record<string, unknown>
  id?: string
  /** 対応する tool_result が実在し、エラーでなかったか。結果が無ければ false */
  succeeded?: boolean
}

export interface ReadOptions {
  /**
   * 直近のコンパクション以降だけを対象にする。
   * コンパクションで会話は要約に置き換わり、それ以前に読んだ内容はコンテキストから消えるため、
   * 「読んだ」という履歴だけを根拠にできない。
   */
  sinceLastCompact?: boolean
}

/** コンパクション要約の行。ここより前の呼び出しは、現在のコンテキストに残っていない */
function isCompactSummary(entry: unknown): boolean {
  return (entry as { isCompactSummary?: unknown })?.isCompactSummary === true
}

/**
 * サイドチェーン（サブエージェント）の行。同じJSONLに混在する。
 * 別コンテキストでの呼び出しなので、メイン会話の履歴としては数えない。
 * フィールドが無い行はメイン会話として扱う。
 */
function isSidechain(entry: unknown): boolean {
  return (entry as { isSidechain?: unknown })?.isSidechain === true
}

/**
 * transcript から tool_use を抽出し、対応する tool_result と突き合わせる。
 * 対象はメイン会話の行のみ。サイドチェーンの呼び出しは含めない。
 * 成功と数えるのは、対応する tool_result が実在し、かつエラーでない呼び出しのみ。
 * 結果が欠落・破損している呼び出しは成功に数えない（fail-closed）。
 */
export function readToolCalls(transcriptPath: string, options: ReadOptions = {}): ToolCall[] {
  const calls: ToolCall[] = []
  const okIds = new Set<string>()
  const errorIds = new Set<string>()

  const entries: unknown[] = []
  for (const line of readFileSync(transcriptPath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (!isSidechain(entry)) entries.push(entry)
    } catch {
      continue
    }
  }

  let from = 0
  if (options.sinceLastCompact) {
    entries.forEach((entry, i) => {
      if (isCompactSummary(entry)) from = i
    })
  }

  for (const entry of entries.slice(from)) {
    const content = (entry as { message?: { content?: unknown } })?.message?.content
    if (!Array.isArray(content)) continue

    for (const item of content) {
      if (item?.type === 'tool_use' && typeof item.name === 'string') {
        calls.push({ name: item.name, input: item.input ?? {}, id: item.id })
      }
      if (item?.type === 'tool_result' && typeof item.tool_use_id === 'string') {
        if (item.is_error === true) errorIds.add(item.tool_use_id)
        else okIds.add(item.tool_use_id)
      }
    }
  }

  return calls.map(c => ({
    ...c,
    succeeded: c.id ? okIds.has(c.id) && !errorIds.has(c.id) : false,
  }))
}

/** 成功が確認できた呼び出しだけを返す。結果が無いものは成功に数えない */
export function successful(calls: ToolCall[]): ToolCall[] {
  return calls.filter(c => c.succeeded === true)
}
