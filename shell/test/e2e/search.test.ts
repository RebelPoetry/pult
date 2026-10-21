// e2e О2 «Поиск, метки, экспорт» (docs/14): ⌘⇧F находит реплику на РАННЕЙ странице истории, Enter
// открывает сессию, окно догружает страницы, прокручивает к реплике и подсвечивает её; метки реплик
// слева от ленты и ⌥↑; «Экспорт в Markdown» из меню сессии кладёт файл в PULT_HOME/exports и показывает
// его в Finder (в тесте Finder подменён). Журнал сессии наполняется `events.emit` тестового демона.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

type Client = Awaited<ReturnType<Harness['client']>>
const TURNS = 40

describe('окно: поиск, метки, экспорт', () => {
  let h: Harness
  let c: Client
  let needleId = 0

  before(async () => {
    h = await launch({ name: 'search' })
    assert.ok(await waitFor(async () => (await h.win.getAttribute('.app', 'data-conn')) === 'up', 20_000), 'окно не подключилось')
    c = await h.client()
    await c.request('agent.start', { name: 'hay', kind: 'claude', cwd: h.workDir('hay'), title: 'Стог' })
    const emit = async (kind: string, data: Record<string, unknown>): Promise<number> =>
      ((await c.request('events.emit', { kind, sessionId: 'hay', provider: 'claude', data })) as { ids: number[] }).ids[0] as number
    needleId = await emit('message.user', { text: 'Найди ИГЛУ в стоге сена' })
    await emit('message.done', { text: 'Ищу.' })
    // Сорок ходов по ~20 КБ (строки по абзацу, как у настоящих ответов): лёгкая история больше страницы
    // (512 КБ) — первая реплика уходит на раннюю страницу.
    const answer = (i: number): string => Array.from({ length: 30 }, (_, j) => `Строка ${j} хода ${i}: ${'сено '.repeat(60)}`).join('\n\n')
    for (let i = 1; i <= TURNS; i++) {
      await emit('message.user', { text: `Реплика ${i}` })
      await emit('message.done', { text: answer(i) })
    }
    const page = (await c.request('events.history', { sessionId: 'hay' })) as { more: boolean; oldest: number }
    assert.ok(page.more && page.oldest > needleId, 'искомая реплика должна быть на ранней странице истории')
  })
  after(async () => { await h?.close() })

  it('⌘⇧F → запрос → Enter: сессия открыта, ранняя страница догружена, реплика на экране и подсвечена', async () => {
    const row = h.win.locator('[data-testid="agent-row"][data-agent="hay"]')
    await row.waitFor({ timeout: 10_000 })
    await h.win.keyboard.press('Meta+Shift+KeyF')
    const dlg = h.win.getByTestId('search-dialog')
    await dlg.waitFor({ timeout: 5000 })
    await dlg.getByTestId('search-input').fill('игл')
    const first = dlg.getByTestId('search-hit').first()
    await first.waitFor({ timeout: 10_000 })
    assert.equal(await first.getAttribute('data-event-id'), String(needleId))
    assert.equal(await first.getAttribute('data-session'), 'hay')
    assert.match((await dlg.getByTestId('search-group').first().textContent()) ?? '', /Стог/)
    assert.equal(await first.locator('mark').textContent(), 'ИГЛ')
    await h.screen('search-dialog')
    await h.win.keyboard.press('Enter')
    await dlg.waitFor({ state: 'detached', timeout: 5000 })

    await h.win.locator('[data-testid="conversation"][data-agent="hay"]').waitFor({ timeout: 10_000 })
    const target = h.win.locator(`[data-testid="msg-user"][data-event-id="${needleId}"]`)
    await target.waitFor({ timeout: 15_000 })
    assert.ok(await waitFor(async () => (await target.getAttribute('class'))?.includes('it-flash') === true, 5000), 'реплика не подсвечена')
    // На экране: верх реплики в видимой части ленты.
    const inView = await h.win.evaluate((id) => {
      const feed = document.querySelector('[data-testid="feed"]') as HTMLElement
      const el = document.querySelector(`[data-testid="msg-user"][data-event-id="${id}"]`) as HTMLElement
      const f = feed.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      return r.top >= f.top - 1 && r.top < f.bottom
    }, needleId)
    assert.ok(inView, 'реплика не на экране')
    await h.screen('search-jump')
  })

  it('метки реплик слева: по одной на реплику; клик и ⌥↓ ведут к реплике', async () => {
    const marks = h.win.getByTestId('user-mark')
    assert.equal(await marks.count(), TURNS + 1)
    // ⌥↓ из пустого поля реплики: первая — найденная реплика встаёт к верхнему краю, вторая — к следующей.
    await h.win.getByTestId('composer').focus()
    const topUser = async (): Promise<string | null> => h.win.evaluate(() => {
      const feed = document.querySelector('[data-testid="feed"]') as HTMLElement
      const f = feed.getBoundingClientRect()
      const users = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="msg-user"]'))
      const vis = users.find((u) => { const r = u.getBoundingClientRect(); return r.top >= f.top - 2 && r.top < f.bottom })
      return vis?.dataset['eventId'] ?? null
    })
    await h.win.keyboard.press('Alt+ArrowDown')
    assert.ok(await waitFor(async () => (await topUser()) === String(needleId), 5000), '⌥↓ не поставил реплику к верхнему краю')
    await h.win.keyboard.press('Alt+ArrowDown')
    assert.ok(await waitFor(async () => (await topUser()) === String(needleId + 2), 5000), '⌥↓ не перешёл к следующей реплике')
    await h.win.keyboard.press('Alt+ArrowUp')
    assert.ok(await waitFor(async () => (await topUser()) === String(needleId), 5000), '⌥↑ не вернул к предыдущей реплике')
    await marks.last().click()
    const last = await marks.last().getAttribute('data-event-id')
    assert.ok(await waitFor(async () => (await h.win.locator(`[data-testid="msg-user"][data-event-id="${last}"]`).getAttribute('class'))?.includes('it-flash') === true, 5000), 'клик по метке не привёл к реплике')
  })

  it('меню сессии → «Экспорт в Markdown»: файл в exports/, Finder показывает его', async () => {
    await h.app.evaluate(({ shell }) => {
      const g = globalThis as unknown as { __revealed?: string[] }
      g.__revealed = []
      shell.showItemInFolder = (p: string) => { g.__revealed?.push(p) }
    })
    await h.win.locator('[data-testid="agent-row"][data-agent="hay"]').click({ button: 'right' })
    await h.win.getByTestId('session-menu-list').getByTestId('row-export').click()
    const revealed = async (): Promise<string[]> => h.app.evaluate(() => (globalThis as unknown as { __revealed?: string[] }).__revealed ?? [])
    assert.ok(await waitFor(async () => (await revealed()).length === 1, 10_000), 'Finder не позвали')
    const [file] = await revealed()
    const dir = path.join(h.home, 'exports')
    assert.deepEqual(readdirSync(dir), [path.basename(file as string)])
    const md = readFileSync(file as string, 'utf8')
    assert.match(md, /^# Стог$/m)
    assert.match(md, /> Найди ИГЛУ в стоге сена/)
    assert.match(md, new RegExp(`^## Ход ${TURNS + 1} · `, 'm'))
  })
})
