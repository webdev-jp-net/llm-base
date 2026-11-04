/**
 * Claude Code Hooks — 審査の記録が Bash で書き換えられたことの検知
 *
 * 審査の記録（lint 待ち・編集の記録・transcript）はフックと Claude Code だけが書く。
 * Bash の直前（PreToolUse）に状態を控え、直後（PostToolUse）に比べる。
 * 控えは Bash の呼び出しIDごとに分ける（サブエージェントなどの Bash が並行して動くため）。
 * 失敗した Bash では直後のフックが動かないので、transcript でその Bash の結果が出ていれば、
 * 次の操作の直前に比べる。
 * 次のどれかに当たれば、Bash で記録を書き換えたとみなす。
 * - lint 待ち・編集の記録の中身が変わった
 * - transcript の既存の部分が変わった（Claude Code は末尾に追記するだけ）
 * - 判定役の記録が Bash の実行中に増えた（判定役の記録は Edit / Write の直後にしか増えない）
 * - 直前に控えた状態が、直後に消えていた
 * 検知したら目印（TAMPER）を残す。目印がある間、md-lint-gate はすべての操作を止める。
 * 目印はユーザーが内容を確かめてから手で消す。
 *
 * 実行中の Bash がある間は、並行して動く別の操作のフックも記録を書き換えない。
 * 追加分は待ち行列（QUEUE_DIR）に置き、実行中の控えにその名前と中身のハッシュを足す。
 * 実行中の Bash がすべて比べ終わってから、待ち行列を記録に反映する。
 * 待ち行列が消された・書き換えられた場合も、Bash で書き換えたとみなす。
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { judgeRecord } from './balance-verdict.ts'

/** Bash の直前に控えた状態の置き場所（プロジェクトルート相対）。中身は呼び出しIDごとのファイル */
export const SNAPSHOT_DIR = '.claude/tmp/md-lint-snapshot'

/** 書き換えを検知した目印（プロジェクトルート相対） */
export const TAMPER = '.claude/tmp/md-lint-tamper.json'

/** Bash の上限（10分）を大きく過ぎた控えは、結果が残らずに終わったものとして扱う */
const STALE_MS = 15 * 60 * 1000

/** 実行中の Bash がある間、フックが記録の代わりに書く待ち行列の置き場所（プロジェクトルート相対） */
export const QUEUE_DIR = '.claude/tmp/md-lint-queue'

interface Snapshot {
  files: Record<string, string | null>
  /** この Bash の実行中にフックが置いた待ち行列（ファイル名 → 中身のハッシュ） */
  queued?: Record<string, string>
  /** Bash を始めた時刻（ミリ秒）。失敗した Bash が書き換えたファイルを拾うのに使う */
  startedAt: number
  transcriptPath: string
  transcriptSize: number
  transcriptHash: string
}

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

/** ファイルの中身のハッシュ。無ければ null */
export const fileHash = (path: string) => (existsSync(path) ? sha(readFileSync(path)) : null)

const readTranscript = (path: string) =>
  path && existsSync(path) ? readFileSync(path) : Buffer.alloc(0)

const snapshotPath = (projectDir: string, toolUseId: string) =>
  join(projectDir, SNAPSHOT_DIR, `${toolUseId.replace(/[^\w-]/g, '_')}.json`)

/** Bash の直前に状態を控える。guardedList はプロジェクトルート相対のパス */
export function takeSnapshot(
  projectDir: string,
  transcriptPath: string,
  guardedList: string[],
  toolUseId: string
): void {
  const transcript = readTranscript(transcriptPath)
  const snapshot: Snapshot = {
    files: Object.fromEntries(guardedList.map(rel => [rel, fileHash(join(projectDir, rel))])),
    startedAt: Date.now(),
    transcriptPath,
    transcriptSize: transcript.length,
    transcriptHash: sha(transcript),
  }
  const path = snapshotPath(projectDir, toolUseId)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(snapshot))
}

/** Bash の直後に比べ、書き換えの痕跡を返す。痕跡が無ければ空。控えは消す */
export function checkSnapshot(projectDir: string, toolUseId: string): string[] {
  const path = snapshotPath(projectDir, toolUseId)
  // 控えは md-lint-gate だけが作って消す。直後に無ければ Bash で消されたとみなす。
  // md-lint-gate 自身を書き換えた Bash では、直前に古いコードが動いて控えが無く、ここで止まる
  if (!existsSync(path)) return ['Bash の直前に控えた状態が消えている']
  const snapshot = JSON.parse(readFileSync(path, 'utf8')) as Snapshot
  rmSync(path)

  const problemList: string[] = []
  for (const [rel, hash] of Object.entries(snapshot.files)) {
    if (fileHash(join(projectDir, rel)) !== hash) problemList.push(`${rel} が書き換えられた`)
  }
  for (const [name, hash] of Object.entries(snapshot.queued ?? {})) {
    if (fileHash(join(projectDir, QUEUE_DIR, name)) !== hash)
      problemList.push(`待ち行列（${QUEUE_DIR}/${name}）が消された、または書き換えられた`)
  }
  const transcript = readTranscript(snapshot.transcriptPath)
  if (sha(transcript.subarray(0, snapshot.transcriptSize)) !== snapshot.transcriptHash) {
    problemList.push('transcript の既存の部分が書き換えられた')
  } else {
    const appended = transcript.subarray(snapshot.transcriptSize).toString('utf8')
    if (appended.split('\n').some(line => judgeRecord(line)))
      problemList.push('Bash の実行中に、判定役の記録が transcript に増えた')
  }
  return problemList
}

export interface FinishedBash {
  toolUseId: string
  startedAt: number
  transcriptPath: string
}

/**
 * 結果が transcript に出ているのに、直後に比べられていない Bash（失敗した Bash）を比べる。
 * 書き換えの痕跡と、その Bash の一覧（書き換えた .md を記録し直すため）を返す
 */
export function checkFinishedSnapshots(projectDir: string): {
  problemList: string[]
  finishedList: FinishedBash[]
} {
  const dir = join(projectDir, SNAPSHOT_DIR)
  const problemList: string[] = []
  const finishedList: FinishedBash[] = []
  if (!existsSync(dir)) return { problemList, finishedList }
  for (const name of readdirSync(dir)) {
    const toolUseId = name.replace(/\.json$/, '')
    const snapshot = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Snapshot
    // 結果が出たか、Bash の上限時間を大きく過ぎた（終了・強制終了で結果が残らなかった）控えを比べる
    const finished =
      Date.now() - snapshot.startedAt > STALE_MS ||
      readTranscript(snapshot.transcriptPath)
        .toString('utf8')
        .includes(`"tool_use_id":"${toolUseId}"`)
    if (!finished) continue
    problemList.push(...checkSnapshot(projectDir, toolUseId))
    finishedList.push({
      toolUseId,
      startedAt: snapshot.startedAt,
      transcriptPath: snapshot.transcriptPath,
    })
  }
  return { problemList, finishedList }
}

/** 控えが残っている（実行中、または結果をまだ比べていない Bash がある）か */
export function isBashInFlight(projectDir: string): boolean {
  const dir = join(projectDir, SNAPSHOT_DIR)
  return existsSync(dir) && readdirSync(dir).length > 0
}

/** 待ち行列に1件置き、開いているすべての控えに、その名前と中身のハッシュを足す */
export function enqueue(projectDir: string, id: string, payload: unknown): void {
  const name = `${Date.now()}-${id.replace(/[^\w-]/g, '_')}.json`
  const content = JSON.stringify(payload)
  const path = join(projectDir, QUEUE_DIR, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  const dir = join(projectDir, SNAPSHOT_DIR)
  if (!existsSync(dir)) return
  for (const snapshotName of readdirSync(dir)) {
    const snapshotFile = join(dir, snapshotName)
    const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8')) as Snapshot
    snapshot.queued = { ...snapshot.queued, [name]: sha(content) }
    writeFileSync(snapshotFile, JSON.stringify(snapshot))
  }
}

/** 待ち行列の中身を、置いた順に返す */
export function readQueue(projectDir: string): { name: string; payload: unknown }[] {
  const dir = join(projectDir, QUEUE_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .sort()
    .map(name => ({ name, payload: JSON.parse(readFileSync(join(dir, name), 'utf8')) }))
}

/** 記録に反映した待ち行列を消す */
export function removeQueue(projectDir: string, nameList: string[]): void {
  for (const name of nameList) rmSync(join(projectDir, QUEUE_DIR, name), { force: true })
}

/** md-lint-gate の処理を1つずつ順に動かすためのロック（プロジェクトルート相対） */
const LOCK = '.claude/tmp/md-lint-lock'

/**
 * ロックを取ってから fn を動かす。並行して動くフック同士が、控え・待ち行列・記録を
 * 同時に読み書きしないようにする。30秒より古いロックは、止まったフックの残りとみなして消す
 */
export async function withLock<T>(projectDir: string, fn: () => T): Promise<T> {
  const path = join(projectDir, LOCK)
  mkdirSync(dirname(path), { recursive: true })
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      mkdirSync(path)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      if (existsSync(path) && Date.now() - statSync(path).mtimeMs > 30_000) {
        rmSync(path, { recursive: true, force: true })
        continue
      }
      if (Date.now() > deadline) throw new Error('md-lint-gate のロックを取れない')
      await Bun.sleep(50)
    }
  }
  try {
    return fn()
  } finally {
    rmSync(path, { recursive: true, force: true })
  }
}

/** 書き換えを検知した目印を残す */
export function markTampered(projectDir: string, problemList: string[]): void {
  const path = join(projectDir, TAMPER)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(problemList, null, 2))
}

/** 書き換えの目印の中身。目印が無ければ null */
export function readTamper(projectDir: string): string | null {
  const path = join(projectDir, TAMPER)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}
