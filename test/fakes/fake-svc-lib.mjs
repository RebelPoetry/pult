// Общая часть фальшивых менеджеров служб (fake-launchctl, fake-systemctl, fake-loginctl).
//
// ЗАЧЕМ ОНИ ВООБЩЕ ЗАПУСКАЮТ ДЕМОНА: настоящий launchctl/systemctl в тестах не вызывается никогда
// (docs/08 §2), но `pult daemon install` проверяет, что демон ОТВЕТИЛ hello_ok. Поэтому фальшивка
// делает то же, что менеджер служб: читает сгенерированный файл службы, берёт из него программу,
// окружение, рабочую папку и путь журнала и поднимает лаунчер отсоединённым. Заодно это проверка
// самого файла: если plist/юнит разбирается не так, демон не поднимется.
//
// Переменные окружения фальшивок:
//   FAKE_SVC_LOG        JSONL: каждая строка — {tool, argv}; тест читает его через waitFor
//   FAKE_SVC_STATE      JSON-состояние: загруженные службы, их pid, linger
//   FAKE_SVC_EXTRA_ENV  JSON-объект переменных, добавляемых демону (PULT_CLAUDE_BIN и т.п. — чтобы
//                       поднятый «службой» демон не искал настоящие CLI)
//   FAKE_SVC_FAIL       имя глагола, который должен ответить ошибкой (kickstart, start, bootstrap…)
//   FAKE_SVC_LAST_EXIT  какой «последний код выхода» печатать про незапущенную службу
//   FAKE_SVC_SPAWN_SCHEDULED=1 launchctl: незапущенная служба — «spawn scheduled» (петля падений)
//   FAKE_SVC_LAST_SIGNAL launchctl: «last terminating signal» незапущенной службы (`Killed: 9`)
//   FAKE_SVC_NOSPAWN=1  загружать, но не запускать процесс (демон так и не ответит)
//   FAKE_SVC_DROP_ENV   через запятую: какие переменные файла службы НЕ передавать демону
//                       (PULT_SERVICE — демон ответит как поднятый «по требованию»)
//   FAKE_SVC_THROTTLE_MS launchctl: ThrottleInterval фальшивого launchd (по умолчанию 1000 мс;
//                       у настоящего — 10 с из plist). См. fake-launchd-job.mjs.

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, closeSync } from 'node:fs'
import { dirname } from 'node:path'

export function logArgv(tool) {
  const f = process.env.FAKE_SVC_LOG
  if (f) appendFileSync(f, JSON.stringify({ tool, argv: process.argv.slice(2) }) + '\n')
}

export function loadState() {
  const f = process.env.FAKE_SVC_STATE
  if (!f || !existsSync(f)) return { jobs: {}, linger: process.env.FAKE_LINGER || 'no' }
  return JSON.parse(readFileSync(f, 'utf8'))
}

export function saveState(st) {
  const f = process.env.FAKE_SVC_STATE
  if (!f) return
  mkdirSync(dirname(f), { recursive: true })
  // tmp+rename: состояние читают параллельно (надзиратель фальшивого launchd, print) — полузаписанный
  // JSON они не должны увидеть никогда.
  const tmp = `${f}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(st, null, 2))
  renameSync(tmp, f)
}

/**
 * Прочитать-изменить-записать состояние под блокировкой (mkdir — атомарен). Нужна, потому что у
 * фальшивого launchd писателей двое: сам launchctl и надзиратель службы (fake-launchd-job.mjs),
 * который записывает выход процесса и перезапуск. Без блокировки bootout, удаливший службу,
 * мог бы быть затёрт надзирателем, и служба «воскресала» бы в состоянии.
 * Каталога состояния нет (тест уже стёр дом) — `fn` не вызывается, ответ `null`.
 */
export function withState(fn) {
  const f = process.env.FAKE_SVC_STATE
  if (!f) { const st = loadState(); const r = fn(st); return r }
  const lock = `${f}.lck`
  for (let i = 0; ; i++) {
    try { mkdirSync(lock); break } catch (e) {
      if (e.code === 'ENOENT') return null
      if (e.code !== 'EEXIST') throw e
      // Хозяин блокировки умер посреди записи — через 5 с блокировка считается брошенной.
      try { if (Date.now() - statSync(lock).mtimeMs > 5000) rmSync(lock, { recursive: true, force: true }) } catch { /* сняли */ }
      sleepSync(5)
    }
  }
  try {
    const st = loadState()
    const r = fn(st)
    saveState(st)
    return r
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

export function alive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

export const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** SIGTERM и ожидание выхода; не ушёл за 8 с — SIGKILL. Так же ведут себя launchd и systemd. */
export function killJob(pid) {
  if (!alive(pid)) return
  try { process.kill(pid, 'SIGTERM') } catch { return }
  for (let i = 0; i < 400 && alive(pid); i++) sleepSync(20)
  if (alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* ушёл */ } }
}

/** Окружение процесса службы: из файла службы + FAKE_SVC_EXTRA_ENV − FAKE_SVC_DROP_ENV. */
export function jobEnv(env) {
  let extra = {}
  try { extra = JSON.parse(process.env.FAKE_SVC_EXTRA_ENV || '{}') } catch { extra = {} }
  const base = {}
  for (const k of ['HOME', 'USER', 'TMPDIR']) if (process.env[k]) base[k] = process.env[k]
  const childEnv = { ...base, ...env, ...extra }
  for (const k of (process.env.FAKE_SVC_DROP_ENV || '').split(',').filter(Boolean)) delete childEnv[k]
  return childEnv
}

/** Поднять программу службы отсоединённой: stdout+stderr — в журнал службы, как делает менеджер. */
export function spawnJob({ program, env, cwd, logPath }) {
  if (process.env.FAKE_SVC_NOSPAWN === '1') return null
  if (logPath) mkdirSync(dirname(logPath), { recursive: true })
  const fd = logPath ? openSync(logPath, 'a') : 'ignore'
  const child = spawn(program, [], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: jobEnv(env),
    cwd: cwd && existsSync(cwd) ? cwd : undefined,
  })
  child.on('error', () => { /* ENOENT и т.п.: тест увидит, что демон не ответил */ })
  child.unref()
  if (typeof fd === 'number') closeSync(fd)
  return child.pid ?? null
}

export const fail = (verb) => process.env.FAKE_SVC_FAIL === verb

/** Событие фальшивого менеджера (выход процесса, перезапуск) — в тот же журнал, что argv. */
export function logEvent(tool, event, data = {}) {
  const f = process.env.FAKE_SVC_LOG
  if (f) { try { appendFileSync(f, JSON.stringify({ tool, event, argv: [], ...data }) + '\n') } catch { /* дом стёрт */ } }
}
