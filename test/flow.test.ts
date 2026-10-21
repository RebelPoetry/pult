// О2 «внимание», часть 2: правила уведомлений (настройки, `notifyCommand`), очередь реплик во время хода
// (`agent.prompt {queue|interrupt}`, `agent.queue.*`) и сторож тишины (`turn.stalled` → внимание `stalled`).
// Демон настоящий, claude — фальшивый (test/fakes/fake-claude.mjs), состояние — во временной папке.

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { connectClient } from '../dist/cli/client.js'
import type { Client as PultClient } from '../dist/cli/client.js'
import { defaultConfig, validateConfig } from '../dist/core/config.js'
import { createStore } from '../dist/core/store.js'
import type { PultEvent } from '../dist/core/events.js'
import { createNotifyRunner, notifyJobFor } from '../dist/daemon/notifyCommand.js'
import type { NotifyJob } from '../dist/daemon/notifyCommand.js'
import { attentionOf, isErrorKind, isRetryable, parseAttention } from '../dist/sessions/attention.js'
import type { Attention } from '../dist/sessions/attention.js'
import { parseSessions } from '../dist/sessions/registry.js'
import { startTestDaemon, tempHome, waitFor } from './helpers.js'
import type { TempHome } from './helpers.js'

const ev = (id: number, kind: string, data: Record<string, unknown> = {}, sessionId = 's'): PultEvent =>
  ({ id, ts: '2026-10-14T10:00:00.000Z', sessionId, provider: 'claude', kind: kind as PultEvent['kind'], data })

describe('настройки уведомлений и сторожа в config.json', () => {
  it('значения по умолчанию и строгий разбор', () => {
    const d = defaultConfig()
    assert.deepEqual(d.notify, { minTurnSeconds: 20, sound: true })
    assert.equal(d.notifyCommand, null)
    assert.deepEqual(d.watchdog, { silenceMinutes: 10 })

    const ok = validateConfig({ notify: { minTurnSeconds: 5, sound: false }, notifyCommand: 'curl -s x', watchdog: { silenceMinutes: 0 } })
    assert.deepEqual(ok.warnings, [])
    assert.deepEqual([ok.config.notify, ok.config.notifyCommand, ok.config.watchdog.silenceMinutes], [{ minTurnSeconds: 5, sound: false }, 'curl -s x', 0])

    const bad = validateConfig({ notify: { minTurnSeconds: -1, sound: 'yes' }, notifyCommand: 42, watchdog: { silenceMinutes: 'ten' } })
    assert.deepEqual(bad.config.notify, { minTurnSeconds: 20, sound: true })
    assert.equal(bad.config.notifyCommand, null)
    assert.equal(bad.config.watchdog.silenceMinutes, 10)
    assert.equal(bad.warnings.length, 4, bad.warnings.join('\n'))
    assert.equal(validateConfig({ notify: [] }).warnings.length, 1)
    assert.equal(validateConfig({ notifyCommand: '   ' }).config.notifyCommand, null, 'пустая команда — выключено')
    assert.deepEqual(validateConfig({ notifyCommand: null }).warnings, [])
  })
})

describe('notifyCommand: какие события и как запускается', () => {
  it('«готово» короче порога — тихо; длинное, неизвестной длины и ошибки — всегда', () => {
    const job = (e: PultEvent, min = 20): NotifyJob | null => notifyJobFor(e, attentionOf(e) as Attention, 'Починить VPN', min)
    assert.equal(job(ev(1, 'status.changed', { status: 'idle', turnId: 't1', turnMs: 3000 })), null)
    assert.deepEqual(job(ev(2, 'status.changed', { status: 'idle', turnId: 't1', turnMs: 25_000 })), { session: 's', title: 'Починить VPN', kind: 'done', text: '' })
    assert.equal(job(ev(3, 'status.changed', { status: 'idle', turnId: 't1' }))?.kind, 'done', 'длительность неизвестна — уведомляем')
    assert.equal(job(ev(4, 'status.changed', { status: 'failed', turnId: 't1', turnMs: 100, message: 'упал' }))?.text, 'упал')
    assert.equal(job(ev(5, 'turn.stalled', { turnId: 't1', silentForMs: 600_000 }))?.kind, 'stalled')
    assert.equal(job(ev(6, 'status.changed', { status: 'idle', turnId: 't1', turnMs: 3000 }), 0)?.kind, 'done', 'порог 0 — всё')
  })

  it('окружение — белый список и PULT_*; таймаут убивает всю группу; на сессию — одна команда, лишние сливаются в последнюю', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-ncmd-'))
    const home = tempHome()
    const exits: Array<{ job: NotifyJob; timedOut: boolean }> = []
    try {
      const envOut = join(dir, 'env.txt')
      const parentEnv = { HOME: dir, PATH: process.env['PATH'] ?? '/usr/bin:/bin', ANTHROPIC_API_KEY: 'sk-секрет', PULT_TOKEN: 'нельзя', HTTPS_PROXY: 'http://x' }
      const r1 = createNotifyRunner({ command: `env > '${envOut}'`, logger: home.logger, env: parentEnv, onExit: (job, res) => exits.push({ job, timedOut: res.timedOut }) })
      r1.fire({ session: 'w', title: 'Название\nс переводом', kind: 'failed', text: 'ход упал' })
      assert.ok(await waitFor(() => exits.length === 1, 5000))
      const env = Object.fromEntries(readFileSync(envOut, 'utf8').trim().split('\n').map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)] }))
      assert.equal(env['PULT_SESSION'], 'w')
      assert.equal(env['PULT_TITLE'], 'Название с переводом', 'управляющие знаки — в пробел')
      assert.equal(env['PULT_KIND'], 'failed')
      assert.equal(env['PULT_TEXT'], 'ход упал')
      assert.equal(env['HOME'], dir)
      for (const k of ['ANTHROPIC_API_KEY', 'PULT_TOKEN', 'HTTPS_PROXY']) assert.equal(env[k], undefined, `${k} не должен дойти до команды`)

      // Таймаут: `sh -c 'sleep 30; …'` убит целиком — файл-метка не появится.
      const mark = join(dir, 'late.txt')
      const r2 = createNotifyRunner({ command: `sleep 30; touch '${mark}'`, logger: home.logger, timeoutMs: 300, onExit: (job, res) => exits.push({ job, timedOut: res.timedOut }) })
      const t0 = Date.now()
      r2.fire({ session: 'slow', title: 'slow', kind: 'done', text: '' })
      assert.ok(await waitFor(() => exits.length === 2, 5000))
      assert.equal(exits[1]?.timedOut, true)
      assert.ok(Date.now() - t0 < 3000, 'команда убита по сроку, а не дождалась sleep')
      assert.equal(r2.running(), 0)

      // Одна за раз на сессию: пока идёт первая, две следующие сливаются в последнюю; другая сессия — параллельно.
      const log = join(dir, 'runs.txt')
      const r3 = createNotifyRunner({ command: `sleep 0.3; echo "$PULT_SESSION:$PULT_KIND" >> '${log}'`, logger: home.logger, onExit: (job, res) => exits.push({ job, timedOut: res.timedOut }) })
      r3.fire({ session: 'a', title: 'a', kind: 'done', text: '' })
      r3.fire({ session: 'a', title: 'a', kind: 'ask', text: '' })
      r3.fire({ session: 'a', title: 'a', kind: 'failed', text: '' })
      r3.fire({ session: 'b', title: 'b', kind: 'done', text: '' })
      assert.equal(r3.running(), 2)
      assert.ok(await waitFor(() => exits.length === 5, 5000))
      assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').sort(), ['a:done', 'a:failed', 'b:done'])
      r1.close(); r2.close(); r3.close()
    } finally { home.remove(); rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('сторож тишины → внимание «завис»', () => {
  it('turn.stalled — ошибка, но не «Повторить»; разбор чужого ответа знает новый вид', () => {
    const a = attentionOf(ev(7, 'turn.stalled', { turnId: 't3', silentForMs: 600_000 }))
    assert.deepEqual(a, { id: 7, kind: 'stalled', at: '2026-10-14T10:00:00.000Z', text: 'ход молчит 10 мин', turnId: 't3' })
    assert.equal(isErrorKind(a), true)
    assert.equal(isRetryable(a), false, 'ход ещё идёт — повторять нечего')
    assert.equal(parseAttention({ id: 1, kind: 'stalled', at: '' })?.kind, 'stalled')
  })

  it('ход молчит дольше порога — одно событие на ход; ход не обрывается сам; стоп снимает', async () => {
    const home = tempHome()
    home.config.watchdog.silenceMinutes = 0.005 // 300 мс
    const cwd = mkdtempSync(join(tmpdir(), 'pt-wd-'))
    writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({ scenario: 'simple', speed: 0, hang: 60_000 }))
    const d = await startTestDaemon(home)
    const c = await connectClient(home.paths)
    try {
      await c.request('agent.start', { name: 'z', kind: 'claude', cwd })
      await c.request('agent.prompt', { name: 'z', text: 'думай' })
      const stalls = async (): Promise<PultEvent[]> => (await events(c, 'z')).filter((e) => e.kind === 'turn.stalled')
      assert.ok(await waitFor(async () => (await stalls()).length > 0, 5000), 'turn.stalled не пришёл')
      await new Promise((r) => setTimeout(r, 1200))
      const got = await stalls()
      assert.equal(got.length, 1, 'одно событие на ход')
      assert.equal(typeof got[0]?.data['turnId'], 'string')
      assert.ok((got[0]?.data['silentForMs'] as number) >= 300)
      const rec = await record(c, 'z')
      assert.equal(rec['lastStatus'], 'working', 'сторож ход не обрывает')
      assert.equal((rec['attention'] as Attention).kind, 'stalled')
      await assert.rejects(c.request('agent.retry', { name: 'z' }), (e: { code?: string }) => e.code === 'invalid_params')
      await c.request('agent.stop', { name: 'z' })
      assert.equal((await record(c, 'z'))['lastStatus'], 'interrupted')
    } finally { c.close(); await d.stop('конец теста'); home.remove(); rmSync(cwd, { recursive: true, force: true }) }
  })
})

async function events(c: PultClient, name: string): Promise<PultEvent[]> {
  return ((await c.request('agent.read', { name, format: 'json' })) as { events: PultEvent[] }).events
}
async function record(c: PultClient, name: string): Promise<Record<string, unknown>> {
  return ((await c.request('agent.list')) as { sessions: Array<Record<string, unknown>> }).sessions.find((s) => s['name'] === name)!
}
const userTexts = async (c: PultClient, name: string): Promise<string[]> =>
  (await events(c, name)).filter((e) => e.kind === 'message.user').map((e) => String(e.data['text']))
const queueOf = async (c: PultClient, name: string): Promise<{ texts: string[]; ids: string[]; paused: boolean }> => {
  const r = await record(c, name)
  const q = (r['queue'] as Array<{ id: string; text: string }> | undefined) ?? []
  return { texts: q.map((x) => x.text), ids: q.map((x) => x.id), paused: r['queuePaused'] === true }
}
const code = (want: string) => (e: { code?: string }): boolean => e.code === want

/** Демон и сессия `q`, у которой каждый ход висит `hang` мс до первого события. */
async function rig(hang: number, home: TempHome = tempHome()): Promise<{ home: TempHome; cwd: string; d: Awaited<ReturnType<typeof startTestDaemon>>; c: PultClient }> {
  const cwd = mkdtempSync(join(tmpdir(), 'pt-q-'))
  writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({ scenario: 'simple', speed: 0, hang }))
  const d = await startTestDaemon(home)
  const c = await connectClient(home.paths)
  await c.request('agent.start', { name: 'q', kind: 'claude', cwd })
  return { home, cwd, d, c }
}

describe('очередь реплик во время хода', () => {
  it('занято — в очередь; порядок, ×, ↑↓; ход кончился — следующая уходит сама, ни одна дважды', async () => {
    const { home, cwd, d, c } = await rig(700)
    try {
      await assert.rejects(c.request('agent.prompt', { name: 'q', text: 'x', queue: true, interrupt: true }), code('invalid_params'))
      const first = (await c.request('agent.prompt', { name: 'q', text: 'раз', queue: true })) as Record<string, unknown>
      assert.equal(typeof first['turnId'], 'string', 'свободна — уходит сразу')
      const two = (await c.request('agent.prompt', { name: 'q', text: 'два', queue: true })) as { queued: boolean; id: string }
      const three = (await c.request('agent.prompt', { name: 'q', text: 'три'.repeat(100), queue: true })) as { queued: boolean; id: string }
      assert.equal(two.queued, true)
      let q = await queueOf(c, 'q')
      assert.equal(q.texts[0], 'два')
      assert.equal([...(q.texts[1] ?? '')].length, 200, 'в списке — превью')
      assert.ok(q.texts[1]?.endsWith('…'))
      // Без queue занятая сессия по-прежнему отказывает.
      await assert.rejects(c.request('agent.prompt', { name: 'q', text: 'мимо' }), code('invalid_params'))

      const moved = (await c.request('agent.queue.move', { name: 'q', id: three.id, to: 0 })) as { queue: Array<{ id: string }> }
      assert.deepEqual(moved.queue.map((x) => x.id), [three.id, two.id])
      await c.request('agent.queue.move', { name: 'q', id: three.id, to: 99 })
      assert.deepEqual((await queueOf(c, 'q')).ids, [two.id, three.id], 'за краем — к краю')
      await c.request('agent.queue.remove', { name: 'q', id: three.id })
      await c.request('agent.prompt', { name: 'q', text: 'четыре', queue: true })
      await assert.rejects(c.request('agent.queue.remove', { name: 'q', id: 'nope' }), code('not_found'))
      await assert.rejects(c.request('agent.queue.move', { name: 'q', id: two.id, to: 1.5 }), code('invalid_params'))
      await assert.rejects(c.request('agent.queue.resume', { name: 'nope' }), code('not_found'))

      assert.ok(await waitFor(async () => {
        const r = await record(c, 'q')
        return r['lastStatus'] === 'idle' && !r['queue'] && (await userTexts(c, 'q')).length === 3
      }, 15_000), JSON.stringify(await userTexts(c, 'q')))
      await new Promise((r) => setTimeout(r, 300))
      assert.deepEqual(await userTexts(c, 'q'), ['раз', 'два', 'четыре'])
      const turns = (await events(c, 'q')).filter((e) => e.kind === 'status.changed' && e.data['status'] === 'idle' && e.data['turnId'])
      assert.equal(turns.length, 3, 'три хода — по одному на реплику')
      assert.ok(turns.every((e) => typeof e.data['turnMs'] === 'number' && (e.data['turnMs'] as number) >= 500), 'длительность хода — в событии')
    } finally { c.close(); await d.stop('конец теста'); home.remove(); rmSync(cwd, { recursive: true, force: true }) }
  })

  it('ход упал — очередь стоит до «Продолжить»; прерванный — тоже; «прервать и сказать» уходит сразу', async () => {
    const { home, cwd, d, c } = await rig(700)
    try {
      await c.request('agent.prompt', { name: 'q', text: 'упади [[not-logged-in]]' })
      await c.request('agent.prompt', { name: 'q', text: 'после падения', queue: true })
      assert.ok(await waitFor(async () => (await queueOf(c, 'q')).paused, 10_000), 'очередь не встала после падения')
      await new Promise((r) => setTimeout(r, 400))
      assert.deepEqual(await userTexts(c, 'q'), ['упади [[not-logged-in]]'], 'стоящая очередь сама не уходит')

      // Прямая реплика при стоящей очереди проходит, очередь так и стоит.
      await c.request('agent.prompt', { name: 'q', text: 'прямо', queue: true })
      // «Прервать и сказать»: стоп «прямо», сразу — «вместо».
      const said = (await c.request('agent.prompt', { name: 'q', text: 'вместо', interrupt: true })) as Record<string, unknown>
      assert.equal(typeof said['turnId'], 'string')
      const evs = await events(c, 'q')
      assert.ok(evs.some((e) => e.kind === 'status.changed' && e.data['status'] === 'interrupted'), 'ход прерван')
      await c.request('agent.wait', { name: 'q', until: ['idle'], timeoutMs: 20_000 })
      await new Promise((r) => setTimeout(r, 300))
      assert.deepEqual(await userTexts(c, 'q'), ['упади [[not-logged-in]]', 'прямо', 'вместо'])
      assert.deepEqual(await queueOf(c, 'q'), { texts: ['после падения'], ids: (await queueOf(c, 'q')).ids, paused: true })

      const resumed = (await c.request('agent.queue.resume', { name: 'q' })) as { queuePaused: boolean }
      assert.equal(resumed.queuePaused, false)
      assert.ok(await waitFor(async () => (await userTexts(c, 'q')).length === 4, 10_000))
      await c.request('agent.wait', { name: 'q', until: ['idle'], timeoutMs: 20_000 })
      assert.deepEqual((await userTexts(c, 'q')).at(-1), 'после падения')
      assert.equal((await record(c, 'q'))['queue'], undefined)
      // Пустая очередь и «Продолжить» — без вреда.
      assert.equal(((await c.request('agent.queue.resume', { name: 'q' })) as { queue: unknown[] }).queue.length, 0)
    } finally { c.close(); await d.stop('конец теста'); home.remove(); rmSync(cwd, { recursive: true, force: true }) }
  })

  it('очередь переживает рестарт демона и стоит; после «Продолжить» уходит ровно один раз', async () => {
    const home = tempHome()
    const first = await rig(5000, home)
    try {
      await first.c.request('agent.prompt', { name: 'q', text: 'долгий' })
      await first.c.request('agent.prompt', { name: 'q', text: 'потом', queue: true })
      // Реестр на диске уже знает очередь — до остановки демона.
      const onDisk = parseSessions(JSON.parse(readFileSync(home.paths.sessions, 'utf8'))).find((r) => r.name === 'q')
      assert.deepEqual(onDisk?.queue?.map((x) => x.text), ['потом'])
    } finally { first.c.close(); await first.d.stop('рестарт в тесте') }
    writeFileSync(join(first.cwd, '.pult-fake.json'), JSON.stringify({ scenario: 'simple', speed: 0 }))
    const d = await startTestDaemon(home)
    const c = await connectClient(home.paths)
    try {
      const q = await queueOf(c, 'q')
      assert.deepEqual([q.texts, q.paused], [['потом'], true], 'ход умер с демоном — очередь стоит')
      await new Promise((r) => setTimeout(r, 400))
      assert.deepEqual(await userTexts(c, 'q'), ['долгий'], 'после рестарта ничего не ушло само')
      await c.request('agent.queue.resume', { name: 'q' })
      assert.ok(await waitFor(async () => (await userTexts(c, 'q')).length === 2, 10_000))
      await c.request('agent.wait', { name: 'q', until: ['idle'], timeoutMs: 20_000 })
      await new Promise((r) => setTimeout(r, 300))
      assert.deepEqual(await userTexts(c, 'q'), ['долгий', 'потом'])
      assert.equal((await record(c, 'q'))['queue'], undefined)
    } finally { c.close(); await d.stop('конец теста'); home.remove(); rmSync(first.cwd, { recursive: true, force: true }) }
  })

  it('daemon.status отдаёт правила уведомлений окну, но не команду', async () => {
    const home = tempHome()
    home.config.notify = { minTurnSeconds: 7, sound: false }
    home.config.notifyCommand = 'echo секрет'
    const d = await startTestDaemon(home)
    const c = await connectClient(home.paths)
    try {
      const st = (await c.request('daemon.status')) as Record<string, unknown>
      assert.deepEqual(st['notify'], { minTurnSeconds: 7, sound: false })
      assert.ok(!JSON.stringify(st).includes('секрет'))
    } finally { c.close(); await d.stop('конец теста'); home.remove() }
  })

  it('notifyCommand демона: конец хода зовёт команду с PULT_*', async () => {
    const home = tempHome()
    const out = join(mkdtempSync(join(tmpdir(), 'pt-nd-')), 'calls.txt')
    home.config.notify.minTurnSeconds = 0
    home.config.notifyCommand = `echo "$PULT_SESSION|$PULT_KIND|$PULT_TITLE" >> '${out}'`
    const { cwd, d, c } = await rig(0, home)
    try {
      await c.request('agent.rename', { name: 'q', title: 'Очередь' })
      await c.request('agent.prompt', { name: 'q', text: 'привет' })
      await c.request('agent.wait', { name: 'q', until: ['idle'], timeoutMs: 20_000 })
      assert.ok(await waitFor(() => { try { return readFileSync(out, 'utf8').includes('q|done|Очередь') } catch { return false } }, 5000))
    } finally { c.close(); await d.stop('конец теста'); home.remove(); rmSync(cwd, { recursive: true, force: true }); rmSync(join(out, '..'), { recursive: true, force: true }) }
  })
})

describe('ревью M4: пауза, будильник очереди, пределы', () => {
  it('служебный idle очередь не будит; фоновый провал и стоп ставят паузу; объём очереди ограничен; стоп чужого хода — no-op', async () => {
    const { home, cwd, d, c } = await rig(0)
    // Через менеджер демона (а не `events.emit`, который пишет мимо свёртки статусов): как пишет адаптер.
    const fake = async (data: Record<string, unknown>): Promise<void> => {
      d.manager.emit({ sessionId: 'q', provider: 'claude', kind: 'status.changed', data })
    }
    try {
      // Фоновый ход «идёт» (подделан) — реплика в очередь.
      await fake({ status: 'working', reason: 'background_turn' })
      await c.request('agent.prompt', { name: 'q', text: 'x', queue: true })
      await fake({ status: 'idle', reason: 'background_process_exit' })
      await new Promise((r) => setTimeout(r, 300))
      assert.deepEqual([await userTexts(c, 'q'), (await queueOf(c, 'q')).texts], [[], ['x']], 'служебный idle — не конец хода')
      // Фоновый ход упал — пауза, хотя исхода хода у менеджера нет.
      await fake({ status: 'working', reason: 'background_turn' })
      await fake({ status: 'failed', reason: 'background_turn_done' })
      assert.equal((await queueOf(c, 'q')).paused, true)
      await c.request('agent.queue.resume', { name: 'q' })
      assert.ok(await waitFor(async () => (await userTexts(c, 'q')).includes('x'), 10_000))
      await c.request('agent.wait', { name: 'q', until: ['idle'], timeoutMs: 20_000 })

      // Объём: 50 000 знаков кириллицы — 100 КБ; третья такая — больше 256 КБ.
      await fake({ status: 'working', reason: 'background_turn' })
      const big = 'я'.repeat(50_000)
      await c.request('agent.prompt', { name: 'q', text: big, queue: true })
      await c.request('agent.prompt', { name: 'q', text: big, queue: true })
      await assert.rejects(c.request('agent.prompt', { name: 'q', text: big, queue: true }),
        (e: { code?: string; message?: string }) => e.code === 'invalid_params' && /256 КБ/.test(e.message ?? ''))
      // Стоп ставит очередь на паузу; стоп «того хода», которого нет, — ничего не делает.
      assert.deepEqual(await c.request('agent.stop', { name: 'q', turnId: 'нет-такого' }), { stopped: false })
      assert.equal((await queueOf(c, 'q')).paused, false)
      assert.deepEqual(await c.request('agent.stop', { name: 'q' }), { stopped: true })
      assert.equal((await queueOf(c, 'q')).paused, true)
      assert.equal((await userTexts(c, 'q')).length, 1, 'после стопа ничего не ушло')
    } finally { c.close(); await d.stop('конец теста'); home.remove(); rmSync(cwd, { recursive: true, force: true }) }
  })

  it('«завис» гаснет в хранилище на конце хода', () => {
    const home = tempHome()
    try {
      const st = createStore(home.paths)
      st.append({ sessionId: 'z', provider: 'claude', kind: 'turn.stalled', data: { turnId: 't1', silentForMs: 600_000 } })
      assert.equal(st.attention('z')?.kind, 'stalled')
      st.append({ sessionId: 'z', provider: 'claude', kind: 'status.changed', data: { status: 'interrupted' } })
      assert.equal(st.attention('z'), null, 'стоп хода — карточка «завис» не висит')
      st.close()
    } finally { home.remove() }
  })

  it('notifyCommand: пока идёт команда, «готово» не вытесняет ждущую ошибку', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-nprio-'))
    const home = tempHome()
    try {
      const log = join(dir, 'runs.txt')
      let exits = 0
      const r = createNotifyRunner({ command: `sleep 0.2; echo "$PULT_KIND" >> '${log}'`, logger: home.logger, onExit: () => { exits++ } })
      r.fire({ session: 'a', title: 'a', kind: 'done', text: '' })
      r.fire({ session: 'a', title: 'a', kind: 'failed', text: '' })
      r.fire({ session: 'a', title: 'a', kind: 'done', text: '' })
      assert.ok(await waitFor(() => exits === 2, 5000))
      assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['done', 'failed'])
      r.close()
    } finally { home.remove(); rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('ход, прерванный сервером (codex)', () => {
  it('сервер прервал ход сам — статус interrupted (provider_interrupted), а не вечный working', async () => {
    const home = tempHome()
    const cwd = mkdtempSync(join(tmpdir(), 'pt-si-'))
    const d = await startTestDaemon(home)
    const c = await connectClient(home.paths)
    try {
      await c.request('agent.start', { name: 'x', kind: 'codex', cwd })
      await c.request('agent.prompt', { name: 'x', text: 'привет [[server-interrupt]]' })
      assert.ok(await waitFor(async () => (await events(c, 'x')).some((e) =>
        e.kind === 'status.changed' && e.data['status'] === 'interrupted' && e.data['reason'] === 'provider_interrupted'), 10_000),
      'нет interrupted от сервера')
      assert.equal((await record(c, 'x'))['lastStatus'], 'interrupted', 'статус застрял')
    } finally { c.close(); await d.stop('конец теста'); home.remove(); rmSync(cwd, { recursive: true, force: true }) }
  })
})
