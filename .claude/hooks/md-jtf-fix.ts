#!/usr/bin/env bun
/**
 * Markdown JTF Fix — 保存時に textlint --fix で全角/半角スペースを整形 (PostToolUse → Edit|Write|Bash)
 *
 * JTF スタイル (textlint-rule-preset-JTF-style の 3.1.1) に従い、全角と半角の
 * 境目のスペースを除去する。ルール定義は .textlintrc.json、除外は .textlintignore。
 *
 * 対象: .md, .mdx のみ。逐語データ（*.json / *.jsonl）は .textlintignore で保護。
 * 無効化: MD_JTF_FIX_DISABLED=true
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { targetFiles } from './lib/changed-md.ts'
import { postContext, runHook } from './lib/hook-output.ts'
import type { HookInput } from './lib/hook-types.ts'
import { isInsideProject } from './lib/paths.ts'
import { readStdinJson } from './lib/read-stdin.ts'

const TARGET_EXTENSIONS = new Set(['.md', '.mdx'])

if (import.meta.main) {
  runHook('md-jtf-fix', async () => {
    if (process.env.MD_JTF_FIX_DISABLED === 'true') process.exit(0)

    const input = await readStdinJson<HookInput>()
    const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
    const bin = join(projectDir, 'node_modules', '.bin', 'textlint')
    if (!existsSync(bin)) process.exit(0)

    const fixed: string[] = []
    for (const filePath of targetFiles(input, projectDir, TARGET_EXTENSIONS)) {
      // プロジェクト内のファイルのみ対象（メモリ等リポジトリ外の .md には触れない）
      if (!isInsideProject(projectDir, filePath)) continue
      const before = readFileSync(filePath, 'utf8')
      spawnSync(bin, ['--fix', filePath], { cwd: projectDir, encoding: 'utf8' })
      const after = existsSync(filePath) ? readFileSync(filePath, 'utf8') : before
      if (after !== before) fixed.push(basename(filePath))
    }

    if (fixed.length > 0) {
      postContext(
        `[md-jtf-fix] ${fixed.join(', ')} の全角/半角スペースを JTF スタイルに整形しました。`
      )
    }
  })
}
