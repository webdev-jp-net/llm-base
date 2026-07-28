import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isGatedCommand,
  isGatedTool,
  isRecordCreation,
  recordFiles,
  recordsReady,
  requiredFiles,
} from './read-gate.ts'

const GATE = join(import.meta.dir, 'read-gate.ts')

/** 参照系として通すコマンド */
const PASS = [
  'ls -la',
  'cat file.txt',
  'git status --short',
  'git log --oneline -1',
  'git diff --stat',
  'git -C /path log',
  'echo FOO=bar',
  'grep -n FOO=bar file',
  'grep -n "sort -o" file',
  'grep -n "git -c" file',
  'printf FOO=bar',
  'sort -u in.txt',
  'find . -name "*.ts"',
  'sort -- -o in.txt',
  'printf -- -v',
  'git log -- --output',
  'ls | grep x',
  'jq -r .name package.json',
  'ls | sort | uniq',
  'uniq in.txt',
  'uniq -c in.txt',
  'uniq -f 1 in.txt',
  'uniq -- in.txt',
  'tree -L 2',
  'date +%Y',
  'date -u +%s',
  'date -r 100 +%F',
  'file x.ts',
  // サブコマンドより後のオプションは、参照系の意味しか持たない
  'git log -p',
  'git log -c',
]

/** 拒否するコマンド */
const BLOCK = [
  // 書き込み・実行
  'rm -rf /tmp/x',
  'npm install',
  'echo x > file',
  'echo x >> file',
  // 環境変数の前置（許可コマンドの挙動を変えられる）
  'PATH=/tmp ls',
  'PATH+=:/tmp ls',
  'A=1 B=2 cat f',
  'GIT_DIR=/tmp git status',
  'env FOO=bar ls',
  'command FOO=bar ls',
  // 書き込みに使えるオプション
  'sort -o out.txt in.txt',
  "sort '-o' out.txt in.txt",
  'sort -uo/tmp/x in.txt',
  'printf -v x y',
  'find . -exec rm {} ;',
  'find . -delete',
  'diff --output=x a b',
  'tree -o out.txt',
  'tree -H . -o /tmp/x',
  'date -s 2026-01-01',
  'date --set=2026-01-01',
  'date 010100002026',
  'file --compile',
  'file -C',
  'sort --compress-program=sh in',
  // サブコマンドより前のオプションは、設定の上書きや外部コマンドの起動に使える
  'git -p log',
  'git --paginate log',
  'git --exec-path=/tmp log',
  // オプションではなく引数の位置で書き込む
  'uniq in.txt out.txt',
  'uniq -f 1 in.txt out.txt',
  'uniq -- in.txt out.txt',
  'git -c core.pager=x log',
  'git -ccore.pager=x log',
  'git --config-env=core.pager=P log',
  // 展開の結果を判定できない
  'sort ${V} out in',
  'sort [-]o out in',
  // 解析できない構文
  'echo $(rm -rf /tmp/x)',
  'echo `rm -rf /tmp/x`',
  'cat <<EOF',
  'diff <(ls) <(ls)',
  // パス指定の実行（許可コマンド名を騙れる）
  '/tmp/ls -la',
  './cat file',
  // 参照系でないgitサブコマンド
  'git commit -m x',
  'git push',
  'git branch -d x',
  // 1つでも拒否対象を含む複合
  'ls && rm -rf /tmp/x',
  'ls; npm install',
  'ls | tee file',
]

describe('isGatedCommand', () => {
  test.each(PASS)('通過: %s', command => {
    expect(isGatedCommand(command)).toBe(false)
  })

  test.each(BLOCK)('拒否: %s', command => {
    expect(isGatedCommand(command)).toBe(true)
  })
})

/** 読み取りとして通すツール */
const PASS_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'mcp__serena__find_symbol',
  'mcp__serena__get_symbols_overview',
]

/** 書き込みの可能性があるため拒否するツール */
const BLOCK_TOOLS = [
  'Edit',
  'Write',
  'NotebookEdit',
  'mcp__serena__replace_content',
  'mcp__serena__write_memory',
  'mcp__serena__edit_memory',
  'mcp__serena__delete_memory',
  'mcp__serena__insert_after_symbol',
  'mcp__serena__read_memory',
  'mcp__serena__list_memories',
  'mcp__serena__onboarding',
  'mcp__playwright__browser_navigate',
  // 許可リストに無いMCPツールは拒否する
  'mcp__unknown__anything',
]

describe('isGatedTool', () => {
  test.each(PASS_TOOLS)('通過: %s', name => {
    expect(isGatedTool(name)).toBe(false)
  })

  test.each(BLOCK_TOOLS)('拒否: %s', name => {
    expect(isGatedTool(name)).toBe(true)
  })
})

describe('requiredFiles', () => {
  let root = ''

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = ''
  })

  /** `_llm-rules/` と `_llm-docs/` の必読ファイルを持つ一時ディレクトリを作る */
  function makeRoot(rules: Record<string, string>, withDocs = true): string {
    root = mkdtempSync(join(tmpdir(), 'read-gate-'))
    mkdirSync(join(root, '_llm-rules'), { recursive: true })
    for (const [path, body] of Object.entries(rules)) {
      const full = join(root, '_llm-rules', path)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, body)
    }
    if (withDocs) {
      mkdirSync(join(root, '_llm-docs/operation'), { recursive: true })
      writeFileSync(join(root, '_llm-docs/project.md'), 'P')
      writeFileSync(join(root, '_llm-docs/operation/dictionary.md'), 'D')
    }
    return root
  }

  test('ファイル名を指定せずに拾う', () => {
    expect(requiredFiles(makeRoot({ 'a.md': 'A', 'b.md': 'B' }))).toEqual({
      files: [
        '_llm-rules/a.md',
        '_llm-rules/b.md',
        '_llm-docs/project.md',
        '_llm-docs/operation/dictionary.md',
      ],
      missing: [],
    })
  })

  test('ファイルが増えても設定の書き換えなしで追従する', () => {
    const { files } = requiredFiles(
      makeRoot({ 'a.md': 'A', 'b.md': 'B', 'c.md': 'C', 'd.md': 'D' })
    )
    expect(files.filter(f => f.startsWith('_llm-rules/'))).toHaveLength(4)
  })

  test('サブディレクトリも走査する', () => {
    const { files } = requiredFiles(
      makeRoot({ 'a.md': 'A', 'sub/b.md': 'B', 'sub/deep/c.md': 'C' })
    )
    expect(files).toContain('_llm-rules/sub/b.md')
    expect(files).toContain('_llm-rules/sub/deep/c.md')
  })

  test('md 以外は必読にしない', () => {
    const { files } = requiredFiles(makeRoot({ 'a.md': 'A', 'b.txt': 'B' }))
    expect(files).not.toContain('_llm-rules/b.txt')
  })

  test('_llm-docs の必読ファイルが無ければ missing に入れる（設定破損として扱う）', () => {
    expect(requiredFiles(makeRoot({ 'a.md': 'A' }, false))).toEqual({
      files: ['_llm-rules/a.md'],
      missing: ['_llm-docs/project.md', '_llm-docs/operation/dictionary.md'],
    })
  })

  test('_llm-rules/ が無ければ missing に入れる', () => {
    root = mkdtempSync(join(tmpdir(), 'read-gate-'))
    expect(requiredFiles(root).missing).toContain('_llm-rules/*.md')
  })

  test('_llm-rules/ が空なら missing に入れる', () => {
    expect(requiredFiles(makeRoot({})).missing).toContain('_llm-rules/*.md')
  })

  test('_llm-rules/ に md が1件も無ければ missing に入れる', () => {
    expect(requiredFiles(makeRoot({ 'a.txt': 'A', 'sub/b.json': 'B' })).missing).toContain(
      '_llm-rules/*.md'
    )
  })

  test('_llm-rules がディレクトリでなければ missing に入れる', () => {
    root = mkdtempSync(join(tmpdir(), 'read-gate-'))
    writeFileSync(join(root, '_llm-rules'), 'not a directory')
    expect(requiredFiles(root).missing).toContain('_llm-rules/*.md')
  })
})

describe('recordFiles', () => {
  let root = ''

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = ''
  })

  /** `_llm-memories/` を持つ一時ディレクトリを作る */
  function makeRoot(files: Record<string, string>): string {
    root = mkdtempSync(join(tmpdir(), 'read-gate-'))
    for (const [path, body] of Object.entries(files)) {
      const full = join(root, '_llm-memories', path)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, body)
    }
    return root
  }

  test('3ファイルを拾う', () => {
    const r = makeRoot({ 'state.md': 'S', 'lessons.md': 'L', 'episodes.md': 'E' })
    expect(recordFiles(r)).toEqual([
      '_llm-memories/state.md',
      '_llm-memories/lessons.md',
      '_llm-memories/episodes.md',
    ])
    expect(recordsReady(r)).toBe(true)
  })

  test('1つでも欠ければ揃っていない', () => {
    const r = makeRoot({ 'state.md': 'S', 'lessons.md': 'L' })
    expect(recordsReady(r)).toBe(false)
  })

  test('空ファイルは数えない', () => {
    const r = makeRoot({ 'state.md': 'S', 'lessons.md': 'L', 'episodes.md': '' })
    expect(recordFiles(r)).not.toContain('_llm-memories/episodes.md')
    expect(recordsReady(r)).toBe(false)
  })

  test('templates/ も想定外のファイルも数えない', () => {
    const r = makeRoot({
      'state.md': 'S',
      'lessons.md': 'L',
      'episodes.md': 'E',
      'note.md': 'N',
      'templates/state.md': 'T',
    })
    expect(recordFiles(r)).toHaveLength(3)
    expect(recordFiles(r)).not.toContain('_llm-memories/note.md')
  })

  test('ディレクトリが無ければ空', () => {
    root = mkdtempSync(join(tmpdir(), 'read-gate-'))
    expect(recordFiles(root)).toEqual([])
    expect(recordsReady(root)).toBe(false)
  })
})

describe('isRecordCreation', () => {
  let root = ''

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = ''
  })

  function makeRoot(files: Record<string, string> = {}): string {
    root = mkdtempSync(join(tmpdir(), 'read-gate-'))
    mkdirSync(join(root, '_llm-memories/templates'), { recursive: true })
    for (const [path, body] of Object.entries(files)) {
      writeFileSync(join(root, '_llm-memories', path), body)
    }
    return root
  }

  test('未作成の記録を Write で作るのは通す', () => {
    const r = makeRoot()
    expect(isRecordCreation('Write', '_llm-memories/state.md', r)).toBe(true)
    expect(isRecordCreation('Write', join(r, '_llm-memories/episodes.md'), r)).toBe(true)
  })

  test('中身のあるものは作成ではない', () => {
    const r = makeRoot({ 'state.md': 'S' })
    expect(isRecordCreation('Write', '_llm-memories/state.md', r)).toBe(false)
  })

  test('空ファイルは作り直せる', () => {
    const r = makeRoot({ 'state.md': '' })
    expect(recordsReady(r)).toBe(false)
    expect(isRecordCreation('Write', '_llm-memories/state.md', r)).toBe(true)
  })

  test('Write 以外は通さない', () => {
    const r = makeRoot()
    expect(isRecordCreation('Edit', '_llm-memories/state.md', r)).toBe(false)
    expect(isRecordCreation('NotebookEdit', '_llm-memories/state.md', r)).toBe(false)
    expect(isRecordCreation('Bash', undefined, r)).toBe(false)
  })

  test('記録の3ファイル以外は通さない', () => {
    const r = makeRoot()
    expect(isRecordCreation('Write', '_llm-memories/note.md', r)).toBe(false)
    expect(isRecordCreation('Write', '_llm-memories/templates/state.md', r)).toBe(false)
    expect(isRecordCreation('Write', '_llm-memories/sub/state.md', r)).toBe(false)
    expect(isRecordCreation('Write', 'src/index.ts', r)).toBe(false)
    expect(isRecordCreation('Write', '../_llm-memories/state.md', r)).toBe(false)
    expect(isRecordCreation('Write', '_llm-memories-x/state.md', r)).toBe(false)
  })

  test('シンボリックリンク越しには書かせない', () => {
    const r = makeRoot()
    const outside = join(r, 'outside')
    mkdirSync(outside, { recursive: true })
    symlinkSync(join(outside, 'escaped.md'), join(r, '_llm-memories/state.md'))
    expect(isRecordCreation('Write', '_llm-memories/state.md', r)).toBe(false)
  })

  test('置き場所自体がディレクトリでなければ通さない', () => {
    root = mkdtempSync(join(tmpdir(), 'read-gate-'))
    symlinkSync(tmpdir(), join(root, '_llm-memories'))
    expect(isRecordCreation('Write', '_llm-memories/state.md', root)).toBe(false)
  })
})

describe('--list', () => {
  let root = ''

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = ''
  })

  /** `--list` を実行して標準出力を返す */
  function runList(): string {
    const proc = Bun.spawnSync(['bun', 'run', GATE, '--list'], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    })
    return proc.stdout.toString()
  }

  /** 必読の対象が揃った一時ディレクトリを作る */
  function makeRoot(withRecords: boolean): string {
    root = mkdtempSync(join(tmpdir(), 'read-gate-'))
    mkdirSync(join(root, '_llm-rules'), { recursive: true })
    writeFileSync(join(root, '_llm-rules/a.md'), 'A')
    mkdirSync(join(root, '_llm-docs/operation'), { recursive: true })
    writeFileSync(join(root, '_llm-docs/project.md'), 'P')
    writeFileSync(join(root, '_llm-docs/operation/dictionary.md'), 'D')
    mkdirSync(join(root, '_llm-memories'), { recursive: true })
    if (withRecords) {
      for (const name of ['state.md', 'lessons.md', 'episodes.md']) {
        writeFileSync(join(root, '_llm-memories', name), 'X')
      }
    }
    return root
  }

  test('必読ファイルと記録を列挙する', () => {
    makeRoot(true)
    expect(runList()).toBe(
      '- _llm-rules/a.md\n- _llm-docs/project.md\n- _llm-docs/operation/dictionary.md\n- _llm-memories/state.md\n- _llm-memories/lessons.md\n- _llm-memories/episodes.md\n'
    )
  })

  test('記録が揃っていなければ作るよう促す', () => {
    makeRoot(false)
    expect(runList()).toContain('templates/ から state.md / lessons.md / episodes.md を作る')
  })

  test('必読の対象が欠けていれば併記する', () => {
    root = mkdtempSync(join(tmpdir(), 'read-gate-'))
    expect(runList()).toContain('見つからない必読対象')
  })
})
