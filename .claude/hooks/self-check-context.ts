#!/usr/bin/env bun
/**
 * Self Check Context — 返答を self-check-criteria.md で判定する Stop フック（agent）に、何に答えた返答かを渡す (UserPromptSubmit, Stop)
 *
 * Stop: 書き終えた返答を .claude/tmp/self-check-last-reply.md に保存する（差し戻されて書き直したら上書き）。
 * UserPromptSubmit: その保存と、送られてきたユーザーの発言をまとめて .claude/tmp/self-check-context.md に書く。
 * 判定するエージェントは self-check-context.md を読む。
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { runHook } from './lib/hook-output.ts'
import type { StopInput, UserPromptSubmitInput } from './lib/hook-types.ts'
import { readStdinJson } from './lib/read-stdin.ts'

if (import.meta.main) {
  runHook('self-check-context', async () => {
    const input = await readStdinJson<StopInput | UserPromptSubmitInput>()
    const dir = join(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), '.claude/tmp')
    mkdirSync(dir, { recursive: true })
    const replyPath = join(dir, 'self-check-last-reply.md')

    if (input.hook_event_name === 'Stop') {
      writeFileSync(replyPath, input.last_assistant_message ?? '')
      return
    }

    const previousReply = existsSync(replyPath) ? readFileSync(replyPath, 'utf8') : ''
    writeFileSync(
      join(dir, 'self-check-context.md'),
      `【直前のアシスタントの返答】\n${previousReply}\n\n【ユーザーの最新の発言】\n${input.prompt}\n`
    )
  })
}
