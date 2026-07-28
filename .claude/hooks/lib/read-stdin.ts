/**
 * Hook スクリプト共通: stdin を全て読み取って文字列として返す。
 * Claude Code hooks は JSON を stdin 経由で渡すため、全 hook で使用する。
 */
export async function readStdin(): Promise<string> {
  const chunks: string[] = []
  const decoder = new TextDecoder()
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(decoder.decode(chunk, { stream: true }))
  }
  return chunks.join('')
}

/** stdin を読み取り JSON としてパースして返す */
export async function readStdinJson<T = unknown>(): Promise<T> {
  const raw = await readStdin()
  return JSON.parse(raw) as T
}
