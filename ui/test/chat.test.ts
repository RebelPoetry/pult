// M8e: три правки чата — «Копировать» у реплики, реплика «отправляется…» без задержки поля, реплика человека
// Markdown'ом. Без DOM: разметка — react-dom/server, жизнь пузыря — чистые функции model/pending.ts.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Conversation } from '../src/components/Conversation.js'
import { copyToClipboard, Markdown } from '../src/components/Markdown.js'
import type { AgentView } from '../src/model/agents.js'
import type { ConvItem } from '../src/model/conversation.js'
import { foldConversation, messageSource } from '../src/model/conversation.js'
import { parseMarkdown } from '../src/model/markdown.js'
import type { PendingSend } from '../src/model/pending.js'
import { pendingBubble, pendingConfirmed, restoreDraft, sendFromComposer, willQueue } from '../src/model/pending.js'
import type { PultEvent } from '../src/model/types.js'

const html = (c: unknown, props: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(c as ComponentType<Record<string, unknown>>, props))
const noop = (): void => {}
const agent: AgentView = { name: 'w', provider: 'claude', status: 'idle', cwd: '/w', pending: 0, lastActivity: '2026-10-20T10:00:00Z' }
const conv = (over: Record<string, unknown> = {}): string => html(Conversation, {
  agent, items: [], now: Date.parse('2026-10-20T10:00:00Z'), usage: undefined, focusedPerm: null, permBusy: new Set(), sendError: null, sending: false,
  onSend: async () => true, onRename: async () => true, onStop: noop, onRemove: noop, onReveal: noop, onApprove: noop, onDeny: noop, onFocusPerm: noop, ...over,
})

let seq = 100
const ev = (kind: string, data: Record<string, unknown> = {}): PultEvent => ({
  id: ++seq, ts: '2026-10-20T10:00:00.000Z', sessionId: 'w', provider: 'claude', kind: kind as PultEvent['kind'], data,
})

describe('M8e: «Копировать» у реплики целиком', () => {
  const items = foldConversation([
    ev('message.user', { text: 'почини `parse_args` в **cli.ts**' }),
    ev('message.delta', { text: 'Готово' }),
    ev('message.done', { text: '## Итог\n\n| a | b |\n|---|---|\n| 1 | 2 |' }),
    ev('tool.called', { toolUseId: 'u1', name: 'Bash', input: { command: 'ls' } }),
  ]).items

  it('кнопка есть у реплики человека и у ответа модели, у строки инструмента — нет', () => {
    const out = conv({ items })
    assert.equal((out.match(/data-testid="msg-copy"/g) ?? []).length, 2)
    assert.match(out, /aria-label="Копировать реплику"/)
    assert.match(out, /aria-label="Копировать ответ"/)
    // Кнопка — настоящая <button>: доступна с клавиатуры (Tab), без tabindex=-1.
    assert.doesNotMatch(out, /msg-copy[^>]*tabindex="-1"/)
    assert.doesNotMatch(out.slice(out.indexOf('data-testid="tool-row"')), /msg-copy/)
  })

  it('копируется ИСХОДНЫЙ Markdown, а не нарисованное; у реплики, которая ещё печатает, кнопки нет', () => {
    assert.equal(messageSource(items[0] as ConvItem), 'почини `parse_args` в **cli.ts**')
    assert.equal(messageSource(items[1] as ConvItem), '## Итог\n\n| a | b |\n|---|---|\n| 1 | 2 |')
    assert.equal(messageSource(items[2] as ConvItem), null)
    const streaming = foldConversation([ev('message.delta', { text: 'пишу' })]).items
    assert.equal(messageSource(streaming[0] as ConvItem), null)
    assert.doesNotMatch(conv({ items: streaming }), /msg-copy/)
  })

  it('буфер — через мост, как у блока кода; нет моста или отказ — false без исключения', async () => {
    const got: string[] = []
    assert.equal(await copyToClipboard({ copyText: async (t) => { got.push(t) } }, '# сырой *текст*'), true)
    assert.deepEqual(got, ['# сырой *текст*'])
    assert.equal(await copyToClipboard(null, 'x'), false)
    assert.equal(await copyToClipboard({ copyText: async () => { throw new Error('нет буфера') } }, 'x'), false)
  })

  it('стили: видна при наведении и фокусе с клавиатуры', () => {
    const css = readFileSync(new URL('../ui/src/styles.css', import.meta.url), 'utf8')
    assert.match(css, /\.it:hover > \.gut \.msg-copy, \.it > \.gut \.msg-copy:focus-visible/)
  })
})

describe('M8e: реплика «отправляется…»', () => {
  const p = (over: Partial<PendingSend> = {}): PendingSend =>
    ({ name: 'w', text: 'сделай', ts: '2026-10-20T10:00:00Z', afterId: 200, phase: 'sending', inFeed: true, nonce: 1, ...over })
  const user = (id: number): ConvItem => ({ type: 'user', key: `e${id}`, id, ts: '2026-10-20T10:00:00Z', text: 'сделай' })
  const model = (id: number): ConvItem => ({ type: 'model', key: `e${id}`, id, ts: '2026-10-20T10:00:00Z', text: 'ок', streaming: false })

  it('пузырь до подтверждения; реплика человека новее отправки — пузыря нет (дубля нет)', () => {
    const before = [user(150), model(151)]
    assert.deepEqual(pendingBubble(p(), 'w', before), { text: 'сделай', ts: '2026-10-20T10:00:00Z' })
    assert.equal(pendingConfirmed(before, 200), false)
    // Пришла своя реплика — подтверждено, и в ленте она одна.
    const after = [...before, user(201)]
    assert.equal(pendingConfirmed(after, 200), true)
    assert.equal(pendingBubble(p(), 'w', after), null)
    // Ответ модели без реплики человека — ещё не подтверждение.
    assert.equal(pendingConfirmed([...before, model(202)], 200), false)
    // Подтверждение не зависит от того, что под ним уже начался ход.
    assert.equal(pendingConfirmed([...after, model(203)], 200), true)
  })

  it('чужая сессия, отправка в очередь, нет отправки — пузыря нет', () => {
    assert.equal(pendingBubble(p(), 'other', []), null)
    assert.equal(pendingBubble(p({ inFeed: false }), 'w', []), null)
    assert.equal(pendingBubble(null, 'w', []), null)
  })

  it('в очередь — только `queue` на занятую сессию или непустую неостановленную очередь', () => {
    const idle = { busy: false, needsYou: false, queueLen: 0, queuePaused: false }
    assert.equal(willQueue('queue', idle), false)
    assert.equal(willQueue(undefined, { ...idle, busy: true }), false)
    assert.equal(willQueue('interrupt', { ...idle, busy: true }), false)
    assert.equal(willQueue('queue', { ...idle, busy: true }), true)
    assert.equal(willQueue('queue', { ...idle, needsYou: true }), true)
    assert.equal(willQueue('queue', { ...idle, queueLen: 2 }), true)
    assert.equal(willQueue('queue', { ...idle, queueLen: 2, queuePaused: true }), false)
  })

  it('отказ: пустое поле — черновик как был; набрано новое — отвергнутое первым через пустую строку, не теряется', () => {
    assert.deepEqual(restoreDraft('', 'мой черновик'), { text: 'мой черновик', caret: 12 })
    assert.deepEqual(restoreDraft('  \n', 'мой черновик'), { text: 'мой черновик', caret: 12 })
    assert.deepEqual(restoreDraft('новое', 'мой черновик'), { text: 'мой черновик\n\nновое', caret: 12 })
  })

  // Поле ввода без DOM: что в нём лежит и куда встала каретка.
  const field = (send: (t: string) => Promise<boolean>) => {
    const f = { value: '', caret: -1, sent: [] as string[], mounted: true }
    const io = {
      clear: () => { f.value = '' },
      send: async (t: string) => { f.sent.push(t); return send(t) },
      current: () => (f.mounted ? f.value : null),
      restore: (text: string, caret: number) => { f.value = text; f.caret = caret },
    }
    return { f, io }
  }

  it('Enter: поле пустеет ДО ответа демона; успех поле не трогает', async () => {
    let release: (ok: boolean) => void = () => {}
    const { f, io } = field(() => new Promise<boolean>((r) => { release = r }))
    f.value = '  сделай  '
    const done = sendFromComposer(f.value, io)
    assert.equal(f.value, '', 'поле не очистилось сразу')
    assert.deepEqual(f.sent, ['сделай'])
    f.value = 'пишу дальше'
    release(true)
    assert.equal(await done, true)
    assert.equal(f.value, 'пишу дальше')
    // Пустой черновик не уходит и поле не трогает.
    const g = field(async () => true)
    g.f.value = '   '
    assert.equal(await sendFromComposer(g.f.value, g.io), false)
    assert.deepEqual([g.f.value, g.f.sent], ['   ', []])
  })

  it('⌘Enter посреди зависшего хода: демон через 10 с ответил timeout, а в поле уже новое — оба текста на месте', async () => {
    let fail: (ok: boolean) => void = () => {}
    const { f, io } = field(() => new Promise<boolean>((r) => { fail = r }))
    f.value = 'Вместо этого сделай так'
    const done = sendFromComposer(f.value, io)
    f.value = 'и ещё вот что'
    // Console ловит `ход … не остановился за 10 с — реплика не отправлена` (ManagerError timeout) → false.
    fail(false)
    assert.equal(await done, false)
    assert.equal(f.value, 'Вместо этого сделай так\n\nи ещё вот что')
    assert.equal(f.caret, 'Вместо этого сделай так'.length)
    // Поле пустое (`updating`) — черновик как был, каретка в конце.
    const g = field(async () => false)
    g.f.value = 'мой черновик\n'
    await sendFromComposer(g.f.value, g.io)
    assert.deepEqual([g.f.value, g.f.caret], ['мой черновик\n', 13])
    // Ушёл на другую сессию до отказа — поля этой сессии нет, возвращать некуда (и не падаем).
    const h = field(async () => false)
    h.f.value = 'x'
    h.f.mounted = false
    assert.equal(await sendFromComposer(h.f.value, h.io), false)
    assert.equal(h.f.caret, -1)
  })

  it('лента рисует пузырь «отправляется…» в конце, и пустой разговор с ним — уже не «Разговор пуст»', () => {
    const out = conv({ items: [user(150)], pending: { text: 'смотри https://a.io', ts: '2026-10-20T10:00:00Z' } })
    assert.match(out, /data-testid="msg-user"[\s\S]*data-testid="msg-user-pending"/)
    assert.match(out, /class="it it-user it-pending"[^>]*aria-busy="true"/)
    assert.match(out, /отправляется…/)
    // Тот же Markdown, что у настоящей реплики, и без «Копировать» — копировать будет настоящая.
    assert.match(out.slice(out.indexOf('msg-user-pending')), /<a href="https:\/\/a.io\/"/)
    assert.doesNotMatch(out.slice(out.indexOf('msg-user-pending')), /msg-copy/)
    const empty = conv({ pending: { text: 'первая', ts: '2026-10-20T10:00:00Z' } })
    assert.doesNotMatch(empty, /Разговор пуст/)
    assert.match(empty, /msg-user-pending/)
    assert.match(conv(), /Разговор пуст/)
  })
})

describe('M8e: реплика человека — тот же безопасный Markdown', () => {
  const md = (text: string): string => html(Markdown, { text, human: true })
  const userFeed = (text: string): string => conv({ items: foldConversation([ev('message.user', { text })]).items })

  it('ссылки живые (и голые адреса), код в строке и блоком', () => {
    const out = userFeed('см. https://example.com/a_b и [доку](https://a.io/x)\n\n```sh\nnpm test\n```\nи `npm run build`')
    assert.match(out, /data-testid="msg-user"[\s\S]*<div class="md">/)
    assert.match(out, /<a href="https:\/\/example.com\/a_b"/)
    assert.match(out, /<a href="https:\/\/a.io\/x"/)
    assert.match(out, /data-testid="md-code"[\s\S]*<pre><code>npm test<\/code><\/pre>/)
    assert.match(out, /<code class="md-icode"[^>]*>npm run build<\/code>/)
  })

  it('переводы строк (Shift+Enter) и отступы на месте: строки не склеиваются и не обрезаются', () => {
    const b = parseMarkdown('первая\nвторая\n  третья\n\n\nпосле пустых', { human: true })
    assert.equal(b.length, 1)
    assert.deepEqual(b[0], { t: 'p', v: [{ t: 'text', v: 'первая\nвторая\n  третья\n\n\nпосле пустых' }] })
    assert.match(md('первая\nвторая'), /<p><span>первая\nвторая<\/span><\/p>/)
    const css = readFileSync(new URL('../ui/src/styles.css', import.meta.url), 'utf8')
    assert.match(css, /\.md p \{[^}]*white-space: pre-wrap/)
  })

  it('snake_case, пути и `__init__.py` с подчёркиваниями — текст, а не курсив', () => {
    for (const t of ['поправь snake_case_name и my_var_2', 'файл src/_private_.ts', 'открой pkg/__init__.py', 'a_b_c/d_e_f.txt']) {
      const out = md(t)
      assert.doesNotMatch(out, /<em>|<strong>/, t)
      assert.ok(out.includes(t.replace(/\//g, '/')), t)
    }
    // Настоящее выделение подчёркиванием по-прежнему работает.
    assert.match(md('это _важно_ и __очень__'), /<em><span>важно<\/span><\/em>[\s\S]*<strong><span>очень<\/span><\/strong>/)
  })

  it('сырой HTML — текстом; опасные ссылки — не ссылками', () => {
    const out = md('<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1))')
    assert.doesNotMatch(out, /<script|<img/)
    assert.match(out, /&lt;script&gt;/)
    assert.doesNotMatch(out, /href="javascript/)
  })

  it('лёгкий Markdown: заголовков, списков, цитат, черт и таблиц нет — строки как набраны; у модели всё по-прежнему', () => {
    for (const t of ['# comment here', 'итог\n---', 'итог\n===', '- раз\n- два', '1. раз', '> цитата', '---', '| a | b |\n|---|---|\n| 1 | 2 |']) {
      const b = parseMarkdown(t, { human: true })
      assert.deepEqual(b, [{ t: 'p', v: [{ t: 'text', v: t }] }], t)
    }
    assert.deepEqual(parseMarkdown('итог\n---').map((b) => b.t), ['h'])
    assert.deepEqual(parseMarkdown('# comment here\n- a').map((b) => b.t), ['h', 'list'])
  })

  it('вставленный Python держит отступы, `# комментарий` — текст; diff с `-`/`+` — дословно', () => {
    const py = 'def f(x):\n    # comment here\n    if x:\n        return [i for i in x]\n    return None'
    assert.deepEqual(parseMarkdown(py, { human: true }), [{ t: 'p', v: [{ t: 'text', v: py }] }])
    const out = md(py)
    assert.ok(out.includes('def f(x):\n    # comment here\n    if x:\n        return'), out)
    assert.doesNotMatch(out, /<h1|<ul|<ol|<li/)
    const diff = '--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-const a = 1\n+const a = 2\n  keep'
    assert.deepEqual(parseMarkdown(diff, { human: true }), [{ t: 'p', v: [{ t: 'text', v: diff }] }])
    assert.doesNotMatch(md(diff), /<ul|<li|<hr|<del/)
  })

  it('блок кода ``` у человека — блоком кода, текст вокруг — абзацами с отступами', () => {
    const b = parseMarkdown('смотри:\n```py\n    x = 1\n```\n  после', { human: true })
    assert.deepEqual(b, [
      { t: 'p', v: [{ t: 'text', v: 'смотри:' }] },
      { t: 'code', lang: 'py', v: '    x = 1' },
      { t: 'p', v: [{ t: 'text', v: '  после' }] },
    ])
  })
})
