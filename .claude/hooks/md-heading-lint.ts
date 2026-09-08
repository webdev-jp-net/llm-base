#!/usr/bin/env bun
/**
 * Markdown Heading Lint — 見出しの構造的欠陥を警告 (PostToolUse → Edit|Write|Bash)
 *
 * 原則: 見出しはそのセクション全体を圧縮した 1 つの概念ラベルであること。副題・メタ・
 * 主張・番号を形式を問わず入れない。検出するのは形式の一部で、
 * 「セクション全体の忠実な圧縮か」は判定しない。
 *
 * 検出（形式の一部）:
 *   1. 見出しの連番プレフィックス       例: `## 1. 概要` — 順序が必須でなければ外す
 *   2. 見出しの副題（ダッシュ/コロン区切り） 例: `# 名前 — 副題` `## 概要：詳細` — ラベルは1つに
 *   3. 行頭の丸ごと太字（擬似見出し）     例: `**重要な点**` 単独行 — h2/h3 にすべき
 *
 * 対象: .md, .mdx のみ。コードブロック内はスキップ。
 * 無効化: MD_HEADING_LINT_DISABLED=true
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { targetFiles } from './lib/changed-md.ts'
import { postContext, runHook } from './lib/hook-output.ts'
import type { HookInput } from './lib/hook-types.ts'
import { isInsideProject } from './lib/paths.ts'
import { readStdinJson } from './lib/read-stdin.ts'

export const TARGET_EXTENSIONS = new Set(['.md', '.mdx'])

const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/
const ORDINAL_RE = /^\d+[.)]\s/
const SUBTITLE_RE = /\s[–—]\s|\s-\s|：|:\s/ // — / – / " - " / 全角コロン / "半角コロン+空白"
const BOLD_LINE_RE = /^\*\*[^*].*\*\*/

export interface Finding {
  line: number
  kind: 'ordinal' | 'subtitle' | 'bold-heading'
  text: string
}

/** 文書を走査して見出しの構造的欠陥を返す（コードブロック内は無視） */
export function lintHeadings(content: string): Finding[] {
  const findings: Finding[] = []
  let inCodeBlock = false

  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock
      continue
    }
    if (inCodeBlock) continue

    const heading = line.match(HEADING_RE)
    if (heading) {
      const title = heading[2]
      if (ORDINAL_RE.test(title)) {
        findings.push({ line: i + 1, kind: 'ordinal', text: line.trim() })
      }
      if (SUBTITLE_RE.test(title)) {
        findings.push({ line: i + 1, kind: 'subtitle', text: line.trim() })
      }
      continue
    }

    if (BOLD_LINE_RE.test(line.trim())) {
      findings.push({
        line: i + 1,
        kind: 'bold-heading',
        text: line.trim().slice(0, 60),
      })
    }
  }
  return findings
}

const REASON: Record<Finding['kind'], string> = {
  ordinal: '連番プレフィックス（順序が必須でなければ外す）',
  subtitle: '副題（ダッシュ/コロン等の区切り。内容ラベル 1 つに圧縮する）',
  'bold-heading': '行頭の丸ごと太字（擬似見出し。h2/h3 にする）',
}

/** findings を人間可読の警告文にまとめる */
export function formatReport(fileName: string, findings: Finding[]): string {
  const lines = findings.slice(0, 20).map(f => `  - L${f.line} [${REASON[f.kind]}]: ${f.text}`)
  const more = findings.length > 20 ? `\n  … 他 ${findings.length - 20} 件` : ''
  return [
    `[md-heading-lint] ${fileName} の見出しに構造的な注意点があります（警告のみ・自動修正なし）:`,
    ...lines,
    more,
    '原則: 見出しはセクション全体を圧縮した 1 つの概念ラベル。副題・メタ・主張・番号を形式を問わず入れない。この警告は形式の一部を検出する補助にすぎず、『セクション全体の忠実な圧縮か』の判定は書き手が行う。',
  ]
    .filter(Boolean)
    .join('\n')
}

// --- CLI エントリーポイント ---
if (import.meta.main) {
  runHook('md-heading-lint', async () => {
    if (process.env.MD_HEADING_LINT_DISABLED === 'true') process.exit(0)

    const input = await readStdinJson<HookInput>()
    const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()

    const reports: string[] = []
    for (const filePath of targetFiles(input, projectDir, TARGET_EXTENSIONS)) {
      // プロジェクト内のファイルのみ対象（メモリ等リポジトリ外の .md には触れない）
      if (!isInsideProject(projectDir, filePath)) continue
      const findings = lintHeadings(readFileSync(filePath, 'utf8'))
      if (findings.length > 0) reports.push(formatReport(basename(filePath), findings))
    }

    if (reports.length > 0) postContext(reports.join('\n'))
  })
}
