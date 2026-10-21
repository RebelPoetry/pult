// О2 «Поиск, метки, экспорт» (docs/14) в окне: клавиши ⌘⇧F и ⌥↑/⌥↓, выдача поиска по сессиям,
// переход к событию (догрузка ранних страниц), метки реплик человека слева от ленты.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Conversation } from '../src/components/Conversation.js'
import { HotkeysHelp } from '../src/components/Panels.js'
import { SearchResults, searchOnce, whenLabel } from '../src/components/Search.js'
import type { AgentView } from '../src/model/agents.js'
import { applyEvents, EMPTY_STATE, finishEarlier, finishHydrate, beginEarlier, beginHydrate, bootState } from '../src/model/state.js'
import type { UiState } from '../src/model/state.js'
import { hotkeyAction, userJumpAllowed } from '../src/model/hotkeys.js'
import type { KeyLike } from '../src/model/hotkeys.js'
import { adjacentUser, flatHits, groupHits, itemForEvent, jumpStep, kindView, splitSnippet, userMarks } from '../src/model/search.js'
import type { SearchHit } from '../src/model/search.js'
import type { PultEvent } from '../src/model/types.js'

const key = (over: Partial<KeyLike>): KeyLike => ({ key: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over })
const html = (c: unknown, props: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(c as ComponentType<Record<string, unknown>>, props))


const ev = (id: number, kind: PultEvent['kind'], data: Record<string, unknown> = {}, sessionId = 'w', parentId?: string): PultEvent =>
  ({ id, ts: `2026-10-14T10:00:${String(id % 60).padStart(2, '0')}.000Z`, sessionId, provider: 'claude', kind, data, ...(parentId ? { parentId } : {}) })

describe('клавиши поиска и меток', () => {
  it('⌘⇧F — по коду клавиши (русская раскладка), точным набором; вне macOS — Ctrl+Shift+F', () => {
    assert.deepEqual(hotkeyAction(key({ key: 'F', code: 'KeyF', metaKey: true, shiftKey: true }), true), { type: 'search' })
    assert.deepEqual(hotkeyAction(key({ key: 'А', code: 'KeyF', metaKey: true, shiftKey: true }), true), { type: 'search' })
    assert.equal(hotkeyAction(key({ key: 'f', code: 'KeyF', metaKey: true }), true), null, '⌘F без Shift — не поиск')
    assert.equal(hotkeyAction(key({ key: 'F', code: 'KeyF', metaKey: true, shiftKey: true, altKey: true }), true), null)
    assert.equal(hotkeyAction(key({ key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true }), true), null, 'на маке Ctrl+Shift+F — не наш')
    assert.deepEqual(hotkeyAction(key({ key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true }), false), { type: 'search' })
  })

  it('⌥↑/⌥↓ — соседние реплики; с другими модификаторами — нет', () => {
    assert.deepEqual(hotkeyAction(key({ key: 'ArrowUp', code: 'ArrowUp', altKey: true }), true), { type: 'userJump', dir: -1 })
    assert.deepEqual(hotkeyAction(key({ key: 'ArrowDown', code: 'ArrowDown', altKey: true }), false), { type: 'userJump', dir: 1 })
    assert.equal(hotkeyAction(key({ key: 'ArrowUp', code: 'ArrowUp', altKey: true, shiftKey: true }), true), null)
    assert.equal(hotkeyAction(key({ key: 'ArrowUp', code: 'ArrowUp', metaKey: true }), true), null)
    assert.equal(hotkeyAction(key({ key: 'ArrowUp', code: 'ArrowUp' }), true), null)
  })

  it('⌥↑ в поле ввода двигает каретку — в ленту не уходит; пустое поле реплики — уходит', () => {
    const el = (tagName: string, extra: Record<string, unknown> = {}): Parameters<typeof userJumpAllowed>[0] =>
      ({ tagName, getAttribute: (n: string) => (n === 'data-testid' ? (extra['testid'] as string | undefined) ?? null : null), ...extra })
    assert.equal(userJumpAllowed(null), true)
    assert.equal(userJumpAllowed(el('BODY')), true)
    assert.equal(userJumpAllowed(el('BUTTON')), true)
    assert.equal(userJumpAllowed(el('INPUT', { value: '' })), false)
    assert.equal(userJumpAllowed(el('TEXTAREA', { value: 'текст', testid: 'composer' })), false)
    assert.equal(userJumpAllowed(el('TEXTAREA', { value: '', testid: 'composer' })), true)
    assert.equal(userJumpAllowed(el('TEXTAREA', { value: '' })), false, 'чужое поле — нет')
    assert.equal(userJumpAllowed(el('DIV', { isContentEditable: true })), false)
  })

  it('справка ⌘/ знает поиск и метки', () => {
    const out = html(HotkeysHelp, { onClose: () => {} })
    assert.match(out, /⌘⇧F|Ctrl\+Shift\+F/)
    assert.match(out, /поиск по всем разговорам/)
    assert.match(out, /⌥↑ ⌥↓|Alt\+↑ Alt\+↓/)
    assert.match(out, /Экспорт в Markdown|экспорт в Markdown/)
  })
})

const hit = (sessionId: string, eventId: number, kind = 'message.user', snippet = 'найди кота', match?: [number, number]): SearchHit =>
  ({ sessionId, eventId, kind, ts: '2026-10-14T10:00:00.000Z', snippet, ...(match ? { match } : {}) })

describe('выдача поиска', () => {
  it('по сессиям в порядке самого нового совпадения; неизвестная окну сессия выпадает; ↑/↓ идут по плоскому списку', () => {
    const hits = [hit('b', 9), hit('a', 8), hit('b', 5), hit('gone', 4), hit('a', 2)]
    const groups = groupHits(hits, (n) => (n === 'gone' ? null : n === 'a' ? 'Сессия А' : n))
    assert.deepEqual(groups.map((g) => [g.sessionId, g.label, g.hits.map((h) => h.eventId)]), [['b', 'b', [9, 5]], ['a', 'Сессия А', [8, 2]]])
    assert.deepEqual(flatHits(groups).map((h) => h.eventId), [9, 5, 8, 2])
  })

  it('совпадение выделяется по границам демона, без них — поиском без регистра', () => {
    assert.deepEqual(splitSnippet({ snippet: 'найди кота', match: [6, 10] }, 'x'), ['найди ', 'кота', ''])
    assert.deepEqual(splitSnippet({ snippet: 'Найди КОТА  тут' }, 'кота тут'), ['Найди ', 'КОТА  тут', ''])
    assert.deepEqual(splitSnippet({ snippet: 'нет', match: [5, 9] }, 'zz'), ['нет', '', ''])
    assert.equal(kindView('tool.called').icon, 'tool')
    assert.equal(kindView('message.user').label, 'ты')
  })

  it('разметка: заголовок сессии, значок вида, <mark>, номер события и выделенная строка', () => {
    const groups = groupHits([hit('w', 7, 'tool.called', 'Bash: npm test', [6, 14]), hit('w', 3, 'message.done', 'тесты зелёные')], () => 'Починка')
    const out = html(SearchResults, { groups, query: 'test', selected: 1, now: Date.parse('2026-10-14T12:00:00.000Z'), onOpen: () => {} })
    assert.match(out, /data-testid="search-group" data-session="w"/)
    assert.match(out, /Починка<span class="n">2<\/span>/)
    assert.match(out, /Bash: <mark>npm test<\/mark>/)
    assert.match(out, /data-event-id="7" data-kind="tool.called"/)
    assert.match(out, /aria-selected="true"[^>]*data-event-id="3"/)
    assert.match(out, /search-kind k-tool/)
  })

  it('время: сегодня — часы, раньше — с датой', () => {
    const now = new Date(2026, 9, 14, 12, 0).getTime()
    assert.match(whenLabel(new Date(2026, 9, 14, 9, 5).toISOString(), now), /^09:05$/)
    assert.match(whenLabel(new Date(2026, 9, 2, 9, 5).toISOString(), now), /^02\.10 09:05$/)
  })
})

describe('переход к событию', () => {
  it('событие — в своём элементе ленты: реплика, итог модели в реплике с первой дельтой, строка субагента', () => {
    let s: UiState = applyEvents(EMPTY_STATE, [
      ev(1, 'message.user', { text: 'привет' }),
      ev(2, 'message.delta', { text: 'При' }),
      ev(3, 'message.delta', { text: 'вет' }),
      ev(4, 'message.done', { text: 'Привет' }),
      ev(5, 'agent.spawned', { toolUseId: 'a1', subagentType: 'Explore' }),
      ev(6, 'tool.called', { toolUseId: 't1', name: 'Grep', input: { pattern: 'x' } }, 'w', 'a1'),
    ])
    const items = s.sessions['w']?.conv.items ?? []
    assert.equal(itemForEvent(items, 1)?.type, 'user')
    assert.equal(itemForEvent(items, 4)?.type, 'model')
    assert.equal(itemForEvent(items, 4)?.id, 2)
    assert.equal(itemForEvent(items, 6)?.type, 'tool', 'строка внутри субагента')
    assert.equal(itemForEvent(items, 0), null)
    s = applyEvents(s, [ev(7, 'message.user', { text: 'ещё' })])
    assert.deepEqual(userMarks(s.sessions['w']?.conv.items ?? []).map((m) => [m.id, m.text]), [[1, 'привет'], [7, 'ещё']])

  })

  it('итог модели — в реплике модели своей области, а не в строке субагента рядом; событие субагента — в его блоке', () => {
    const s = applyEvents(EMPTY_STATE, [
      ev(1, 'message.user', { text: 'привет' }),
      ev(2, 'message.delta', { text: 'Сна' }),
      ev(3, 'agent.spawned', { toolUseId: 'a1', subagentType: 'Explore' }),
      ev(4, 'tool.called', { toolUseId: 't1', name: 'Grep', input: { pattern: 'x' } }, 'w', 'a1'),
      ev(5, 'message.done', { text: 'Сначала' }),
      ev(6, 'message.done', { text: 'нашёл' }, 'w', 'a1'),
    ])
    const items = s.sessions['w']?.conv.items ?? []
    assert.equal(itemForEvent(items, 5)?.type, 'tool', 'без подсказки — ближайший элемент, строка субагента')
    const root = itemForEvent(items, 5, { kind: 'message.done' })
    assert.equal(root?.type, 'model')
    assert.ok(root && root.id < 3, 'реплика корня, заведённая дельтой')
    const sub = itemForEvent(items, 6, { kind: 'message.done', parentId: 'a1' })
    assert.equal(sub?.type, 'model')
    assert.equal(sub?.id, 6)
    assert.equal(itemForEvent(items, 4, { kind: 'tool.called', parentId: 'a1' })?.id, 4)
    assert.equal(itemForEvent(items, 4, { kind: 'tool.called', parentId: 'нет-такого' })?.type, 'agent', 'область не нашлась — корень')
  })

  it('поиск отменён демоном — один повтор; снова отменён — «прерван», не вечное «ищу…»; старый демон — «обнови»', async () => {
    let n = 0
    const r1 = await searchOnce(async () => (++n === 1 ? { results: [], truncated: false, superseded: true } : { results: [hit('w', 1)], truncated: false }), 'кот')
    assert.ok(r1.ok && r1.reply.results.length === 1)
    assert.equal(n, 2)
    const r2 = await searchOnce(async () => ({ results: [], truncated: false, superseded: true }), 'кот')
    assert.deepEqual(r2, { ok: false, error: 'Поиск прерван — попробуй ещё раз.' })
    const r3 = await searchOnce(async () => { throw { code: 'method_not_allowed', message: 'нет' } }, 'кот')
    assert.ok(!r3.ok && /обнови Пульт/.test(r3.error))
  })

  it('лента не собрана → её соберёт открытие; в пути → ждать; раньше загруженного → ещё страница; иначе — листать', () => {
    let s = bootState({ events: [], activity: { w: '2026-10-14T10:00:00.000Z' }, cursor: 100 })
    assert.equal(jumpStep(s, 'w', 10), 'hydrate')
    s = beginHydrate(s, 'w')
    assert.equal(jumpStep(s, 'w', 10), 'wait')
    s = finishHydrate(s, 'w', { events: [ev(50, 'message.user', { text: 'поздно' })], more: true, oldest: 50, cursor: 100 })
    assert.equal(jumpStep(s, 'w', 60), 'ready')
    assert.equal(jumpStep(s, 'w', 10), 'earlier')
    s = beginEarlier(s, 'w')
    assert.equal(jumpStep(s, 'w', 10), 'wait')
    s = finishEarlier(s, 'w', { events: [ev(20, 'message.user', { text: 'раньше' })], more: true, oldest: 20, cursor: 100 })
    assert.equal(jumpStep(s, 'w', 10), 'earlier')
    s = finishEarlier(beginEarlier(s, 'w'), 'w', { events: [ev(5, 'message.user', { text: 'начало' })], more: false, oldest: 5, cursor: 100 })
    assert.equal(jumpStep(s, 'w', 10), 'ready')
    assert.equal(jumpStep(applyEvents(EMPTY_STATE, []), 'w', 1), 'ready', 'полное доигрывание (старая оболочка) — всё уже в ленте')
  })

  it('⌥↑/⌥↓ по верху реплик: вверх — выше видимого края, вниз — ниже; дальше некуда — null', () => {
    const tops = [{ id: 1, top: 0 }, { id: 5, top: 400 }, { id: 9, top: 900 }]
    assert.equal(adjacentUser(tops, 400, -1), 1, 'реплика ровно у края не находится снова')
    assert.equal(adjacentUser(tops, 400, 1), 9)
    assert.equal(adjacentUser(tops, 650, -1), 5)
    assert.equal(adjacentUser(tops, 0, -1), null)
    assert.equal(adjacentUser(tops, 900, 1), null)
  })
})

describe('метки реплик человека', () => {
  const agent: AgentView = { name: 'w', provider: 'claude', status: 'idle', cwd: '/w', pending: 0, lastActivity: '2026-10-14T10:00:00Z' }
  const props = (items: unknown[]): Record<string, unknown> => ({
    agent, items, now: Date.now(), usage: undefined, focusedPerm: null, permBusy: new Set(), sendError: null, sending: false,
    onSend: async () => true, onRename: async () => true, onStop: () => {}, onRemove: () => {}, onReveal: () => {}, onApprove: () => {}, onDeny: () => {}, onFocusPerm: () => {},
  })

  it('полоса слева: метка на реплику, по порядку до замера; у элементов ленты — номер события', () => {
    const s = applyEvents(EMPTY_STATE, [
      ev(1, 'message.user', { text: 'первая' }),
      ev(2, 'message.done', { text: 'ответ' }),
      ev(3, 'tool.called', { toolUseId: 't', name: 'Bash', input: { command: 'ls' } }),
      ev(4, 'message.user', { text: 'вторая' }),
    ])
    const out = html(Conversation, props([...(s.sessions['w']?.conv.items ?? [])]))
    assert.equal((out.match(/data-testid="user-mark"/g) ?? []).length, 2)
    assert.match(out, /data-testid="user-mark" data-event-id="1" style="top:25%"/)
    assert.match(out, /data-testid="user-mark" data-event-id="4" style="top:75%"/)
    assert.match(out, /data-testid="msg-user" data-event-id="1"/)
    assert.match(out, /data-testid="msg-model" data-streaming="0" data-event-id="2"/)
    assert.match(out, /data-testid="tool-row" data-event-id="3"/)
  })

  it('реплик человека нет — полосы нет', () => {
    const s = applyEvents(EMPTY_STATE, [ev(1, 'message.done', { text: 'сам' })])
    assert.doesNotMatch(html(Conversation, props([...(s.sessions['w']?.conv.items ?? [])])), /user-rail/)
  })
})
