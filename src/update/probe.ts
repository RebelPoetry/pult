// Перезапуск демона на активной версии и проба (docs/08 §4).
//
// ЛОВУШКА, РАДИ КОТОРОЙ ЭТОТ ФАЙЛ ОТДЕЛЬНО: CLI, выполняющий `pult update`, — СТАРАЯ версия.
// Его `daemonEntry()` (`../daemon/main.js` рядом с ним самим) поднял бы старого демона, проба
// увидела бы старую версию и откатила бы исправное обновление. Поэтому точка входа берётся из
// `current` — ровно тот же файл, что запустит лаунчер службы.
//
// Проба — до трёх попыток: `hello_ok` за ≤ 10 с, `daemon.status.version` = ожидаемой, и демон
// жив через 2 с после ответа (ловит падение сразу после `listen` — например, на первом тике
// после старта, которого одно рукопожатие не видит).
//
// ПРОЦЕСС ВЫШЕЛ ДО hello_ok — проба кончается сразу, без новых попыток (решение лида 23.09.2026,
// B2 повторной приёмки): детерминированное падение повтор не лечит, а launchd его и так уже повторил.
// Попытки остаются только таймауту без выхода и «ответил, но через 2 с мёртв».
//
// ПОД СЛУЖБОЙ (A2 ревью В4): ребёнка-спавна нет, и раньше выход процесса попытки не замечался —
// сломанная версия под настоящим launchd откатывалась 81 с, молча. Теперь проба опрашивает
// менеджер служб (launchd `runs`/`pid`, systemd `ExecMainPID`/`MainPID`) и проваливает попытку,
// как только процесс ЭТОЙ попытки вышел; каждая попытка печатает строку хода с длительностью шагов
// — по ним видно, где уходит время (так нашёлся `kickstart -k`, придержанный ThrottleInterval).

import type { ChildProcess } from 'node:child_process'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { connectClient } from '../cli/client.js'
import { spawnDaemonDetached } from '../cli/startOnDemand.js'
import type { PultPaths } from '../core/paths.js'
import type { DaemonStatus } from '../core/rpc.js'
import type { ServiceContext } from '../service/context.js'
import { stopRunningDaemon } from '../service/install.js'
import type { ManagerState, Step } from '../service/manager.js'
import { formatLastExit, queryState, restart as restartService, restartCommand } from '../service/manager.js'
import { daemonEntryIn } from './versions.js'

export const PROBE_ATTEMPTS = 3
export const HELLO_WAIT_MS = 10_000
export const ALIVE_AFTER_MS = 2_000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function daemonStatusOnce(paths: PultPaths, timeoutMs = 2000): Promise<DaemonStatus | null> {
  let client
  try { client = await connectClient(paths, { timeoutMs }) } catch { return null }
  try {
    // Потолок и на сам запрос, не только на hello: версия, ответившая hello_ok и зависшая,
    // держала пробу вечно — ни повторов, ни отката, run/update.lock занят навсегда.
    return (await client.request('daemon.status', undefined, { timeoutMs })) as DaemonStatus
  } catch {
    return null
  } finally {
    client.close()
  }
}

export interface RestartContext {
  paths: PultPaths
  /** Служба ЭТОГО PULT_HOME или null — тогда отсоединённый спавн из `current`. */
  svc: ServiceContext | null
  env: NodeJS.ProcessEnv
  warn: (s: string) => void
  /** Строки хода пробы (stderr): попытка, команда перезапуска, исход — с длительностями. */
  progress?: (s: string) => void
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} с`

/** Состояние службы или null: ошибка опроса менеджера пробу не валит — она просто ждёт hello_ok. */
function managerState(ctx: RestartContext): ManagerState | null {
  if (!ctx.svc) return null
  try {
    const m = queryState(ctx.svc)
    return m.error ? null : m
  } catch {
    return null
  }
}

/** Файл, куда попадает stderr демона: у службы — service.log, у спавна — журнал демона. */
export const outputFile = (ctx: RestartContext): string => (ctx.svc ? ctx.paths.serviceLog : ctx.paths.logFile)

export function fileSize(file: string): number {
  try { return statSync(file).size } catch { return 0 }
}

/** Что дописано в файл после смещения `from` — последние `lines` строк. */
export function tailSince(file: string, from: number, lines = 20): string {
  let fd: number
  try { fd = openSync(file, 'r') } catch { return '' }
  try {
    const size = statSync(file).size
    const start = size >= from ? from : 0
    const len = Math.min(size - start, 256 * 1024)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    return buf.toString('utf8').split('\n').filter((l) => l.trim()).slice(-lines).join('\n')
  } finally {
    closeSync(fd)
  }
}

interface Started {
  child: ChildProcess | null
  via: 'service' | 'spawn'
  /** Состояние службы ДО перезапуска: от него отсчитывается «процесс этой попытки». */
  base: ManagerState | null
  /**
   * Служба перезагружена (launchd bootout + bootstrap): это НОВАЯ служба, её `runs` начинается
   * заново и может совпасть с прежним — выход процесса попытки узнаётся по коду/сигналу выхода.
   */
  fresh: boolean
}

/**
 * Один старт демона на активной версии. Работающий демон сначала останавливается мягко
 * (`daemon.stop`: сессии остаются в реестре и поднимаются ленивым resume, как в В2/В3), иначе
 * новый упрётся в lock и выйдет с кодом 3. Под службой — перезапуск через менеджер служб;
 * менеджер ответил ошибкой — спавн в обход с предупреждением (как ensureDaemon).
 * Под launchd это перезагрузка bootout + bootstrap, а не `kickstart -k` (см. manager.ts `restart`).
 */
async function startOnce(ctx: RestartContext, tag: string): Promise<Started> {
  const say = ctx.progress ?? ((): void => {})
  const t0 = Date.now()
  const stopped = await stopRunningDaemon(ctx.paths)
  if (stopped.stopped) say(`${tag}: остановлен прежний демон (pid ${stopped.pid ?? '?'}) — ${secs(Date.now() - t0)}`)
  if (ctx.svc) {
    const base = managerState(ctx)
    let st: Step
    const t1 = Date.now()
    try {
      st = restartService(ctx.svc)
    } catch (e) {
      st = { cmd: restartCommand(ctx.svc), ok: false, detail: (e as Error).message }
    }
    say(`${tag}: ${st.cmd} — ${st.ok ? 'ok' : `ошибка: ${st.detail}`}, ${secs(Date.now() - t1)}`)
    if (st.ok) return { child: null, via: 'service', base, fresh: ctx.svc.platform === 'darwin' }
    ctx.warn(`pult update: служба ${ctx.svc.name} не перезапустилась (${st.cmd}: ${st.detail}) — поднимаю демона напрямую`)
  }
  const entry = daemonEntryIn(ctx.paths.current)
  const child = spawnDaemonDetached(ctx.paths, entry, ctx.env)
  say(`${tag}: спавн ${entry} (pid ${child.pid ?? '?'})`)
  return { child, via: 'spawn', base: null, fresh: false }
}

export interface ProbeOutcome {
  ok: boolean
  /** Почему последняя попытка не удалась — для человека. */
  reason: string
  status?: DaemonStatus
  attempts: number
}

/** Как часто спрашивать менеджер служб о процессе попытки (spawnSync — не на каждом обороте). */
const MANAGER_POLL_MS = 300

/**
 * Вышел ли процесс службы, запущенный ЭТОЙ попыткой. Новый запуск виден по смене метки `runs`
 * (launchd `runs`, systemd `ExecMainPID`) или по pid, который мы уже видели; вышел — pid нет или
 * он сменился (менеджер поднял процесс заново сам).
 */
function serviceExited(started: Started, m: ManagerState, seenPid: number | null): boolean {
  if (seenPid !== null) return m.pid !== seenPid
  // Свежезагруженная служба: `(never exited)` до первого выхода — код или сигнал значит, что вышел
  // процесс ЭТОЙ попытки (сравнивать `runs` с прежней службой нельзя: счёт начался заново).
  if (started.fresh) return m.pid === null && (m.runs ?? 0) > 0 && (m.lastExitCode !== null || m.lastSignal !== null)
  const base = started.base
  const newRun = base !== null && m.runs !== null && m.runs !== base.runs
  return newRun && m.pid === null
}

/**
 * Ждать `hello_ok` + `daemon.status` с нужной версией. Ребёнок-спавн, вышедший раньше ответа, —
 * провал сразу, а не через 10 с: сломанная версия падает мгновенно, и ждать её незачем. Под
 * службой то же самое узнаётся у менеджера служб; выход засчитывается, только если его показали
 * два опроса подряд — мгновение между «убит» и «поднят» при перезапуске провалом не считается.
 */
async function waitVersion(ctx: RestartContext, started: Started, version: string, waitMs: number): Promise<{ status: DaemonStatus | null; reason: string; exited: boolean }> {
  // Объект, а не `let`: присваивание в обработчике TS не видит и сузил бы переменную до null.
  const died: { how: string | null } = { how: null }
  started.child?.once('exit', (code, signal) => { died.how = signal ? `сигнал ${signal}` : `код ${code}` })
  const deadline = Date.now() + waitMs
  let seen: DaemonStatus | null = null
  let seenPid: number | null = null
  let exitSeen = 0
  let nextPoll = 0
  while (Date.now() < deadline) {
    const st = await daemonStatusOnce(ctx.paths)
    if (st) {
      seen = st
      const modeOk = started.via !== 'service' || st.mode === 'service'
      if (st.version === version && modeOk) return { status: st, reason: '', exited: false }
    }
    if (died.how !== null) return { status: null, reason: `демон вышел (${died.how}), не ответив hello_ok`, exited: true }
    if (started.via === 'service' && Date.now() >= nextPoll) {
      nextPoll = Date.now() + MANAGER_POLL_MS
      const m = managerState(ctx)
      if (m) {
        if (serviceExited(started, m, seenPid)) {
          if (++exitSeen >= 2) {
            const how = m.lastExitCode !== null || m.lastSignal !== null ? formatLastExit(m) : 'код не сообщён'
            return { status: null, reason: `демон вышел (${how}), не ответив hello_ok`, exited: true }
          }
        } else {
          exitSeen = 0
          if (m.pid !== null && seenPid === null) seenPid = m.pid
        }
      }
    }
    await sleep(100)
  }
  return {
    status: null,
    exited: false,
    reason: seen
      ? `за ${Math.round(waitMs / 1000)} с отвечал не тот демон: версия ${seen.version}, режим ${seen.mode}, pid ${seen.pid}`
      : `демон не ответил hello_ok за ${Math.round(waitMs / 1000)} с`,
  }
}

export interface ProbeOptions {
  attempts?: number
  helloWaitMs?: number
  /** 0 — не проверять «жив через N мс» (подъём старой версии при откате). */
  aliveAfterMs?: number
  /** Слово в строках хода: `проба` (новая версия) или `откат` (подъём прежней). */
  label?: string
}

export async function restartAndProbe(ctx: RestartContext, version: string, opts: ProbeOptions = {}): Promise<ProbeOutcome> {
  const attempts = opts.attempts ?? PROBE_ATTEMPTS
  const helloWaitMs = opts.helloWaitMs ?? HELLO_WAIT_MS
  const aliveAfterMs = opts.aliveAfterMs ?? ALIVE_AFTER_MS
  const say = ctx.progress ?? ((): void => {})
  let reason = 'проба не запускалась'
  for (let i = 1; i <= attempts; i++) {
    const tag = `${opts.label ?? 'проба'} ${i}/${attempts}`
    let started: Started
    try {
      started = await startOnce(ctx, tag)
    } catch (e) {
      reason = (e as Error).message
      say(`${tag}: ${reason}`)
      continue
    }
    const t0 = Date.now()
    const got = await waitVersion(ctx, started, version, helloWaitMs)
    if (!got.status) {
      reason = got.reason
      say(`${tag}: ${reason.replace(/, не ответив hello_ok$/, '')} через ${secs(Date.now() - t0)}`)
      // Вышел, не ответив: повтор того же кода упадёт так же (под launchd он уже и повторён).
      // Раньше тут шли ещё две попытки, и под launchd каждая ждала ThrottleInterval (B2, 65 с отката).
      if (got.exited) {
        if (i < attempts) say(`${tag}: процесс вышел до hello_ok — повторять незачем`)
        return { ok: false, reason, attempts: i }
      }
      continue
    }
    say(`${tag}: ${version} ответил (pid ${got.status.pid}) за ${secs(Date.now() - t0)}`
      + `${aliveAfterMs > 0 ? ` — жив ли через ${aliveAfterMs / 1000} с` : ''}`)
    if (aliveAfterMs <= 0) return { ok: true, reason: '', status: got.status, attempts: i }
    await sleep(aliveAfterMs)
    const again = await daemonStatusOnce(ctx.paths)
    if (again && again.pid === got.status.pid && again.version === version) {
      return { ok: true, reason: '', status: again, attempts: i }
    }
    reason = `демон ${version} (pid ${got.status.pid}) ответил, но через ${aliveAfterMs / 1000} с уже не отвечает — падает сразу после старта`
    say(`${tag}: ${reason}`)
  }
  return { ok: false, reason, attempts }
}
