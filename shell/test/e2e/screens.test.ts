// ДЕМО для скриншотов (docs/12 §5): реалистичное состояние на фальшивых CLI и полноэкранные кадры
// каждого экрана в светлой и тёмной теме — по ним визуал судит отдельный судья.
//
// Состояние: четыре агента —
//   ui-refactor  claude, ход ИДЁТ: Read закончен, субагент Explore ищет Grep-ом и «печатает»;
//   codex-review codex, ход ЗАКОНЧЕН (записанный сценарий с субагентом);
//   fix-limits   claude, ЖДЁТ разрешения на правку файла (Edit с диффом); с названием «Округление лимитов»;
//   codex-tests  codex, ЖДЁТ разрешения на команду;
// Inbox — два запроса, лимиты claude и codex — из событий ходов.
// Кадры: main, inbox, new-agent, doctor, daemon-down × light, dark → test-results/screens/.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

type Client = Awaited<ReturnType<Harness['client']>>
type Rec = { name: string; lastStatus: string }

describe('скриншоты экранов (демо)', () => {
  let h: Harness
  let c: Client
  const shots: string[] = []

  const both = async (name: string, ready?: () => Promise<void>): Promise<void> => {
    for (const sch of ['light', 'dark'] as const) {
      await h.scheme(sch)
      if (ready) await ready()
      shots.push(await h.screen(`${name}-${sch}`))
    }
    await h.scheme('light')
  }
  const list = async (): Promise<Rec[]> => ((await c.request('agent.list', {})) as { sessions: Rec[] }).sessions
  const statusOf = async (name: string): Promise<string | undefined> => (await list()).find((r) => r.name === name)?.lastStatus

  before(async () => {
    h = await launch({ name: 'screens' })
    assert.ok(await waitFor(async () => (await h.win.getAttribute('.app', 'data-conn')) === 'up', 20_000), 'окно не подключилось')
    c = await h.client()
    h.codexConfig({ speed: 0, scenarioByDir: { 'codex-review': 'subagent', 'codex-tests': 'permission-accept' } })
  })
  after(async () => {
    if (c) {
      try {
        const left = (await c.request('perm.list', {})) as { pending: Array<{ id: string }> }
        for (const p of left.pending) await c.request('perm.resolve', { id: p.id, decision: 'deny', message: 'конец демо' })
      } catch { /* демон уже остановлен сценарием daemon-down */ }
    }
    await h?.close()
    process.stdout.write(`screens:\n${shots.map((s) => `  ${s}`).join('\n')}\n`)
  })

  it('заводит четыре агента в разных состояниях', async () => {
    const start = async (name: string, kind: 'claude' | 'codex', cwd: string, text: string, extra: Record<string, unknown> = {}): Promise<void> => {
      await c.request('agent.start', { name, kind, cwd, ...extra })
      await c.request('agent.prompt', { name, text })
    }
    await start('codex-review', 'codex', h.workDir('codex-review'), 'Проверь, что README объясняет запуск окна, и делегируй вычитку субагенту', { effort: 'medium' })
    assert.ok(await waitFor(async () => (await statusOf('codex-review')) === 'idle', 20_000), 'codex-review не закончил ход')

    await start('ui-refactor', 'claude', h.workDir('ui-refactor', { scenario: 'demo-working', speed: 1 }),
      'Шапка показывает 100 % лимита, хотя лимит не исчерпан. Разберись, где округление.', { model: 'sonnet', effort: 'medium' })
    await start('fix-limits', 'claude', h.workDir('fix-limits', { scenario: 'demo-edit', speed: 1 }),
      'Поправь округление в formatPct: 99,6 % не должно показываться как 100 %.', { model: 'fable', effort: 'xhigh', title: 'Округление лимитов' })
    await start('codex-tests', 'codex', h.workDir('codex-tests'), 'Прогони юнит-тесты интерфейса и запиши итог в x.txt', { effort: 'low' })

    assert.ok(await waitFor(async () => (await statusOf('fix-limits')) === 'blocked_permission', 20_000), 'fix-limits не спросил разрешения')
    assert.ok(await waitFor(async () => (await statusOf('codex-tests')) === 'blocked_permission', 20_000), 'codex-tests не спросил разрешения')
    assert.equal(await statusOf('ui-refactor'), 'working')
    assert.ok(await waitFor(async () => ((await h.win.getByTestId('inbox-count').textContent()) ?? '') === '2', 10_000), 'в Inbox не два запроса')
    // Субагент ui-refactor успел «напечатать» хвост до паузы.
    await h.win.locator('[data-testid="agent-row"][data-agent="ui-refactor"]').click()
    assert.ok(await waitFor(async () => ((await h.win.getByTestId('feed').textContent()) ?? '').includes('99,6'), 15_000), 'дельты субагента не дошли')
  })

  it('главный экран: агент за работой (Inbox скрыт)', async () => {
    if (await h.win.getByTestId('inbox').count()) await h.win.keyboard.press('Meta+I')
    await h.win.getByTestId('inbox').waitFor({ state: 'detached', timeout: 3000 })
    await h.win.locator('[data-testid="agent-row"][data-agent="ui-refactor"]').click()
    await h.win.getByTestId('subagent').waitFor({ timeout: 5000 })
    await both('main')
  })

  it('Inbox открыт: два запроса, у выбранного агента карточка ещё и в ленте', async () => {
    await h.win.keyboard.press('Meta+I')
    await h.win.getByTestId('inbox').waitFor({ timeout: 3000 })
    await h.win.locator('[data-testid="agent-row"][data-agent="fix-limits"]').click()
    await h.win.locator('[data-testid="conversation"][data-agent="fix-limits"]').getByTestId('perm-card').waitFor({ timeout: 5000 })
    assert.equal(await h.win.getByTestId('inbox').getByTestId('perm-card').count(), 2)
    await both('inbox', async () => {
      // Раскладка Inbox: дифф переносится, а не уходит за край (оверлейные полосы macOS прокрутку
      // не показывают); время ожидания — на строке заголовка у КАЖДОЙ карточки.
      const layout = await h.win.evaluate(() => {
        const inbox = document.querySelector('[data-testid="inbox"]')!
        const diffs = Array.from(inbox.querySelectorAll<HTMLElement>('.diff')).map((d) => d.scrollWidth - d.clientWidth)
        const heads = Array.from(inbox.querySelectorAll<HTMLElement>('.perm-h')).map((h) => {
          const l = h.querySelector('.lbl')!.getBoundingClientRect()
          const w = h.querySelector('.waited')!.getBoundingClientRect()
          return Math.abs((l.top + l.bottom) / 2 - (w.top + w.bottom) / 2)
        })
        return { diffs, heads }
      })
      assert.ok(layout.diffs.length > 0, 'в Inbox нет диффа')
      for (const over of layout.diffs) assert.ok(over <= 1, `дифф в Inbox шире колонки на ${over}px`)
      for (const dy of layout.heads) assert.ok(dy <= 3, `«ждёт …» ушло со строки заголовка (${dy}px)`)
    })
  })

  it('меню сессии по правому клику', async () => {
    const row = h.win.locator('[data-testid="agent-row"]').first()
    await row.click({ button: 'right' })
    await h.win.getByTestId('session-menu-list').waitFor({ timeout: 3000 })
    shots.push(await h.screen('session-menu-light'))
    await h.win.keyboard.press('Escape')
  })

  it('диалог «+ Агент»', async () => {
    await h.stubPickFolder(h.workDir('landing-copy'))
    await h.win.keyboard.press('Meta+N')
    const dlg = h.win.getByTestId('new-agent-dialog')
    await dlg.waitFor({ timeout: 3000 })
    await dlg.getByTestId('pick-folder').click()
    await waitFor(async () => ((await dlg.getByTestId('new-agent-name').inputValue()) === 'landing-copy'), 3000)
    await dlg.getByTestId('new-agent-worktree').fill('feat/landing-copy')
    await dlg.getByTestId('new-agent-prompt').fill('Перепиши первый экран лендинга короче: одна мысль, одна кнопка.')
    // Ряды модели и усилия целиком в диалоге: шесть уровней codex — самый широкий ряд.
    for (const provider of ['codex', 'claude'] as const) {
      await dlg.getByRole('group', { name: 'Провайдер' }).getByRole('button', { name: provider }).click()
      const over = await dlg.evaluate((el) => {
        const body = el.querySelector('.form-stack')!.getBoundingClientRect()
        return Array.from(el.querySelectorAll('.seg')).map((s) => Math.round(s.getBoundingClientRect().right - body.right))
      })
      for (const px of over) assert.ok(px <= 0, `ряд кнопок (${provider}) шире диалога на ${px}px`)
    }
    assert.deepEqual(await dlg.getByRole('group', { name: 'Усилие' }).getByRole('button').allTextContents(), ['low', 'medium', 'high', 'xhigh', 'max'])
    assert.deepEqual(await dlg.getByRole('group', { name: 'Модель' }).getByRole('button').allTextContents(), ['haiku', 'sonnet', 'opus', 'fable'])
    await both('new-agent')
    await h.win.keyboard.press('Escape')
    await dlg.waitFor({ state: 'detached', timeout: 3000 })
  })

  it('панель doctor', async () => {
    await h.win.getByTestId('open-doctor').click()
    const panel = h.win.getByTestId('doctor-panel')
    await panel.waitFor({ timeout: 3000 })
    assert.ok(await waitFor(async () => (await panel.getByTestId('doctor-item').count()) > 3, 20_000), 'пункты доктора не пришли')
    await waitFor(async () => (await panel.getByTestId('doctor-rerun').isEnabled()), 20_000)
    // Страж в тесте подменён (PULT_TEST_NET=ok): doctor не ходит в сеть по-настоящему.
    const net = (await panel.locator('[data-testid="doctor-item"]', { hasText: 'Сеть claude' }).textContent()) ?? ''
    assert.match(net, /loc=XX, 0 мс/, `doctor сходил в сеть по-настоящему: ${net}`)
    // Команда «почини» копируется через main (в тесте — не в системный буфер).
    const copyBtn = panel.getByTestId('doctor-copy').first()
    assert.ok(await copyBtn.count(), 'ни у одной строки нет команды «почини»')
    const code = copyBtn.locator('xpath=preceding-sibling::code')
    const before = [(await copyBtn.boundingBox())!.width, (await code.boundingBox())!.width]
    await copyBtn.click()
    const copied = await h.app.evaluate(() => (globalThis as { __pultTestClipboard?: string }).__pultTestClipboard ?? null)
    assert.ok(copied && copied.length > 0, 'команда не скопировалась')
    assert.equal(copied, await code.textContent(), 'копируется ровно команда из рамки')
    assert.ok(await waitFor(async () => /скопировано/.test((await copyBtn.textContent()) ?? ''), 2000))
    const after = [(await copyBtn.boundingBox())!.width, (await code.boundingBox())!.width]
    assert.deepEqual(after, before, '«скопировано» сдвинуло кнопку и рамку команды')
    await both('doctor')
    await h.win.keyboard.press('Escape')
    await panel.waitFor({ state: 'detached', timeout: 3000 })
  })

  it('демон недоступен: плашка и кнопка «Запустить демона», последнее состояние приглушено', async () => {
    // Сначала снимаем ходы и вопросы — дети фальшивых CLI гаснут вместе с ними, а не висят сиротами.
    for (const p of ((await c.request('perm.list', {})) as { pending: Array<{ id: string }> }).pending) {
      await c.request('perm.resolve', { id: p.id, decision: 'deny', message: 'конец демо' })
    }
    await h.win.locator('[data-testid="agent-row"][data-agent="ui-refactor"]').click()
    await h.win.locator('[data-testid="conversation"][data-agent="ui-refactor"]').getByTestId('subagent').waitFor({ timeout: 5000 })
    await c.request('agent.stop', { name: 'ui-refactor' })
    // Ход прерван: tool_result после kill не придёт — спиннер субагента обязан погаснуть сам.
    assert.ok(await waitFor(async () => (await h.win.getByTestId('subagent').first().getByTestId('subagent-state').getAttribute('data-state')) === 'stopped', 5000),
      'субагент прерванного хода всё ещё «идёт»')
    await c.request('daemon.stop', {})
    assert.ok(await waitFor(async () => (await h.win.getAttribute('.app', 'data-conn')) === 'down', 15_000), 'окно не заметило остановку демона')
    await h.win.getByTestId('conn-banner').waitFor({ timeout: 5000 })
    await h.win.locator('[data-testid="agent-row"][data-agent="ui-refactor"]').click({ force: true }).catch(() => { /* строки неактивны */ })
    // Шапка не выдаёт последнее известное за живое; ввод не зовёт печатать.
    assert.match((await h.win.locator('header.hdr').getAttribute('class')) ?? '', /hdr-stale/)
    assert.match((await h.win.getByTestId('composer').getAttribute('placeholder')) ?? '', /демон недоступен/)
    await both('daemon-down')
  })
})
