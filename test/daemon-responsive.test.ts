// Демон отвечает всегда: ни старт, ни `doctor.run` не останавливают событийный цикл.
//
// ЧТО ИЗМЕРЕНО 30.09.2026 (настоящий launchd, служба с фоновым приоритетом — один и тот же набор
// запусков там шёл в 17 раз дольше):
//   * старт: до `listen` демон спрашивал `claude --version` и `codex --version` через spawnSync —
//     до 6 с на эти два запуска; рабочая служба стартовала 11 с вместо 0,4 с, и проба `pult update`
//     («hello_ok за 10 с») провалилась;
//   * `doctor.run` (его зовёт окно при каждом открытии): логин-шелл, семь `--version` и два входа
//     подряд через spawnSync — 19 с без ответа на тестовой службе, 44–94 с на рабочей; четыре
//     команды CLI подряд упали с «демон не ответил на hello».
// Здесь то же самое на МЕДЛЕННЫХ фальшивых CLI (sh-скрипты): настоящие claude/codex не запускаются.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { connectClient } from '../dist/cli/client.js'
import type { DoctorReport } from '../dist/env/doctor.js'
import type { LocateDeps, LocatedTool, ToolName } from '../dist/env/locate.js'
import { locateAllAsync, TOOLS } from '../dist/env/locate.js'
import { sleep, startTestDaemon, tempHome, waitFor } from './helpers.js'

const DAEMON_ENTRY = fileURLToPath(new URL('../dist/daemon/main.js', import.meta.url))
/** Предзагрузка, которая пишет каждый spawnSync главного потока в файл TRACE_SPAWNSYNC. */
const TRACE = pathToFileURL(fileURLToPath(new URL('../test/fakes/trace-spawnsync.mjs', import.meta.url))).href

function script(file: string, body: string): string {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

describe('старт демона', () => {
  it('до listen не запускается ни один CLI, а на событийном цикле — ни одного spawnSync, кроме ps для lock', async () => {
    const home = tempHome()
    // Свой HOME: `~/.local/bin/codex` и `~/.claude/local/claude` — первые кандидаты поиска, и оба
    // здесь фальшивые. Каждый запуск пишет строку в журнал и думает 3 с.
    const fakeHome = mkdtempSync(join(tmpdir(), 'ph-'))
    const log = join(fakeHome, 'запуски.log')
    const body = `echo "$0 $*" >> "${log}"\nsleep 3\necho "фальшивый 9.9.9"`
    script(join(fakeHome, '.local/bin/codex'), body)
    script(join(fakeHome, '.claude/local/claude'), body)
    const trace = join(fakeHome, 'spawnsync.log')
    const t0 = Date.now()
    // Без PULT_CLAUDE_BIN/PULT_CODEX_BIN: идёт боевой поиск CLI.
    const child = spawn(process.execPath, ['--import', TRACE, DAEMON_ENTRY], {
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: fakeHome, PULT_HOME: home.paths.home, PULT_TEST: '1',
        TRACE_SPAWNSYNC: trace,
      },
      stdio: 'ignore',
    })
    const exited = new Promise<void>((r) => { child.once('exit', () => r()) })
    try {
      let client = null
      while (!client && Date.now() - t0 < 10_000) {
        try { client = await connectClient(home.paths, { timeoutMs: 1000 }) } catch { await sleep(20) }
      }
      const took = Date.now() - t0
      assert.ok(client, 'демон не ответил hello_ok за 10 с')
      const st = (await client.request('daemon.status')) as { pid: number }
      assert.equal(st.pid, child.pid)
      assert.ok(!existsSync(log), `демон запускал CLI на старте:\n${existsSync(log) ? readFileSync(log, 'utf8') : ''}`)
      assert.ok(took < 2500, `hello_ok пришёл через ${took} мс — старт ждал «--version» (3 с)?`)
      // И доктор демона (в тестовом режиме — версии node/npm/git, пункты службы и версий): всё, что
      // он запускает, идёт асинхронно или в потоке. Единственный spawnSync главного потока за всю
      // жизнь демона — `ps` при взятии lock (время старта процесса, core/lock.ts).
      const report = (await client.request('doctor.run', { net: false })) as DoctorReport
      assert.ok(report.items.some((i) => i.id === 'cli.node' && i.status === 'ok'), JSON.stringify(report.items))
      const traced = existsSync(trace) ? readFileSync(trace, 'utf8').split('\n').filter(Boolean) : []
      assert.deepEqual([...new Set(traced)], ['ps'], `spawnSync на событийном цикле демона: ${traced.join(', ')}`)
      await client.request('daemon.stop')
      client.close()
      await exited
      assert.ok(!existsSync(log), 'CLI запущен после старта, хотя ни одного хода не было')
    } finally {
      try { child.kill('SIGKILL') } catch { /* уже вышел */ }
      await waitFor(() => !existsSync(home.paths.lock) || child.exitCode !== null || child.signalCode !== null, 5000)
      home.remove()
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })
})

describe('doctor.run на демоне: медленные CLI', () => {
  it('пока доктор спрашивает версии и вход, hello новых клиентов и daemon.status отвечают сразу', async () => {
    const home = tempHome()
    const bin = mkdtempSync(join(tmpdir(), 'pb-'))
    for (const name of TOOLS) {
      script(join(bin, name), name === 'claude'
        ? 'sleep 0.4\nif [ "$1" = auth ]; then echo \'{"loggedIn":true}\'; else echo "claude 9.9.9"; fi'
        : `sleep 0.4\necho "${name} 9.9.9"`)
    }
    // Поиск и запуск — боевые (locateAllAsync, run доктора по умолчанию); isExec пускает только в
    // папку фальшивок, так что настоящие CLI машины тест не запускает.
    const daemon = await startTestDaemon(home, {
      doctor: {
        pathEntries: [bin, '/usr/bin', '/bin'],
        locate: (d: LocateDeps) => locateAllAsync({ ...d, isExec: (p) => dirname(p) === bin, realpath: (p) => p, home: '/нет-такого-дома' }),
        codexSchema: async () => ({ status: 'ok', expected: 'x', actual: 'x', files: 314, detail: 'тест' }),
      },
    })
    const c1 = await connectClient(home.paths, { client: 'shell' })
    const c2 = await connectClient(home.paths)
    try {
      const t0 = Date.now()
      let finished = false
      const doc = c1.request('doctor.run', { net: false }).finally(() => { finished = true })
      const hellos: number[] = []
      const statuses: number[] = []
      while (!finished) {
        let t = Date.now()
        const fresh = await connectClient(home.paths)
        hellos.push(Date.now() - t)
        fresh.close()
        t = Date.now()
        await c2.request('daemon.status')
        statuses.push(Date.now() - t)
        await sleep(20)
      }
      const report = (await doc) as DoctorReport
      const took = Date.now() - t0
      assert.equal(report.items.find((i) => i.id === 'cli.claude')?.data?.['version'], 'claude 9.9.9', JSON.stringify(report.items))
      assert.equal(report.items.find((i) => i.id === 'login.claude')?.status, 'ok')
      assert.ok(took >= 700, `doctor.run прошёл за ${took} мс — медленные CLI не запускались?`)
      assert.ok(hellos.length >= 3, `за время доктора новых клиентов подключилось ${hellos.length}`)
      assert.ok(Math.max(...hellos) < 500, `hello нового клиента ждал ${Math.max(...hellos)} мс; ряд: ${JSON.stringify(hellos)}`)
      assert.ok(Math.max(...statuses) < 500, `daemon.status ждал ${Math.max(...statuses)} мс; ряд: ${JSON.stringify(statuses)}`)
    } finally {
      c1.close()
      c2.close()
      await daemon.stop('конец теста')
      home.remove()
      rmSync(bin, { recursive: true, force: true })
    }
  })

  it('второй doctor.run, пришедший посреди первого, получает тот же отчёт — процессы не запускаются дважды', async () => {
    // Окно зовёт доктора при каждом открытии и переподключении: у владельца два прогона легли друг
    // за другом, и каждый запускал свой десяток процессов.
    const home = tempHome()
    let locates = 0
    const none = (): Record<ToolName, LocatedTool> => Object.fromEntries(TOOLS.map((name) =>
      [name, { name, path: null, realpath: null, version: null, versionExitCode: null, viaPath: false, triedCount: 0 }])) as Record<ToolName, LocatedTool>
    const daemon = await startTestDaemon(home, {
      doctor: { locate: async () => { locates++; await sleep(200); return none() } },
    })
    const c1 = await connectClient(home.paths, { client: 'shell' })
    const c2 = await connectClient(home.paths, { client: 'shell' })
    try {
      const [a, b] = (await Promise.all([
        c1.request('doctor.run', { net: false }),
        c2.request('doctor.run', { net: false }),
      ])) as [DoctorReport, DoctorReport]
      assert.equal(locates, 1, 'два одновременных doctor.run — один прогон')
      assert.equal(a.generatedAt, b.generatedAt)
      const c = (await c1.request('doctor.run', { net: false })) as DoctorReport
      assert.equal(locates, 2, 'следующий doctor.run после конца первого — новый прогон, а не вчерашний отчёт')
      assert.ok(c.items.length > 0)
    } finally {
      c1.close()
      c2.close()
      await daemon.stop('конец теста')
      home.remove()
    }
  })
})
