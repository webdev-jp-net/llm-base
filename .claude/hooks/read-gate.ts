#!/usr/bin/env bun
/**
 * Read Gate — 必読ファイルの読了を確認するまで変更操作を拒否する
 * (PreToolUse → Edit | Write | NotebookEdit | Bash)
 *
 * 読了の判定材料はセッションの記録（transcript）のみ。成功した Read の file_path だけを
 * 読了とみなす。注入された写しは読了に数えない。
 * コンパクションで会話が要約に置き換わると読んだ内容が消えるため、要約より前の読了は数えない。
 *
 * Bash は許可リスト方式。参照系と確認できないコマンドは拒否する。
 * 判定できない場合も拒否する。
 */

import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { blockTool } from './lib/hook-output.ts'
import { readStdinJson } from './lib/read-stdin.ts'
import { readToolCalls, successful } from './lib/transcript.ts'

interface Input {
  tool_name: string
  tool_input: Record<string, unknown>
  transcript_path?: string
  cwd?: string
}

/** 比較の基準にするプロジェクトルート */
let projectRoot = ''

/** 配下の .md をすべて必読とするディレクトリ */
const REQUIRED_DIR = '_llm-rules'

/** ディレクトリの外にある必読ファイル */
const REQUIRED_EXTRA = ['_llm-docs/project.md', '_llm-docs/operation/dictionary.md']

/**
 * 読み取りと確認できる MCP ツール（完全一致）。ここに無い MCP ツールはすべて拒否する。
 * 未知のサーバーのツールが読み取り専用かは名前から判断できないため、許可は列挙でしか与えない。
 */
const READ_ONLY_MCP_TOOLS = new Set([
  'mcp__serena__find_symbol',
  'mcp__serena__find_declaration',
  'mcp__serena__find_implementations',
  'mcp__serena__find_referencing_symbols',
  'mcp__serena__get_symbols_overview',
  'mcp__serena__get_diagnostics_for_file',
  'mcp__serena__initial_instructions',
])

export interface RequiredFiles {
  files: string[]
  /** 必須の対象が見つからなかった理由。空でなければ判定が成立していない */
  missing: string[]
}

/** 必読ファイルの一覧。ファイル名は持たず、ディレクトリを走査して作る */
export function requiredFiles(root: string): RequiredFiles {
  const files: string[] = []
  const missing: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.md')) files.push(relative(root, full))
    }
  }
  const dir = join(root, REQUIRED_DIR)
  if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir)
  // ディレクトリはあるが .md が1件も無い場合も、ルールが失われた状態として扱う
  if (!files.length) missing.push(`${REQUIRED_DIR}/*.md`)
  for (const path of REQUIRED_EXTRA) {
    if (existsSync(join(root, path))) files.push(path)
    else missing.push(path)
  }
  // 実行記録。欠けていても missing には入れない（初期化前として別に扱う）
  files.push(...recordFiles(root))
  return { files, missing }
}

/** 実行記録の置き場所 */
const RECORDS_DIR = '_llm-memories'

/** 実行記録のファイル名。直下のこの3つだけを見る */
const RECORD_NAMES = ['state.md', 'lessons.md', 'episodes.md']

/** 何かが存在するか（シンボリックリンクの実体を追わない） */
function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** 中身のある実行記録の一覧。欠けているもの・空のもの・実ファイルでないものは数えない */
export function recordFiles(root: string): string[] {
  const dir = join(root, RECORDS_DIR)
  if (!exists(dir) || !lstatSync(dir).isDirectory()) return []
  return RECORD_NAMES.filter(name => {
    const full = join(dir, name)
    if (!exists(full)) return false
    const stat = lstatSync(full)
    return stat.isFile() && stat.size > 0
  }).map(name => `${RECORDS_DIR}/${name}`)
}

/** 3つ揃っているか */
export function recordsReady(root: string): boolean {
  return recordFiles(root).length === RECORD_NAMES.length
}

/**
 * 未作成の実行記録を作る操作か。
 * 既にあるものの書き換えも、置き場所の外への書き込みも通さない。
 */
export function isRecordCreation(toolName: string, filePath: unknown, root: string): boolean {
  if (toolName !== 'Write') return false
  if (typeof filePath !== 'string') return false
  const dir = join(root, RECORDS_DIR)
  // 置き場所がディレクトリでない（シンボリックリンク等）なら通さない
  if (exists(dir) && !lstatSync(dir).isDirectory()) return false
  const abs = resolve(root, filePath)
  if (!RECORD_NAMES.some(name => abs === resolve(dir, name))) return false
  if (!exists(abs)) return true
  // 空の実ファイルは未作成と同じ扱い。中身のあるものとリンクは通さない
  const stat = lstatSync(abs)
  return stat.isFile() && stat.size === 0
}

/**
 * 読み取り専用として通す Bash コマンド（許可リスト）。
 */
const READ_ONLY_COMMANDS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'grep',
  'rg',
  'find',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'echo',
  'printf',
  'pwd',
  'which',
  'type',
  'file',
  'stat',
  'du',
  'df',
  'date',
  'ps',
  'jq',
  'diff',
  'tree',
  'basename',
  'dirname',
  'realpath',
  'true',
  'test',
  'sleep',
])

/** 参照系に限って通す git のサブコマンド */
const READ_ONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set([
    'status',
    'log',
    'diff',
    'show',
    'blame',
    'describe',
    'rev-parse',
    'ls-files',
    'shortlog',
  ]),
}

/** これらを含むコマンドは解析不能として拒否する */
const UNPARSEABLE = /\$\(|`|<<|<\(|>\(|\\\n/

/**
 * 許可コマンドでも拒否するオプション。
 * long はトークンとの前方一致、short は短縮オプションのクラスタに含まれる1文字。
 */
const WRITING_OPTIONS: Record<string, { long?: RegExp; short?: string }> = {
  printf: { short: 'v' },
  find: { long: /^-(exec|execdir|delete|ok|okdir|fprint|fprint0|fls|fprintf)$/ },
  // --compress-program は一時ファイルの圧縮に外部プログラムを起動できる
  sort: { long: /^(--output|--compress-program)/, short: 'o' },
  diff: { long: /^--output/ },
  // -C / --compile はコンパイル済み magic ファイルを書き出す
  file: { long: /^--compile/, short: 'C' },
  git: { long: /^(--config-env|--ext-diff$|--textconv$|--output)/ },
  tree: { short: 'o' },
  date: { long: /^--set/, short: 's' },
}

/**
 * オプションではなく引数の位置で書き込むコマンド。2つめのオペランドが出力先になる。
 * 値を別トークンで取るオプションは、その値をオペランドと数えないため読み飛ばす。
 */
/**
 * オペランドの位置で書き込むコマンドの判定。
 * `valueOptions` は値を別トークンで取るオプション（その値はオペランドではない）。
 * `readOnly` はオペランド列が参照だけかを判定する。
 */
const OPERAND_RULES: Record<
  string,
  { valueOptions: Set<string>; readOnly: (operands: string[]) => boolean }
> = {
  // uniq IN OUT は2つめのオペランドへ書き出す
  uniq: { valueOptions: new Set(['-f', '-s', '-w']), readOnly: o => o.length < 2 },
  // date はオペランドでシステム時刻を変更できる（date 010100002026）。+書式 の出力だけを通す
  date: {
    valueOptions: new Set(['-r', '-v', '-f', '-d']),
    readOnly: o => o.every(v => v.startsWith('+')),
  },
}

/** 展開の結果を判定できない文字。書き込みオプションを持つコマンドの引数では拒否する */
const EXPANDABLE = /[$*?[\]]/

interface ScannedChar {
  ch: string
  /** 引用符の中、またはエスケープされている文字 */
  literal: boolean
}

/** コマンド文字列を1度だけ走査し、各文字が構文として働くかを判定する */
function scan(command: string): ScannedChar[] {
  const out: ScannedChar[] = []
  let quote: string | null = null
  let escaped = false
  for (const ch of command) {
    if (escaped) {
      out.push({ ch, literal: true })
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) {
        quote = null
        continue
      }
      out.push({ ch, literal: true })
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    out.push({ ch, literal: false })
  }
  return out
}

/** 走査結果を、実行される単位に分解する */
function splitSegments(scanned: ScannedChar[]): ScannedChar[][] {
  const parts: ScannedChar[][] = []
  let current: ScannedChar[] = []
  for (const c of scanned) {
    if (!c.literal && (c.ch === '|' || c.ch === ';' || c.ch === '&' || c.ch === '\n')) {
      parts.push(current)
      current = []
      continue
    }
    current.push(c)
  }
  parts.push(current)
  return parts.filter(p => p.some(c => !/\s/.test(c.ch)))
}

interface Token {
  value: string
  /** 引用符やエスケープを含むトークン。構文としては解釈しない */
  literal: boolean
}

function tokenize(segment: ScannedChar[]): Token[] {
  const tokens: Token[] = []
  let value = ''
  let literal = false
  let started = false
  for (const c of segment) {
    if (!c.literal && /\s/.test(c.ch)) {
      if (started) tokens.push({ value, literal })
      value = ''
      literal = false
      started = false
      continue
    }
    if (c.ch === '(' || c.ch === '{') {
      if (!c.literal && !started) continue
    }
    value += c.ch
    literal = literal || c.literal
    started = true
  }
  if (started) tokens.push({ value, literal })
  return tokens
}

/** 書き込むリダイレクトを含むか（引用符の外にあるもの） */
function hasRedirect(segment: ScannedChar[]): boolean {
  return segment.some((c, i) => {
    if (c.literal || c.ch !== '>') return false
    const prev = segment[i - 1]
    // <> は読み書きで開き、ファイルが無ければ作成する
    if (prev?.ch === '<' && !prev.literal) return true
    return !prev || !['=', '>', '-'].includes(prev.ch) || prev.literal
  })
}

function isReadOnly(segment: ScannedChar[]): boolean {
  if (hasRedirect(segment)) return false
  const tokens = tokenize(segment)
  // コマンド名の前に置く環境変数の指定は通さない（引数位置の FOO=bar は値として扱う）
  const first = tokens[0]
  if (first && !first.literal && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(first.value)) return false
  const head = first?.value ?? ''
  // パス指定の実行は通さない（許可コマンド名を騙れるため）
  if (!head || head.includes('/')) return false
  const writing = WRITING_OPTIONS[head]
  if (writing) {
    const args = tokens.slice(1)
    // 引用符の外の展開は結果を判定できない
    if (args.some(t => !t.literal && EXPANDABLE.test(t.value))) return false
    const values = args.map(t => t.value)
    // end-of-options 以降はオペランド
    const end = values.indexOf('--')
    const options = (end === -1 ? values : values.slice(0, end)).filter(v => v.startsWith('-'))
    if (writing.long && options.some(v => writing.long?.test(v))) return false
    // 短縮オプションは結合できるため、クラスタ内の1文字として探す
    const short = writing.short
    if (short && options.some(v => !v.startsWith('--') && v.slice(1).includes(short))) return false
  }
  const operandRule = OPERAND_RULES[head]
  if (operandRule) {
    const rest = tokens.slice(1).map(t => t.value)
    const operands: string[] = []
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--') {
        operands.push(...rest.slice(i + 1))
        break
      }
      // `-` 単体は標準入力の指定なのでオペランド
      if (rest[i].startsWith('-') && rest[i].length > 1) {
        if (operandRule.valueOptions.has(rest[i])) i++
        continue
      }
      operands.push(rest[i])
    }
    if (!operandRule.readOnly(operands)) return false
  }
  const sub = READ_ONLY_SUBCOMMANDS[head]
  // 値を別トークンで取るオプションはその値ごと読み飛ばし、サブコマンドの位置を特定する
  if (sub) {
    const valueOptions = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
    // サブコマンドより前のオプションは、設定の上書きや外部コマンドの起動に使える。
    // -p / --paginate は既存の core.pager に設定されたコマンドを実行する
    const globalWriting = /^(-c|-p$|--paginate$|--exec-path)/
    const rest = tokens.slice(1).map(t => t.value)
    let i = 0
    while (i < rest.length && rest[i].startsWith('-')) {
      if (globalWriting.test(rest[i])) return false
      i += valueOptions.has(rest[i]) ? 2 : 1
    }
    const subcommand = rest[i]
    return subcommand !== undefined && sub.has(subcommand)
  }
  return READ_ONLY_COMMANDS.has(head)
}

export function isGatedCommand(command: string): boolean {
  if (UNPARSEABLE.test(command)) return true
  const parts = splitSegments(scan(command))
  if (!parts.length) return true
  return !parts.every(isReadOnly)
}

export function isGatedTool(name: string): boolean {
  if (['Edit', 'Write', 'NotebookEdit'].includes(name)) return true
  // MCPツールは読み取りと確認できるものだけ通す
  if (name.startsWith('mcp__')) return !READ_ONLY_MCP_TOOLS.has(name)
  return false
}

function isGated(input: Input): boolean {
  if (input.tool_name !== 'Bash') return isGatedTool(input.tool_name)
  return isGatedCommand(String(input.tool_input?.command ?? ''))
}

/**
 * 成功した Read から、読了済みの対象を集める。
 * コンパクション以前の呼び出しは数えない。会話が要約に置き換わり、読んだ内容が残っていないため。
 */
function collectReads(transcriptPath: string): string[] {
  const reads: string[] = []
  for (const call of successful(readToolCalls(transcriptPath, { sinceLastCompact: true }))) {
    if (call.name === 'Read') {
      const p = call.input.file_path
      // 範囲指定のある Read は部分読みなので数えない（出力側の打ち切りまでは判定できない）
      if (
        typeof p === 'string' &&
        call.input.offset === undefined &&
        call.input.limit === undefined
      ) {
        reads.push(resolve(projectRoot, p))
      }
    }
  }
  return reads
}

const main = async () => {
  const input = await readStdinJson<Input>()
  projectRoot = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()
  if (!isGated(input)) process.exit(0)

  const transcript = input.transcript_path ?? ''
  if (!transcript || !existsSync(transcript)) {
    blockTool(
      'セッションの記録を参照できないため、必読ファイルの読了を確認できない。この操作は通せない。'
    )
    return
  }

  const root = projectRoot
  // 記録が揃っていないリポジトリでは、記録を作る操作だけを通す
  if (!recordsReady(root)) {
    if (isRecordCreation(input.tool_name, input.tool_input?.file_path, root)) process.exit(0)
    blockTool(
      `実行記録が無い。${RECORDS_DIR}/templates/ の state.md / lessons.md / episodes.md を ${RECORDS_DIR}/ 直下へ作るまで、この操作は通せない。`
    )
    return
  }
  const read = collectReads(transcript)
  // プロジェクトルート基準の絶対パスで完全一致させる
  const required = requiredFiles(root)
  // 必読の対象そのものが欠けている場合は設定破損。読了を判定できないので拒否する
  if (required.missing.length) {
    blockTool(
      `必読の対象が見つからないため読了を判定できない: ${required.missing.join(' / ')}。この操作は通せない。`
    )
    return
  }
  const unread = required.files.filter(f => !read.includes(resolve(root, f)))
  if (!unread.length) process.exit(0)

  blockTool(
    `着手前の読み込みが完了していないため、この操作は通せない。未読:\n${unread
      .map(f => `- ${f}（Read で全文を読む。offset/limit 指定は読了に数えない）`)
      .join('\n')}`
  )
}

/** 必読の対象を1行ずつ出力する（`--list`） */
function printRequired(): void {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd()
  const { files, missing } = requiredFiles(root)
  const lines = [...files]
  if (!recordsReady(root)) {
    lines.push(`${RECORDS_DIR}/templates/ から state.md / lessons.md / episodes.md を作る`)
  }
  if (missing.length) lines.push(`（見つからない必読対象: ${missing.join(' / ')}）`)
  process.stdout.write(lines.map(l => `- ${l}\n`).join(''))
}

if (import.meta.main) {
  if (process.argv.includes('--list')) printRequired()
  else
    main().catch(e => {
      blockTool(`読了判定に失敗したため、この操作は通せない: ${e instanceof Error ? e.message : e}`)
    })
}
