#!/usr/bin/env bun
/**
 * Markdown Lint Gate — 編集した .md が textlint・見出しlint・doc-balance を通るまで次の操作を止める
 * (PostToolUse → Edit|Write|Bash で記録 / PreToolUse → すべてのツールで判定)
 *
 * PostToolUse: 編集された .md を lint 待ちとして .claude/tmp/md-lint-pending.json に記録する。
 *   あわせて、doc-balance の判定を待つ編集として呼び出しIDを記録する（lib/balance-verdict.ts）。
 *   対象の決め方は md-jtf-fix・md-heading-lint と同じ（targetFiles・isInsideProject）。
 * PreToolUse: lint 待ちのファイルを textlint（--fix なし）と見出しlintで検査し、通ったものを外す。
 *   doc-balance の直近の判定が不合格または未判定のファイルも残す。
 *   残っていれば、そのファイルの Read と Edit / Write 以外を拒否する。
 *   git commit を含む Bash の前には、コミットに入りうる .md も加えて検査する。
 * Bash の直前には HEAD と参照の先を控え、直後に、その Bash で作られたコミットに
 *   doc-balance に合格した中身と違う .md が入っていないかを確かめる（控えは lib/record-guard.ts）。
 *   失敗した Bash では直後のフックが動かないので、控えが残っていれば次の操作の直前に確かめ、
 *   その Bash が書き換えた .md を Bash による編集として記録する。
 * agent 型フックの判定役自身の呼び出し（agent_id が hook-agent- で始まる）は対象にしない。
 * 検査を次の操作の直前に行うのは、編集直後に並行して動く md-jtf-fix の整形が終わってから
 * 検査するため。
 *
 * 対象: .md, .mdx のみ。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import {
  type EditEvent,
  balanceStatus,
  lastHumanLine,
  MAX_FAIL_STREAK,
  pruneEvents,
  readEvents,
  readVerdicts,
  writeEvents,
} from './lib/balance-verdict.ts'
import {
  filesModifiedSince,
  targetFiles,
  unchangedFromHead,
  withoutIgnored,
} from './lib/changed-md.ts'
import { blockPost, blockTool } from './lib/hook-output.ts'
import type { HookInput } from './lib/hook-types.ts'
import { isInsideProject } from './lib/paths.ts'
import { readStdinJson } from './lib/read-stdin.ts'
import {
  fileHash,
  finishedSnapshots,
  markTampered,
  readTamper,
  removeSnapshot,
  saveSnapshot,
  TAMPER,
  withLock,
} from './lib/record-guard.ts'
import { formatReport, lintHeadingList } from './md-heading-lint.ts'

const TARGET_EXTENSION_LIST = new Set(['.md', '.mdx'])

/** lint 待ちの記録（プロジェクトルート相対） */
export const PENDING = '.claude/tmp/md-lint-pending.json'

/** lint 待ちの間も、違反ファイルが対象なら通すツール */
const FIX_TOOL_LIST = new Set(['Read', 'Edit', 'Write'])

/** lint 待ちの一覧。記録が無ければ空。壊れていれば例外 */
export function readPending(projectDir: string): string[] {
  const path = join(projectDir, PENDING)
  if (!existsSync(path)) return []
  const list = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(list)) throw new Error(`${PENDING} が配列ではない`)
  return list.filter((f): f is string => typeof f === 'string')
}

export function writePending(projectDir: string, fileList: string[]): void {
  const path = join(projectDir, PENDING)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify([...new Set(fileList)].sort(), null, 2))
}

/** textlint の違反行。違反が無ければ空。textlint が無ければ検査しない（md-jtf-fix と同じ） */
function textlintViolationList(projectDir: string, filePath: string): string[] {
  const bin = join(projectDir, 'node_modules', '.bin', 'textlint')
  if (!existsSync(bin)) return []
  const result = spawnSync(bin, ['--format', 'unix', filePath], {
    cwd: projectDir,
    encoding: 'utf8',
  })
  if (result.status === 0) return []
  // 1 は違反あり。それ以外は検査そのものが失敗している
  if (result.status !== 1) {
    throw new Error(`textlint を実行できない: ${(result.stderr || result.stdout).trim()}`)
  }
  return result.stdout
    .split('\n')
    .filter(line => line.startsWith(filePath))
    .map(line => line.slice(filePath.length + 1))
}

/** ファイルの違反をすべて返す。通っていれば空 */
export function lintProblems(projectDir: string, filePath: string): string[] {
  const name = relative(projectDir, filePath)
  const problemList = textlintViolationList(projectDir, filePath).map(
    line => `[textlint] ${name}:${line}`
  )
  const findingList = lintHeadingList(readFileSync(filePath, 'utf8'))
  if (findingList.length > 0) problemList.push(formatReport(name, findingList))
  return problemList
}

/** lint 待ちの間も通す操作か（違反ファイルを読む・直す操作だけ） */
export function isAllowedWhilePending(
  toolName: string,
  toolInput: Record<string, unknown>,
  failingList: string[],
  projectDir: string
): boolean {
  if (!FIX_TOOL_LIST.has(toolName)) return false
  const filePath = toolInput.file_path
  if (typeof filePath !== 'string') return false
  return failingList.includes(resolve(projectDir, filePath))
}

/** 判定役が読む doc-balance の基準（プロジェクトルート相対） */
const CRITERIA = '.claude/commands/doc-balance.md'

/**
 * 判定役は基準をフック入力の cwd の下から読む。cwd がプロジェクトルート以外で、
 * そこに別の基準が置かれていれば、判定役が違う基準で判定するので書き換えとみなす
 */
function checkCriteriaLocation(input: HookInput, projectDir: string): void {
  const cwd = resolve(input.cwd ?? projectDir)
  if (cwd === resolve(projectDir)) return
  if (existsSync(join(cwd, CRITERIA)))
    markTampered(projectDir, [
      `プロジェクトルート以外（${cwd}）に doc-balance の基準が置かれている`,
    ])
}

interface Edited {
  tool: string
  toolUseId: string
  transcriptPath: string
}

/** 編集された .md を lint 待ちと doc-balance の判定待ちに記録する */
function recordFiles(projectDir: string, fileList: string[], edit: Edited): void {
  const editedList = fileList
    .filter(filePath => isInsideProject(projectDir, filePath))
    .map(filePath => resolve(filePath))
  if (editedList.length === 0) return
  writePending(projectDir, [...readPending(projectDir), ...editedList])
  writeEvents(projectDir, [
    ...readEvents(projectDir),
    ...editedList.map(file => ({ file, ...edit })),
  ])
}

/** PostToolUse: 編集された .md を記録する */
function record(input: HookInput, projectDir: string): void {
  recordFiles(projectDir, targetFiles(input, projectDir, TARGET_EXTENSION_LIST), {
    tool: input.tool_name,
    toolUseId: input.tool_use_id ?? '',
    transcriptPath: input.transcript_path ?? '',
  })
}

/** Bash の直前の HEAD を控える場所（プロジェクトルート相対）。中身は呼び出しIDごとのファイル */
const HEAD_DIR = '.claude/tmp/md-lint-head'

const headPath = (projectDir: string, toolUseId: string) =>
  join(projectDir, HEAD_DIR, `${toolUseId.replace(/[^\w-]/g, '_')}.json`)

/** git の出力。失敗したら null */
function gitOutput(projectDir: string, args: string[]): string | null {
  const result = spawnSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd: projectDir,
    encoding: 'utf8',
  })
  return result.status === 0 ? result.stdout : null
}

/** Bash の直前に、HEAD とすべての参照の指す先を控える */
function saveHead(projectDir: string, toolUseId: string): void {
  const head = gitOutput(projectDir, ['rev-parse', '--verify', '-q', 'HEAD'])?.trim() ?? ''
  // rebase の途中でも、枝の参照は rebase 前の枝先を指している
  const tipList = (gitOutput(projectDir, ['for-each-ref', '--format=%(objectname)']) ?? '')
    .split('\n')
    .filter(Boolean)
  const path = headPath(projectDir, toolUseId)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ head, tipList, startedAt: Date.now() }))
}

/**
 * コミットの中のファイル（<コミット>:<パス>）と同じ中身が、Bash の前からあるコミットにすでにあるか。
 * amend・rebase・cherry-pick・revert での作り直しは、元の中身がここで見つかる。
 * 探すのは Bash の直前に控えた参照の先だけ（同じ Bash の中で別の参照に作ったコミットは数えない）
 */
function existedBefore(projectDir: string, object: string, tipList: string[]): boolean {
  if (tipList.length === 0) return false
  const blob = gitOutput(projectDir, ['rev-parse', object])?.trim()
  if (!blob) return false
  const found = gitOutput(projectDir, [
    'log',
    '--format=%H',
    '-1',
    `--find-object=${blob}`,
    ...new Set(tipList),
  ])
  return (found ?? '').trim() !== ''
}

/**
 * Bash の間に作られたコミットに、doc-balance に合格した中身と違う .md が入っていないかを確かめる。
 * コミットのコマンドの形（別名・スクリプト・merge など）に関係なく、HEAD の変化から拾う。
 * コミットされた中身は、合格を確かめた時の中身（passedHash）と同じでなければならない
 */
function checkNewCommits(projectDir: string, toolUseId: string): string[] {
  const path = headPath(projectDir, toolUseId)
  if (!existsSync(path)) return []
  const {
    head,
    tipList = [],
    startedAt,
  } = JSON.parse(readFileSync(path, 'utf8')) as {
    head: string
    tipList?: string[]
    startedAt: number
  }
  rmSync(path)
  const now = gitOutput(projectDir, ['rev-parse', '--verify', '-q', 'HEAD'])?.trim() ?? ''
  if (!now || now === head) return []

  const eventList = readEvents(projectDir)
  const verdicts = readVerdicts(eventList)
  const problemList: string[] = []
  const logLines = (
    gitOutput(projectDir, ['log', '--format=%H %ct %P', head ? `${head}..${now}` : now]) ?? ''
  )
    .split('\n')
    .filter(Boolean)
  for (const logLine of logLines) {
    const [sha, committedAt, ...parentList] = logLine.split(' ')
    // この Bash の間に作られたコミットだけを見る（pull で入った他人のコミットは見ない）
    if (Number(committedAt) * 1000 < startedAt - 2000) continue
    const diffArgs =
      parentList.length > 1
        ? ['diff-tree', '--cc', '--no-commit-id', '--name-only', '-r', sha]
        : ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '--diff-filter=ACMR', sha]
    const pathList = (gitOutput(projectDir, diffArgs) ?? '')
      .split('\n')
      .filter(p => p && TARGET_EXTENSION_LIST.has(extname(p).toLowerCase()))
    for (const rel of pathList) {
      // .gitignore で追跡対象外のファイルは審査の対象外（強制的に追加して追跡済みのものは対象）
      if (spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd: projectDir }).status === 0)
        continue
      // amend・rebase・cherry-pick などでの作り直し: 同じ中身が、この Bash より前のコミットにすでにある
      if (existedBefore(projectDir, `${sha}:${rel}`, [head, ...tipList].filter(Boolean))) continue
      const blob = spawnSync('git', ['show', `${sha}:${rel}`], { cwd: projectDir })
      const blobHash = createHash('sha256')
        .update(blob.stdout ?? '')
        .digest('hex')
      const file = resolve(projectDir, rel)
      const status = balanceStatus(eventList, verdicts, file)
      const last = eventList.findLast(e => e.file === file)
      if (status.kind !== 'pass' || last?.passedHash !== blobHash)
        problemList.push(
          `doc-balance に合格した中身と違う ${rel} がコミットされた（${sha.slice(0, 7)}）`
        )
    }
  }
  return problemList
}

/**
 * PreToolUse: 直後のフックが動かなかった（失敗した）Bash について、作られたコミットを確かめ、
 * その Bash が書き換えた .md を、Bash による編集として記録する
 */
function settleFinishedBash(projectDir: string): void {
  const finishedList = finishedSnapshots(projectDir)
  const problemList = finishedList.flatMap(bash => checkNewCommits(projectDir, bash.toolUseId))
  if (problemList.length > 0) markTampered(projectDir, problemList)
  for (const bash of finishedList) {
    const fileList = withoutIgnored(
      projectDir,
      filesModifiedSince(projectDir, TARGET_EXTENSION_LIST, bash.startedAt)
    )
    recordFiles(projectDir, fileList, {
      tool: 'Bash',
      toolUseId: bash.toolUseId,
      transcriptPath: bash.transcriptPath,
    })
  }
}

/** Bash の直後: 審査を通っていない中身がコミットされていれば、目印を残して差し戻す */
function detect(input: HookInput, projectDir: string): void {
  removeSnapshot(projectDir, input.tool_use_id ?? '')
  const problemList = checkNewCommits(projectDir, input.tool_use_id ?? '')
  if (problemList.length === 0) return
  markTampered(projectDir, problemList)
  const message = [
    '[md-lint-gate] Bash で、審査を通っていない中身がコミットされた。すべての操作を止める。',
    ...problemList,
    `ユーザーが確かめて ${TAMPER} を消すまで、作業を再開しない。`,
  ].join('\n')
  blockPost(message, message)
}

/** git commit を含む Bash コマンドか */
export function isCommitCommand(command: string): boolean {
  return /\bgit\b[^;&|]*\bcommit\b/.test(command)
}

/**
 * コミットに入りうる .md（HEAD との差分があるものと、ignore されていない未追跡のもの）。
 * 編集時の記録をすり抜けた .md（MCP ツールでの編集、mtime を保つ mv / cp -p など）を拾う。
 * 同じコマンドの git add で加わるファイルも拾えるよう、未追跡のものも含める。
 */
export function committableMdList(projectDir: string): string[] {
  const git = (args: string[]) => {
    // 日本語のファイル名を引用符で囲ませない（拡張子の判定から漏れるため）
    const result = spawnSync('git', ['-c', 'core.quotepath=off', ...args], {
      cwd: projectDir,
      encoding: 'utf8',
    })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} に失敗した: ${result.stderr}`)
    return result.stdout.split('\n').filter(Boolean)
  }
  // まだコミットが無ければ HEAD との差分は取れないので、インデックスにあるものを対象にする
  const hasHead =
    spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: projectDir }).status === 0
  const pathList = [
    ...(hasHead
      ? git(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD'])
      : git(['ls-files', '--cached'])),
    ...git(['ls-files', '--others', '--exclude-standard']),
  ]
  return pathList
    .filter(path => TARGET_EXTENSION_LIST.has(extname(path).toLowerCase()))
    .map(path => resolve(projectDir, path))
}

/** doc-balance の直近の判定が不合格または未判定のファイルと、その理由 */
function balanceProblems(
  input: HookInput,
  projectDir: string,
  extraList: string[]
): { failingList: string[]; problemList: string[]; stopAll: boolean } {
  // 不合格の回数は、ユーザーの最後の発言より後の判定だけを数える
  const streakStart = {
    transcriptPath: input.transcript_path ?? '',
    line: lastHumanLine(input.transcript_path),
  }
  let stopAll = false
  const recordedList: EditEvent[] = readEvents(projectDir)
  // 追跡済みで HEAD と同じ中身のファイルは、すでにコミットされた内容なので記録から外す
  // （コミット済みの合格、git pull・checkout で入れ替わったファイル）
  const committed = unchangedFromHead(projectDir, [...new Set(recordedList.map(e => e.file))])
  const eventList = recordedList.filter(e => !committed.has(e.file))
  const verdicts = readVerdicts(eventList)
  const fileList = [...new Set([...eventList.map(e => e.file), ...extraList])]
  const failingList: string[] = []
  const passedList: string[] = []
  const problemList: string[] = []
  for (const file of fileList) {
    if (!existsSync(file)) continue
    let status = balanceStatus(eventList, verdicts, file, streakStart)
    if (status.kind === 'pass') {
      // 合格は、最初に確かめた時の中身に対してだけ有効にする
      const last = eventList.findLast(e => e.file === file)
      const current = fileHash(file) ?? ''
      if (last && last.passedHash === undefined) last.passedHash = current
      if (last && last.passedHash === current) {
        passedList.push(file)
        continue
      }
      // 記録の残らない経路で中身が変わった。Bash での書き換えと同じく、Write し直すまで外さない
      eventList.push({
        file,
        toolUseId: `changed-after-pass-${Date.now()}`,
        tool: 'Bash',
        transcriptPath: '',
      })
      status = balanceStatus(eventList, verdicts, file, streakStart)
      if (status.kind === 'pass') continue
    }
    failingList.push(file)
    problemList.push(`[doc-balance] ${relative(projectDir, file)}: ${status.reason}`)
    if (status.failStreak >= MAX_FAIL_STREAK) {
      stopAll = true
      problemList.push(
        `[doc-balance] ${relative(projectDir, file)} は不合格が${status.failStreak}回続いている。直すのをやめ、止まったままユーザーに相談すること。ユーザーが返事をするまで、Read 以外の操作は止まる。`
      )
    }
  }
  writeEvents(
    projectDir,
    pruneEvents(eventList, passedList).filter(e => existsSync(e.file))
  )
  return { failingList, problemList, stopAll }
}

/** PreToolUse: lint 待ちと doc-balance を検査し、通っていないものがあれば操作を拒否する。拒否したら true */
function gate(input: HookInput, projectDir: string): boolean {
  const tamper = readTamper(projectDir)
  if (tamper !== null) {
    const message = [
      '[md-lint-gate] 審査を通っていない中身のコミット、または基準の置き換えを検知したため、すべての操作を止めている。',
      tamper,
      `ユーザーが確かめて ${TAMPER} を消すまで、作業を再開しない。`,
    ].join('\n')
    blockTool(message, message)
    return true
  }

  const command = input.tool_name === 'Bash' ? String(input.tool_input?.command ?? '') : ''
  const committableList = isCommitCommand(command) ? committableMdList(projectDir) : []
  const pendingList = [...readPending(projectDir), ...committableList]

  const problemList: string[] = []
  const lintFailingList: string[] = []
  for (const filePath of new Set(pendingList)) {
    if (!existsSync(filePath)) continue
    const fileProblemList = lintProblems(projectDir, filePath)
    if (fileProblemList.length === 0) continue
    lintFailingList.push(filePath)
    problemList.push(...fileProblemList)
  }
  writePending(projectDir, lintFailingList)

  const balance = balanceProblems(input, projectDir, committableList)
  problemList.push(...balance.problemList)
  const failingList = [...new Set([...lintFailingList, ...balance.failingList])]
  if (failingList.length === 0) return false
  // 不合格が続いたら、ユーザーが返事をするまで Read 以外はすべて止める
  if (balance.stopAll) {
    if (input.tool_name === 'Read') return false
    blockTool(['[md-lint-gate] doc-balance の不合格が続いている。', ...problemList].join('\n'))
    return true
  }
  if (isAllowedWhilePending(input.tool_name, input.tool_input ?? {}, failingList, projectDir))
    return false

  blockTool(
    [
      '[md-lint-gate] 編集した .md が textlint・見出しlint・doc-balance を通っていないため、この操作は通せない。',
      '違反ファイルを直して通すまで、違反ファイルの Read と Edit / Write 以外は止まる。',
      ...problemList,
    ].join('\n')
  )
  return true
}

/** agent 型フックの判定役自身の呼び出しか */
export function isHookAgent(input: HookInput): boolean {
  return input.agent_id?.startsWith('hook-agent-') === true
}

if (import.meta.main) {
  let event = ''
  let received: HookInput | undefined
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
  const main = async () => {
    const input = await readStdinJson<HookInput>()
    received = input
    event = input.hook_event_name
    if (isHookAgent(input)) return
    const isBash = input.tool_name === 'Bash'
    // 並行して動くフック同士が記録を同時に読み書きしないよう、1つずつ順に動かす
    await withLock(projectDir, () => {
      if (event === 'PreToolUse') {
        // 失敗した Bash では直後のフックが動かないので、残った控えをここで片付ける
        settleFinishedBash(projectDir)
        checkCriteriaLocation(input, projectDir)
        const blocked = gate(input, projectDir)
        if (isBash && !blocked) {
          saveSnapshot(projectDir, input.transcript_path ?? '', input.tool_use_id ?? '')
          saveHead(projectDir, input.tool_use_id ?? '')
        }
        return
      }
      if (isBash) detect(input, projectDir)
      record(input, projectDir)
    })
  }
  main().catch(e => {
    // 記録・判定ができないときは止める（read-gate と同じ fail-closed）
    const message = `[md-lint-gate] lint 待ちの記録・判定に失敗した: ${e instanceof Error ? e.message : e}`
    if (event !== 'PreToolUse') {
      // 直後の記録に失敗しても編集を失わないよう、ロックを取らずに記録を試みる
      try {
        if (received) record(received, projectDir)
      } catch {
        // 記録もできなければ、差し戻しだけを返す
      }
      blockPost(message)
    } else blockTool(`${message}。この操作は通せない。`)
  })
}
