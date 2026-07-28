/**
 * Claude Code Hooks — パス判定
 */

import { isAbsolute, relative, resolve } from 'node:path'

/**
 * filePath が projectDir の内側にあるか。
 * 文字列の前方一致では `/path/repo-other` が `/path/repo` に一致してしまうため、
 * 相対パスへ変換して `..` と絶対パスを弾く。projectDir 自身は内側としない。
 */
export function isInsideProject(projectDir: string, filePath: string): boolean {
  const rel = relative(resolve(projectDir), resolve(filePath))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
