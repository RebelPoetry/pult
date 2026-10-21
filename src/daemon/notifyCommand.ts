// Своя команда на уведомление (О2, docs/14 «Правила уведомлений»; как «Notification Command» у cmux).
//
// ЗАЧЕМ В ДЕМОНЕ, а не в окне: уведомление нужнее всего, когда окна нет, — человек ушёл от Мака, а сессия
// упала или спросила. Команда из `notifyCommand` в config.json (например, `curl` в Telegram) запускается на
// каждое событие внимания: готово, упал, вопрос, лимит, страж, завис.
//
// ПРАВИЛА ЗАПУСКА — все про то, чтобы чужая команда не могла навредить демону:
//   * `/bin/sh -c <команда>`, окружение — белый список (`buildChildEnv`: HOME, USER, PATH, LANG, TERM,
//     TMPDIR) плюс PULT_SESSION, PULT_TITLE, PULT_KIND, PULT_TEXT. Ни токена демона, ни ключей
//     провайдеров, ни прокси команда не видит (инвариант 1);
//   * не дольше 10 с — потом SIGKILL всей группе процессов (`sh -c 'sleep 60'` иначе оставил бы sleep); и после
//     обычного выхода sh группа добивается: фоновый `cmd &` из команды не переживает её;
//   * на сессию — одна команда за раз; пришло ещё, пока идёт, — запоминается одно и уходит следом:
//     самое важное (вопрос, ошибка, «завис» важнее «готово»), при равных — последнее. Очередь из сотни
//     запусков никому не нужна, а «упал» не должен потеряться за «готово»;
//   * провал команды — строка в журнале демона и только; цикл событий не ждёт её никогда (spawn без await).
// Правило «короткий ход не уведомляет» — тоже здесь: `done` с `turnMs` меньше порога пропускается.

import { spawn } from 'node:child_process'
import type { PultEvent } from '../core/events.js'
import type { Logger } from '../core/log.js'
import { buildChildEnv } from '../env/allowlist.js'
import type { Attention } from '../sessions/attention.js'

export const NOTIFY_COMMAND_TIMEOUT_MS = 10_000
/** Предел PULT_TEXT и PULT_TITLE в знаках: переменная окружения — не место для простыни. */
export const NOTIFY_TEXT_MAX = 1000

export interface NotifyJob {
  session: string
  title: string
  kind: Attention['kind']
  text: string
}

export interface NotifyRunnerOptions {
  command: string
  logger: Logger
  /** Окружение демона: из него белый список берёт HOME, PATH и прочее. */
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  /** Тест ждёт конца запуска: зовётся после каждого выхода команды. */
  onExit?(job: NotifyJob, result: { code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }): void
}

export interface NotifyRunner {
  fire(job: NotifyJob): void
  /** Сколько команд идёт прямо сейчас (тест и отладка). */
  running(): number
  /** Погасить идущие команды (остановка демона). */
  close(): void
}

const clip = (s: string): string => {
  const one = [...s.replace(/[\u0000-\u001f\u007f]+/g, ' ')]
  return one.length > NOTIFY_TEXT_MAX ? `${one.slice(0, NOTIFY_TEXT_MAX - 1).join('')}…` : one.join('')
}

/** Важность для слияния: «готово» — 0, всё остальное (вопрос, ошибка, «завис») — 1. */
const priority = (job: NotifyJob): number => (job.kind === 'done' ? 0 : 1)

export function createNotifyRunner(opts: NotifyRunnerOptions): NotifyRunner {
  const timeoutMs = opts.timeoutMs ?? NOTIFY_COMMAND_TIMEOUT_MS
  const active = new Map<string, import('node:child_process').ChildProcess>()
  const pending = new Map<string, NotifyJob>()
  let closed = false

  const run = (job: NotifyJob): void => {
    const env = buildChildEnv(opts.env ?? process.env, {
      extra: { PULT_SESSION: job.session, PULT_TITLE: clip(job.title), PULT_KIND: job.kind, PULT_TEXT: clip(job.text) },
    })
    let child
    try {
      // Своя группа процессов (`detached`): по таймауту убиваем всю группу — и sh, и то, что он запустил.
      child = spawn('/bin/sh', ['-c', opts.command], { env, stdio: 'ignore', detached: true })
    } catch (e) {
      opts.logger.warn('notifyCommand не запустился', { session: job.session, kind: job.kind, error: (e as Error).message })
      return
    }
    active.set(job.session, child)
    let timedOut = false
    const kill = (): void => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* ушёл */ } }
    }
    const timer = setTimeout(() => {
      timedOut = true
      opts.logger.warn('notifyCommand не уложился в срок — убит', { session: job.session, kind: job.kind, timeoutMs })
      kill()
    }, timeoutMs)
    timer.unref?.()
    let done = false
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (active.get(job.session) === child) active.delete(job.session)
      // Хвосты группы (`cmd &` внутри команды) — следом за sh. ESRCH (группы уже нет) — норма.
      kill()
      if (!timedOut && code !== 0) opts.logger.warn('notifyCommand завершился с ошибкой', { session: job.session, kind: job.kind, code, signal })
      opts.onExit?.(job, { code, signal, timedOut })
      const next = pending.get(job.session)
      if (next && !closed) { pending.delete(job.session); run(next) }
    }
    child.on('error', (e) => {
      opts.logger.warn('notifyCommand упал', { session: job.session, kind: job.kind, error: e.message })
      finish(null, null)
    })
    child.on('exit', (code, signal) => finish(code, signal))
    // Ребёнок не держит цикл событий демона: остановка демона его не ждёт.
    child.unref()
  }

  return {
    fire(job) {
      if (closed) return
      if (active.has(job.session)) {
        const prev = pending.get(job.session)
        if (!prev || priority(job) >= priority(prev)) pending.set(job.session, job)
        return
      }
      run(job)
    },
    running: () => active.size,
    close() {
      closed = true
      pending.clear()
      for (const child of active.values()) {
        try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* ушёл */ }
      }
      active.clear()
    },
  }
}

/**
 * Событие внимания → запуск команды или `null`. «Готово» короче порога (`turnMs` из события конца хода)
 * не зовёт никого — то же правило, что у окна. Длительность неизвестна (старый журнал, фоновый ход без
 * начала) — уведомляем: лучше лишнее «готово», чем потерянное.
 */
export function notifyJobFor(ev: PultEvent, att: Attention, title: string, minTurnSeconds: number): NotifyJob | null {
  if (att.kind === 'done') {
    const ms = ev.data['turnMs']
    if (typeof ms === 'number' && Number.isFinite(ms) && ms < minTurnSeconds * 1000) return null
  }
  return { session: ev.sessionId, title, kind: att.kind, text: att.text ?? '' }
}
