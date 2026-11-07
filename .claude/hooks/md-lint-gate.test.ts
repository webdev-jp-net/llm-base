import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  committableMdList,
  isAllowedWhilePending,
  isCommitCommand,
  lintProblems,
  PENDING,
  readPending,
  writePending,
} from './md-lint-gate.ts'

const GATE = join(import.meta.dir, 'md-lint-gate.ts')
let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'md-lint-gate-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const write = (rel: string, content: string) => {
  const full = join(root, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
  return full
}

/** フックを stdin 付きで実行し、stdout を返す */
const run = (input: Record<string, unknown>) => {
  const proc = Bun.spawnSync(['bun', 'run', GATE], {
    stdin: Buffer.from(JSON.stringify({ cwd: root, session_id: 's', ...input })),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  })
  return proc.stdout.toString()
}

const pre = (tool_name: string, tool_input: Record<string, unknown>) =>
  run({ hook_event_name: 'PreToolUse', tool_name, tool_input })

const isDenied = (out: string) =>
  out !== '' && JSON.parse(out).hookSpecificOutput.permissionDecision === 'deny'

describe('readPending / writePending', () => {
  test('記録が無ければ空', () => {
    expect(readPending(root)).toEqual([])
  })
  test('重複を除いて保存する', () => {
    writePending(root, ['/b.md', '/a.md', '/b.md'])
    expect(readPending(root)).toEqual(['/a.md', '/b.md'])
  })
})

describe('lintProblems', () => {
  test('見出しの違反を詳細つきで返す', () => {
    const f = write('a.md', '# 名前 — 副題\n')
    expect(lintProblems(root, f).join('\n')).toContain('L1 [副題')
  })
  test('違反が無ければ空', () => {
    const f = write('a.md', '# 名前\n\n本文\n')
    expect(lintProblems(root, f)).toEqual([])
  })
})

describe('isAllowedWhilePending', () => {
  const failing = () => [join(root, 'a.md')]
  test('違反ファイルの Read と編集は通す', () => {
    const input = { file_path: join(root, 'a.md') }
    for (const tool of ['Read', 'Edit', 'Write']) {
      expect(isAllowedWhilePending(tool, input, failing(), root)).toBe(true)
    }
  })
  test('相対パスでも違反ファイルなら通す', () => {
    expect(isAllowedWhilePending('Edit', { file_path: 'a.md' }, failing(), root)).toBe(true)
  })
  test('別ファイルの Read と編集は止める', () => {
    const input = { file_path: join(root, 'b.md') }
    expect(isAllowedWhilePending('Read', input, failing(), root)).toBe(false)
    expect(isAllowedWhilePending('Edit', input, failing(), root)).toBe(false)
  })
  test('それ以外のツールは、違反ファイルが対象でも止める', () => {
    const input = { file_path: join(root, 'a.md') }
    expect(isAllowedWhilePending('NotebookEdit', input, failing(), root)).toBe(false)
  })
})

describe('フック全体', () => {
  test('違反のある .md を編集すると、次の操作を止める', () => {
    const f = write('a.md', '## 1. 概要\n')
    run({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: f } })
    expect(readPending(root)).toEqual([f])
    expect(isDenied(pre('Bash', { command: 'ls' }))).toBe(true)
  })

  test('違反ファイルを直す操作は通す', () => {
    const f = write('a.md', '## 1. 概要\n')
    writePending(root, [f])
    expect(pre('Edit', { file_path: f })).toBe('')
  })

  test('直ったら lint 待ちから外し、操作を通す', () => {
    const f = write('a.md', '## 概要\n')
    writePending(root, [f])
    expect(pre('Bash', { command: 'ls' })).toBe('')
    expect(readPending(root)).toEqual([])
  })

  test('違反の無い .md の編集では止めない', () => {
    const f = write('a.md', '## 概要\n')
    run({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: f } })
    expect(pre('Bash', { command: 'ls' })).toBe('')
  })

  test('記録が壊れていたら止める', () => {
    write(PENDING, '{')
    expect(isDenied(pre('Bash', { command: 'ls' }))).toBe(true)
  })
})

describe('コミット時の判定', () => {
  /** root を git リポジトリにし、ok.md を1件コミットしておく */
  const initRepo = () => {
    const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: root })
    git('init', '-q')
    git('config', 'user.email', 't@example.com')
    git('config', 'user.name', 't')
    write('ok.md', '# 見出し\n')
    write('.gitignore', 'ignored.md\n.claude/tmp\n')
    git('add', '.')
    git('commit', '-qm', 'init')
  }

  test('git commit を含むコマンドを見分ける', () => {
    expect(isCommitCommand('git commit -m x')).toBe(true)
    expect(isCommitCommand('git add a.md && git commit -m x')).toBe(true)
    expect(isCommitCommand('git -C /path commit -am x')).toBe(true)
    expect(isCommitCommand('git log --oneline')).toBe(false)
    expect(isCommitCommand('echo commit')).toBe(false)
  })

  test('差分のある .md と未追跡の .md を拾い、ignore されたものは拾わない', () => {
    initRepo()
    const changed = write('ok.md', '# 見出し\n\n追記\n')
    const untracked = write('docs/new.md', '# 新規\n')
    write('ignored.md', '# 無視\n')
    write('note.txt', 'x')
    expect(committableMdList(root).sort()).toEqual([untracked, changed].sort())
  })

  test('記録をすり抜けた違反 .md があればコミットを止める', () => {
    initRepo()
    write('docs/bad.md', '## 1. 概要\n')
    expect(isDenied(pre('Bash', { command: 'git add . && git commit -m x' }))).toBe(true)
  })

  test('コミット以外のコマンドでは差分を見ない', () => {
    initRepo()
    write('docs/bad.md', '## 1. 概要\n')
    expect(pre('Bash', { command: 'ls' })).toBe('')
  })

  test('まだコミットの無いリポジトリでも判定できる', () => {
    Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
    const good = write('docs/good.md', '## 概要\n')
    expect(committableMdList(root)).toEqual([good])
    expect(pre('Bash', { command: 'git add . && git commit -m init' })).toBe('')
    write('docs/bad.md', '## 1. 概要\n')
    expect(isDenied(pre('Bash', { command: 'git add . && git commit -m init' }))).toBe(true)
  })

  test('違反が無ければコミットを止めない', () => {
    initRepo()
    write('docs/good.md', '## 概要\n')
    expect(pre('Bash', { command: 'git commit -am x' })).toBe('')
  })
})
