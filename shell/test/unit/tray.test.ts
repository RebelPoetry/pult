import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { SESSION_STATUSES } from '../../../src/sessions/registry.js'
import { statusView } from '../../../ui/src/model/agents.js'
import type { ConnState } from '../../src/contract.js'
import {
  dockBadge, menuLabel, pendingFrom, sessionsFrom, sortSessions, statusLabel, TRAY_MAX_REQUESTS, TRAY_MAX_SESSIONS, trayModel,
} from '../../src/tray.js'
import type { TrayInput, TrayItem, TrayModel, TrayRequest, TraySession } from '../../src/tray.js'

const BUILD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'build')

const UP: ConnState = { state: 'up', daemon: { version: '0.2.5', pid: 42, startedAt: '2026-10-07T10:00:00.000Z' } }
const DOWN: ConnState = { state: 'down', reason: 'соединение с демоном закрыто', attempt: 2, retryInMs: 4000 }

const sess = (name: string, lastStatus: string, lastEventId: number, extra: Partial<TraySession> = {}): TraySession =>
  ({ name, lastStatus: lastStatus as TraySession['lastStatus'], lastEventId, ...extra })
const req = (id: string, sessionId: string, toolName: string, createdAt = '2026-10-07T10:00:00.000Z'): TrayRequest =>
  ({ id, sessionId, toolName, createdAt })

const model = (over: Partial<TrayInput> = {}): TrayModel =>
  trayModel({ conn: UP, status: { version: '0.2.5', mode: 'service' }, sessions: [], pending: [], ...over })
type Entry = Extract<TrayItem, { kind: 'item' }>
const entries = (m: TrayModel): Entry[] => m.items.filter((i): i is Entry => i.kind === 'item')
const item = (m: TrayModel, id: string): Entry | undefined => entries(m).find((i) => i.id === id)
const labels = (m: TrayModel, prefix: string): string[] => entries(m).filter((i) => i.id.startsWith(prefix)).map((i) => i.label)
const headers = (m: TrayModel): string[] => m.items.flatMap((i) => (i.kind === 'header' ? [i.label] : []))

describe('строка меню: модель', () => {
  it('демон под службой: строка демона с версией и режимом, пункты «Открыть» и «Выйти»', () => {
    const m = model()
    assert.deepEqual(m.items[0], { kind: 'item', id: 'daemon', label: 'Демон 0.2.5 · служба', enabled: false })
    assert.equal(item(model({ status: { version: '0.2.6', mode: 'on-demand' } }), 'daemon')?.label, 'Демон 0.2.6 · по требованию')
    // daemon.status не ответил — версия из рукопожатия, без режима.
    assert.equal(item(model({ status: null }), 'daemon')?.label, 'Демон 0.2.5')
    assert.deepEqual(item(m, 'open')?.action, { kind: 'open', target: {} })
    const quit = item(m, 'quit')
    assert.deepEqual([quit?.label, quit?.action], ['Выйти из Пульта', { kind: 'quit' }])
    assert.match(quit?.sublabel ?? '', /Сессии продолжат работать в демоне/)
    assert.equal(m.title, '')
    assert.equal(m.tooltip, 'Пульт · всё спокойно')
  })

  it('запросы: счётчик в заголовке, «Ждут тебя» — старые сверху, вопрос Codex — «вопрос»', () => {
    const m = model({
      sessions: [sess('beta', 'blocked_permission', 10, { title: 'Починить VPN' }), sess('cx', 'blocked_question', 12)],
      pending: [req('p2', 'cx', 'requestUserInput', '2026-10-07T10:00:05.000Z'), req('p1', 'beta', 'Edit', '2026-10-07T10:00:01.000Z')],
    })
    assert.equal(m.title, '2')
    assert.deepEqual(headers(m), ['Ждут тебя', 'Сессии'])
    assert.deepEqual(labels(m, 'perm:'), ['Починить VPN — Edit', 'cx — вопрос'])
    assert.deepEqual(item(m, 'perm:p1')?.action, { kind: 'open', target: { sessionId: 'beta', permId: 'p1' } })
    assert.equal(m.tooltip, 'Пульт · 2 ждут тебя')
  })

  it('запрос сессии, которой нет в agent.list, подписан её именем', () => {
    assert.deepEqual(labels(model({ sessions: [], pending: [req('p1', 'ghost', 'Bash')] }), 'perm:'), ['ghost — Bash'])
  })

  it('сессии: ждущие → идущие → остальные по свежести; название вместо имени; статус по-русски', () => {
    const m = model({
      sessions: [
        sess('old', 'idle', 5),
        sess('run', 'working', 7),
        sess('fresh', 'done', 30),
        sess('ask', 'idle', 3, { title: 'Ответь мне' }),
        sess('q', 'blocked_question', 1),
      ],
      pending: [req('p1', 'ask', 'Bash')],
    })
    assert.deepEqual(labels(m, 'session:'), [
      '● Ответь мне · готов',
      '● q · ждёт ответа',
      '● run · идёт',
      '● fresh · завершён',
      '● old · готов',
    ])
    assert.deepEqual(item(m, 'session:run')?.action, { kind: 'open', target: { sessionId: 'run' } })
    assert.equal(m.tooltip, 'Пульт · 1 ждёт тебя · 1 идёт')
  })

  it('без perm.list порядок берёт счётчик из agent.list', () => {
    const sorted = sortSessions([sess('a', 'idle', 9), sess('b', 'idle', 1, { pendingPermissions: 1 })], null)
    assert.deepEqual(sorted.map((s) => s.name), ['b', 'a'])
    // perm.list есть — он правда «сейчас»: устаревший счётчик записи не поднимает сессию.
    const live = sortSessions([sess('a', 'idle', 9), sess('b', 'idle', 1, { pendingPermissions: 1 })], [])
    assert.deepEqual(live.map((s) => s.name), ['a', 'b'])
  })

  it('много сессий и запросов: поимённо до предела, остальное строкой «ещё N»', () => {
    const many = Array.from({ length: TRAY_MAX_SESSIONS + 4 }, (_, i) => sess(`s${i}`, 'idle', i))
    const reqs = Array.from({ length: TRAY_MAX_REQUESTS + 2 }, (_, i) => req(`p${i}`, 's0', 'Bash', `2026-10-07T10:00:${String(10 + i)}.000Z`))
    const m = model({ sessions: many, pending: reqs })
    assert.equal(entries(m).filter((i) => i.id.startsWith('session:')).length, TRAY_MAX_SESSIONS)
    assert.equal(item(m, 'sessions:more')?.label, 'Ещё 4 — в окне')
    assert.equal(entries(m).filter((i) => /^perm:p\d+$/.test(i.id)).length, TRAY_MAX_REQUESTS)
    const more = item(m, 'perm:more')
    assert.equal(more?.label, 'Ещё 2 — в Inbox окна')
    assert.deepEqual(more?.action, { kind: 'open', target: { sessionId: 's0', permId: `p${TRAY_MAX_REQUESTS}` } })
    assert.equal(m.title, '1', 'счётчик — сессии, а не запросы: 12 запросов одной сессии — 1 (как на доке)')
  })

  it('сессий нет — строка «Сессий пока нет» без действия', () => {
    const none = item(model(), 'sessions:none')
    assert.deepEqual([none?.label, none?.enabled, none?.action], ['Сессий пока нет', false, undefined])
  })

  it('демон недоступен: ни сессий, ни запросов, пустой счётчик; «Открыть» работает', () => {
    const m = model({ conn: DOWN, sessions: [sess('run', 'working', 7)], pending: [req('p1', 'run', 'Bash')] })
    assert.deepEqual(item(m, 'daemon'), { kind: 'item', id: 'daemon', label: 'Демон недоступен', enabled: false, sublabel: 'соединение с демоном закрыто' })
    assert.deepEqual(headers(m), [])
    assert.equal(labels(m, 'session:').length + labels(m, 'perm:').length, 0)
    assert.equal(m.title, '')
    assert.equal(m.tooltip, 'Пульт · демон недоступен')
    assert.equal(item(m, 'open')?.enabled, true)
    assert.equal(item(m, 'quit')?.enabled, true)
  })

  it('подключение: строка демона и подсказка о подключении', () => {
    const m = model({ conn: { state: 'connecting', attempt: 0 }, sessions: null, pending: null })
    assert.equal(item(m, 'daemon')?.label, 'Демон: подключение…')
    assert.equal(m.tooltip, 'Пульт · подключение к демону…')
  })

  it('agent.list или perm.list не ответили — раздела нет, счётчик пуст', () => {
    const m = model({ sessions: null, pending: null })
    assert.deepEqual(headers(m), [])
    assert.equal(m.title, '')
  })

  it('подсказка: согласование «ждёт/ждут», «идёт/идут»', () => {
    // Ждут — сессии с запросом (по одной на каждую), идут — сессии в работе.
    const tip = (n: number, w: number): string => model({
      sessions: [
        ...Array.from({ length: w }, (_, i) => sess(`w${i}`, 'working', i)),
        ...Array.from({ length: n }, (_, i) => sess(`b${i}`, 'blocked_permission', 100 + i)),
      ],
      pending: Array.from({ length: n }, (_, i) => req(`p${i}`, `b${i}`, 'Bash')),
    }).tooltip
    assert.equal(tip(1, 3), 'Пульт · 1 ждёт тебя · 3 идут')
    assert.equal(tip(11, 21), 'Пульт · 11 ждут тебя · 21 идёт')
    assert.equal(tip(21, 0), 'Пульт · 21 ждёт тебя')
    assert.equal(tip(0, 2), 'Пульт · 2 идут')
  })

  it('словарь — «сессии», слова «агент» в меню нет', () => {
    const m = model({ sessions: [sess('a', 'working', 1)], pending: [req('p1', 'a', 'Bash')] })
    const text = [m.tooltip, ...m.items.flatMap((i) => (i.kind === 'separator' ? [] : [i.label, ...(i.kind === 'item' && i.sublabel ? [i.sublabel] : [])]))].join('\n')
    assert.doesNotMatch(text, /агент/i)
  })

  it('длинное название обрезается многоточием', () => {
    const [label] = labels(model({ sessions: [sess('a', 'idle', 1, { title: 'Я'.repeat(80) })] }), 'session:')
    assert.match(label ?? '', /^● Я+… · готов$/)
    assert.ok([...(label ?? '')].length < 80)
  })

  it('статусы подписаны так же, как в списке окна', () => {
    for (const s of SESSION_STATUSES) assert.equal(statusLabel(s), statusView(s).label, s)
    assert.equal(statusLabel('нечто'), 'нечто')
  })

  it('`&` в названии не съедается мнемоникой меню', () => {
    assert.equal(menuLabel('R&D · идёт'), 'R&&D · идёт')
  })

  it('разбор ответов демона: кривой ответ — null, мусорные строки пропущены', () => {
    assert.equal(sessionsFrom(null), null)
    assert.equal(sessionsFrom({ sessions: 'x' }), null)
    assert.deepEqual(sessionsFrom({ sessions: [{ name: 'a', lastStatus: 'idle', lastEventId: 1 }, { name: 1 }, null] }), [{ name: 'a', lastStatus: 'idle', lastEventId: 1 }])
    assert.equal(pendingFrom({}), null)
    assert.deepEqual(pendingFrom({ pending: [{ id: 'p', sessionId: 'a', toolName: 'Bash', createdAt: 'x' }, { id: 2 }] }), [{ id: 'p', sessionId: 'a', toolName: 'Bash', createdAt: 'x' }])
  })
})

/** RGBA пикселей PNG, который пишет scripts/make-tray-icon.mjs (8 бит, RGBA, фильтр строк 0). */
function readPng(file: string): { width: number; height: number; rgba: Buffer } {
  const buf = readFileSync(file)
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${file}: не PNG`)
  let off = 8
  let width = 0
  let height = 0
  const idat: Buffer[] = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      assert.deepEqual([data[8], data[9]], [8, 6], `${file}: ждали 8 бит RGBA`)
    }
    if (type === 'IDAT') idat.push(data)
    off += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1)
    assert.equal(raw[row], 0, `${file}: фильтр строки ${y} не 0 — файл не из make-tray-icon.mjs`)
    raw.copy(rgba, y * width * 4, row + 1, row + 1 + width * 4)
  }
  return { width, height, rgba }
}

describe('значок на доке: сколько сессий ждут тебя (О2)', () => {
  const failed = { id: 20, kind: 'failed' as const, at: '', text: 'упал' }
  const done = { id: 21, kind: 'done' as const, at: '' }
  it('разрешения и вопросы + непрочитанные ошибки; готовые и прочитанные — нет; сессия считается раз', () => {
    const sessions = [
      sess('err', 'failed', 20, { attention: failed, lastSeenEventId: 5 }),
      sess('seen-err', 'failed', 20, { attention: failed, lastSeenEventId: 20 }),
      sess('done', 'idle', 21, { attention: done, lastSeenEventId: 5 }),
      sess('ask', 'blocked_permission', 22, { attention: { id: 22, kind: 'ask', at: '' }, lastSeenEventId: 5 }),
      sess('both', 'failed', 23, { attention: { id: 23, kind: 'limit', at: '' }, lastSeenEventId: 5 }),
      sess('marked', 'failed', 24, { attention: { id: 4, kind: 'blocked', at: '' }, lastSeenEventId: 30, markedUnread: true }),
    ]
    const pending = [req('p1', 'ask', 'Bash'), req('p2', 'both', 'Edit'), req('p3', 'ask', 'requestUserInput')]
    assert.equal(dockBadge(sessions, pending), '4', 'err, ask, both, marked')
    assert.equal(model({ sessions, pending }).badge, '4')
    // perm.list не ответил — по счётчику agent.list.
    assert.equal(dockBadge([sess('a', 'blocked_permission', 1, { pendingPermissions: 2 }), sess('b', 'idle', 2)], null), '1')
    assert.equal(dockBadge([sess('done', 'idle', 21, { attention: done })], []), '', 'ноль — пусто')
    assert.equal(dockBadge(null, pending), '', 'без списка сессий — пусто')
  })
  it('демон недоступен — значок пуст: старое число выглядело бы живым', () => {
    const sessions = [sess('err', 'failed', 20, { attention: failed, lastSeenEventId: 5 })]
    assert.equal(model({ conn: DOWN, sessions, pending: [] }).badge, '')
    assert.equal(model({ sessions, pending: [] }).badge, '1')
  })
  it('счётчик в строке меню — то же число, что на доке; у архивных считается только ждущий запрос', () => {
    const sessions = [
      sess('err', 'failed', 20, { attention: failed, lastSeenEventId: 5 }),
      sess('old', 'failed', 21, { attention: failed, lastSeenEventId: 5, archived: true }),
      sess('arch-ask', 'blocked_permission', 22, { archived: true }),
      sess('ask', 'blocked_permission', 23),
    ]
    const m = model({ sessions, pending: [req('p1', 'ask', 'Bash'), req('p2', 'ask', 'Edit'), req('p3', 'arch-ask', 'Bash')] })
    // err + ask + arch-ask (архивная, но стоит на разрешении); ошибка архивной old — нет.
    assert.deepEqual([m.title, m.badge], ['3', '3'])
    assert.match(m.tooltip, /^Пульт · 3 ждут тебя/)
  })

  it('кривое внимание в ответе демона не роняет счёт', () => {
    assert.equal(dockBadge([sess('x', 'failed', 1, { attention: { id: 'x', kind: 'failed' } as never })], []), '')
  })
})

describe('строка меню: значок', () => {
  for (const [name, size] of [['trayTemplate.png', 16], ['trayTemplate@2x.png', 32]] as const) {
    it(`${name}: ${size}×${size}, шаблонный — только чёрный и прозрачность`, () => {
      const { width, height, rgba } = readPng(path.join(BUILD, name))
      assert.deepEqual([width, height], [size, size])
      let opaque = 0
      for (let i = 0; i < rgba.length; i += 4) {
        assert.deepEqual([rgba[i], rgba[i + 1], rgba[i + 2]], [0, 0, 0], `${name}: цветной пиксель ${i / 4}`)
        if (rgba[i + 3] === 255) opaque++
      }
      // Рисунок есть, но не заливка: фейдеры занимают малую часть холста.
      assert.ok(opaque > size * size * 0.1 && opaque < size * size * 0.5, `${name}: непрозрачных ${opaque}`)
    })
  }

  it('значок едет в приложение: оба файла в `files` electron-builder', () => {
    const pkg = JSON.parse(readFileSync(path.join(BUILD, '..', 'package.json'), 'utf8')) as { build: { files: string[] } }
    assert.ok(pkg.build.files.includes('build/trayTemplate.png'))
    assert.ok(pkg.build.files.includes('build/trayTemplate@2x.png'))
  })
})
