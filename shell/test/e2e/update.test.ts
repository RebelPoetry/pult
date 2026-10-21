// e2e M8c, канал обновлений в окне: версия окна видна интерфейсу через user agent Electron; демон с
// тестовым «релизом» (PULT_TEST_UPDATE_DIR, свой ключ) сразу находит 9.9.9 — плашка «Доступна 9.9.9 ·
// Что нового · Обновить». «Обновить» доходит до демона через мост и запускает НАСТОЯЩИЙ отсоединённый
// `pult update`; тарбола в «релизе» нет, он выходит с кодом 1 — плашка «Обновление не удалось», демон
// и окно на месте.

import assert from 'node:assert/strict'
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { launch, SHELL_DIR, waitFor } from './harness.js'
import type { Harness } from './harness.js'

const SHELL_VERSION = (JSON.parse(readFileSync(path.join(SHELL_DIR, 'package.json'), 'utf8')) as { version: string }).version

/** Подписанный latest.json — формат src/update/manifest.ts, собранный здесь руками, без кода пакета. */
function release(dir: string): string {
  const { privateKey } = generateKeyPairSync('ed25519')
  const raw = Buffer.from((createPublicKey(privateKey).export({ format: 'jwk' }) as { x: string }).x, 'base64url')
  const manifest = Buffer.from(JSON.stringify({
    schema: 1, version: '9.9.9', released: '2026-10-19T10:00:00.000Z',
    notes: 'https://github.com/pawellazarew/pult/releases/tag/v9.9.9',
    package: { url: 'https://example.invalid/v9.9.9/pult-9.9.9.tgz', sha256: 'e'.repeat(64), size: 100 },
    app: { version: SHELL_VERSION, minVersion: '0.1.13' },
  }))
  writeFileSync(path.join(dir, 'latest.json'), JSON.stringify({
    schema: 1,
    keyId: createHash('sha256').update(raw).digest('hex').slice(0, 8),
    payload: manifest.toString('base64'),
    signature: sign(null, manifest, privateKey).toString('base64'),
  }))
  return raw.toString('base64')
}

describe('окно: плашка обновления', () => {
  let h: Harness
  let rel = ''

  before(async () => {
    rel = mkdtempSync(path.join(tmpdir(), 'pe-rel-'))
    const pub = release(rel)
    h = await launch({
      name: 'update',
      env: {
        PULT_UPDATE_URL: 'https://example.invalid/latest.json',
        PULT_TEST_UPDATE_DIR: rel,
        PULT_TEST_RELEASE_KEY: pub,
        PULT_TEST_UPDATE_FIRST_MS: '0',
      },
    })
    assert.ok(await waitFor(async () => (await h.win.getAttribute('.app', 'data-conn')) === 'up', 20_000), 'окно не подключилось')
  })
  after(async () => {
    await h?.close()
    rmSync(rel, { recursive: true, force: true })
  })

  it('user agent окна несёт его версию — по ней интерфейс сверяет app.minVersion', async () => {
    const ua = await h.win.evaluate(() => navigator.userAgent)
    assert.match(ua, new RegExp(`(?:^|\\s)(?:Pult|pult-shell)/${SHELL_VERSION.replace(/\./g, '\\.')}(?:\\s|$)`), ua)
  })

  it('демон нашёл 9.9.9 — «Доступна 9.9.9 · Что нового · Обновить»; update.status через мост', async () => {
    const st = (await h.win.evaluate(() => window.pult!.call('update.status'))) as { latest: { version: string } | null; available: boolean }
    assert.equal(st.latest?.version, '9.9.9')
    assert.equal(st.available, true)
    const banner = h.win.getByTestId('update-available')
    await banner.waitFor({ timeout: 20_000 })
    assert.match(await banner.innerText(), /Доступна 9\.9\.9/)
    await h.win.getByTestId('update-notes').waitFor({ timeout: 2000 })
    await h.shot('available')
  })

  it('«Обновить» запускает настоящий pult update; тарбола нет — «не удалось», демон прежний', async () => {
    const pid = h.daemonPid()
    await h.win.getByTestId('update-apply').click()
    const c = await h.client()
    assert.ok(await waitFor(async () => ((await c.request('update.status')) as { apply: { state: string } }).apply.state === 'failed', 30_000), 'pult update не завершился провалом')
    const st = (await c.request('update.status')) as { apply: { state: string; error?: string } }
    assert.match(st.apply.error ?? '', /с кодом 1 — подробности: .*update\.log/)
    assert.match(readFileSync(path.join(h.home, 'logs', 'update.log'), 'utf8'), /ответил HTTP 404/)
    assert.equal(h.daemonPid(), pid, 'демон не должен был перезапуститься')
    // Плашка обновится по опросу статуса окна (раз в 15 с).
    await h.win.getByTestId('update-failed').waitFor({ timeout: 25_000 })
    await h.shot('failed')
  })
})

describe('окно: пока ставится обновление, реплика не уходит, а черновик остаётся', () => {
  let h: Harness
  let rel = ''

  before(async () => {
    rel = mkdtempSync(path.join(tmpdir(), 'pe-rel-'))
    const pub = release(rel)
    h = await launch({
      name: 'update-hold',
      env: {
        PULT_UPDATE_URL: 'https://example.invalid/latest.json',
        PULT_TEST_UPDATE_DIR: rel,
        PULT_TEST_RELEASE_KEY: pub,
        PULT_TEST_UPDATE_FIRST_MS: '0',
        // `pult update` «качает» 8 с: окно застаёт состояние «ставится».
        PULT_TEST_UPDATE_HOLD_MS: '8000',
      },
    })
    assert.ok(await waitFor(async () => (await h.win.getAttribute('.app', 'data-conn')) === 'up', 20_000), 'окно не подключилось')
  })
  after(async () => {
    await h?.close()
    rmSync(rel, { recursive: true, force: true })
  })

  it('«Обновить» → «Обновляю…»; Enter в поле — отказ «Пульт обновляется», текст в поле на месте', async () => {
    const c = await h.client()
    await c.request('agent.start', { name: 'w', kind: 'claude', cwd: h.workDir('w') })
    await h.win.locator('[data-testid="agent-row"][data-agent="w"]').click()
    await h.win.locator('[data-testid="conversation"][data-agent="w"]').waitFor({ timeout: 10_000 })
    await h.win.getByTestId('update-apply').click({ timeout: 20_000 })
    const banner = h.win.getByTestId('update-applying')
    await banner.waitFor({ timeout: 10_000 })
    assert.match(await banner.innerText(), /Обновляю до 9\.9\.9…/)
    const box = h.win.getByTestId('composer')
    await box.fill('мой черновик')
    // M8e: поле чистится сразу по Enter, отказ возвращает черновик (поле пустое). Пишем каждое значение, которое
    // React кладёт в поле, — сквозь его же счётчик значения на элементе (иначе onChange перестал бы видеть ввод).
    await box.evaluate((el) => {
      const own = Object.getOwnPropertyDescriptor(el, 'value') ?? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
      const log: string[] = []
      ;(window as unknown as { __composerSets: string[] }).__composerSets = log
      Object.defineProperty(el, 'value', {
        configurable: true,
        get() { return own?.get?.call(this) as string },
        set(v: string) { log.push(String(v)); own?.set?.call(this, v) },
      })
    })
    await box.press('Enter')
    const err = h.win.getByTestId('send-error')
    await err.waitFor({ timeout: 10_000 })
    assert.match(await err.innerText(), /Пульт обновляется — отправь после перезапуска/)
    assert.equal(await box.inputValue(), 'мой черновик')
    const sets = await h.win.evaluate(() => (window as unknown as { __composerSets: string[] }).__composerSets.slice())
    assert.deepEqual(sets.slice(-2), ['', 'мой черновик'], `поле не очистилось и не вернулось: ${JSON.stringify(sets)}`)
    assert.equal(await h.win.getByTestId('msg-user-pending').count(), 0, 'пузырь «отправляется…» остался после отказа')
    const tail = (await c.request('events.tail', { since: 0, sessionId: 'w' })) as { events: Array<{ kind: string }> }
    assert.equal(tail.events.filter((e) => e.kind === 'message.user').length, 0, 'реплика ушла в журнал')
    await h.shot('applying')
    // Дождаться конца ребёнка (тарбола нет — код 1), чтобы он не писал в дом теста после его удаления.
    assert.ok(await waitFor(async () => ((await c.request('update.status')) as { apply: { state: string } }).apply.state === 'failed', 30_000))
  })
})
