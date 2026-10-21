import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MAC_FILENAMES, MAX_PATHS, parseFileUrls, parseFilenamesPlist, readClipboardPaths, URI_LIST } from '../../src/clipboardPaths.js'

const board = (formats: Record<string, string>) => ({ read: async (t: string) => formats[t] ?? '' })

const plist = (paths: string[]): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><array>${paths.map((p) => `<string>${p}</string>`).join('')}</array></plist>`

describe('пути скопированных файлов', () => {
  it('macOS: несколько файлов из Finder — список из plist, XML-сущности раскрыты', async () => {
    const cb = board({ [MAC_FILENAMES]: plist(['/srv/p/a b.txt', '/srv/p/R&amp;D/x.png']) })
    assert.deepEqual(await readClipboardPaths(cb, 'darwin'), ['/srv/p/a b.txt', '/srv/p/R&D/x.png'])
  })
  it('macOS без plist — из text/uri-list, с раскодированием %20 и кириллицы', async () => {
    const cb = board({ [URI_LIST]: 'file:///srv/p/%D0%9E%D1%82%D1%87%D1%91%D1%82%20v2.pdf' })
    assert.deepEqual(await readClipboardPaths(cb, 'darwin'), ['/srv/p/Отчёт v2.pdf'])
  })
  it('Linux: text/uri-list, комментарии и не-file пропущены', async () => {
    const cb = board({ [URI_LIST]: '# comment\nfile:///srv/h/a.txt\r\nhttps://x.y/z\nfile:///srv/h/b.txt\n', [MAC_FILENAMES]: plist(['/mac/only']) })
    assert.deepEqual(await readClipboardPaths(cb, 'linux'), ['/srv/h/a.txt', '/srv/h/b.txt'])
  })
  it('в буфере текст, а не файлы — пусто (вставка останется обычной)', async () => {
    assert.deepEqual(await readClipboardPaths(board({}), 'darwin'), [])
    assert.deepEqual(await readClipboardPaths({ read: async () => { throw new Error('format') } }, 'darwin'), [])
  })
  it('чужой буфер: относительные пути, NUL и дубли отброшены, не больше MAX_PATHS', async () => {
    assert.deepEqual(parseFilenamesPlist(plist(['rel/x', '/a\0b'])).length, 2)
    const many = Array.from({ length: MAX_PATHS + 10 }, (_, i) => `/p/${i}`)
    const got = await readClipboardPaths(board({ [MAC_FILENAMES]: plist(['rel/x', '/a\0b', '/p/0', ...many]) }), 'darwin')
    assert.equal(got.length, MAX_PATHS)
    assert.equal(got[0], '/p/0')
    assert.ok(!got.includes('rel/x'))
  })
  it('числовые XML-сущности в plist раскрыты', () => {
    assert.deepEqual(parseFilenamesPlist(plist(['/srv/p/a&#x9;b', '/srv/p/&#1054;.txt'])), ['/srv/p/a\tb', '/srv/p/О.txt'])
  })
  it('file:// на чужом хосте — не локальный файл', () => {
    assert.deepEqual(parseFileUrls('file://server/share/x'), [])
  })
})
