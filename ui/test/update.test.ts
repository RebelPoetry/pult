// Плашка обновления (M8c): состояния по `daemon.status.update` и версии окна — модель и разметка.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { UpdateBanner } from '../src/components/UpdateBanner.js'
import { addDismissed, applyErrorText, DISMISSED_MAX, updateBanner, windowVersionFromUA } from '../src/model/update.js'
import type { UpdateStatus } from '../../src/core/rpc.js'

const text = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const noop = (): void => {}

const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  enabled: true,
  current: '0.2.27',
  checking: false,
  checkedAt: '2026-10-19T10:00:00Z',
  error: null,
  latest: {
    version: '1.0.3', released: '2026-10-19T09:00:00Z',
    notes: 'https://github.com/pawellazarew/pult/releases/tag/v1.0.3',
    app: { version: '0.2.0', minVersion: '0.1.13' },
  },
  available: true,
  bad: false,
  apply: { state: 'idle' },
  failure: null,
  ...over,
})

const render = (u: UpdateStatus | null, win: string | null = '0.1.14', dismissed: string[] = []): string =>
  renderToStaticMarkup(createElement(UpdateBanner, { view: updateBanner(u, win, dismissed), busy: false, onAction: noop, onNotes: noop, onDismiss: noop }))

describe('версия окна из user agent Electron', () => {
  it('Pult.app и рабочая копия; чужой UA — null', () => {
    const base = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)'
    assert.equal(windowVersionFromUA(`${base} Pult/0.1.14 Chrome/140.0.0.0 Electron/44.4.5 Safari/537.36`), '0.1.14')
    assert.equal(windowVersionFromUA(`${base} pult-shell/0.1.14 Chrome/140.0.0.0 Electron/44.4.5 Safari/537.36`), '0.1.14')
    assert.equal(windowVersionFromUA(`${base} Chrome/140.0.0.0 Safari/537.36`), null)
    assert.equal(windowVersionFromUA(`${base} NotPult/9.9.9 Chrome/1`), null)
    assert.equal(windowVersionFromUA(undefined), null)
  })
})

describe('плашка обновления: состояния', () => {
  it('доступна — «Доступна 1.0.3 · Что нового · Обновить», можно скрыть', () => {
    const out = render(status())
    assert.match(out, /data-testid="update-available"/)
    assert.equal(text(out), 'Доступна 1.0.3 Что нового Обновить')
    assert.match(out, /data-testid="update-dismiss"/)
    assert.match(out, /role="status"/)
  })

  it('нечего ставить, bad, нет статуса, скрыта крестиком — плашки нет', () => {
    assert.equal(render(status({ available: false })), '')
    assert.equal(render(status({ available: false, bad: true })), '')
    assert.equal(render(null), '')
    assert.equal(render(status(), '0.1.14', ['1.0.3']), '')
    // Скрыта прошлая версия — новая снова видна.
    assert.match(render(status(), '0.1.14', ['1.0.2']), /Доступна 1\.0\.3/)
  })

  it('ходы идут — «Обновлю после окончания ходов (N идут) · Сейчас»', () => {
    const out = render(status({ apply: { state: 'waiting', turns: 2, since: '2026-10-19T10:00:00Z', to: '1.0.3' } }))
    assert.match(out, /data-testid="update-waiting"/)
    assert.match(text(out), /Обновлю до 1\.0\.3 после окончания ходов \(2 идут\)/)
    assert.match(text(out), /Сейчас/)
    assert.doesNotMatch(out, /update-dismiss/)
    assert.match(text(render(status({ apply: { state: 'waiting', turns: 1, since: 'x', to: '1.0.3' } }))), /\(1 идёт\)/)
    assert.match(text(render(status({ apply: { state: 'waiting', turns: 21, since: 'x', to: '1.0.3' } }))), /\(21 идёт\)/)
    assert.match(text(render(status({ apply: { state: 'waiting', turns: 11, since: 'x', to: '1.0.3' } }))), /\(11 идут\)/)
    // «Сейчас» — это force.
    assert.deepEqual(updateBanner(status({ apply: { state: 'waiting', turns: 2, since: 'x', to: '1.0.3' } }), null)?.action, { label: 'Сейчас', force: true })
  })

  it('ставится — без кнопок; не удалось — причина и «Повторить»', () => {
    const applying = render(status({ apply: { state: 'applying', since: 'x', to: '1.0.3' } }))
    assert.match(text(applying), /Обновляю до 1\.0\.3… Демон перезапустится, окно переподключится само; новые реплики — после перезапуска/)
    assert.doesNotMatch(applying, /data-testid="update-apply"/)
    const failed = render(status({ apply: { state: 'failed', at: 'x', error: 'pult update вышел с кодом 1' } }))
    assert.match(failed, /data-testid="update-failed"/)
    assert.match(text(failed), /Обновление не удалось: pult update вышел с кодом 1/)
    assert.match(text(failed), /Повторить/)
    // Скрытая версия не прячет провал: его человек запустил сам.
    assert.match(render(status({ apply: { state: 'failed', at: 'x', error: 'e' } }), '0.1.14', ['1.0.3']), /update-failed/)
  })

  it('окно старше app.minVersion — «Нужна новая версия окна», ссылка на релиз, без «Обновить»', () => {
    const u = status({ latest: { ...status().latest!, app: { version: '0.2.0', minVersion: '0.1.14' } } })
    const out = render(u, '0.1.13')
    assert.match(out, /data-testid="update-window"/)
    assert.match(text(out), /Доступна 1\.0\.3 · Нужна новая версия окна \(стоит 0\.1\.13, нужна 0\.1\.14 или новее\)/)
    assert.match(text(out), /Что нового/)
    assert.doesNotMatch(out, /data-testid="update-apply"/)
    // Версия окна неизвестна (не Electron) — про окно молчим, обновление предлагаем.
    assert.match(render(u, null), /update-available/)
    // Окно годится — обычная плашка.
    assert.match(render(u, '0.1.14'), /update-available/)
  })

  it('проба не прошла и откат — «не встало, вернул …», скрывается до следующей неудачи', () => {
    const failure = { to: '1.0.3', back: '1.0.2', at: '2026-10-19T11:00:00Z', result: 'rolled_back' as const, message: 'не прошла пробу', log: '/h/logs/update.log' }
    const u = status({ available: false, bad: true, failure })
    const out = render(u)
    assert.match(out, /data-testid="update-rolledback"/)
    assert.match(text(out), /Обновление до 1\.0\.3 не встало, вернул 1\.0\.2 · подробности: \/h\/logs\/update\.log/)
    assert.match(out, /data-testid="update-dismiss"/)
    assert.equal(updateBanner(u, null)?.dismissKey, 'failure:2026-10-19T11:00:00Z')
    assert.equal(render(u, '0.1.14', ['failure:2026-10-19T11:00:00Z']), '')
    // npm или загрузка — без отката: причина словами.
    const npm = render(status({ available: false, failure: { ...failure, back: null, result: 'failed', message: 'npm install не удался' } }))
    assert.match(text(npm), /Обновление до 1\.0\.3 не встало: npm install не удался/)
  })

  it('ошибка проверки канала (404) в плашку не идёт — её место pult doctor и --check', () => {
    const err = 'latest.json: … ответил HTTP 404 — релизов в канале нет или адрес недоступен'
    assert.equal(render(status({ latest: null, available: false, error: err })), '')
    const out = render(status({ error: err }))
    assert.match(out, /update-available/)
    assert.doesNotMatch(out, /404/)
  })

  it('ревью: скрытые ключи — списком; старая неудача не заслоняет НОВУЮ версию; неудача из терминала — «в терминале»', () => {
    const failure = { to: '1.0.3', back: '1.0.2', at: 'T1', result: 'rolled_back' as const, message: 'm', log: null }
    // Из терминала: файла журнала нет — так и говорим.
    assert.match(text(render(status({ available: false, bad: true, failure }))), /не встало, вернул 1\.0\.2 · подробности были в терминале/)
    // Скрыть неудачу не воскрешает скрытую «Доступна 1.0.4» и наоборот.
    const u = status({ latest: { ...status().latest!, version: '1.0.4' }, failure })
    assert.match(render(u), /update-available/, 'вышла 1.0.4 новее не вставшей 1.0.3 — её и показываем')
    let hidden = addDismissed([], '1.0.4')
    hidden = addDismissed(hidden, 'failure:T1')
    assert.deepEqual(hidden, ['1.0.4', 'failure:T1'])
    assert.equal(render(u, '0.1.14', hidden), '')
    // Та же версия, что не встала (bad, available=false), — неудача; скрыта — пусто.
    assert.match(render(status({ available: false, bad: true, failure })), /update-rolledback/)
    assert.equal(render(status({ available: false, bad: true, failure }), '0.1.14', ['failure:T1']), '')
    // Список не растёт без конца.
    let many: string[] = []
    for (let i = 0; i < 50; i++) many = addDismissed(many, `v${i}`)
    assert.equal(many.length, DISMISSED_MAX)
    assert.equal(many.at(-1), 'v49')
  })

  it('старая оболочка отвергла update.apply — подсказка про pult update', () => {
    assert.match(applyErrorText('method_not_allowed', 'метод update.apply окну не разрешён'), /оболочка старше 0\.1\.14\) — в терминале: pult update/)
    assert.equal(applyErrorText('invalid_params', 'ставить нечего'), 'Обновление не запустилось: ставить нечего')
  })
})
