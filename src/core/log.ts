// Журнал демона: JSONL в PULT_HOME/logs/pultd.log.
// Инвариант 7: в журнал не попадают адреса почты и токены. Фильтр стоит НА ЗАПИСИ, а не
// на вызывающем коде — иначе один забытый `log.info(err)` в адаптере сливает ключ.

import { appendFileSync, closeSync, openSync, writeSync } from 'node:fs'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Имена полей, чьи значения вырезаются целиком, чем бы они ни были. */
const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE)/i

const VALUE_RULES: Array<{ re: RegExp; to: string }> = [
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, to: '<email>' },
  { re: /sk-ant-[A-Za-z0-9_-]{8,}/g, to: '<token>' },
  { re: /\bsk-[A-Za-z0-9]{16,}/g, to: '<token>' },
  // Ключи OpenAI нового вида: `sk-proj-…`, `sk-svcacct-…`, `sk-admin-…`. Правило выше их НЕ ловит —
  // после `sk-` идут 4–7 букв и дефис. Первым такой ключ мог бы напечатать `codex login status`
  // (он маскирует, но проверять чужую маску Пульт не обязан) — В5, строка «Подписка codex».
  { re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{16,}/g, to: '<token>' },
  { re: /\b(?:ghp|gho|ghs|ghr)_[A-Za-z0-9]{16,}/g, to: '<token>' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{16,}/g, to: '<token>' },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, to: '<token>' },
  { re: /\b(?:Bearer|Basic)[ \t]+[A-Za-z0-9._~+/-]{16,}=*/g, to: '<token>' },
  // Логин и пароль внутри URL: так выглядит прокси вида http://user:pass@host:port, который
  // владелец мог написать в config.json и который иначе уехал бы в отчёт доктора как есть.
  { re: /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, to: '$1<redacted>@' },
  // Длинная шестнадцатеричная строка — это наш собственный токен сокета (64 символа)
  // и любой похожий на него секрет.
  { re: /\b[0-9a-f]{32,}\b/gi, to: '<token>' },
]

export function redactString(s: string): string {
  let out = s
  for (const rule of VALUE_RULES) out = out.replace(rule.re, rule.to)
  return out
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '<deep>'
  if (typeof value === 'string') return redactString(value)
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) }
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_NAME_RE.test(k) ? '<redacted>' : redact(v, depth + 1)
  }
  return out
}

export interface Logger {
  log(level: LogLevel, msg: string, data?: Record<string, unknown>): void
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
  close(): void
}

export interface LoggerOptions {
  /** Дублировать строки в stdout — для запуска демона на переднем плане. */
  echo?: boolean
  pid?: number
}

export function createLogger(file: string, opts: LoggerOptions = {}): Logger {
  // Один открытый fd на весь срок жизни демона: appendFileSync открывал бы файл на каждую
  // строку, а строк в потоке событий много.
  let fd: number | null = null
  try {
    fd = openSync(file, 'a', 0o600)
  } catch {
    fd = null
  }
  const pid = opts.pid ?? process.pid

  const write = (line: string): void => {
    if (fd !== null) {
      try { writeSync(fd, line) } catch { /* диск пропал — демон из-за журнала не падает */ }
    } else {
      try { appendFileSync(file, line) } catch { /* см. выше */ }
    }
    if (opts.echo) process.stdout.write(line)
  }

  const log = (level: LogLevel, msg: string, data?: Record<string, unknown>): void => {
    const rec = {
      ts: new Date().toISOString(),
      level,
      pid,
      msg: redactString(msg),
      ...(data ? (redact(data) as Record<string, unknown>) : {}),
    }
    write(JSON.stringify(rec) + '\n')
  }

  return {
    log,
    debug: (m, d) => log('debug', m, d),
    info: (m, d) => log('info', m, d),
    warn: (m, d) => log('warn', m, d),
    error: (m, d) => log('error', m, d),
    close: () => {
      if (fd !== null) { try { closeSync(fd) } catch { /* уже закрыт */ } fd = null }
    },
  }
}
