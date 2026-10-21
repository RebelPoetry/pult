// Меню сессии (07.10.2026): архив и автоназвание по первой реплике. Модуль названия — без CLI
// (запуск подставляется), архив и название — через настоящий демон с фальшивым claude.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { connectClient } from '../dist/cli/client.js'
import { claudeTitleArgs, cleanModelTitle, createAutoTitler, fallbackTitle } from '../dist/sessions/autotitle.js'
import { parseSessions } from '../dist/sessions/registry.js'
import { startTestDaemon, tempHome, waitFor } from './helpers.js'

const ok = (result: string) => ({ status: 0, stdout: JSON.stringify({ type: 'result', is_error: false, result }), stderr: '' })

describe('автоназвание: модуль', () => {
  it('название из первых слов: первая содержательная строка, до 6 слов, без хвостовой пунктуации', () => {
    assert.equal(fallbackTitle('# Почини падающий тест в шапке лимитов, пожалуйста срочно\nподробности'), 'Почини падающий тест в шапке лимитов')
    assert.equal(fallbackTitle('\n\n  > Сделай ревью.  \n'), 'Сделай ревью')
    assert.equal(fallbackTitle('   '), null)
  })
  it('ответ модели: первая строка, без кавычек и точки; мусор и простыни — не название', () => {
    assert.equal(cleanModelTitle('«Фикс шапки лимита».\n'), 'Фикс шапки лимита')
    assert.equal(cleanModelTitle('"Review PR 42"'), 'Review PR 42')
    assert.equal(cleanModelTitle(''), null)
    assert.equal(cleanModelTitle('это очень длинный ответ модели который явно не похож на короткое название сессии'), null)
  })
  it('запрос: haiku, свой системный промпт, без инструментов, настроек и записи сессии', () => {
    const a = claudeTitleArgs('Задача X')
    for (const f of ['-p', '--system-prompt', '--no-session-persistence']) assert.ok(a.includes(f), f)
    assert.deepEqual(a.slice(a.indexOf('--model'), a.indexOf('--model') + 2), ['--model', 'haiku'])
    assert.equal(a[a.indexOf('--tools') + 1], '')
    assert.equal(a[a.indexOf('--setting-sources') + 1], '')
    assert.equal(a.at(-1), 'Задача: Задача X')
  })
  it('ответ модели годен — он; страж не пустил, ошибка CLI или мусор — первые слова', async () => {
    const env = async (): Promise<Record<string, string> | null> => ({ HOME: '/srv/h' })
    const t = (run: Parameters<typeof createAutoTitler>[0]['run'], e = env) => createAutoTitler({ bin: 'claude', cwd: '/srv/h', env: e, run })
    assert.equal(await t(async () => ok('Фикс шапки лимита'))('Почини шапку'), 'Фикс шапки лимита')
    let called = false
    assert.equal(await t(async () => { called = true; return ok('x') }, async () => null)('Почини шапку лимитов'), 'Почини шапку лимитов')
    assert.equal(called, false, 'страж не пустил — в сеть не ходим')
    assert.equal(await t(async () => ({ status: 1, stdout: '', stderr: 'boom' }))('Почини шапку'), 'Почини шапку')
    assert.equal(await t(async () => ({ status: 0, stdout: 'не json', stderr: '' }))('Почини шапку'), 'Почини шапку')
  })
})

describe('реестр: архив и флаг автоназвания', () => {
  it('поля читаются только как true; мусор — нет поля', () => {
    const [a, b] = parseSessions({ sessions: [
      { name: 'a', provider: 'claude', cwd: '/srv/a', archived: true, autoTitled: true },
      { name: 'b', provider: 'claude', cwd: '/srv/b', archived: 'yes', autoTitled: 1 },
    ] })
    assert.equal(a?.archived, true)
    assert.equal(a?.autoTitled, true)
    assert.equal(b?.archived, undefined)
    assert.equal(b?.autoTitled, undefined)
  })
})

describe('демон: архив и автоназвание', () => {
  it('первая реплика даёт название один раз; ручное не перетирается; архив — пометка, реплика возвращает', async () => {
    const home = tempHome()
    const cwd = mkdtempSync(join(tmpdir(), 'pt-menu-'))
    writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({ scenario: 'simple', speed: 0 }))
    const asked: string[] = []
    const d = await startTestDaemon(home, { titler: async (text) => { asked.push(text); return 'Короткое название' } })
    const c = await connectClient(home.paths)
    const rec = async (name: string): Promise<Record<string, unknown>> =>
      ((await c.request('agent.list')) as { sessions: Array<Record<string, unknown>> }).sessions.find((s) => s['name'] === name)!
    try {
      await c.request('agent.start', { name: 'w', kind: 'claude', cwd })
      await c.request('agent.prompt', { name: 'w', text: 'Почини падающий тест' })
      assert.ok(await waitFor(async () => (await rec('w'))['title'] === 'Короткое название', 10_000), 'название не появилось')
      assert.equal((await rec('w'))['autoTitled'], true)
      await c.request('agent.wait', { name: 'w', until: ['idle'], timeoutMs: 20_000 })
      await c.request('agent.rename', { name: 'w', title: '' })
      await c.request('agent.prompt', { name: 'w', text: 'Ещё реплика' })
      await c.request('agent.wait', { name: 'w', until: ['idle'], timeoutMs: 20_000 })
      assert.deepEqual(asked, ['Почини падающий тест'], 'название спрашивается один раз')
      assert.equal((await rec('w'))['title'], undefined, 'стёртое руками название не возвращается')

      // Ручное название до первой реплики — автоназвание его не трогает.
      await c.request('agent.start', { name: 'm', kind: 'claude', cwd, title: 'Моё' })
      await c.request('agent.prompt', { name: 'm', text: 'Сделай что-нибудь' })
      await c.request('agent.wait', { name: 'm', until: ['idle'], timeoutMs: 20_000 })
      assert.equal((await rec('m'))['title'], 'Моё')
      assert.equal(asked.length, 1)

      // Архив: пометка туда и обратно; реплика в архивную сессию возвращает её.
      assert.equal(((await c.request('agent.archive', { name: 'm', archived: true })) as Record<string, unknown>)['archived'], true)
      assert.equal((await rec('m'))['archived'], true)
      await assert.rejects(c.request('agent.archive', { name: 'm' }), (e: { code?: string }) => e.code === 'invalid_params')
      await c.request('agent.prompt', { name: 'm', text: 'Вернись' })
      assert.equal((await rec('m'))['archived'], undefined, 'реплика возвращает из архива')
      await c.request('agent.wait', { name: 'm', until: ['idle'], timeoutMs: 20_000 })
    } finally { c.close(); await d.stop('конец теста'); home.remove(); rmSync(cwd, { recursive: true, force: true }) }
  })
})
