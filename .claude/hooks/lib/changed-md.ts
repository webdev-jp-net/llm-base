/**
 * Claude Code Hooks — 処理対象ファイルの特定
 *
 * Edit / Write は tool_input.file_path を対象にする。
 * Bash はファイルパスを渡してこないため、PreToolUse で touch した目印
 * （.claude/tmp/.bash-mark）より新しいファイルを対象にする。
 * .gitignore で追跡対象外のファイルは対象にしない（審査をそろえるのはリポジトリに入る文書）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import type { HookInput } from './hook-types.ts'

/** Bash 実行前に touch する目印（プロジェクトルート相対） */
export const BASH_MARK = '.claude/tmp/.bash-mark'

/** 走査しないディレクトリ */
const SKIP_DIRS = new Set(['node_modules', '.git'])

/** 目印より新しい対象拡張子のファイル。目印が無ければ空 */
export function changedFilesSince(projectDir: string, extensions: Set<string>): string[] {
  const mark = join(projectDir, BASH_MARK)
  if (!existsSync(mark)) return []
  const since = lstatSync(mark).mtimeMs
  const found: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (SKIP_DIRS.has(name)) continue
      const full = join(dir, name)
      const stat = lstatSync(full)
      if (stat.isDirectory()) walk(full)
      else if (
        stat.isFile() &&
        extensions.has(extname(name).toLowerCase()) &&
        stat.mtimeMs >= since
      )
        found.push(full)
    }
  }
  walk(projectDir)
  return found
}

/**
 * .gitignore で無視されるファイルを除く。追跡済みのファイルは除かない（--no-index を付けない）。
 * git リポジトリの外など git check-ignore が判定できないときは、何も除かない。
 */
export function withoutIgnored(projectDir: string, fileList: string[]): string[] {
  // ファイルごとに、そのファイルのあるディレクトリから判定する。
  // worktree の中のファイルは、その worktree のリポジトリの規則で判定される
  return fileList.filter(filePath => {
    const dir = dirname(filePath)
    const result = spawnSync('git', ['check-ignore', '-q', '--', filePath], {
      cwd: existsSync(dir) ? dir : projectDir,
    })
    // 0: 無視される / 1: 無視されない / それ以外: 判定できない（除かない）
    return result.status !== 0
  })
}

/** フック入力から処理対象のファイル一覧を決める */
export function targetFiles(
  input: HookInput,
  projectDir: string,
  extensions: Set<string>
): string[] {
  if (input.tool_name === 'Bash')
    return withoutIgnored(projectDir, changedFilesSince(projectDir, extensions))
  if (input.tool_name !== 'Edit' && input.tool_name !== 'Write') return []
  const filePath = input.tool_input.file_path as string | undefined
  if (!filePath || !existsSync(filePath)) return []
  if (!extensions.has(extname(filePath).toLowerCase())) return []
  return withoutIgnored(projectDir, [filePath])
}
