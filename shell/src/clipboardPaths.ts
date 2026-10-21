// Пути скопированных файлов из системного буфера — как вставка в нативных приложениях: ⌘C на файле
// в Finder → ⌘V в поле реплики даёт полный путь, а не одно имя (Chromium вставил бы `text/plain`,
// где у Finder только имя файла). Модуль чистый: буфер приходит параметром, тесты — без Electron.

import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Сколько путей и какой длины пропускаем в окно — буфер чужой, доверять ему вслепую незачем. */
export const MAX_PATHS = 64
const MAX_PATH_LEN = 4096

/**
 * Буфер Electron 44: формат читается целиком по MIME (`clipboard.read()` → `ClipboardItem.getType`).
 * Пусто — такого формата в буфере нет.
 */
export interface ClipboardLike {
  read(type: string): Promise<string>
}

/**
 * Список путей, который Finder кладёт при ⌘C (один или несколько файлов). Сырой формат macOS
 * Electron отдаёт только под этим именем — замерено лидом 06.10.2026 на Electron 44:
 * `NSPasteboard writeObjects` с двумя NSURL даёт в `types` ровно эту строку и `text/uri-list`.
 */
export const MAC_FILENAMES = 'electron application/osclipboard;format="NSFilenamesPboardType"'
export const URI_LIST = 'text/uri-list'

const decodeXml = (s: string): string => s
  .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/** `NSFilenamesPboardType` — XML-plist со списком путей: так Finder кладёт несколько файлов разом. */
export function parseFilenamesPlist(xml: string): string[] {
  const out: string[] = []
  for (const m of xml.matchAll(/<string>([^<]*)<\/string>/g)) out.push(decodeXml(m[1]!))
  return out
}

/** `text/uri-list`: строки `file://…`, `#` — комментарий. */
export function parseFileUrls(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || !line.startsWith('file://')) continue
    try { out.push(fileURLToPath(line)) } catch { /* не локальный файл */ }
  }
  return out
}

const valid = (p: string): boolean => p.length > 0 && p.length <= MAX_PATH_LEN && isAbsolute(p) && !p.includes('\0')

export async function readClipboardPaths(cb: ClipboardLike, platform: NodeJS.Platform): Promise<string[]> {
  const tryRead = async (type: string): Promise<string> => { try { return (await cb.read(type)) || '' } catch { return '' } }
  let paths: string[] = platform === 'darwin' ? parseFilenamesPlist(await tryRead(MAC_FILENAMES)) : []
  if (!paths.length) paths = parseFileUrls(await tryRead(URI_LIST))
  return [...new Set(paths.filter(valid))].slice(0, MAX_PATHS)
}
