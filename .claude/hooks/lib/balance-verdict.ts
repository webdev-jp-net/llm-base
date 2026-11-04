/**
 * Claude Code Hooks — doc-balance の合否
 *
 * .md を Edit / Write した直後に、agent 型フックの判定役が doc-balance の基準で判定する
 * （.claude/settings.json の PostToolUse）。判定役は合否どちらでも ok:false を返し、
 * 理由の先頭に PASS / FAIL を書く。Claude Code はそれを、その Edit / Write の呼び出しIDを付けた
 * 差し戻しとして transcript に残す。判定役がエラーで止まると何も残らないので、
 * PASS の記録が無い判定は不合格として扱う。
 *
 * 編集の記録（BALANCE）: .md ごとの編集の履歴（呼び出しID・ツール名・その時の transcript）。
 * 合否は記録には書かず、毎回 transcript から読む（transcript は Edit / Write を deny で止め、
 * Bash での書き換えは record-guard で検知する）。
 * Bash での書き換えは判定されないので、Write し直して判定を受けるまで未判定になる。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 編集の記録（プロジェクトルート相対） */
export const BALANCE = '.claude/tmp/md-lint-balance.json'

/** 判定役のプロンプトの先頭に置く目印。transcript で判定役の記録を見分ける */
export const JUDGE_MARK = '[doc-balance-judge]'

/** Claude Code が agent 型フックの ok:false の理由に付ける前置き */
const AGENT_BLOCK_PREFIX = 'Agent hook condition was not met:'

/** 不合格がこの回数続いたら、直すのをやめてユーザーに相談させる */
export const MAX_FAIL_STREAK = 8

export interface EditEvent {
  file: string
  toolUseId: string
  tool: string
  /** 編集した時の transcript。判定役の記録はここに残る（セッションごとに別のファイル） */
  transcriptPath: string
  /**
   * 合格を最初に確かめた時のファイルの中身のハッシュ。
   * 合格はこの中身に対してだけ有効で、中身が変われば（記録の残らない経路の書き換えも含め）未判定に戻る
   */
  passedHash?: string
}

export interface Verdict {
  pass: boolean
  reason: string
  /** 記録がある transcript と、その何行目か（ユーザーの発言より後かを比べるため） */
  transcriptPath?: string
  line?: number
}

export type BalanceStatus =
  | { kind: 'pass' }
  | { kind: 'fail'; reason: string; failStreak: number }
  | { kind: 'unjudged'; reason: string; failStreak: number }

/** 不合格を数え始める位置: その transcript の、ユーザーの最後の発言の行 */
export interface StreakStart {
  transcriptPath: string
  line: number
}

/** transcript で、ユーザー（人）の最後の発言の行。無ければ -1 */
export function lastHumanLine(transcriptPath: string | undefined): number {
  if (!transcriptPath || !existsSync(transcriptPath)) return -1
  let last = -1
  readFileSync(transcriptPath, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (!line.includes('"human"')) return
      try {
        const entry = JSON.parse(line)
        if (entry?.type === 'user' && entry?.origin?.kind === 'human') last = i
      } catch {
        // 壊れた行は数えない
      }
    })
  return last
}

/** 編集の記録。記録が無ければ空。壊れていれば例外 */
export function readEvents(projectDir: string): EditEvent[] {
  const path = join(projectDir, BALANCE)
  if (!existsSync(path)) return []
  const list = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(list)) throw new Error(`${BALANCE} が配列ではない`)
  return list.filter(
    (e): e is EditEvent =>
      typeof e?.file === 'string' &&
      typeof e?.toolUseId === 'string' &&
      typeof e?.tool === 'string' &&
      typeof e?.transcriptPath === 'string'
  )
}

export function writeEvents(projectDir: string, eventList: EditEvent[]): void {
  const path = join(projectDir, BALANCE)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(eventList, null, 2))
}

/**
 * transcript と、同じセッションのサブエージェントの transcript（<セッション>/subagents/*.jsonl）。
 * サブエージェントの編集の判定は、サブエージェント側に記録されることがある
 */
function withSubagentTranscripts(transcriptPath: string): string[] {
  const dir = join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents')
  if (!transcriptPath.endsWith('.jsonl') || !existsSync(dir)) return [transcriptPath]
  return [
    transcriptPath,
    ...readdirSync(dir)
      .filter(name => name.endsWith('.jsonl'))
      .map(name => join(dir, name)),
  ]
}

/** 編集の記録にある transcript から、判定役の記録（Edit / Write の呼び出しID → 合否）を集める */
export function readVerdicts(eventList: EditEvent[]): Map<string, Verdict> {
  const verdicts = new Map<string, Verdict>()
  const pathList = new Set(eventList.flatMap(e => withSubagentTranscripts(e.transcriptPath)))
  for (const transcriptPath of pathList) {
    if (!transcriptPath || !existsSync(transcriptPath)) continue
    readFileSync(transcriptPath, 'utf8')
      .split('\n')
      .forEach((text, line) => {
        const verdict = judgeRecord(text)
        if (verdict) verdicts.set(verdict.toolUseId, { ...verdict, transcriptPath, line })
      })
  }
  return verdicts
}

/** transcript の1行が判定役の記録なら、その呼び出しIDと合否を返す */
export function judgeRecord(line: string): (Verdict & { toolUseId: string }) | null {
  if (!line.includes(JUDGE_MARK)) return null
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return null
  }
  const attachment = (entry as { attachment?: Record<string, unknown> })?.attachment
  if (attachment?.type !== 'hook_blocking_error') return null
  const toolUseId = attachment.toolUseID
  const blocking = attachment.blockingError as { blockingError?: unknown; command?: unknown }
  if (typeof toolUseId !== 'string' || typeof blocking?.blockingError !== 'string') return null
  if (typeof blocking.command !== 'string' || !blocking.command.includes(JUDGE_MARK)) return null
  const reason = blocking.blockingError.replace(AGENT_BLOCK_PREFIX, '').trim()
  // 合格は理由がちょうど PASS のときだけ。PASS のあとに何か続けば不合格として扱う
  return { toolUseId, pass: reason === 'PASS', reason }
}

/**
 * ファイルの直近の状態。
 * streakStart を渡すと、不合格の回数はそのユーザーの発言より後の判定だけを数える
 * （ユーザーに相談して返事をもらったら、数え直す）
 */
export function balanceStatus(
  eventList: EditEvent[],
  verdicts: Map<string, Verdict>,
  file: string,
  streakStart?: StreakStart
): BalanceStatus {
  const own = eventList.filter(e => e.file === file)
  if (own.length === 0)
    return { kind: 'unjudged', reason: 'doc-balance の判定を受けていない', failStreak: 0 }
  const passed = (e: EditEvent) => e.tool !== 'Bash' && verdicts.get(e.toolUseId)?.pass === true
  // 不合格・判定なし・Bash での書き換えのあとは、ファイル全体を出し直す Write で合格するまで外さない
  const lastNotPassed = own.findLastIndex(e => !passed(e))
  if (lastNotPassed === -1) return { kind: 'pass' }
  const cleared = own.slice(lastNotPassed + 1).some(e => e.tool === 'Write' && passed(e))
  if (cleared) return { kind: 'pass' }

  // 不合格の回数。Bash での書き換えや Edit での合格では数え直さず、Write での合格までさかのぼる
  let failStreak = 0
  for (const e of [...own].reverse()) {
    if (e.tool === 'Write' && passed(e)) break
    const verdict = verdicts.get(e.toolUseId)
    if (!verdict || verdict.pass) continue
    if (
      streakStart &&
      (verdict.transcriptPath !== streakStart.transcriptPath ||
        (verdict.line ?? -1) <= streakStart.line)
    )
      continue
    failStreak++
  }
  const blocker = own[lastNotPassed]
  if (blocker.tool === 'Bash')
    return {
      kind: 'unjudged',
      reason: 'Bash で書き換えたため未判定。Write し直して判定を受けること',
      failStreak,
    }
  const verdict = verdicts.get(blocker.toolUseId)
  const reason = verdict
    ? verdict.reason
    : '判定役の合格の記録が無い（判定役がエラーで止まった場合も不合格として扱う）'
  const suffix =
    lastNotPassed < own.length - 1 ? '（不合格のあとは、Write し直して合格する必要がある）' : ''
  return { kind: 'fail', reason: reason + suffix, failStreak }
}

/** 合格したファイルの古い履歴を捨てる（直近の1件だけ残す） */
export function pruneEvents(eventList: EditEvent[], passedList: string[]): EditEvent[] {
  const passed = new Set(passedList)
  return eventList.filter(
    (e, i) => !passed.has(e.file) || !eventList.slice(i + 1).some(n => n.file === e.file)
  )
}
