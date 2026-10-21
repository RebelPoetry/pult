// Менеджер сессий поверх адаптера Codex: рестарт демона, стоп посреди хода, удаление.
//
// ПОЗВАТЬ `boot` ДВАЖДЫ ПО ОДНОМУ PULT_HOME — это и есть рестарт демона: реестр и журнал на
// диске те же, а менеджер и адаптер новые и пустые. Ковыряться во внутренностях адаптера не
// нужно и нечестно: его незнание сессии здесь настоящее.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { createCodexAdapter } from '../dist/adapters/codex/adapter.js'
import { defaultConfig } from '../dist/core/config.js'
import { createStore } from '../dist/core/store.js'
import type { EventStore } from '../dist/core/store.js'
import type { NetCheck } from '../dist/env/net.js'
import { createBroker } from '../dist/perm/broker.js'
import { createManager } from '../dist/sessions/manager.js'
import type { SessionManager } from '../dist/sessions/manager.js'
import { createRegistry } from '../dist/sessions/registry.js'
import { FAKE_CODEX, sleep, tempHome, waitFor } from './helpers.js'
import type { TempHome } from './helpers.js'

const seenPids: number[] = []
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

after(() => {
  const survivors = seenPids.filter(alive)
  assert.deepEqual(survivors, [], `фальшивые app-server пережили тесты: ${survivors.join(', ')}`)
})

const okNet = async (): Promise<NetCheck> => ({
  provider: 'codex', mode: 'auto', path: 'direct', proxy: null, loc: 'FI', ok: true,
  reason: 'ok', fellBack: false, guard: ['RU'], attempts: [], ms: 1,
  checkedAt: '2026-09-21T10:00:00.000Z', cached: false,
})

interface Stand {
  manager: SessionManager
  store: EventStore
  close(): Promise<void>
}

function boot(home: TempHome): Stand {
  const store = createStore(home.paths)
  const broker = createBroker({ emit: (d) => { manager.emit(d) } })
  const codex = createCodexAdapter({
    paths: home.paths, config: defaultConfig(), logger: home.logger,
    bin: FAKE_CODEX,
    emit: (d) => { manager.emit(d) },
    askPermission: (req) => broker.request(req),
    cancelPermissions: (sessionId, reason) => {
      let n = 0
      for (const p of broker.list(sessionId)) {
        if (broker.resolve(p.id, { behavior: 'deny', message: reason }, 'provider_gone')) n++
      }
      return n
    },
    netCheck: okNet,
    schemaCheck: () => ({ status: 'ok', expected: 'x', actual: 'x', files: 310, detail: 'тест' }),
  })
  const manager = createManager({
    paths: home.paths, config: defaultConfig(), logger: home.logger, store,
    publish: (d) => store.append(d),
    adapters: { codex },
    broker,
  })
  return { manager, store, async close() { await manager.shutdown(); store.close() } }
}

/** Настройка фальшивого сервера лежит в PULT_HOME: это cwd ОБЩЕГО процесса. */
function tune(home: TempHome, cfg: Record<string, unknown>): void {
  writeFileSync(join(home.paths.home, '.pult-fake-codex.json'), JSON.stringify({
    scenario: 'simple', speed: 0, logOut: join(home.paths.home, 'server.jsonl'), ...cfg,
  }))
}

function serverLog(home: TempHome): Array<Record<string, unknown>> {
  const file = join(home.paths.home, 'server.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
}

const clientMsgs = (home: TempHome): Array<{ method?: string; params?: Record<string, unknown> }> =>
  serverLog(home).filter((r) => r['ev'] === 'client').map((r) => (r['msg'] as { method?: string; params?: Record<string, unknown> }))

function collectPids(home: TempHome): void {
  for (const r of serverLog(home)) if (r['ev'] === 'boot') seenPids.push(Number(r['pid']))
}

function workDir(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'pt-cxw-'))
  mkdirSync(cwd, { recursive: true })
  return cwd
}

describe('codex: сессия переживает рестарт демона', () => {
  it('тред возобновляется по записанному id, cwd и model восстановлены', async () => {
    const home = tempHome()
    const cwd = workDir()
    tune(home, {})
    const first = boot(home)
    let threadId = ''
    try {
      await first.manager.start({ name: 'w', kind: 'codex', cwd, model: 'gpt-6-astra', effort: 'low' })
      // На `agent start` треда ещё нет: он заводится на первом ходе (и только ход делает его
      // возобновляемым — измерено пробой В3).
      assert.equal(first.manager.list()[0]?.providerSessionId, undefined)
      await first.manager.prompt('w', 'привет')
      assert.ok(await waitFor(() => first.manager.list()[0]?.lastStatus === 'idle', 20_000))
      threadId = String(first.manager.list()[0]?.providerSessionId ?? '')
      assert.match(threadId, /^01a0c000-thread/)
    } finally { await first.close() }

    const second = boot(home)
    try {
      // Адаптер второго стенда сессии не знает — незнание настоящее.
      await second.manager.prompt('w', 'ещё раз')
      assert.ok(await waitFor(() => second.manager.list()[0]?.lastStatus === 'idle', 20_000))
      const resume = clientMsgs(home).find((m) => m.method === 'thread/resume')
      assert.ok(resume, 'после рестарта тред обязан ВОЗОБНОВЛЯТЬСЯ')
      assert.equal((resume.params as { threadId: string }).threadId, threadId)
      assert.equal((resume.params as { excludeTurns: boolean }).excludeTurns, true)
      assert.equal((resume.params as { cwd: string }).cwd, cwd)
      assert.equal((resume.params as { model: string }).model, 'gpt-6-astra')
      const turn = clientMsgs(home).filter((m) => m.method === 'turn/start').pop()
      assert.equal((turn?.params as { effort: string }).effort, 'low')
    } finally {
      await second.close(); collectPids(home)
      rmSync(cwd, { recursive: true, force: true }); home.remove()
    }
  })

  it('сессия без единого хода после рестарта заводит тред заново, а не идёт в никуда', async () => {
    const home = tempHome()
    const cwd = workDir()
    tune(home, {})
    const first = boot(home)
    try {
      await first.manager.start({ name: 'w', kind: 'codex', cwd })
    } finally { await first.close() }

    const second = boot(home)
    try {
      await second.manager.prompt('w', 'первый ход после рестарта')
      assert.ok(await waitFor(() => second.manager.list()[0]?.lastStatus === 'idle', 20_000))
      const methods = clientMsgs(home).map((m) => m.method)
      assert.ok(!methods.includes('thread/resume'), `возобновлять было нечего: ${methods.join(', ')}`)
      assert.equal(methods.filter((m) => m === 'thread/start').length, 1)
    } finally {
      await second.close(); collectPids(home)
      rmSync(cwd, { recursive: true, force: true }); home.remove()
    }
  })

  it('после рестарта rm работает по сессии, которую адаптер ни разу не видел', async () => {
    const home = tempHome()
    const cwd = workDir()
    tune(home, {})
    const first = boot(home)
    try {
      await first.manager.start({ name: 'w', kind: 'codex', cwd })
      await first.manager.prompt('w', 'привет')
      assert.ok(await waitFor(() => first.manager.list()[0]?.lastStatus === 'idle', 20_000))
    } finally { await first.close() }

    const second = boot(home)
    try {
      await second.manager.stop('w')
      await second.manager.rm('w')
      assert.deepEqual(second.manager.list(), [])
      const ended = second.store.readFrom(0, { sessionId: 'w' }).filter((e) => e.kind === 'session.ended')
      assert.equal(ended.length, 1)
      // Ни одного процесса поднимать ради удаления не нужно: адаптер незнакомую сессию
      // принимает молча.
      assert.equal(serverLog(home).filter((r) => r['ev'] === 'boot').length, 1)
    } finally {
      await second.close(); collectPids(home)
      rmSync(cwd, { recursive: true, force: true }); home.remove()
    }
  })

  it('работавшая на момент падения сессия встаёт как cold', async () => {
    const home = tempHome()
    const cwd = workDir()
    tune(home, { scenario: 'hang' })
    const first = boot(home)
    try {
      await first.manager.start({ name: 'w', kind: 'codex', cwd })
      await first.manager.prompt('w', 'думай долго [[hang]]')
      assert.ok(await waitFor(() => first.manager.list()[0]?.lastStatus === 'working', 20_000))
    } finally { await first.close() }
    assert.equal(createRegistry(home.paths).get('w')?.lastStatus, 'working')

    const second = boot(home)
    try {
      assert.equal(second.manager.list()[0]?.lastStatus, 'cold')
    } finally {
      await second.close(); collectPids(home)
      rmSync(cwd, { recursive: true, force: true }); home.remove()
    }
  })
})

describe('codex: стоп посреди хода глазами журнала', () => {
  it('ни одного failed и РОВНО ОДИН interrupted на стоп', async () => {
    const home = tempHome()
    const cwd = workDir()
    tune(home, {})
    const stand = boot(home)
    try {
      await stand.manager.start({ name: 'w', kind: 'codex', cwd })
      await stand.manager.prompt('w', 'думай долго [[hang]]')
      assert.ok(await waitFor(() => clientMsgs(home).some((m) => m.method === 'turn/start'), 20_000))
      await stand.manager.stop('w')
      assert.ok(await waitFor(() => stand.manager.list()[0]?.lastStatus === 'interrupted', 10_000))
      // Ждём тишины: ложный `failed` от снятого хода приходил бы ПОСЛЕ interrupted.
      await sleep(300)
      const statuses = stand.store.readFrom(0, { sessionId: 'w' })
        .filter((e) => e.kind === 'status.changed')
        .map((e) => String((e.data as { status?: unknown }).status))
      assert.deepEqual(statuses.filter((s) => s === 'failed'), [], `ложный failed: ${statuses.join(' → ')}`)
      assert.deepEqual(statuses.filter((s) => s === 'interrupted'), ['interrupted'], statuses.join(' → '))
      // Общий процесс жив: стоп снимает ХОД, а не сервер.
      assert.equal(serverLog(home).filter((r) => r['ev'] === 'boot').length, 1)
    } finally {
      await stand.close(); collectPids(home)
      rmSync(cwd, { recursive: true, force: true }); home.remove()
    }
  })

  it('два агента Codex в одном процессе: стоп одного не трогает второго', async () => {
    const home = tempHome()
    const a = workDir()
    const b = workDir()
    tune(home, {})
    const stand = boot(home)
    try {
      await stand.manager.start({ name: 'a', kind: 'codex', cwd: a })
      await stand.manager.start({ name: 'b', kind: 'codex', cwd: b })
      await stand.manager.prompt('a', 'думай долго [[hang]]')
      await stand.manager.prompt('b', 'привет')
      assert.ok(await waitFor(() => stand.manager.list().find((s) => s.name === 'b')?.lastStatus === 'idle', 20_000))
      await stand.manager.stop('a')
      const list = stand.manager.list()
      assert.equal(list.find((s) => s.name === 'a')?.lastStatus, 'interrupted')
      assert.equal(list.find((s) => s.name === 'b')?.lastStatus, 'idle')
      assert.equal(serverLog(home).filter((r) => r['ev'] === 'boot').length, 1, 'процесс обязан быть ОДИН')
      // И следующий ход второй сессии по-прежнему идёт.
      await stand.manager.prompt('b', 'ещё раз')
      assert.ok(await waitFor(() => {
        const rec = stand.manager.list().find((s) => s.name === 'b')
        return rec?.lastStatus === 'idle'
      }, 20_000))
    } finally {
      await stand.close(); collectPids(home)
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
      home.remove()
    }
  })
})

describe('codex: расход в pult usage', () => {
  it('ход добавляет строку расхода с токенами и окнами лимита', async () => {
    const home = tempHome()
    const cwd = workDir()
    tune(home, {})
    const stand = boot(home)
    try {
      await stand.manager.start({ name: 'w', kind: 'codex', cwd })
      await stand.manager.prompt('w', 'привет')
      assert.ok(await waitFor(() => stand.manager.list()[0]?.lastStatus === 'idle', 20_000))
      const row = stand.manager.usage().find((u) => u.session === 'w')
      assert.ok(row)
      assert.equal(row.provider, 'codex')
      assert.equal(row.turns, 1)
      assert.equal(row.inputTokens, 18632)
      assert.equal(row.outputTokens, 5)
      const rl = row.rateLimit as { windows: { five_hour: { utilization: number } } } | null
      assert.ok(rl, 'снимок лимитов обязан доехать до pult usage')
      assert.equal(rl.windows.five_hour.utilization, 0.31)
    } finally {
      await stand.close(); collectPids(home)
      rmSync(cwd, { recursive: true, force: true }); home.remove()
    }
  })
})
