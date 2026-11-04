/**
 * Claude Code Hooks — Bash の控えと、審査を通らない中身を検知した目印
 *
 * Bash の直前（PreToolUse）に、始めた時刻と transcript を呼び出しIDごとに控える
 * （サブエージェントなどの Bash が並行して動くため）。直後（PostToolUse）に md-lint-gate が
 * 控えを消し、その Bash で作られたコミットを確かめる。
 * 失敗した Bash では直後のフックが動かないので、transcript にその Bash の結果が出ているか、
 * Bash の上限を大きく過ぎていれば、次の操作の直前に終わったものとして扱う
 * （その Bash が書き換えた .md の記録と、コミットの確認は md-lint-gate が行う）。
 * 審査を通っていない中身のコミットや、基準の置き換えを検知したら目印（TAMPER）を残す。
 * 目印がある間、md-lint-gate はすべての操作を止める。目印はユーザーが内容を確かめてから手で消す。
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

/** Bash の直前に控えた状態の置き場所（プロジェクトルート相対）。中身は呼び出しIDごとのファイル */
export const SNAPSHOT_DIR = '.claude/tmp/md-lint-snapshot'

/** 検知した目印（プロジェクトルート相対） */
export const TAMPER = '.claude/tmp/md-lint-tamper.json'

/** Bash の上限（10分）を大きく過ぎた控えは、結果が残らずに終わったものとして扱う */
const STALE_MS = 15 * 60 * 1000

interface Snapshot {
  /** Bash を始めた時刻（ミリ秒）。失敗した Bash が書き換えたファイルを拾うのに使う */
  startedAt: number
  transcriptPath: string
}

/** ファイルの中身のハッシュ。無ければ null */
export const fileHash = (path: string) =>
  existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null

const readTranscript = (path: string) =>
  path && existsSync(path) ? readFileSync(path) : Buffer.alloc(0)

const snapshotPath = (projectDir: string, toolUseId: string) =>
  join(projectDir, SNAPSHOT_DIR, `${toolUseId.replace(/[^\w-]/g, '_')}.json`)

/** Bash の直前に、始めた時刻と transcript を控える */
export function saveSnapshot(projectDir: string, transcriptPath: string, toolUseId: string): void {
  const path = snapshotPath(projectDir, toolUseId)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ startedAt: Date.now(), transcriptPath } satisfies Snapshot))
}

/** Bash の直後に控えを消す */
export function removeSnapshot(projectDir: string, toolUseId: string): void {
  rmSync(snapshotPath(projectDir, toolUseId), { force: true })
}

export interface FinishedBash {
  toolUseId: string
  startedAt: number
  transcriptPath: string
}

/**
 * 結果が transcript に出ているのに、直後のフックが動かなかった Bash（失敗した Bash）の控えを
 * 消し、その一覧を返す（書き換えた .md の記録と、コミットの確認は md-lint-gate が行う）
 */
export function finishedSnapshots(projectDir: string): FinishedBash[] {
  const dir = join(projectDir, SNAPSHOT_DIR)
  const finishedList: FinishedBash[] = []
  if (!existsSync(dir)) return finishedList
  for (const name of readdirSync(dir)) {
    const toolUseId = name.replace(/\.json$/, '')
    const snapshot = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Snapshot
    // 結果が出たか、Bash の上限時間を大きく過ぎた（終了・強制終了で結果が残らなかった）控え
    const finished =
      Date.now() - snapshot.startedAt > STALE_MS ||
      readTranscript(snapshot.transcriptPath)
        .toString('utf8')
        .includes(`"tool_use_id":"${toolUseId}"`)
    if (!finished) continue
    removeSnapshot(projectDir, toolUseId)
    finishedList.push({
      toolUseId,
      startedAt: snapshot.startedAt,
      transcriptPath: snapshot.transcriptPath,
    })
  }
  return finishedList
}

/** md-lint-gate の処理を1つずつ順に動かすためのロック（プロジェクトルート相対） */
const LOCK = '.claude/tmp/md-lint-lock'

/**
 * ロックを取ってから fn を動かす。並行して動くフック同士が、控え・記録を
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

/** 検知した目印を残す */
export function markTampered(projectDir: string, problemList: string[]): void {
  const path = join(projectDir, TAMPER)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(problemList, null, 2))
}

/** 目印の中身。目印が無ければ null */
export function readTamper(projectDir: string): string | null {
  const path = join(projectDir, TAMPER)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}
