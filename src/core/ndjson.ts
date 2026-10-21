// Кадрирование NDJSON. Потоку из сокета нельзя верить в двух местах сразу: он склеивает
// несколько сообщений в один chunk и рвёт одно сообщение (и даже один символ UTF-8) на два.
// StringDecoder держит хвост недобитого символа, буфер — хвост недобитой строки.

import { StringDecoder } from 'node:string_decoder'

/** 1 МиБ на строку. Всё, что больше, — либо мусор, либо попытка выжрать память демону. */
export const MAX_LINE_BYTES = 1024 * 1024

export class NdjsonError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'NdjsonError'
  }
}

export interface LineSplitter {
  /** Отдаёт готовые строки без `\n`. Пустые строки отбрасываются. */
  push(chunk: Buffer | string): string[]
  /** Сколько байт уже накоплено в недобитой строке (для тестов и диагностики). */
  pending(): number
}

export function createLineSplitter(maxLineBytes: number = MAX_LINE_BYTES): LineSplitter {
  const decoder = new StringDecoder('utf8')
  let buf = ''
  return {
    push(chunk: Buffer | string): string[] {
      buf += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      const lines: string[] = []
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        // Предел проверяется и у ГОТОВОЙ строки: проверка одного лишь недобитого остатка
        // пропускала сколь угодно длинную строку, если она пришла вместе со своим `\n`.
        if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
          buf = ''
          throw new NdjsonError(
            'line_too_long',
            `строка NDJSON длиннее ${maxLineBytes} байт — соединение разрывается`,
          )
        }
        const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
        if (trimmed.trim()) lines.push(trimmed)
      }
      if (Buffer.byteLength(buf, 'utf8') > maxLineBytes) {
        // Буфер сбрасываем: продолжать разбор после переполнения нечестно — середина
        // выброшенной строки выглядела бы как начало новой.
        buf = ''
        throw new NdjsonError(
          'line_too_long',
          `строка NDJSON длиннее ${maxLineBytes} байт — соединение разрывается`,
        )
      }
      return lines
    },
    pending(): number {
      return Buffer.byteLength(buf, 'utf8')
    },
  }
}

export function encodeLine(value: unknown): string {
  return JSON.stringify(value) + '\n'
}
