import { describe, expect, test } from 'bun:test'
import { isInsideProject } from './paths.ts'

describe('isInsideProject', () => {
  const root = '/path/repo'

  test('直下のファイルは内側', () => {
    expect(isInsideProject(root, '/path/repo/README.md')).toBe(true)
  })

  test('サブディレクトリのファイルは内側', () => {
    expect(isInsideProject(root, '/path/repo/_llm-docs/project.md')).toBe(true)
  })

  test('名前が前方一致する別ディレクトリは外側', () => {
    expect(isInsideProject(root, '/path/repo-other/README.md')).toBe(false)
  })

  test('親ディレクトリのファイルは外側', () => {
    expect(isInsideProject(root, '/path/README.md')).toBe(false)
  })

  test('無関係なパスは外側', () => {
    expect(isInsideProject(root, '/tmp/README.md')).toBe(false)
  })

  test('プロジェクトルート自身は内側としない', () => {
    expect(isInsideProject(root, '/path/repo')).toBe(false)
  })

  test('`..` を含んで外へ出るパスは外側', () => {
    expect(isInsideProject(root, '/path/repo/../repo-other/README.md')).toBe(false)
  })

  test('`..` を含んでも内側に戻るパスは内側', () => {
    expect(isInsideProject(root, '/path/repo/sub/../README.md')).toBe(true)
  })

  test('末尾のスラッシュの有無で判定が変わらない', () => {
    expect(isInsideProject('/path/repo/', '/path/repo/README.md')).toBe(true)
    expect(isInsideProject('/path/repo/', '/path/repo-other/README.md')).toBe(false)
  })
})
