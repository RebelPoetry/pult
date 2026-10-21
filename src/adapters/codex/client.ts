// Клиент `codex app-server` по stdio: кадрирование JSON-RPC, сопоставление по id, запросы
// сервера к клиенту. Один экземпляр = один дочерний процесс, а он у Пульта ОДИН НА ВСЕХ.
//
// ПОЧЕМУ отдельный файл. Адаптер занят сессиями, тредами и разрешениями; всё, что ниже —
// это транспорт, и он обязан быть скучным: строка в stdin, строка из stdout, ни одной
// догадки о смысле. Перенесено из `spike/codex/client.mjs` (нога B1–S5), с тремя правками,
// каждая из которых оплачена измерением:
//
//   1. Поле `jsonrpc` на проводе НЕОБЯЗАТЕЛЬНО в обе стороны (спайк, 20.09.2026). Мы его
//      ставим, но разбираем сообщения по форме, а не по его наличию: сообщение с `id` и
//      `method` — запрос сервера, с одним `id` — ответ, с одним `method` — уведомление.
//   2. Предел длины строки — 16 МиБ, а не общий 1 МиБ из `core/ndjson.ts`: одно
//      `item/completed` с `aggregatedOutput` большой команды честно бывает многомегабайтным,
//      и рвать на этом соединение — значит терять ход из-за длинного `npm test`.
//      Строка сверх предела НЕ роняет ни соединение, ни демона: её выбрасывают и считают.
//   3. У каждого запроса свой таймаут. Молчащий app-server иначе держит ход навсегда:
//      `pult agent wait` обязан упереться в свой таймаут, а не в вечность.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/** 16 МиБ на строку: см. пункт 2 в шапке. */
export const MAX_APP_SERVER_LINE = 16 * 1024 * 1024
/** Сколько ждём ответа на служебный запрос (initialize, thread/start, turn/start, …). */
export const REQUEST_TIMEOUT_MS = 60_000

export type JsonRpcId = number | string

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export class AppServerError extends Error {
  readonly rpc: JsonRpcError
  constructor(rpc: JsonRpcError) {
    super(rpc.message)
    this.name = 'AppServerError'
    this.rpc = rpc
  }
}

export interface ClientOptions {
  bin: string
  args?: string[]
  cwd: string
  env: Record<string, string>
  /** Уведомление сервера: `{method, params}` без id. */
  onNotification(method: string, params: Record<string, unknown>): void
  /** Запрос сервера К КЛИЕНТУ: на него обязан прийти ответ по этому же id. */
  onServerRequest(id: JsonRpcId, method: string, params: Record<string, unknown>): void
  onExit(code: number | null, signal: NodeJS.Signals | null): void
  /** Спавн не удался (ENOENT, EACCES, несуществующий cwd). Процесса не будет вовсе. */
  onSpawnError(error: Error): void
  /** Строка stderr — её кладут в журнал демона, а не в события сессии. */
  onStderr?(line: string): void
  /** Строка, которую не удалось разобрать: мусор на stdout, обрезки, слишком длинная строка. */
  onBadLine?(reason: string, sample: string): void
  now?: () => number
}

export interface AppServerClient {
  readonly pid: number | undefined
  /** Процесс ещё не вышел и труба цела. */
  alive(): boolean
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  notify(method: string, params: Record<string, unknown>): void
  /** Ответ на запрос сервера. Второй ответ по тому же id молча игнорируется. */
  respond(id: JsonRpcId, result: Record<string, unknown>): void
  /** Ответ ОШИБКОЙ на запрос сервера: метод, которого мы не умеем. */
  respondError(id: JsonRpcId, code: number, message: string): void
  kill(signal: NodeJS.Signals): void
  /** Ждёт выхода процесса. false — не дождались за `ms`. */
  waitExit(ms: number): Promise<boolean>
  /** Закрыть stdin: ИЗМЕРЕНО 21.09.2026 — app-server на это выходит сам с кодом 0. */
  endStdin(): void
}

interface Pending {
  resolve(value: Record<string, unknown>): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  method: string
}

/**
 * Кадровщик потока app-server. Почему не общий `createLineSplitter` из `core/ndjson.ts`:
 * тот на строке сверх предела БРОСАЕТ и сбрасывает буфер целиком — то есть вместе с
 * переростком теряет и соседние сообщения из того же куска. Для сокета демона это правильно
 * (там переросток — попытка выжрать память), а здесь стоило бы потерянного хода: ИЗМЕРЕНО
 * тестом — ответ, пришедший в одном куске со строкой-переростком, пропадал.
 *
 * Здесь переросток выбрасывается ПОСТРОЧНО: сама длинная строка (и её хвост в следующих
 * кусках) отбрасывается, всё, что было до и после неё, разбирается как обычно.
 */
function createAppServerSplitter(
  maxBytes: number,
  onDrop: (reason: string, sample: string) => void,
): (chunk: Buffer) => string[] {
  const decoder = new StringDecoder('utf8')
  let buf = ''
  let dropping = false
  return (chunk: Buffer): string[] => {
    buf += decoder.write(chunk)
    const lines: string[] = []
    for (;;) {
      const nl = buf.indexOf('\n')
      if (nl === -1) break
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (dropping) { dropping = false; continue } // это хвост уже засчитанного переростка
      if (Buffer.byteLength(line, 'utf8') > maxBytes) { onDrop('line_too_long', ''); continue }
      const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
      if (trimmed.trim()) lines.push(trimmed)
    }
    if (Buffer.byteLength(buf, 'utf8') > maxBytes) {
      if (!dropping) { dropping = true; onDrop('line_too_long', '') }
      buf = ''
    }
    return lines
  }
}

export function createAppServerClient(opts: ClientOptions): AppServerClient {
  const splitter = createAppServerSplitter(MAX_APP_SERVER_LINE, (reason, sample) => opts.onBadLine?.(reason, sample))
  const pending = new Map<JsonRpcId, Pending>()
  const answered = new Set<JsonRpcId>()
  let nextId = 1
  let exited = false

  const child: ChildProcess = spawn(opts.bin, opts.args ?? ['app-server'], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const failAllPending = (error: Error): void => {
    for (const [id, p] of [...pending]) {
      pending.delete(id)
      clearTimeout(p.timer)
      p.reject(error)
    }
  }

  // ПОСТОЯННЫЙ слушатель 'error'. Без него Node бросает ENOENT НЕОБРАБОТАННЫМ и роняет весь
  // демон со всеми чужими сессиями — тот же урок, что в адаптере Claude (правка F1 по В2).
  // ВАЖНО: при неудачном спавне события 'exit' НЕ БУДЕТ ВОВСЕ, поэтому ожидающие запросы
  // хоронятся здесь же. Иначе `initialize` висел бы до своего таймаута — измерено: ход по
  // несуществующему бинарю падал не сразу, а через минуту.
  child.on('error', (e: Error) => {
    exited = true
    failAllPending(new Error(`app-server не запустился: ${e.message}`))
    opts.onSpawnError(e)
  })
  child.stdin?.on('error', () => { /* труба закрылась под нами */ })

  child.on('exit', (code, signal) => {
    exited = true
    failAllPending(new Error(`app-server вышел (code=${code ?? '—'} signal=${signal ?? '—'})`))
    opts.onExit(code, signal)
  })

  const handle = (msg: Record<string, unknown>): void => {
    const id = msg['id'] as JsonRpcId | undefined
    const method = typeof msg['method'] === 'string' ? msg['method'] : null
    const params = (msg['params'] && typeof msg['params'] === 'object' && !Array.isArray(msg['params'])
      ? msg['params']
      : {}) as Record<string, unknown>

    if (id !== undefined && method !== null) {
      opts.onServerRequest(id, method, params)
      return
    }
    if (id !== undefined) {
      const p = pending.get(id)
      if (!p) return
      pending.delete(id)
      clearTimeout(p.timer)
      const err = msg['error']
      if (err !== undefined && err !== null && typeof err === 'object') {
        const e = err as Record<string, unknown>
        p.reject(new AppServerError({
          code: typeof e['code'] === 'number' ? e['code'] : 0,
          message: typeof e['message'] === 'string' ? e['message'] : 'ошибка без текста',
          ...(e['data'] !== undefined ? { data: e['data'] } : {}),
        }))
        return
      }
      const result = msg['result']
      p.resolve(result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {})
      return
    }
    if (method !== null) opts.onNotification(method, params)
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    // Соединение не рвётся НИ НА ЧЁМ: ни мусор, ни переросток не стоят того, чтобы потерять
    // общий процесс со всеми чужими ходами.
    for (const line of splitter(chunk)) {
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { opts.onBadLine?.('bad_json', line.slice(0, 200)); continue }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        opts.onBadLine?.('not_an_object', line.slice(0, 200))
        continue
      }
      handle(parsed as Record<string, unknown>)
    }
  })

  const stderrSplitter = createAppServerSplitter(64 * 1024, () => { /* длинную строку stderr просто теряем */ })
  child.stderr?.on('data', (chunk: Buffer) => {
    for (const line of stderrSplitter(chunk)) opts.onStderr?.(line)
  })

  const write = (payload: unknown): void => {
    if (exited) return
    try { child.stdin?.write(JSON.stringify(payload) + '\n') } catch { /* труба закрыта — увидим по 'exit' */ }
  }

  return {
    get pid() { return child.pid },

    alive: () => !exited && child.exitCode === null && child.signalCode === null,

    request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
      const id = nextId++
      if (exited) return Promise.reject(new Error(`app-server уже вышел: ${method}`))
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!pending.has(id)) return
          pending.delete(id)
          reject(new Error(`app-server не ответил на ${method} за ${timeoutMs} мс`))
        }, timeoutMs)
        // `unref` НЕ зовём: пока запрос в полёте, демону есть чего ждать.
        pending.set(id, { resolve, reject, timer, method })
        write({ jsonrpc: '2.0', id, method, params })
      })
    },

    notify(method, params) { write({ jsonrpc: '2.0', method, params }) },

    respond(id, result) {
      if (answered.has(id)) return
      answered.add(id)
      write({ jsonrpc: '2.0', id, result })
    },

    respondError(id, code, message) {
      if (answered.has(id)) return
      answered.add(id)
      write({ jsonrpc: '2.0', id, error: { code, message } })
    },

    kill(signal) { try { child.kill(signal) } catch { /* уже мёртв */ } },

    waitExit(ms) {
      return new Promise<boolean>((resolve) => {
        if (exited || child.exitCode !== null || child.signalCode !== null) { resolve(true); return }
        const onExit = (): void => { clearTimeout(timer); resolve(true) }
        const timer = setTimeout(() => { child.off('exit', onExit); resolve(false) }, ms)
        timer.unref?.()
        child.once('exit', onExit)
      })
    },

    endStdin() { try { child.stdin?.end() } catch { /* уже закрыт */ } },
  }
}
