// Транспорт адаптера Codex: кадрирование JSON-RPC по stdio и сопоставление по id.
// Здесь нарочно НЕ фальшивый app-server, а управляемый крошечный сервер: нужны случаи,
// которых в записи не бывает, — склейка, разрыв строки, мусор, переросток, молчание.

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { createAppServerClient, AppServerError, MAX_APP_SERVER_LINE } from '../dist/adapters/codex/client.js'
import type { AppServerClient } from '../dist/adapters/codex/client.js'
import { buildChildEnv } from '../dist/env/allowlist.js'
import { sleep, waitFor } from './helpers.js'

/**
 * Крошечный сервер на stdio: отвечает по команде из метода. Он не изображает codex — он
 * изображает ПРОВОД, и ровно те его состояния, ради которых написан кадровщик.
 */
const SERVER = `
let buf = ''
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    let m
    try { m = JSON.parse(line) } catch { continue }
    const { id, method, params } = m
    if (method === 'echo') { out({ jsonrpc: '2.0', id, result: { got: params } }); continue }
    if (method === 'slow') { continue }
    if (method === 'err') { out({ jsonrpc: '2.0', id, error: { code: -32600, message: 'no rollout found for thread id X' } }); continue }
    if (method === 'srv') { out({ jsonrpc: '2.0', id: 77, method: 'item/commandExecution/requestApproval', params: { threadId: 't1' } }); out({ jsonrpc: '2.0', id, result: {} }); continue }
    if (method === 'twoinone') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'a/one', params: { n: 1 } }) + '\\n' + JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } }) + '\\n')
      continue
    }
    if (method === 'split') {
      const s = JSON.stringify({ jsonrpc: '2.0', id, result: { ok: 'разрезанный ответ' } }) + '\\n'
      process.stdout.write(s.slice(0, 12))
      setTimeout(() => process.stdout.write(s.slice(12)), 40)
      continue
    }
    if (method === 'garbage') {
      process.stdout.write('это не JSON\\n')
      process.stdout.write('[1,2,3]\\n')
      process.stdout.write('x'.repeat(${MAX_APP_SERVER_LINE} + 10) + '\\n')
      out({ jsonrpc: '2.0', id, result: { survived: true } })
      continue
    }
    if (method === 'bye') { out({ jsonrpc: '2.0', id, result: {} }); setTimeout(() => process.exit(3), 20); continue }
  }
})
`

interface Rig {
  client: AppServerClient
  notes: Array<{ method: string; params: Record<string, unknown> }>
  requests: Array<{ id: number | string; method: string }>
  bad: Array<{ reason: string; sample: string }>
  exits: Array<{ code: number | null; signal: NodeJS.Signals | null }>
  spawnErrors: Error[]
  answers: unknown[]
}

/** Все pid, которые этот файл породил: после прогона ни один не имеет права быть живым. */
const seenPids: number[] = []
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

after(() => {
  const survivors = seenPids.filter(alive)
  assert.deepEqual(survivors, [], `дочерние процессы пережили тесты: ${survivors.join(', ')}`)
})

function rig(bin = process.execPath, args = ['-e', SERVER]): Rig {
  const r: Rig = { client: null as never, notes: [], requests: [], bad: [], exits: [], spawnErrors: [], answers: [] }
  r.client = createAppServerClient({
    bin,
    args,
    cwd: process.cwd(),
    env: buildChildEnv(process.env),
    onNotification: (method, params) => { r.notes.push({ method, params }) },
    onServerRequest: (id, method) => { r.requests.push({ id: id as number, method }) },
    onExit: (code, signal) => { r.exits.push({ code, signal }) },
    onSpawnError: (e) => { r.spawnErrors.push(e) },
    onBadLine: (reason, sample) => { r.bad.push({ reason, sample }) },
  })
  if (r.client.pid !== undefined) seenPids.push(r.client.pid)
  return r
}

describe('клиент app-server: кадрирование и сопоставление по id', () => {
  it('два сообщения в одном куске и одно сообщение в двух кусках разбираются верно', async () => {
    const r = rig()
    try {
      const two = await r.client.request('twoinone', {})
      assert.deepEqual(two, { ok: true })
      assert.deepEqual(r.notes.map((n) => n.method), ['a/one'])
      const split = await r.client.request('split', {})
      assert.deepEqual(split, { ok: 'разрезанный ответ' })
    } finally { r.client.kill('SIGKILL'); await r.client.waitExit(2000) }
  })

  it('параллельные запросы получают СВОИ ответы, а не первый попавшийся', async () => {
    const r = rig()
    try {
      const [a, b, c] = await Promise.all([
        r.client.request('echo', { n: 1 }),
        r.client.request('echo', { n: 2 }),
        r.client.request('echo', { n: 3 }),
      ])
      assert.deepEqual([a, b, c].map((x) => (x as { got: { n: number } }).got.n), [1, 2, 3])
    } finally { r.client.kill('SIGKILL'); await r.client.waitExit(2000) }
  })

  it('ошибка JSON-RPC приезжает как AppServerError с кодом и дословным текстом', async () => {
    const r = rig()
    try {
      await assert.rejects(() => r.client.request('err', {}), (e: Error) => {
        assert.ok(e instanceof AppServerError)
        assert.equal((e as AppServerError).rpc.code, -32600)
        // Текст обязан доходить ДОСЛОВНО: по нему работает самолечение треда.
        assert.match(e.message, /no rollout found for thread id/)
        return true
      })
    } finally { r.client.kill('SIGKILL'); await r.client.waitExit(2000) }
  })

  it('молчащий сервер: запрос падает по СВОЕМУ таймауту, соединение живо', async () => {
    const r = rig()
    try {
      await assert.rejects(() => r.client.request('slow', {}, 200), (e: Error) => {
        assert.match(e.message, /не ответил на slow за 200 мс/)
        return true
      })
      assert.deepEqual(await r.client.request('echo', { n: 9 }), { got: { n: 9 } })
    } finally { r.client.kill('SIGKILL'); await r.client.waitExit(2000) }
  })

  it('запрос СЕРВЕРА к клиенту: ответ уходит один раз, повторный молча игнорируется', async () => {
    const r = rig()
    try {
      await r.client.request('srv', {})
      assert.ok(await waitFor(() => r.requests.length === 1, 2000))
      assert.equal(r.requests[0]?.method, 'item/commandExecution/requestApproval')
      r.client.respond(77, { decision: 'decline' })
      r.client.respond(77, { decision: 'accept' })
      // Сервер-заглушка ответы не разбирает; важно, что второй не ушёл и ничего не сломал.
      assert.deepEqual(await r.client.request('echo', { n: 1 }), { got: { n: 1 } })
    } finally { r.client.kill('SIGKILL'); await r.client.waitExit(2000) }
  })

  it('мусор, массив вместо объекта и строка-переросток не рвут соединение', async () => {
    const r = rig()
    try {
      const res = await r.client.request('garbage', {}, 10_000)
      assert.deepEqual(res, { survived: true })
      const reasons = r.bad.map((b) => b.reason)
      assert.ok(reasons.includes('bad_json'), JSON.stringify(r.bad))
      assert.ok(reasons.includes('not_an_object'), JSON.stringify(r.bad))
      assert.ok(reasons.includes('line_too_long'), JSON.stringify(r.bad))
    } finally { r.client.kill('SIGKILL'); await r.client.waitExit(2000) }
  })

  it('выход процесса хоронит ожидающие запросы и сообщает код выхода', async () => {
    const r = rig()
    try {
      await r.client.request('bye', {})
      const pending = r.client.request('slow', {}, 10_000)
      await assert.rejects(() => pending, (e: Error) => {
        assert.match(e.message, /app-server вышел \(code=3/)
        return true
      })
      assert.ok(await waitFor(() => r.exits.length === 1, 2000))
      assert.equal(r.exits[0]?.code, 3)
      assert.equal(r.client.alive(), false)
    } finally { r.client.kill('SIGKILL'); await r.client.waitExit(2000) }
  })

  it('НЕУДАЧНЫЙ СПАВН: ожидающий запрос падает сразу, а не по таймауту', async () => {
    const r = rig('/нет/такого/бинаря/pult-codex', [])
    try {
      const t0 = Date.now()
      await assert.rejects(() => r.client.request('echo', {}, 30_000), (e: Error) => {
        assert.match(e.message, /app-server не запустился/)
        assert.match(e.message, /ENOENT/)
        return true
      })
      assert.ok(Date.now() - t0 < 5000, 'ожидание не имеет права тянуться до таймаута запроса')
      assert.equal(r.spawnErrors.length, 1)
    } finally { r.client.kill('SIGKILL') }
  })

  it('закрытие stdin гасит сервер сам — измерено на настоящем app-server', async () => {
    const r = rig()
    try {
      await r.client.request('echo', { n: 1 })
      r.client.endStdin()
      assert.ok(await r.client.waitExit(3000), 'сервер обязан выйти сам по закрытию stdin')
    } finally { r.client.kill('SIGKILL'); await sleep(10) }
  })
})
