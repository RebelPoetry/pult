// Подписки: стык «доигрываем прошлое» и «отдаём живое», фильтр по сессии, курсор после
// рестарта демона, отцепление медленного клиента.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PultEvent } from '../dist/core/events.js'
import { PROTOCOL_VERSION } from '../dist/core/rpc.js'
import { createStore } from '../dist/core/store.js'
import { readToken } from '../dist/core/token.js'
import { createBus, createSubscriptions } from '../dist/daemon/subscriptions.js'
import { rawConnect, startTestDaemon, tempHome, waitFor } from './helpers.js'

interface Collected {
  events: PultEvent[]
  stop(): void
}

function collect(conn: Awaited<ReturnType<typeof rawConnect>>): Collected {
  const events: PultEvent[] = []
  let live = true
  const pump = async (): Promise<void> => {
    while (live) {
      let frame: Record<string, unknown>
      try {
        frame = await conn.next(2000)
      } catch {
        return
      }
      if (frame['event']) events.push(frame['event'] as PultEvent)
    }
  }
  void pump()
  return { events, stop: () => { live = false } }
}

describe('подписка', () => {
  it('доигрывает прошлое и продолжает живым — без дыр и без повторов', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home)
    try {
      // Прошлое.
      for (let i = 0; i < 40; i++) {
        daemon.emit({ sessionId: 's', provider: 'pult', kind: 'status.changed', data: { i } })
      }
      const conn = await rawConnect(home.paths)
      conn.send({ type: 'hello', token: readToken(home.paths.token), client: 'cli', protocol: PROTOCOL_VERSION })
      await conn.next()

      conn.send({ id: 1, method: 'events.subscribe', params: { since: 0 } })
      // События, случившиеся в ТО ЖЕ мгновение, что и запрос подписки: демон ещё не успел его
      // разобрать. Ровно здесь наивная реализация теряет или дублирует кадры.
      for (let i = 40; i < 60; i++) {
        daemon.emit({ sessionId: 's', provider: 'pult', kind: 'status.changed', data: { i } })
      }
      const reply = await conn.next()
      assert.equal((reply['result'] as Record<string, unknown>)['sub'], 1)

      const sink = collect(conn)
      for (let i = 60; i < 80; i++) {
        daemon.emit({ sessionId: 's', provider: 'pult', kind: 'status.changed', data: { i } })
      }
      const ok = await waitFor(() => sink.events.length >= 81) // 80 наших + daemon.started
      sink.stop()
      assert.ok(ok, `получено ${sink.events.length} кадров из 81`)

      const ids = sink.events.map((e) => e.id)
      assert.deepEqual(ids, Array.from({ length: 81 }, (_, i) => i + 1), 'порядок, дыры или повторы')
      conn.end()
    } finally {
      await daemon.stop('тест')
      home.remove()
    }
  })

  it('фильтр по sessionId пропускает только свою сессию', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home)
    try {
      daemon.emit({ sessionId: 'a', provider: 'pult', kind: 'session.started' })
      daemon.emit({ sessionId: 'b', provider: 'pult', kind: 'session.started' })

      const conn = await rawConnect(home.paths)
      conn.send({ type: 'hello', token: readToken(home.paths.token), client: 'cli', protocol: PROTOCOL_VERSION })
      await conn.next()
      conn.send({ id: 1, method: 'events.subscribe', params: { since: 0, sessionId: 'a' } })
      await conn.next()

      const sink = collect(conn)
      daemon.emit({ sessionId: 'b', provider: 'pult', kind: 'message.done' })
      daemon.emit({ sessionId: 'a', provider: 'pult', kind: 'message.done' })
      await waitFor(() => sink.events.length >= 2)
      sink.stop()

      assert.ok(sink.events.every((e) => e.sessionId === 'a'), 'просочилась чужая сессия')
      assert.equal(sink.events.length, 2)
      conn.end()
    } finally {
      await daemon.stop('тест')
      home.remove()
    }
  })

  it('после рестарта демона подписка с курсора доигрывает пропущенное', async () => {
    const home = tempHome()
    const first = await startTestDaemon(home)
    first.emit({ sessionId: 's', provider: 'pult', kind: 'message.done', data: { n: 1 } })
    const cursor = first.status().lastEventId
    await first.stop('тест')

    const second = await startTestDaemon(home)
    try {
      second.emit({ sessionId: 's', provider: 'pult', kind: 'message.done', data: { n: 2 } })
      const conn = await rawConnect(home.paths)
      conn.send({ type: 'hello', token: readToken(home.paths.token), client: 'cli', protocol: PROTOCOL_VERSION })
      await conn.next()
      conn.send({ id: 1, method: 'events.subscribe', params: { since: cursor } })
      await conn.next()

      const sink = collect(conn)
      await waitFor(() => sink.events.length >= 3)
      sink.stop()
      // daemon.stopping первого, daemon.started второго, message.done{n:2} — и ни одного
      // события с номером <= курсора.
      assert.ok(sink.events.every((e) => e.id > cursor))
      assert.deepEqual(sink.events.map((e) => e.kind), ['daemon.stopping', 'daemon.started', 'message.done'])
      conn.end()
    } finally {
      await second.stop('тест')
      home.remove()
    }
  })
})

describe('менеджер подписок', () => {
  it('медленный клиент отцепляется с кадром end', () => {
    const home = tempHome()
    try {
      const store = createStore(home.paths)
      const bus = createBus()
      const subs = createSubscriptions(bus, store)
      const frames: unknown[] = []
      let accept = true
      const handle = subs.subscribe({ since: 0 }, {
        write: (f) => { frames.push(f); return accept },
      })
      handle.start()
      assert.equal(subs.count(), 1)

      accept = false
      bus.emit(store.append({ sessionId: 's', provider: 'pult', kind: 'status.changed' }))
      assert.equal(subs.count(), 0, 'медленный клиент остался подписан')
      const last = frames[frames.length - 1] as { sub: number; end?: { code: string } }
      assert.equal(last.end?.code, 'slow_consumer')
      store.close()
    } finally {
      home.remove()
    }
  })

  it('unsubscribe и dispose снимают слушателей', () => {
    const home = tempHome()
    try {
      const store = createStore(home.paths)
      const bus = createBus()
      const subs = createSubscriptions(bus, store)
      const a = subs.subscribe({ since: 0 }, { write: () => true })
      a.start()
      const b = subs.subscribe({ since: 0 }, { write: () => true })
      b.start()
      assert.equal(bus.listenerCount(), 2)
      assert.equal(subs.unsubscribe(a.sub), true)
      assert.equal(subs.unsubscribe(a.sub), false)
      subs.dispose()
      assert.equal(bus.listenerCount(), 0)
      assert.equal(subs.count(), 0)
      store.close()
    } finally {
      home.remove()
    }
  })
})
