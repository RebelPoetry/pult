// `pult daemon stop` — остановка, которая не врёт «останавливать нечего» (A1 ревью В4).
//
// КАК ЛОМАЛОСЬ (приёмка лида на настоящем launchd, 23.09.2026): kill -9 демона → launchd поднимает
// нового, а в run/ ещё лежат сокет, lock и токен УБИТОГО. Новый демон сокет ещё не слушает, и
// `pult daemon stop` в это окно не мог подключиться → «демон не запущен — останавливать нечего»,
// код 0. Через 2 с `pult daemon status` показывал живого демона с аптаймом 2 с. То же окно есть и
// у подъёма по требованию: lock уже взят, `listen` ещё не было.
//
// ПОРЯДОК (решение лида 23.09.2026 по B1 повторной приёмки):
//   1. сокет отвечает — `daemon.stop`, ждём снятия lock;
//   2. сокет молчит, но демон ЭТОГО дома жив или стартует (процесс службы жив или запуск запланирован
//      после сигнала; lock держит живой pultd) — СНАЧАЛА ждём сокет (до 10 с от появления процесса;
//      на настоящем launchd bootstrap → ответ сокета за 1,5 с) и гасим через `daemon.stop`: это
//      единственный путь, который всегда кончается кодом 0;
//   3. сокета так и нет — ОДИН сигнал: служба — через менеджер (launchd `kill SIGTERM`, systemd
//      `stop`), иначе SIGTERM держателю lock, если доказано, что это pultd; держатель жив, но не
//      опознан — сигнала нет, честный код 1 с его pid. Процесс вышел, а менеджер снова его запускает
//      (смерть от сигнала до обработчиков) — честный код 1 и что живо. Новый pid повторно НЕ сигналим;
//   4. ничего из этого — «не запущен», код 0.
//
// КАК ЛОМАЛОСЬ (B1, настоящий launchd, 0.1.0-acc.4): прежний шаг 2 сразу слал `launchctl kill
// SIGTERM` процессу в окне старта — лаунчеру (sh без trap) или node, ещё грузящему граф импортов до
// обработчиков сигналов. Смерть от сигнала — «неуспешный выход», KeepAlive поднимал демона снова,
// а stop бил сигналом и каждый новый pid, опять в его окне старта: 25 с петли, «служба не
// остановилась (менеджер снова её запускает)», код 1, демон жив, `последний выход: сигнал 15`.
// Фальшивый launchd службу не воскрешал, поэтому тест на него проходил.

import { existsSync } from 'node:fs'
import type { Client } from '../cli/client.js'
import { connectClient } from '../cli/client.js'
import type { LockDeps } from '../core/lock.js'
import { confirmedLockHolder, liveLockHolder } from '../core/lock.js'
import type { PultPaths } from '../core/paths.js'
import type { ServiceContext } from './context.js'
import { queryState, signalStop } from './manager.js'
import { ownServiceContext } from './status.js'

export type StopOutcome =
  | { result: 'stopped'; via: 'socket' | 'service' | 'signal'; pid: number | null }
  | { result: 'none' }
  | { result: 'failed'; message: string }

export interface StopOptions {
  env?: NodeJS.ProcessEnv
  /** Сколько ждать сокета от стартующего демона (от первого увиденного процесса), прежде чем слать сигнал. */
  sockWaitMs?: number
  /** Потолок на ожидание сокета целиком: запланированный launchd запуск ждёт ThrottleInterval (10 с). */
  serviceWaitMs?: number
  /** Сколько ждать снятия lock после сигнала или `daemon.stop`. */
  lockWaitMs?: number
  /** Только для тестов: пробы процесса (`ps`) для суждения о держателе lock. */
  lockDeps?: LockDeps
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function tryConnect(paths: PultPaths, timeoutMs = 2000): Promise<Client | null> {
  try { return await connectClient(paths, { timeoutMs }) } catch { return null }
}

/**
 * Ждать, пока lock не будет держать никто живой — по тому же осторожному вердикту, что у
 * `acquireLock` («`ps` не ответил» = держит): свободен тот lock, который новый pultd сможет взять.
 * Протухший файл убитого демона — не помеха.
 */
async function waitLockFree(paths: PultPaths, waitMs: number, deps: LockDeps = {}): Promise<boolean> {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (!existsSync(paths.lock) || liveLockHolder(paths.lock, deps) === null) return true
    await sleep(50)
  }
  return !existsSync(paths.lock) || liveLockHolder(paths.lock, deps) === null
}

async function stopViaSocket(paths: PultPaths, client: Client, lockWaitMs: number, deps: LockDeps = {}): Promise<StopOutcome> {
  const pid = client.daemon.pid
  const closed = new Promise<void>((r) => client.onClose(() => r()))
  try {
    await client.request('daemon.stop', undefined, { timeoutMs: 5000 })
  } catch { /* соединение могло закрыться раньше ответа — дальше решает lock */ }
  await Promise.race([closed, sleep(5000)])
  client.close()
  if (await waitLockFree(paths, lockWaitMs, deps)) return { result: 'stopped', via: 'socket', pid }
  return { result: 'failed', message: `демон (pid ${pid}) не остановился за ${lockWaitMs / 1000} с: lock ${paths.lock} держит живой процесс` }
}

/** Процесс службы жив или менеджер вот-вот его поднимет (launchd `spawn scheduled`, systemd auto-restart). */
function serviceBusy(svc: ServiceContext): { busy: boolean; pid: number | null } {
  const m = queryState(svc)
  if (!m.loaded) return { busy: false, pid: null }
  if (m.pid !== null) return { busy: true, pid: m.pid }
  const st = m.state ?? ''
  // launchd `spawn scheduled` после СИГНАЛА (kill -9, SIGTERM раньше обработчиков) — демон вот-вот
  // поднимется живым. После выхода с КОДОМ это петля падений (78, 1, 3): живого демона там нет,
  // а ждать очередного падения незачем — решает lock ниже.
  if (st === 'spawn scheduled') return { busy: m.lastExitCode === null, pid: null }
  return { busy: st.startsWith('activating'), pid: null }
}

/** Жив ли демон этого дома или стартует: процесс службы (или её запланированный запуск), держатель lock. */
function whoIsStarting(paths: PultPaths, svc: ServiceContext | null, deps: LockDeps = {}): { busy: boolean; pid: number | null; service: boolean } {
  let s = { busy: false, pid: null as number | null }
  if (svc) { try { s = serviceBusy(svc) } catch { /* менеджер не ответил — решает lock */ } }
  const holder = liveLockHolder(paths.lock, deps)
  return { busy: s.busy || holder !== null, pid: s.pid ?? holder?.pid ?? null, service: s.busy }
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

export async function stopDaemon(paths: PultPaths, opts: StopOptions = {}): Promise<StopOutcome> {
  const env = opts.env ?? process.env
  const o = { sockWaitMs: opts.sockWaitMs ?? 10_000, serviceWaitMs: opts.serviceWaitMs ?? 25_000, lockWaitMs: opts.lockWaitMs ?? 10_000 }

  const client = await tryConnect(paths)
  const deps = opts.lockDeps ?? {}
  if (client) return stopViaSocket(paths, client, o.lockWaitMs, deps)

  const svc = ownServiceContext(paths, env)

  // --- 2. демон стартует: ждём сокет -----------------------------------------------------
  // Окно 10 с отсчитывается от первого увиденного процесса: запланированный launchd запуск ещё
  // может ждать ThrottleInterval, и сокета без процесса не будет. Общий потолок — serviceWaitMs.
  const t0 = Date.now()
  let seenAt: number | null = null
  let lastPid: number | null = null
  let who = whoIsStarting(paths, svc, deps)
  if (!who.busy) return { result: 'none' }
  for (;;) {
    if (who.pid !== null) { lastPid = who.pid; seenAt ??= Date.now() }
    const c = await tryConnect(paths, 1000)
    if (c) return stopViaSocket(paths, c, o.lockWaitMs, deps)
    if ((seenAt !== null && Date.now() - seenAt >= o.sockWaitMs) || Date.now() - t0 >= o.serviceWaitMs) break
    await sleep(200)
    who = whoIsStarting(paths, svc, deps)
    if (!who.busy) {
      // Ушёл сам, пока мы ждали: остановлен — если и lock свободен.
      if (await waitLockFree(paths, o.lockWaitMs, deps)) return { result: 'stopped', via: 'signal', pid: lastPid }
      return { result: 'failed', message: `lock ${paths.lock} держит живой процесс, а демон не отвечает — смотри pult daemon status` }
    }
  }

  // --- 3. сокета нет: один сигнал ---------------------------------------------------------
  const waited = Math.round((Date.now() - (seenAt ?? t0)) / 1000)
  let signalled: number | null = who.pid
  let via: 'service' | 'signal' = 'signal'
  if (svc && who.service) {
    via = 'service'
    // Отказ менеджера здесь не приговор: ниже решает его состояние.
    try { signalStop(svc) } catch { /* см. выше */ }
  } else {
    // Сигнал — только ДОКАЗАННОМУ pultd (`confirmedLockHolder`), а не «возможному держателю».
    // КАК ЛОМАЛОСЬ (`codex review` дельты В4, 28.09.2026): здесь стоял `liveLockHolder`, который для
    // lock без времени старта при упавшем `ps` отвечает «держит». Номер протухшего lock, доставшийся
    // чужому процессу, получал SIGTERM. Менеджер служб (ветка выше) свой pid знает сам — её не трогаем.
    const holder = confirmedLockHolder(paths.lock, deps)
    signalled = holder?.pid ?? null
    if (holder) {
      try { process.kill(holder.pid, 'SIGTERM') } catch { /* ушёл сам */ }
    } else {
      const unknown = liveLockHolder(paths.lock, deps)
      if (unknown) {
        return {
          result: 'failed',
          message: `lock ${paths.lock} держит живой процесс pid ${unknown.pid}, демон не ответил за ${waited} с, `
            + `а подтвердить, что это pultd, не удалось (ps не ответил или это чужой процесс) — сигнал не послан; `
            + `проверь \`ps -p ${unknown.pid}\` и, если это pultd, останови его сам`,
        }
      }
    }
  }
  const deadline = Date.now() + o.lockWaitMs
  while (signalled !== null && alive(signalled) && Date.now() < deadline) await sleep(100)
  if (signalled !== null && alive(signalled)) {
    return { result: 'failed', message: `демон (pid ${signalled}) не ответил за ${waited} с и не вышел по SIGTERM за ${o.lockWaitMs / 1000} с` }
  }
  if (svc) {
    let again = { busy: false, pid: null as number | null }
    try { again = serviceBusy(svc) } catch { /* менеджер не ответил — решает lock */ }
    if (again.busy) {
      return {
        result: 'failed',
        message: `демон службы ${svc.name} не ответил за ${waited} с; после SIGTERM менеджер служб снова запускает его`
          + `${again.pid !== null ? ` (pid ${again.pid})` : ' (перезапуск запланирован)'} — демон не остановлен, смотри pult daemon status и pult doctor`,
      }
    }
  }
  if (!(await waitLockFree(paths, o.lockWaitMs, deps))) {
    return { result: 'failed', message: `процесс демона вышел, но lock ${paths.lock} держит живой процесс` }
  }
  return { result: 'stopped', via, pid: signalled ?? lastPid }
}
