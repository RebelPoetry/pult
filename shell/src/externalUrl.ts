// Какие ссылки из окна main отдаёт системному браузеру. Адрес приходит из текста модели, то есть
// он чужой: окно рисует живыми только http(s) и mailto, но main окну не верит и проверяет сам.
// Модуль чистый: тесты — без Electron.

/** Длиннее — не ссылка из ответа, а мусор или попытка протащить данные в адресе. */
export const MAX_URL_LEN = 2048

const ALLOWED = new Set(['http:', 'https:', 'mailto:'])

/**
 * Нормализованный адрес для `shell.openExternal` или `null`. Отказ: не строка, пусто, длиннее
 * MAX_URL_LEN, NUL, не разбирается `new URL`, схема не http/https/mailto (javascript:, file:,
 * data:, smb:, относительный путь), http(s) без хоста или с логином-паролем в адресе
 * (`https://bank.example.com@evil.example.org` ведёт не на bank.example.com), mailto без адресата.
 */
export function externalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_URL_LEN || raw.includes('\0')) return null
  let u: URL
  try { u = new URL(raw.trim()) } catch { return null }
  if (!ALLOWED.has(u.protocol)) return null
  if (u.protocol === 'mailto:') return u.pathname ? u.href : null
  if (!u.hostname || u.username || u.password) return null
  return u.href
}
