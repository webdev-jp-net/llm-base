import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASH_MARK, changedFilesSince, targetFiles } from './changed-md.ts'
import type { HookInput } from './hook-types.ts'

const MD = new Set(['.md', '.mdx'])
let root = ''

const input = (tool_name: string, file_path?: string): HookInput => ({
  tool_name,
  tool_input: file_path ? { file_path } : {},
  cwd: root,
  session_id: 's',
  hook_event_name: 'PostToolUse',
})

/** mtime を目印より前後にずらして書く（秒単位の粒度でも判定できるよう 10 秒離す） */
const write = (rel: string, offsetSec: number) => {
  const full = join(root, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, 'x')
  const t = Date.now() / 1000 + offsetSec
  utimesSync(full, t, t)
  return full
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'changed-md-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('changedFilesSince', () => {
  test('目印が無ければ空', () => {
    write('a.md', 10)
    expect(changedFilesSince(root, MD)).toEqual([])
  })

  test('目印より新しい .md だけを返す', () => {
    write(BASH_MARK, 0)
    write('old.md', -10)
    const fresh = write('_llm-docs/new.md', 10)
    write('new.txt', 10)
    expect(changedFilesSince(root, MD)).toEqual([fresh])
  })

  test('node_modules と .git は見ない', () => {
    write(BASH_MARK, 0)
    write('node_modules/x.md', 10)
    write('.git/y.md', 10)
    expect(changedFilesSince(root, MD)).toEqual([])
  })
})

describe('targetFiles', () => {
  test('Edit / Write は file_path をそのまま対象にする', () => {
    const f = write('a.md', 0)
    expect(targetFiles(input('Edit', f), root, MD)).toEqual([f])
    expect(targetFiles(input('Write', f), root, MD)).toEqual([f])
  })

  test('Edit でも拡張子が対象外なら空', () => {
    const f = write('a.txt', 0)
    expect(targetFiles(input('Edit', f), root, MD)).toEqual([])
  })

  test('Bash は目印より新しいファイルを対象にする', () => {
    write(BASH_MARK, 0)
    const fresh = write('a.md', 10)
    expect(targetFiles(input('Bash'), root, MD)).toEqual([fresh])
  })

  test('それ以外のツールは空', () => {
    const f = write('a.md', 0)
    expect(targetFiles(input('Read', f), root, MD)).toEqual([])
  })
})
