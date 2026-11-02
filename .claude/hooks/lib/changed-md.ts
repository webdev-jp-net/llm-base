/**
 * Claude Code Hooks — 処理対象ファイルの特定
 *
 * Edit / Write は tool_input.file_path を対象にする。
 * Bash はファイルパスを渡してこないため、PreToolUse で touch した目印
 * （.claude/tmp/.bash-mark）より新しいファイルを対象にする。
 */

import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'
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

/** フック入力から処理対象のファイル一覧を決める */
export function targetFiles(
  input: HookInput,
  projectDir: string,
  extensions: Set<string>
): string[] {
  if (input.tool_name === 'Bash') return changedFilesSince(projectDir, extensions)
  if (input.tool_name !== 'Edit' && input.tool_name !== 'Write') return []
  const filePath = input.tool_input.file_path as string | undefined
  if (!filePath || !existsSync(filePath)) return []
  if (!extensions.has(extname(filePath).toLowerCase())) return []
  return [filePath]
}
