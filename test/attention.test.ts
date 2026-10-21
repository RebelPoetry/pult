// О2 «внимание»: классификация событий, «непрочитано», хранилище (последнее событие внимания по
// сессии), миграция реестра и RPC `agent.seen` / `agent.retry` на настоящем демоне с фальшивым claude.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { connectClient } from '../dist/cli/client.js'
import type { PultEvent } from '../dist/core/events.js'
import { createStore } from '../dist/core/store.js'
import {
  ATTENTION_TEXT_MAX, attentionOf, isRetryable, isUnread, isUnreadError, needsYouCount, parseAttention, retryPrompt, waitClass,
} from '../dist/sessions/attention.js'
import type { Attention } from '../dist/sessions/attention.js'
import { createRegistry, parseSessions } from '../dist/sessions/registry.js'
import { startTestDaemon, tempHome } from './helpers.js'

const ev = (id: number, kind: string, data: Record<string, unknown> = {}, sessionId = 's'): PultEvent =>
  ({ id, ts: `2026-10-14T10:00:${String(id % 60).padStart(2, '0')}.000Z`, sessionId, provider: 'claude', kind: kind as PultEvent['kind'], data })

describe('внимание: какие события зовут человека', () => {
  it('конец хода, падение, вопрос, лимит, страж; служебное и предупреждение — нет', () => {
    const k = (e: PultEvent): [string, string | undefined] | null => { const a = attentionOf(e); return a ? [a.kind, a.text] : null }
    assert.deepEqual(k(ev(1, 'status.changed', { status: 'idle', turnId: 't1' })), ['done', undefined])
    assert.equal(k(ev(2, 'status.changed', { status: 'idle', reason: 'warm_ttl' })), null, 'idle без хода — служба')
    assert.equal(k(ev(3, 'status.changed', { status: 'working', turnId: 't1' })), null)
    assert.deepEqual(k(ev(4, 'status.changed', { status: 'failed', turnId: 't', errorCode: 'internal', message: 'процесс упал' })), ['failed', 'процесс упал'])
    assert.deepEqual(k(ev(5, 'status.changed', { status: 'failed', error: 'spawn ENOENT' })), ['failed', 'spawn ENOENT'])
    assert.equal(k(ev(6, 'status.changed', { status: 'failed', reason: 'net_blocked' })), null, 'причину стража несёт net.blocked')
    assert.equal(k(ev(7, 'status.changed', { status: 'limited', rateLimitStatus: 'allowed_warning' })), null)
    assert.deepEqual(k(ev(8, 'permission.requested', { id: 'p', toolName: 'Bash' })), ['ask', 'Bash'])
    assert.deepEqual(k(ev(9, 'question.asked', {})), ['ask', undefined])
    assert.deepEqual(k(ev(10, 'limit.hit', { status: 'rejected', rateLimitType: 'five_hour' })), ['limit', 'five_hour'])
    assert.deepEqual(k(ev(11, 'limit.hit', { source: 'limit', reason: 'usage_limit', message: 'Лимит исчерпан' })), ['limit', 'Лимит исчерпан'])
    assert.equal(k(ev(12, 'limit.hit', { status: 'allowed_warning' })), null, 'предупреждение — не лимит')
    assert.deepEqual(k(ev(13, 'net.blocked', { reason: 'blocked_country', loc: 'RU' })), ['blocked', 'blocked_country (выход RU)'])
    assert.deepEqual(k(ev(14, 'provider.blocked', { text: 'аккаунт заблокирован' })), ['blocked', 'аккаунт заблокирован'])
    for (const kind of ['message.done', 'message.user', 'tool.called', 'usage.updated', 'context.updated', 'session.ended']) assert.equal(k(ev(20, kind)), null, kind)
  })

  it('номер хода — в ошибке хода; фоновый ход — «готово»/«упал» без номера; limited — только с ходом', () => {
    const a = (e: PultEvent): Attention | null => attentionOf(e)
    assert.deepEqual(a(ev(1, 'status.changed', { status: 'failed', turnId: 't3', message: 'x' })), { id: 1, kind: 'failed', at: ev(1, 'x').ts, text: 'x', turnId: 't3' })
    assert.equal(a(ev(2, 'status.changed', { status: 'idle', reason: 'background_turn_done' }))?.kind, 'done', 'фоновый ход доделал — непрочитано')
    const bgFail = a(ev(3, 'status.changed', { status: 'failed', reason: 'background_turn_done' }))
    assert.deepEqual([bgFail?.kind, bgFail?.turnId, isRetryable(bgFail)], ['failed', undefined, false], 'фоновый провал не повторить')
    assert.deepEqual([a(ev(4, 'status.changed', { status: 'limited', turnId: 't4', reason: 'usage_limit' }))?.kind, a(ev(4, 'status.changed', { status: 'limited', turnId: 't4' }))?.turnId], ['limit', 't4'])
    assert.equal(a(ev(5, 'status.changed', { status: 'limited', rateLimitStatus: 'rejected' })), null, 'limited без хода — эхо limit.hit')
    assert.equal(a(ev(6, 'net.blocked', { reason: 'error_retry_storm', turnId: 't6' }))?.turnId, 't6')
    assert.equal(isRetryable(a(ev(7, 'limit.hit', { status: 'rejected' }))), false, 'лимит аккаунта вне хода')
    assert.equal(isRetryable(a(ev(8, 'status.changed', { status: 'idle', turnId: 't8' }))), false, '«готово» не ошибка')
    assert.equal(parseAttention({ id: 1, kind: 'failed', at: '', turnId: 't1' })?.turnId, 't1')
  })

  it('причина — одной строкой и не длиннее предела', () => {
    const a = attentionOf(ev(1, 'status.changed', { status: 'failed', message: `строка\n${'x'.repeat(1000)}` }))
    assert.equal([...(a?.text ?? '')].length, ATTENTION_TEXT_MAX)
    assert.ok(a?.text?.startsWith('строка x'))
    assert.ok(a?.text?.endsWith('…'))
  })

  it('непрочитано: событие свежее отметки «видел» или пометка руками; класс очереди и счёт для дока', () => {
    const done: Attention = { id: 10, kind: 'done', at: '' }
    const failed: Attention = { id: 10, kind: 'failed', at: '', text: 'x' }
    assert.equal(isUnread({ attention: done }), true, 'без отметки — всё непрочитано')
    assert.equal(isUnread({ attention: done, lastSeenEventId: 10 }), false)
    assert.equal(isUnread({ attention: done, lastSeenEventId: 9 }), true)
    assert.equal(isUnread({ lastSeenEventId: 0 }), false, 'внимания не было')
    assert.equal(isUnread({ lastSeenEventId: 50, markedUnread: true }), true)
    assert.equal(isUnreadError({ attention: failed, lastSeenEventId: 9 }), true)
    assert.equal(isUnreadError({ attention: done, lastSeenEventId: 9 }), false)
    assert.equal(isUnreadError({ attention: failed, lastSeenEventId: 10, markedUnread: true }), true)
    assert.equal(waitClass(true, failed, 1), 0, 'ошибка важнее запроса')
    assert.equal(waitClass(false, failed, 1), 1, 'прочитанная ошибка — не ошибка очереди')
    assert.equal(waitClass(true, done, 1), 1)
    assert.equal(waitClass(true, done, 0), 2)
    assert.equal(waitClass(false, done, 0), null)
    // Док: разрешения и вопросы + непрочитанные ошибки; готовые — нет; сессия с тем и другим — одна.
    assert.equal(needsYouCount([
      { name: 'a', attention: failed, lastSeenEventId: 1 },
      { name: 'b', attention: done, lastSeenEventId: 1 },
      { name: 'c', attention: { id: 3, kind: 'limit', at: '' }, lastSeenEventId: 5 },
    ], { a: 1, d: 2, e: 0 }), 2)
    // Архивные: ошибка не считается, ждущий запрос — считается (решение лида 14.10).
    assert.equal(needsYouCount([
      { name: 'a', attention: failed, lastSeenEventId: 1, archived: true },
      { name: 'd', archived: true },
      { name: 'f', attention: failed, lastSeenEventId: 1 },
    ], { d: 2 }), 2)
    assert.equal(needsYouCount([{ name: 'a', attention: failed, lastSeenEventId: 1, archived: true }], {}), 0)
  })

  it('чужой ответ разбирается без доверия', () => {
    assert.deepEqual(parseAttention({ id: 3, kind: 'limit', at: 'x', text: 'r' }), { id: 3, kind: 'limit', at: 'x', text: 'r' })
    for (const bad of [null, 1, {}, { id: '3', kind: 'done' }, { id: 3, kind: 'boom' }, { id: 1.5, kind: 'done' }]) assert.equal(parseAttention(bad), null, JSON.stringify(bad))
  })
})

describe('«Повторить»: реплика именно упавшего хода', () => {
  const user = (id: number, text: string): PultEvent => ev(id, 'message.user', { text })
  const st = (id: number, status: string, turnId?: string, extra: Record<string, unknown> = {}): PultEvent =>
    ev(id, 'status.changed', { status, ...(turnId ? { turnId } : {}), ...extra })
  const errAt = (events: PultEvent[]): Attention => attentionOf(events.at(-1)!)!
  const text = (events: PultEvent[]): string | null => { const r = retryPrompt(events, errAt(events)); return 'text' in r ? r.text : null }

  it('упавший ход — его реплика, даже если номер хода повторялся до рестарта демона', () => {
    const events = [user(1, 'старая'), st(2, 'working', 't1'), st(3, 'idle', 't1'), user(4, 'новая'), st(5, 'working', 't1'), st(6, 'failed', 't1', { message: 'упал' })]
    assert.equal(text(events), 'новая')
    // Повтор после повтора: перед упавшим ходом две реплики — берётся ближайшая к его началу.
    assert.equal(text([user(1, 'a'), st(2, 'working', 't2'), st(3, 'failed', 't2'), user(4, 'b'), st(5, 'working', 't3'), st(6, 'failed', 't3')]), 'b')
  })

  it('ход закончился, потом лимит аккаунта на простое — повторять нечего', () => {
    const events = [user(1, 'x'), st(2, 'working', 't1'), st(3, 'idle', 't1'), ev(4, 'limit.hit', { status: 'rejected' })]
    const r = retryPrompt(events, errAt(events))
    assert.match('reason' in r ? r.reason : '', /вне хода/)
  })

  it('после ошибки — новая реплика: отказ', () => {
    const events = [user(1, 'x'), st(2, 'working', 't1'), st(3, 'failed', 't1'), user(4, 'y')]
    const r = retryPrompt(events, attentionOf(events[2]!)!)
    assert.match('reason' in r ? r.reason : '', /новая реплика/)
  })

  it('удалили и завели заново с тем же именем: реплика прежней сессии не берётся', () => {
    const rm = ev(3, 'session.ended', { reason: 'rm' })
    assert.equal(text([user(1, 'чужая'), st(2, 'working', 't1'), rm, st(4, 'working', 't1'), st(5, 'failed', 't1')]), null, 'реплика — за границей rm')
    assert.equal(text([user(1, 'чужая'), st(2, 'working', 't1'), rm, st(4, 'failed', 't1')]), null, 'начало хода — за границей rm')
    assert.equal(text([user(1, 'чужая'), rm, user(4, 'своя'), st(5, 'working', 't1'), st(6, 'failed', 't1')]), 'своя')
  })

  it('событие ошибки не в журнале или начала хода нет — отказ с причиной', () => {
    const r = retryPrompt([user(1, 'x')], { id: 99, kind: 'failed', at: '', turnId: 't1' })
    assert.ok('reason' in r)
    const r2 = retryPrompt([user(1, 'x'), st(2, 'failed', 't9')], { id: 2, kind: 'failed', at: '', turnId: 't9' })
    assert.match('reason' in r2 ? r2.reason : '', /начало хода t9/)
  })
})

describe('хранилище: последнее событие внимания по сессии', () => {
  it('копится на записи и тем же проходом при открытии; удаление сессии стирает', () => {
    const home = tempHome()
    try {
      const st = createStore(home.paths)
      st.append({ sessionId: 'a', provider: 'claude', kind: 'status.changed', data: { status: 'idle', turnId: 't1' } })
      st.append({ sessionId: 'a', provider: 'claude', kind: 'message.done', data: { text: 'x' } })
      st.append({ sessionId: 'b', provider: 'claude', kind: 'net.blocked', data: { reason: 'blocked_country', loc: 'RU' } })
      st.append({ sessionId: 'b', provider: 'claude', kind: 'status.changed', data: { status: 'failed', reason: 'net_blocked' } })
      st.append({ sessionId: 'x', provider: 'claude', kind: 'limit.hit', data: { status: 'rejected' } })
      st.append({ sessionId: 'x', provider: 'claude', kind: 'session.ended', data: { reason: 'rm' } })
      // Реплика человека гасит прошлое внимание: старая ошибка не держит значок и «Повторить».
      st.append({ sessionId: 'u', provider: 'claude', kind: 'status.changed', data: { status: 'failed', turnId: 't1' } })
      st.append({ sessionId: 'u', provider: 'claude', kind: 'message.user', data: { text: 'другое' } })
      const check = (s: typeof st): void => {
        assert.equal(s.attention('u'), null, 'message.user гасит внимание')
        assert.deepEqual(s.attention('a'), { id: 1, kind: 'done', at: s.attention('a')?.at })
        assert.equal(s.attention('b')?.kind, 'blocked', 'failed от стража не затирает причину')
        assert.equal(s.attention('b')?.text, 'blocked_country (выход RU)')
        assert.equal(s.attention('x'), null, 'удалённая сессия внимания не держит')
        assert.equal(s.attention('nope'), null)
      }
      check(st)
      st.close()
      const again = createStore(home.paths)
      check(again)
      again.close()
    } finally {
      home.remove()
    }
  })
})

describe('реестр: отметка «видел»', () => {
  it('поля читаются строго; миграция ставит отметку только старым записям', () => {
    const [a, b] = parseSessions({ sessions: [
      { name: 'a', provider: 'claude', cwd: '/srv/a', lastSeenEventId: 7, markedUnread: true },
      { name: 'b', provider: 'claude', cwd: '/srv/b', lastSeenEventId: -1, markedUnread: 'yes' },
    ] })
    assert.deepEqual([a?.lastSeenEventId, a?.markedUnread], [7, true])
    assert.deepEqual([b?.lastSeenEventId, b?.markedUnread], [undefined, undefined])

    const home = tempHome()
    try {
      writeFileSync(home.paths.sessions, JSON.stringify({ version: 1, sessions: [
        { name: 'old', provider: 'claude', cwd: '/srv/a', lastStatus: 'idle', lastEventId: 3 },
        { name: 'seen', provider: 'claude', cwd: '/srv/a', lastStatus: 'idle', lastEventId: 3, lastSeenEventId: 2 },
        { name: 'ahead', provider: 'claude', cwd: '/srv/a', lastStatus: 'idle', lastEventId: 3, lastSeenEventId: 500 },
      ] }))
      const reg = createRegistry(home.paths)
      assert.equal(reg.seedSeen(40), 2)
      assert.equal(reg.get('ahead')?.lastSeenEventId, 40, 'отметка впереди журнала опускается до его конца')
      assert.equal(reg.get('old')?.lastSeenEventId, 40)
      assert.equal(reg.get('seen')?.lastSeenEventId, 2, 'свою отметку миграция не трогает')
      assert.equal(reg.seedSeen(99), 0, 'миграция разовая')
      assert.equal(createRegistry(home.paths).get('old')?.lastSeenEventId, 40, 'записано на диск')
    } finally {
      home.remove()
    }
  })

  it('демон после обновления: старые сессии прочитаны, их прошлое «готово» точку не зажигает', async () => {
    const home = tempHome()
    const st = createStore(home.paths)
    st.append({ sessionId: 'old', provider: 'claude', kind: 'status.changed', data: { status: 'idle', turnId: 't1' } })
    st.append({ sessionId: 'old', provider: 'claude', kind: 'status.changed', data: { status: 'failed', message: 'упал вчера' } })
    st.close()
    writeFileSync(home.paths.sessions, JSON.stringify({ version: 1, sessions: [
      { name: 'old', provider: 'claude', cwd: '/srv/a', lastStatus: 'failed', lastEventId: 2 },
    ] }))
    const d = await startTestDaemon(home)
    const c = await connectClient(home.paths)
    try {
      const old = ((await c.request('agent.list')) as { sessions: Array<Record<string, unknown>> }).sessions[0]!
      assert.equal(old['lastSeenEventId'], 2, 'отметка — последний номер журнала до старта')
      assert.equal((old['attention'] as Attention).kind, 'failed')
      assert.equal(isUnread(old as Parameters<typeof isUnread>[0]), false)
    } finally { c.close(); await d.stop('конец теста'); home.remove() }
  })
})

describe('RPC agent.seen и agent.retry', () => {
  it('ход закончился — непрочитано; seen — прочитано; unread — пометка; rm стирает внимание', async () => {
    const home = tempHome()
    const cwd = mkdtempSync(join(tmpdir(), 'pt-att-'))
    writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({ scenario: 'simple', speed: 0 }))
    const d = await startTestDaemon(home)
    const c = await connectClient(home.paths)
    const rec = async (name: string): Promise<Record<string, unknown>> =>
      ((await c.request('agent.list')) as { sessions: Array<Record<string, unknown>> }).sessions.find((s) => s['name'] === name)!
    const unread = async (name: string): Promise<boolean> => isUnread((await rec(name)) as Parameters<typeof isUnread>[0])
    const code = (want: string) => (e: { code?: string }): boolean => e.code === want
    try {
      await c.request('agent.start', { name: 'w', kind: 'claude', cwd })
      assert.equal(typeof (await rec('w'))['lastSeenEventId'], 'number', 'новая сессия заводится с отметкой')
      assert.equal(await unread('w'), false)
      await assert.rejects(c.request('agent.retry', { name: 'w' }), code('invalid_params'), 'реплик ещё не было')

      await c.request('agent.prompt', { name: 'w', text: 'Сделай раз' })
      await c.request('agent.wait', { name: 'w', until: ['idle'], timeoutMs: 20_000 })
      const att = (await rec('w'))['attention'] as Attention
      assert.equal(att.kind, 'done')
      assert.equal(await unread('w'), true)

      const seen = (await c.request('agent.seen', { name: 'w' })) as Record<string, unknown>
      assert.ok((seen['lastSeenEventId'] as number) >= att.id)
      assert.equal(await unread('w'), false)

      await c.request('agent.seen', { name: 'w', unread: true })
      assert.equal((await rec('w'))['markedUnread'], true)
      assert.equal(await unread('w'), true)
      await c.request('agent.seen', { name: 'w' })
      assert.equal((await rec('w'))['markedUnread'], undefined, 'показ снимает пометку')

      await assert.rejects(c.request('agent.seen', { name: 'nope' }), code('not_found'))
      await assert.rejects(c.request('agent.seen', { name: 'w', unread: 'yes' }), code('invalid_params'))
      await assert.rejects(c.request('agent.retry', { name: 'nope' }), code('not_found'))

      // upTo: отметка — до показанного события, не дальше конца журнала и не назад.
      await c.request('agent.seen', { name: 'w', unread: true })
      const before = (await rec('w'))['lastSeenEventId'] as number
      assert.equal(((await c.request('agent.seen', { name: 'w', upTo: 1 })) as Record<string, unknown>)['lastSeenEventId'], before, 'назад не двигается')
      assert.equal((await rec('w'))['markedUnread'], undefined, 'показ с upTo тоже снимает пометку')
      const far = (await c.request('agent.seen', { name: 'w', upTo: 1_000_000 })) as Record<string, unknown>
      assert.equal(far['lastSeenEventId'], ((await c.request('daemon.status')) as { lastEventId: number }).lastEventId, 'не дальше конца журнала')
      await assert.rejects(c.request('agent.seen', { name: 'w', upTo: -1 }), code('invalid_params'))
      await assert.rejects(c.request('agent.seen', { name: 'w', upTo: 1.5 }), code('invalid_params'))

      // Номер хода «Сделай раз» — из журнала: ошибка этого хода повторяет именно его реплику.
      const evs = async (): Promise<PultEvent[]> => ((await c.request('agent.read', { name: 'w', format: 'json' })) as { events: PultEvent[] }).events
      const turnOf = (list: PultEvent[]): string => String(list.filter((e) => e.kind === 'status.changed' && e.data['status'] === 'working').at(-1)?.data['turnId'])
      const t1 = turnOf(await evs())
      await c.request('events.emit', { kind: 'status.changed', sessionId: 'w', provider: 'claude', data: { status: 'failed', turnId: t1, message: 'процесс упал' } })
      const failed = (await rec('w'))['attention'] as Attention
      assert.deepEqual([failed.kind, failed.text, failed.turnId], ['failed', 'процесс упал', t1])
      assert.equal(isUnreadError((await rec('w')) as Parameters<typeof isUnreadError>[0]), true)
      const retried = (await c.request('agent.retry', { name: 'w' })) as { turnId?: string }
      assert.equal(typeof retried.turnId, 'string')
      assert.ok(((await rec('w'))['lastSeenEventId'] as number) >= failed.id, 'реплика ушла — ошибка прочитана')
      await c.request('agent.wait', { name: 'w', until: ['idle'], timeoutMs: 20_000 })
      const users = async (): Promise<unknown[]> => (await evs()).filter((e) => e.kind === 'message.user').map((e) => e.data['text'])
      assert.deepEqual(await users(), ['Сделай раз', 'Сделай раз'])

      // Ход удался, потом лимит аккаунта на простаивающей сессии: повторять нечего, ошибка остаётся непрочитанной.
      await c.request('events.emit', { kind: 'limit.hit', sessionId: 'w', provider: 'claude', data: { status: 'rejected', rateLimitType: 'five_hour' } })
      const limit = (await rec('w'))['attention'] as Attention
      assert.deepEqual([limit.kind, limit.turnId], ['limit', undefined])
      await assert.rejects(c.request('agent.retry', { name: 'w' }), (e: { code?: string; message?: string }) => e.code === 'invalid_params' && /вне хода/.test(e.message ?? ''))
      assert.ok(((await rec('w'))['lastSeenEventId'] as number) < limit.id, 'отказ не отмечает «видел»')
      assert.deepEqual(await users(), ['Сделай раз', 'Сделай раз'], 'ничего не отправлено')

      // Удаление: новая сессия с тем же именем прошлого внимания не наследует.
      await c.request('agent.rm', { name: 'w' })
      await c.request('agent.start', { name: 'w', kind: 'claude', cwd })
      assert.equal((await rec('w'))['attention'], undefined)
      assert.equal(await unread('w'), false)
      // …и ошибка с тем же номером хода в новой сессии не берёт реплику прежней.
      await c.request('events.emit', { kind: 'status.changed', sessionId: 'w', provider: 'claude', data: { status: 'failed', turnId: t1 } })
      await assert.rejects(c.request('agent.retry', { name: 'w' }), code('invalid_params'))
      // agent.read видит журнал по имени целиком, с прежней сессией: новых реплик не прибавилось.
      assert.deepEqual(await users(), ['Сделай раз', 'Сделай раз'], 'реплика удалённой сессии не ушла')
    } finally { c.close(); await d.stop('конец теста'); home.remove(); rmSync(cwd, { recursive: true, force: true }) }
  })
})

describe('RPC: повтор и реплика не уходят дважды', () => {
  it('занятая сессия: повтор — отказ, «видел» не ставится; две реплики разом — одна уходит', async () => {
    const home = tempHome()
    const cwd = mkdtempSync(join(tmpdir(), 'pt-att2-'))
    // Ход висит 3 с до первого байта: сессия «занята» достаточно долго.
    writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({ scenario: 'simple', speed: 0, hang: 3000 }))
    const d = await startTestDaemon(home)
    const c = await connectClient(home.paths)
    const rec = async (): Promise<Record<string, unknown>> =>
      ((await c.request('agent.list')) as { sessions: Array<Record<string, unknown>> }).sessions.find((s) => s['name'] === 'b')!
    try {
      await c.request('agent.start', { name: 'b', kind: 'claude', cwd })
      const both = await Promise.allSettled([
        c.request('agent.prompt', { name: 'b', text: 'раз' }),
        c.request('agent.prompt', { name: 'b', text: 'два' }),
      ])
      assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(both.map((r) => r.status === 'rejected' ? String((r.reason as Error).message) : 'ok')))
      const rejected = both.find((r) => r.status === 'rejected') as PromiseRejectedResult
      assert.equal((rejected.reason as { code?: string }).code, 'invalid_params')

      // Ход идёт; ошибка «того же хода» уже в журнале (подделана) — повтор всё равно отказ, отметка не тронута.
      const working = ((await c.request('agent.read', { name: 'b', format: 'json' })) as { events: PultEvent[] }).events
        .filter((e) => e.kind === 'status.changed' && e.data['status'] === 'working').at(-1)
      await c.request('events.emit', { kind: 'status.changed', sessionId: 'b', provider: 'claude', data: { status: 'failed', turnId: working?.data['turnId'] } })
      const seenBefore = (await rec())['lastSeenEventId']
      await assert.rejects(c.request('agent.retry', { name: 'b' }), (e: { code?: string; message?: string }) => e.code === 'invalid_params' && /занята/.test(e.message ?? ''))
      assert.equal((await rec())['lastSeenEventId'], seenBefore, 'отказ не отмечает «видел»')
      await c.request('agent.wait', { name: 'b', until: ['idle'], timeoutMs: 20_000 })
    } finally { c.close(); await d.stop('конец теста'); home.remove(); rmSync(cwd, { recursive: true, force: true }) }
  })
})
