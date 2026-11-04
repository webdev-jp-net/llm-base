#!/usr/bin/env bun
/**
 * Markdown Lint Gate — 編集した .md が textlint と見出しlintを通るまで次の操作を止める
 * (PostToolUse → Edit|Write|Bash で記録 / PreToolUse → すべてのツールで判定)
 *
 * PostToolUse: 編集された .md を lint 待ちとして .claude/tmp/md-lint-pending.json に記録する。
 *   対象の決め方は md-jtf-fix・md-heading-lint と同じ（targetFiles・isInsideProject）。
 * PreToolUse: lint 待ちのファイルを textlint（--fix なし）と見出しlintで検査し、通ったものを外す。
 *   違反が残っていれば、違反ファイルの Read と Edit / Write 以外を拒否する。
 *   git commit を含む Bash の前には、コミットに入りうる .md も lint 待ちに加えて検査する。
 * 検査を次の操作の直前に行うのは、編集直後に並行して動く md-jtf-fix の整形が終わってから
 * 検査するため。
 *
 * 対象: .md, .mdx のみ。
 * 無効化: MD_LINT_GATE_DISABLED=true
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { targetFiles } from './lib/changed-md.ts'
import { blockPost, blockTool } from './lib/hook-output.ts'
import type { HookInput } from './lib/hook-types.ts'
import { isInsideProject } from './lib/paths.ts'
import { readStdinJson } from './lib/read-stdin.ts'
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

/** PostToolUse: 編集された .md を lint 待ちに加える */
function record(input: HookInput, projectDir: string): void {
  const editedList = targetFiles(input, projectDir, TARGET_EXTENSION_LIST)
    .filter(filePath => isInsideProject(projectDir, filePath))
    .map(filePath => resolve(filePath))
  if (editedList.length === 0) return
  writePending(projectDir, [...readPending(projectDir), ...editedList])
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
    const result = spawnSync('git', args, { cwd: projectDir, encoding: 'utf8' })
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

/** PreToolUse: lint 待ちを検査し、違反が残っていれば操作を拒否する */
function gate(input: HookInput, projectDir: string): void {
  const command = input.tool_name === 'Bash' ? String(input.tool_input?.command ?? '') : ''
  const pendingList = isCommitCommand(command)
    ? [...readPending(projectDir), ...committableMdList(projectDir)]
    : readPending(projectDir)
  if (pendingList.length === 0) return

  const problemList: string[] = []
  const failingList: string[] = []
  for (const filePath of pendingList) {
    if (!existsSync(filePath)) continue
    const fileProblemList = lintProblems(projectDir, filePath)
    if (fileProblemList.length === 0) continue
    failingList.push(filePath)
    problemList.push(...fileProblemList)
  }
  writePending(projectDir, failingList)
  if (failingList.length === 0) return
  if (isAllowedWhilePending(input.tool_name, input.tool_input ?? {}, failingList, projectDir))
    return

  blockTool(
    [
      '[md-lint-gate] 編集した .md が textlint・見出しlintを通っていないため、この操作は通せない。',
      '違反ファイルを直して lint を通すまで、違反ファイルの Read と Edit / Write 以外は止まる。',
      ...problemList,
    ].join('\n')
  )
}

if (import.meta.main) {
  let event = ''
  const main = async () => {
    if (process.env.MD_LINT_GATE_DISABLED === 'true') process.exit(0)
    const input = await readStdinJson<HookInput>()
    event = input.hook_event_name
    const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
    if (event === 'PostToolUse') record(input, projectDir)
    else gate(input, projectDir)
  }
  main().catch(e => {
    // 記録・判定ができないときは止める（read-gate と同じ fail-closed）
    const message = `[md-lint-gate] lint 待ちの記録・判定に失敗した: ${e instanceof Error ? e.message : e}`
    if (event === 'PostToolUse') blockPost(message)
    else blockTool(`${message}。この操作は通せない。`)
  })
}
