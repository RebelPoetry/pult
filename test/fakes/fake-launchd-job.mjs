#!/usr/bin/env node
// Надзиратель одной службы фальшивого launchd: то, что у настоящего делает сам launchd, а
// одноразовый процесс fake-launchctl сделать не может, — следит за процессом службы и поднимает его
// заново по правилам plist Пульта (docs/08 §2: `KeepAlive {SuccessfulExit: false}`, `ThrottleInterval`).
//
// ЗАЧЕМ (B1 приёмки В4, 23.09.2026): прежняя фальшивка процесс службы только запускала. Смерть от
// сигнала на настоящем launchd — «неуспешный выход», служба поднимается снова через ThrottleInterval;
// на фальшивке — нет. Поэтому `pult daemon stop`, славший SIGTERM демону ДО его обработчиков, на
// фальшивке проходил, а на настоящем launchd крутился 25 с в петле «сигнал → воскрешение».
//
// Модель:
//   * выход с кодом 0 — службу не поднимать (state `not running`);
//   * смерть от сигнала или код ≠ 0 — `spawn scheduled`, новый запуск через ThrottleInterval,
//     отсчитанный, как у launchd, от НАЧАЛА прошлого запуска (FAKE_SVC_THROTTLE_MS, по умолчанию 1 с);
//   * служба снята (bootout) или перезапущена (kickstart сменил поколение `gen`) — надзиратель уходит,
//     ничего не поднимая.
// Каждый выход и перезапуск пишется в FAKE_SVC_LOG событием {tool: 'launchd', event: 'exit'|'respawn'}.
//
// Вход — FAKE_JOB (JSON): {label, gen, program, env, cwd, logPath}.

import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { jobEnv, logEvent, withState } from './fake-svc-lib.mjs'

const spec = JSON.parse(process.env.FAKE_JOB || '{}')
const throttleMs = Number(process.env.FAKE_SVC_THROTTLE_MS || 1000)
// Имена сигналов — как в настоящем `last terminating signal = Terminated: 15`.
const SIGNAME = { SIGTERM: 'Terminated: 15', SIGKILL: 'Killed: 9', SIGINT: 'Interrupt: 2', SIGHUP: 'Hangup: 1' }
const mine = (st) => st.jobs?.[spec.label]?.gen === spec.gen
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function spawnOnce() {
  let fd = 'ignore'
  if (spec.logPath) {
    mkdirSync(dirname(spec.logPath), { recursive: true })
    fd = openSync(spec.logPath, 'a')
  }
  try {
    return spawn(spec.program, [], {
      stdio: ['ignore', fd, fd],
      env: jobEnv(spec.env || {}),
      cwd: spec.cwd && existsSync(spec.cwd) ? spec.cwd : undefined,
    })
  } finally {
    if (typeof fd === 'number') closeSync(fd)
  }
}

async function main() {
  for (;;) {
    const child = spawnOnce()
    const exited = new Promise((r) => {
      child.once('exit', (code, signal) => r({ code, signal }))
      // Программы нет (ENOENT): launchd отвечает на это кодом 78 (EX_CONFIG) и крутит перезапуски.
      child.once('error', () => r({ code: 78, signal: null }))
    })
    const pid = child.pid ?? null
    const started = withState((st) => {
      if (!mine(st)) return false
      const j = st.jobs[spec.label]
      j.pid = pid
      j.spawning = null
      j.runs = (j.runs || 0) + 1
      j.scheduled = false
      j.lastStart = Date.now()
      return true
    })
    if (!started) {
      if (pid) { try { process.kill(pid, 'SIGKILL') } catch { /* ушёл */ } }
      return
    }
    const { code, signal } = await exited
    const respawn = signal !== null || code !== 0
    const lastStart = Date.now()
    const still = withState((st) => {
      if (!mine(st)) return null
      const j = st.jobs[spec.label]
      if (j.pid === pid) j.pid = null
      j.lastExit = signal ? null : code
      j.lastSignal = signal ? (SIGNAME[signal] ?? `${signal}: 0`) : null
      j.scheduled = respawn
      return j.lastStart ?? lastStart
    })
    logEvent('launchd', 'exit', { label: spec.label, pid, code, signal })
    if (still === null || !respawn) return
    await sleep(Math.max(0, still + throttleMs - Date.now()))
    if (!withState((st) => mine(st))) return
    logEvent('launchd', 'respawn', { label: spec.label })
  }
}

await main()
