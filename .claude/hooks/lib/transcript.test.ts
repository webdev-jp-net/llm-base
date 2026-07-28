import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readToolCalls, successful } from './transcript.ts'

/** 成功した Read 1件ぶんの2行（tool_use と tool_result） */
function readCall(id: string, path: string): string[] {
  return [
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: path } }],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, is_error: false }],
      },
    }),
  ]
}

/** サイドチェーン（サブエージェント）が行った成功した Read */
function sidechainReadCall(id: string, path: string): string[] {
  return readCall(id, path).map(line => JSON.stringify({ ...JSON.parse(line), isSidechain: true }))
}

/** コンパクション要約の行 */
const COMPACT = JSON.stringify({
  type: 'user',
  isSidechain: false,
  isCompactSummary: true,
  message: { role: 'user', content: 'This session is being continued from a previous...' },
})

/** サイドチェーン側のコンパクション要約 */
const SIDECHAIN_COMPACT = JSON.stringify({ ...JSON.parse(COMPACT), isSidechain: true })

describe('readToolCalls', () => {
  let dir = ''

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  function makeTranscript(lines: string[]): string {
    dir = mkdtempSync(join(tmpdir(), 'transcript-'))
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, `${lines.join('\n')}\n`)
    return path
  }

  /** 成功した Read の file_path */
  function readPaths(path: string, sinceLastCompact = false): string[] {
    return successful(readToolCalls(path, { sinceLastCompact })).map(c => String(c.input.file_path))
  }

  test('コンパクション以前の読了は数えない', () => {
    const path = makeTranscript([
      ...readCall('a', 'before.md'),
      COMPACT,
      ...readCall('b', 'after.md'),
    ])
    expect(readPaths(path, true)).toEqual(['after.md'])
  })

  test('指定しなければ全件を返す', () => {
    const path = makeTranscript([
      ...readCall('a', 'before.md'),
      COMPACT,
      ...readCall('b', 'after.md'),
    ])
    expect(readPaths(path)).toEqual(['before.md', 'after.md'])
  })

  test('コンパクションが無ければ全件を返す', () => {
    const path = makeTranscript([...readCall('a', 'x.md'), ...readCall('b', 'y.md')])
    expect(readPaths(path, true)).toEqual(['x.md', 'y.md'])
  })

  test('コンパクションが複数あれば最後のものを境界にする', () => {
    const path = makeTranscript([
      ...readCall('a', 'first.md'),
      COMPACT,
      ...readCall('b', 'second.md'),
      COMPACT,
      ...readCall('c', 'third.md'),
    ])
    expect(readPaths(path, true)).toEqual(['third.md'])
  })

  test('サイドチェーンの読了はメイン会話の読了に数えない', () => {
    const path = makeTranscript([...sidechainReadCall('s', 'sub.md'), ...readCall('m', 'main.md')])
    expect(readPaths(path, true)).toEqual(['main.md'])
  })

  test('サイドチェーンのコンパクションは境界にしない', () => {
    const path = makeTranscript([
      ...readCall('a', 'main.md'),
      SIDECHAIN_COMPACT,
      ...sidechainReadCall('s', 'sub.md'),
    ])
    expect(readPaths(path, true)).toEqual(['main.md'])
  })

  test('結果が無い呼び出しは成功に数えない', () => {
    const [toolUse] = readCall('a', 'x.md')
    expect(readPaths(makeTranscript([toolUse]), true)).toEqual([])
  })

  test('エラーになった呼び出しは成功に数えない', () => {
    const [toolUse] = readCall('a', 'x.md')
    const errorResult = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true }],
      },
    })
    expect(readPaths(makeTranscript([toolUse, errorResult]), true)).toEqual([])
  })
})
