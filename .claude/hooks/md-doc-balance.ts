#!/usr/bin/env bun
/**
 * Markdown Doc Balance — 追記のバランス自己チェックで差し戻す (PostToolUse → Edit|Write|Bash)
 *
 * チェック項目の正本は .claude/commands/doc-balance.md。対象ファイルが 1 つでもあれば
 * その全文を reason として返し、差し戻す。
 *
 * 対象: .md, .mdx のみ。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { targetFiles } from './lib/changed-md.ts'
import { blockPost, runHook } from './lib/hook-output.ts'
import type { HookInput } from './lib/hook-types.ts'
import { isInsideProject } from './lib/paths.ts'
import { readStdinJson } from './lib/read-stdin.ts'

const TARGET_EXTENSION_LIST = new Set(['.md', '.mdx'])

if (import.meta.main) {
  runHook('md-doc-balance', async () => {
    const input = await readStdinJson<HookInput>()
    const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
    const criteria = join(projectDir, '.claude', 'commands', 'doc-balance.md')
    if (!existsSync(criteria)) process.exit(0)

    // プロジェクト内のファイルのみ対象（メモリ等リポジトリ外の .md には触れない）
    const hit = targetFiles(input, projectDir, TARGET_EXTENSION_LIST).some(filePath =>
      isInsideProject(projectDir, filePath)
    )
    if (!hit) process.exit(0)

    blockPost(
      `編集した .md にdoc-balanceの原則を適用して自己チェックすること（追記の分量・粒度・位置・構造・不要なナンバリングを周囲と揃っているか検問する）:\n\n${readFileSync(criteria, 'utf8')}`
    )
  })
}
