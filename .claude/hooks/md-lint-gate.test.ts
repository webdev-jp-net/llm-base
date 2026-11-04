import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JUDGE_MARK, readEvents, writeEvents } from './lib/balance-verdict.ts'
import { QUEUE_DIR, SNAPSHOT_DIR, TAMPER } from './lib/record-guard.ts'
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

const transcript = () => join(root, 'transcript.jsonl')

/** 判定役の記録を transcript に1行足す */
const judge = (toolUseId: string, reason: string) =>
  appendFileSync(
    transcript(),
    JSON.stringify({
      type: 'attachment',
      attachment: {
        type: 'hook_blocking_error',
        hookName: 'PostToolUse:Write',
        toolUseID: toolUseId,
        hookEvent: 'PostToolUse',
        blockingError: {
          blockingError: `Agent hook condition was not met: ${reason}`,
          command: `${JUDGE_MARK} 判定役のプロンプト`,
        },
      },
    }) + '\n'
  )

/** ファイルを Write で編集し、判定役が合格を出した状態にする */
const writePassed = (file: string, toolUseId: string) => {
  writeEvents(root, [...readEvents(root), event(file, 'Write', toolUseId)])
  judge(toolUseId, 'PASS')
}

/** 編集の記録の1件 */
const event = (file: string, tool: string, toolUseId: string) => ({
  file,
  toolUseId,
  tool,
  transcriptPath: transcript(),
})

/** フックを stdin 付きで実行し、stdout を返す */
const run = (input: Record<string, unknown>) => {
  const proc = Bun.spawnSync(['bun', 'run', GATE], {
    stdin: Buffer.from(
      JSON.stringify({ cwd: root, session_id: 's', transcript_path: transcript(), ...input })
    ),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  })
  return proc.stdout.toString()
}

const pre = (tool_name: string, tool_input: Record<string, unknown>, tool_use_id = 'b1') =>
  run({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id })

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
  test('壊れた記録は例外にする', () => {
    write(PENDING, '{')
    expect(() => readPending(root)).toThrow()
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
  test('それ以外のツールは止める', () => {
    for (const tool of ['Bash', 'Grep', 'Glob', 'Agent', 'NotebookEdit', 'mcp__x__y']) {
      expect(isAllowedWhilePending(tool, {}, failing(), root)).toBe(false)
    }
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

  test('違反が無く doc-balance に合格した .md の編集では止めない', () => {
    const f = write('a.md', '## 概要\n')
    run({
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: f },
      tool_use_id: 't1',
    })
    judge('t1', 'PASS')
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

  const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: root })
  const postBash = (tool_use_id: string) =>
    run({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'x' },
      tool_use_id,
    })

  test('コミットのコマンドの形に関係なく、合格していない中身の .md のコミットを Bash の直後に止める', () => {
    initRepo()
    writeFileSync(transcript(), '{}\n')
    write('docs/a.md', '## 概要\n')
    // コミットとは見分けられないコマンドの中で、コミットされたとする
    expect(pre('Bash', { command: 'bash s.sh' }, 'b1')).toBe('')
    git('add', 'docs/a.md')
    git('commit', '-qm', 'x')
    expect(postBash('b1')).toContain('合格した中身と違う docs/a.md')
    expect(existsSync(join(root, TAMPER))).toBe(true)
  })

  test('合格した中身のままコミットした .md は止めない', () => {
    initRepo()
    writeFileSync(transcript(), '{}\n')
    const f = write('docs/a.md', '## 概要\n')
    writePassed(f, 't1')
    expect(pre('Bash', { command: 'bash s.sh' }, 'b1')).toBe('')
    git('add', 'docs/a.md')
    git('commit', '-qm', 'x')
    expect(postBash('b1')).toBe('')
  })

  test('コミット済みの .md を含むコミットを amend で作り直しても止めない', () => {
    initRepo()
    writeFileSync(transcript(), '{}\n')
    const f = write('docs/a.md', '## 概要\n')
    writePassed(f, 't1')
    git('add', 'docs/a.md')
    git('commit', '-qm', 'x')
    // コミット後の操作で、コミット済みの .md の記録は外れる
    expect(pre('Bash', { command: 'ls' }, 'b0')).toBe('')
    expect(postBash('b0')).toBe('')
    expect(pre('Bash', { command: 'git commit --amend' }, 'b1')).toBe('')
    git('commit', '--amend', '-qm', 'x #1')
    expect(postBash('b1')).toBe('')
    expect(existsSync(join(root, TAMPER))).toBe(false)
  })

  test('ほかのブランチのコミットを cherry-pick しても止めない', () => {
    initRepo()
    writeFileSync(transcript(), '{}\n')
    git('switch', '-qc', 'other')
    write('docs/b.md', '## 別\n')
    git('add', 'docs/b.md')
    git('commit', '-qm', 'other')
    git('switch', '-q', '-')
    // 親を変えておく（同じ親だと、同じ秒の cherry-pick は元と同じコミットになる）
    write('c.txt', 'c\n')
    git('add', 'c.txt')
    git('commit', '-qm', 'c')
    expect(pre('Bash', { command: 'git cherry-pick other' }, 'b1')).toBe('')
    git('cherry-pick', 'other')
    expect(postBash('b1')).toBe('')
    expect(existsSync(join(root, TAMPER))).toBe(false)
  })

  test('衝突で止まった rebase を、別の Bash で続行しても止めない', () => {
    initRepo()
    writeFileSync(transcript(), '{}\n')
    const main = Bun.spawnSync(['git', 'branch', '--show-current'], { cwd: root })
      .stdout.toString()
      .trim()
    git('switch', '-qc', 'feature')
    const f = write('docs/a.md', '## 概要\n')
    writePassed(f, 't1')
    write('c.txt', 'feature\n')
    git('add', '.')
    git('commit', '-qm', 'a')
    git('switch', '-q', main)
    write('c.txt', 'main\n')
    git('add', 'c.txt')
    git('commit', '-qm', 'c')
    git('switch', '-q', 'feature')
    // コミット後の操作で、コミット済みの .md の記録は外れる
    expect(pre('Bash', { command: 'ls' }, 'b0')).toBe('')
    expect(postBash('b0')).toBe('')
    expect(pre('Bash', { command: `git rebase ${main}` }, 'b1')).toBe('')
    git('rebase', main)
    expect(postBash('b1')).toBe('')
    write('c.txt', 'resolved\n')
    git('add', 'c.txt')
    expect(pre('Bash', { command: 'git rebase --continue' }, 'b2')).toBe('')
    Bun.spawnSync(['git', 'rebase', '--continue'], {
      cwd: root,
      env: { ...process.env, GIT_EDITOR: 'true' },
    })
    expect(postBash('b2')).toBe('')
    expect(existsSync(join(root, TAMPER))).toBe(false)
  })

  test('同じ Bash の中で別の参照に一度コミットした、審査を通っていない中身は止める', () => {
    initRepo()
    writeFileSync(transcript(), '{}\n')
    expect(pre('Bash', { command: 'bash s.sh' }, 'b1')).toBe('')
    write('docs/n.md', '## 新規\n')
    git('add', 'docs/n.md')
    git('stash', '-q')
    git('stash', 'apply', '-q', '--index')
    git('commit', '-qm', 'n')
    expect(postBash('b1')).toContain('合格した中身と違う docs/n.md')
  })

  test('.gitignore 対象でも強制的に追加してコミットした、合格していない .md は止める', () => {
    initRepo()
    writeFileSync(transcript(), '{}\n')
    write('ignored.md', '## 概要\n')
    expect(pre('Bash', { command: 'bash s.sh' }, 'b1')).toBe('')
    git('add', '-f', 'ignored.md')
    git('commit', '-qm', 'x')
    expect(postBash('b1')).toContain('合格した中身と違う ignored.md')
  })

  test('日本語名の .md もコミット前の検査の対象にする', () => {
    initRepo()
    const f = write('文書.md', '## 概要\n')
    expect(committableMdList(root)).toContain(f)
  })

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
    write('.gitignore', 'transcript.jsonl\n.claude/tmp\n')
    const good = write('docs/good.md', '## 概要\n')
    writePassed(good, 't1')
    expect(committableMdList(root)).toEqual([good])
    expect(pre('Bash', { command: 'git add . && git commit -m init' })).toBe('')
    write('docs/bad.md', '## 1. 概要\n')
    expect(isDenied(pre('Bash', { command: 'git add . && git commit -m init' }))).toBe(true)
  })

  test('違反が無く doc-balance に合格していればコミットを止めない', () => {
    initRepo()
    writePassed(write('docs/good.md', '## 概要\n'), 't1')
    expect(pre('Bash', { command: 'git commit -am x' })).toBe('')
  })

  test('doc-balance の判定を受けていない .md があればコミットを止める', () => {
    initRepo()
    write('docs/good.md', '## 概要\n')
    expect(isDenied(pre('Bash', { command: 'git commit -am x' }))).toBe(true)
  })
})

describe('doc-balance の判定', () => {
  const edited = (file: string, tool: string, toolUseId: string) =>
    run({
      hook_event_name: 'PostToolUse',
      tool_name: tool,
      tool_input: { file_path: file },
      tool_use_id: toolUseId,
    })

  test('不合格なら止め、理由を示す', () => {
    const f = write('a.md', '## 概要\n')
    edited(f, 'Edit', 't1')
    judge('t1', 'FAIL: 追記が周囲より長い')
    const out = pre('Bash', { command: 'ls' })
    expect(isDenied(out)).toBe(true)
    expect(out).toContain('追記が周囲より長い')
  })

  test('判定役の記録が無ければ（エラーで止まった場合も）止める', () => {
    const f = write('a.md', '## 概要\n')
    edited(f, 'Edit', 't1')
    expect(isDenied(pre('Bash', { command: 'ls' }))).toBe(true)
  })

  test('止まっている間も、そのファイルを直す操作は通す', () => {
    const f = write('a.md', '## 概要\n')
    edited(f, 'Edit', 't1')
    expect(pre('Write', { file_path: f })).toBe('')
  })

  test('書き直して合格すれば通す', () => {
    const f = write('a.md', '## 概要\n')
    edited(f, 'Edit', 't1')
    judge('t1', 'FAIL: x')
    edited(f, 'Write', 't2')
    judge('t2', 'PASS')
    expect(pre('Bash', { command: 'ls' })).toBe('')
  })

  test('合格のあと Bash で書き換えたら未判定に戻る', () => {
    const f = write('a.md', '## 概要\n')
    writePassed(f, 't1')
    writeEvents(root, [...readEvents(root), event(f, 'Bash', 'b1')])
    const out = pre('Bash', { command: 'ls' })
    expect(isDenied(out)).toBe(true)
    expect(out).toContain('Write し直して')
  })

  test('Bash で書き換えたあとは、Edit で合格しても未判定のまま', () => {
    const f = write('a.md', '## 概要\n')
    writeEvents(root, [event(f, 'Bash', 'b1')])
    edited(f, 'Edit', 't1')
    judge('t1', 'PASS')
    expect(pre('Bash', { command: 'ls' })).toContain('Write し直して')
    edited(f, 'Write', 't2')
    judge('t2', 'PASS')
    expect(pre('Bash', { command: 'ls' })).toBe('')
  })

  /** 別のセッション（transcript が別のファイル）からの操作 */
  const preInOtherSession = () =>
    run({
      hook_event_name: 'PreToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: 'x' },
      transcript_path: join(root, 'other-session.jsonl'),
    })

  test('合格は、編集したセッションの transcript から読むので、別のセッションでも合格のまま', () => {
    const f = write('a.md', '## 概要\n')
    edited(f, 'Write', 't1')
    judge('t1', 'PASS')
    expect(preInOtherSession()).toBe('')
  })

  test('不合格は別のセッションでも止まり続ける', () => {
    const f = write('a.md', '## 概要\n')
    edited(f, 'Write', 't1')
    judge('t1', 'FAIL: x')
    expect(isDenied(preInOtherSession())).toBe(true)
  })

  test('編集したセッションの transcript が無ければ、合格とみなさない', () => {
    const f = write('a.md', '## 概要\n')
    edited(f, 'Write', 't1')
    judge('t1', 'PASS')
    rmSync(transcript())
    expect(isDenied(preInOtherSession())).toBe(true)
  })

  test('合格のあと、記録の残らない経路で中身が変わったら、Write し直すまで止める', () => {
    const f = write('a.md', '## 概要\n')
    edited(f, 'Write', 't1')
    judge('t1', 'PASS')
    expect(pre('Grep', { pattern: 'x' }, 'g1')).toBe('')
    write('a.md', '## 概要\n\n記録されない追記\n')
    expect(pre('Grep', { pattern: 'x' }, 'g2')).toContain('Write し直して')
    edited(f, 'Edit', 't2')
    judge('t2', 'PASS')
    expect(isDenied(pre('Grep', { pattern: 'x' }, 'g3'))).toBe(true)
    edited(f, 'Write', 't3')
    judge('t3', 'PASS')
    expect(pre('Grep', { pattern: 'x' }, 'g4')).toBe('')
  })

  test('理由が PASS で始まっても、PASS ちょうどでなければ不合格', () => {
    const f = write('a.md', '## 概要\n')
    edited(f, 'Write', 't1')
    judge('t1', 'PASSしていない。FAIL: 分量が多い')
    expect(isDenied(pre('Grep', { pattern: 'x' }, 'g1'))).toBe(true)
  })

  test('不合格が8回続いたら、そのファイルの編集も含め Read 以外を止め、ユーザーの発言で数え直す', () => {
    const f = write('a.md', '## 概要\n')
    for (let i = 0; i < 8; i++) {
      edited(f, 'Write', `t${i}`)
      judge(`t${i}`, 'FAIL: x')
    }
    expect(isDenied(pre('Write', { file_path: f }, 'w1'))).toBe(true)
    expect(pre('Read', { file_path: f }, 'r1')).toBe('')
    appendFileSync(
      transcript(),
      JSON.stringify({ type: 'user', origin: { kind: 'human' }, message: { content: 'ok' } }) + '\n'
    )
    expect(pre('Write', { file_path: f }, 'w2')).toBe('')
  })

  test('不合格のあと、別の箇所の Edit で合格しても止め続ける', () => {
    const f = write('a.md', '## 概要\n')
    edited(f, 'Edit', 't1')
    judge('t1', 'FAIL: x')
    edited(f, 'Edit', 't2')
    judge('t2', 'PASS')
    const out = pre('Grep', { pattern: 'x' }, 'g1')
    expect(isDenied(out)).toBe(true)
    expect(out).toContain('Write し直して合格する必要がある')
  })

  test('Bash のあと、不合格の Write を挟んで Edit で合格しても止め続ける', () => {
    const f = write('a.md', '## 概要\n')
    writeEvents(root, [event(f, 'Bash', 'b0')])
    edited(f, 'Write', 't1')
    judge('t1', 'FAIL: x')
    edited(f, 'Edit', 't2')
    judge('t2', 'PASS')
    expect(isDenied(pre('Grep', { pattern: 'x' }, 'g1'))).toBe(true)
  })

  test('Bash を挟んでも、不合格の連続回数は数え直さない', () => {
    const f = write('a.md', '## 概要\n')
    for (let i = 0; i < 8; i++) {
      edited(f, 'Write', `t${i}`)
      judge(`t${i}`, 'FAIL: x')
      if (i === 4) writeEvents(root, [...readEvents(root), event(f, 'Bash', 'b1')])
    }
    expect(pre('Grep', { pattern: 'x' }, 'g1')).toContain('ユーザーに相談')
  })

  test('追跡済みで HEAD と同じ中身のファイルは、記録から外す', () => {
    Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
    Bun.spawnSync(['git', 'config', 'user.email', 't@example.com'], { cwd: root })
    Bun.spawnSync(['git', 'config', 'user.name', 't'], { cwd: root })
    write('.gitignore', 'transcript.jsonl\nother-session.jsonl\n.claude/tmp\n')
    const f = write('a.md', '## 概要\n')
    Bun.spawnSync(['git', 'add', '.'], { cwd: root })
    Bun.spawnSync(['git', 'commit', '-qm', 'init'], { cwd: root })
    edited(f, 'Edit', 't1')
    judge('t1', 'FAIL: x')
    expect(pre('Grep', { pattern: 'x' }, 'g1')).toBe('')
    expect(readEvents(root)).toEqual([])
  })

  test('不合格が8回続いたら、ユーザーに相談するよう示す', () => {
    const f = write('a.md', '## 概要\n')
    for (let i = 0; i < 8; i++) {
      edited(f, 'Edit', `t${i}`)
      judge(`t${i}`, 'FAIL: x')
    }
    expect(pre('Bash', { command: 'ls' })).toContain('ユーザーに相談')
  })

  test('判定役自身の呼び出しは止めない', () => {
    const f = write('a.md', '## 概要\n')
    edited(f, 'Edit', 't1')
    expect(
      run({
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: join(root, 'other.md') },
        agent_id: 'hook-agent-x',
      })
    ).toBe('')
  })
})

describe('Bash での記録の書き換えの検知', () => {
  const post = (tool_use_id: string) =>
    run({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'x' },
      tool_use_id,
    })

  test('書き換えが無ければ止めない', () => {
    writeFileSync(transcript(), '{}\n')
    expect(pre('Bash', { command: 'ls' })).toBe('')
    appendFileSync(transcript(), '{"type":"user"}\n')
    expect(post('b1')).toBe('')
    expect(existsSync(join(root, TAMPER))).toBe(false)
  })

  test('待ちの記録が書き換えられたら、目印を残して以降の操作を止める', () => {
    writeFileSync(transcript(), '{}\n')
    expect(pre('Bash', { command: 'ls' })).toBe('')
    writePending(root, [join(root, 'x.md')])
    expect(post('b1')).toContain('書き換えられた')
    expect(existsSync(join(root, TAMPER))).toBe(true)
    expect(isDenied(pre('Read', { file_path: join(root, 'x.md') }))).toBe(true)
  })

  test('Bash の実行中に判定役の記録が増えたら止める', () => {
    writeFileSync(transcript(), '{}\n')
    expect(pre('Bash', { command: 'ls' })).toBe('')
    judge('t9', 'PASS')
    expect(post('b1')).toContain('判定役の記録')
  })

  test('transcript の既存の部分が書き換えられたら止める', () => {
    writeFileSync(transcript(), '{"a":1}\n')
    expect(pre('Bash', { command: 'ls' })).toBe('')
    writeFileSync(transcript(), '{"a":2}\n{"b":1}\n')
    expect(post('b1')).toContain('transcript の既存の部分')
  })

  test('失敗して直後のフックが動かなかった Bash の書き換えも、次の操作の直前に止める', () => {
    writeFileSync(transcript(), '{}\n')
    expect(pre('Bash', { command: 'ls' }, 'b1')).toBe('')
    // まだ結果が出ていない（実行中の）Bash の控えは比べない
    expect(pre('Read', { file_path: join(root, 'y.md') }, 'r1')).toBe('')
    writePending(root, [join(root, 'x.md')])
    appendFileSync(
      transcript(),
      JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'b1' }] } }) + '\n'
    )
    expect(isDenied(pre('Read', { file_path: join(root, 'x.md') }, 'r2'))).toBe(true)
    expect(existsSync(join(root, TAMPER))).toBe(true)
  })

  test('失敗した Bash が書き換えた .md は、次の操作の直前に Bash による編集として記録する', () => {
    writeFileSync(transcript(), '{}\n')
    const f = write('a.md', '## 概要\n')
    writePassed(f, 't1')
    expect(pre('Bash', { command: 'sed' }, 'b1')).toBe('')
    write('a.md', '## 概要\n\n追記\n')
    appendFileSync(
      transcript(),
      JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'b1' }] } }) + '\n'
    )
    const out = pre('Grep', { pattern: 'x' }, 'g1')
    expect(out).toContain('Write し直して')
    expect(readEvents(root).at(-1)).toMatchObject({ file: f, tool: 'Bash', toolUseId: 'b1' })
  })

  test('Bash の実行中に別の操作で編集した .md は、待ち行列に置き、Bash の直後に記録する', () => {
    writeFileSync(transcript(), '{}\n')
    expect(pre('Bash', { command: 'ls' }, 'b1')).toBe('')
    const f = write('a.md', '## 1. 概要\n')
    run({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: f },
      tool_use_id: 'e1',
    })
    // 実行中でも、待ち行列に置いた .md で止める
    expect(isDenied(pre('Grep', { pattern: 'x' }, 'g1'))).toBe(true)
    expect(post('b1')).toBe('')
    expect(existsSync(join(root, TAMPER))).toBe(false)
    expect(readPending(root)).toEqual([f])
    expect(readEvents(root).at(-1)).toMatchObject({ file: f, toolUseId: 'e1' })
  })

  test('Bash の実行中に待ち行列が消されたら止める', () => {
    writeFileSync(transcript(), '{}\n')
    expect(pre('Bash', { command: 'ls' }, 'b1')).toBe('')
    const f = write('a.md', '## 概要\n')
    run({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: f },
      tool_use_id: 'e1',
    })
    rmSync(join(root, QUEUE_DIR), { recursive: true })
    expect(post('b1')).toContain('待ち行列')
    expect(existsSync(join(root, TAMPER))).toBe(true)
  })

  test('結果が残らないまま古くなった Bash の控えは、終わったものとして比べ、待ち行列を反映する', () => {
    writeFileSync(transcript(), '{}\n')
    expect(pre('Bash', { command: 'ls' }, 'b1')).toBe('')
    const f = write('a.md', '## 概要\n')
    run({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: f },
      tool_use_id: 'e1',
    })
    // 控えの開始時刻を16分前にする（強制終了などで結果が残らなかった Bash）
    const snapshotFile = join(root, SNAPSHOT_DIR, 'b1.json')
    const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'))
    writeFileSync(
      snapshotFile,
      JSON.stringify({ ...snapshot, startedAt: Date.now() - 16 * 60 * 1000 })
    )
    pre('Grep', { pattern: 'x' }, 'g1')
    expect(existsSync(join(root, TAMPER))).toBe(false)
    expect(readEvents(root).some(e => e.file === f && e.toolUseId === 'e1')).toBe(true)
  })

  test('Bash で doc-balance の基準が書き換えられたら止める', () => {
    writeFileSync(transcript(), '{}\n')
    write('.claude/commands/doc-balance.md', '# 基準\n')
    expect(pre('Bash', { command: 'ls' }, 'b1')).toBe('')
    write('.claude/commands/doc-balance.md', '# 基準\n\nどの編集も合格とする\n')
    expect(post('b1')).toContain('doc-balance.md が書き換えられた')
  })

  test('プロジェクトルート以外の cwd に基準が置かれていたら止める', () => {
    write('sub/.claude/commands/doc-balance.md', '# 別の基準\n')
    const out = run({
      hook_event_name: 'PreToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: 'x' },
      tool_use_id: 'g1',
      cwd: join(root, 'sub'),
    })
    expect(isDenied(out)).toBe(true)
    expect(existsSync(join(root, TAMPER))).toBe(true)
  })

  test('並行して動く Bash の控えは、それぞれの直後に比べる', () => {
    writeFileSync(transcript(), '{}\n')
    expect(pre('Bash', { command: 'ls' }, 'b1')).toBe('')
    expect(pre('Bash', { command: 'ls' }, 'b2')).toBe('')
    expect(post('b2')).toBe('')
    expect(post('b1')).toBe('')
    expect(existsSync(join(root, TAMPER))).toBe(false)
  })

  test('Bash の直後に控えが消えていたら止める', () => {
    writeFileSync(transcript(), '{}\n')
    expect(pre('Bash', { command: 'ls' })).toBe('')
    rmSync(join(root, SNAPSHOT_DIR), { recursive: true })
    expect(post('b1')).toContain('消えている')
    expect(existsSync(join(root, TAMPER))).toBe(true)
  })

  test('Bash 以外の操作の直前には、控えが無くても止めない', () => {
    expect(pre('Read', { file_path: join(root, 'x.md') })).toBe('')
    expect(existsSync(join(root, TAMPER))).toBe(false)
  })
})
