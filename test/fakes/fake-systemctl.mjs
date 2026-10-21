#!/usr/bin/env node
// Фальшивый `systemctl --user`: daemon-reload, reset-failed, enable --now, start, restart, stop,
// disable --now, show. Юниты ищет в PULT_SERVICE_DIR (тот же шов, что у Пульта). argv — в FAKE_SVC_LOG.
// Тексты ошибок — как у systemd 249–255.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { alive, fail, killJob, loadState, logArgv, saveState, spawnJob } from './fake-svc-lib.mjs'

logArgv('systemctl')
const argv = process.argv.slice(2).filter((a) => a !== '--user')
const verb = argv[0]
const st = loadState()
const dir = process.env.PULT_SERVICE_DIR || ''

/** Снимает кавычки и C-экранирование значения, как systemd, и `%%` → `%`. */
function unquote(v) {
  v = v.trim()
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, '$1')
  return v.replace(/%%/g, '%')
}

function parseUnit(text) {
  const env = {}
  let program = null
  let cwd = null
  let logPath = null
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i < 0 || line.startsWith('#')) continue
    const k = line.slice(0, i).trim()
    const v = line.slice(i + 1)
    if (k === 'ExecStart') program = unquote(v).replace(/\$\$/g, '$')
    else if (k === 'Environment') {
      const kv = unquote(v)
      const j = kv.indexOf('=')
      env[kv.slice(0, j)] = kv.slice(j + 1)
    } else if (k === 'WorkingDirectory') cwd = v.trim().replace(/%%/g, '%')
    else if (k === 'StandardOutput') logPath = v.trim().replace(/^append:/, '').replace(/%%/g, '%')
  }
  return { program, env, cwd, logPath }
}

const unitFile = (unit) => join(dir, unit)

function startUnit(unit) {
  const job = st.jobs[unit] || (st.jobs[unit] = { pid: null, lastExit: null, enabled: false })
  if (alive(job.pid)) return
  job.pid = spawnJob(parseUnit(readFileSync(unitFile(unit), 'utf8')))
}

switch (verb) {
  case 'daemon-reload':
    process.exit(0)
  case 'reset-failed': {
    const unit = argv[1]
    if (!existsSync(unitFile(unit))) { process.stderr.write(`Failed to reset failed state of unit ${unit}: Unit ${unit} not loaded.\n`); process.exit(1) }
    process.exit(0)
  }
  case 'enable': {
    const unit = argv.filter((a) => !a.startsWith('-'))[1]
    if (!existsSync(unitFile(unit))) { process.stderr.write(`Failed to enable unit: Unit file ${unit} does not exist.\n`); process.exit(1) }
    if (fail('enable')) { process.stderr.write(`Job for ${unit} failed because the control process exited with error code.\n`); process.exit(1) }
    const job = st.jobs[unit] || (st.jobs[unit] = { pid: null, lastExit: null, enabled: false })
    job.enabled = true
    if (argv.includes('--now')) startUnit(unit)
    saveState(st)
    process.exit(0)
  }
  case 'start':
  case 'restart': {
    const unit = argv[1]
    if (!existsSync(unitFile(unit))) { process.stderr.write(`Failed to ${verb} ${unit}: Unit ${unit} not found.\n`); process.exit(5) }
    if (fail(verb)) { process.stderr.write(`Job for ${unit} failed because the control process exited with error code.\n`); process.exit(1) }
    const job = st.jobs[unit] || (st.jobs[unit] = { pid: null, lastExit: null, enabled: false })
    if (verb === 'restart' && alive(job.pid)) { killJob(job.pid); job.lastExit = 0 }
    startUnit(unit)
    saveState(st)
    process.exit(0)
  }
  case 'stop': {
    // Синхронный, как настоящий: SIGTERM и ожидание выхода; отменяет запланированный перезапуск.
    const unit = argv[1]
    if (!existsSync(unitFile(unit))) { process.stderr.write(`Failed to stop ${unit}: Unit ${unit} not loaded.\n`); process.exit(5) }
    const job = st.jobs[unit]
    if (job && alive(job.pid)) { killJob(job.pid); job.lastExit = 0 }
    saveState(st)
    process.exit(0)
  }
  case 'disable': {
    const unit = argv.filter((a) => !a.startsWith('-'))[1]
    const job = st.jobs[unit]
    if (!job && !existsSync(unitFile(unit))) { process.stderr.write(`Failed to disable unit: Unit file ${unit} does not exist.\n`); process.exit(1) }
    if (job && argv.includes('--now') && alive(job.pid)) { killJob(job.pid); job.lastExit = 0 }
    delete st.jobs[unit]
    saveState(st)
    process.exit(0)
  }
  case 'show': {
    const unit = argv[1]
    const pi = argv.indexOf('-p')
    const props = pi >= 0 ? argv[pi + 1].split(',') : ['LoadState', 'ActiveState', 'MainPID', 'ExecMainStatus']
    const job = st.jobs[unit]
    const loaded = existsSync(unitFile(unit))
    const running = !!job && alive(job.pid)
    const lastEnv = process.env.FAKE_SVC_LAST_EXIT
    // Сигнал (FAKE_SVC_LAST_SIGNAL, `Killed: 9`): ExecMainCode=2 (CLD_KILLED), ExecMainStatus = номер.
    const sig = !running && process.env.FAKE_SVC_LAST_SIGNAL ? /(\d+)\s*$/.exec(process.env.FAKE_SVC_LAST_SIGNAL)?.[1] : undefined
    const values = {
      LoadState: loaded ? 'loaded' : 'not-found',
      ActiveState: running ? 'active' : process.env.FAKE_SVC_ACTIVE || 'inactive',
      SubState: running ? 'running' : 'dead',
      MainPID: running ? String(job.pid) : '0',
      // pid последнего главного процесса — остаётся и после его выхода, как у systemd.
      ExecMainPID: String(job?.pid ?? 0),
      ExecMainCode: running ? '0' : sig ? '2' : '1',
      ExecMainStatus: running ? '0' : sig ?? String(lastEnv ?? job?.lastExit ?? 0),
    }
    process.stdout.write(props.map((p) => `${p}=${values[p] ?? ''}`).join('\n') + '\n')
    process.exit(0)
  }
  default:
    process.stderr.write(`fake-systemctl: глагол ${verb} не поддержан\n`)
    process.exit(64)
}
