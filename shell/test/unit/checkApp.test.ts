import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

// check-app.mjs — скрипт проверки собранного Pult.app, запускать его в юнит-тестах нельзя (нужен
// настоящий подписанный бандл), поэтому держим инвариант по его тексту.
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'check-app.mjs')

describe('check-app: ожидание медленного первого запуска', () => {
  it('DevToolsActivePort ждём долгим таймаутом: файл порта появляется вместе с boot', () => {
    const src = readFileSync(SCRIPT, 'utf8')
    const long = /const FIRST_LAUNCH_MS = (\d[\d_]*)/.exec(src)
    assert.ok(long, 'нет константы FIRST_LAUNCH_MS')
    assert.ok(Number(long[1].replace(/_/g, '')) >= 90_000, `FIRST_LAUNCH_MS=${long[1]}`)
    // Первая же проверка окна должна ждать FIRST_LAUNCH_MS: иначе задержка первого запуска
    // (Chromium ещё не стартовал) валит прогон на дефолтных 15 с раньше долгого ожидания.
    const portWait = /waitFor\(\(\) => existsSync\(portFile\)(?:, ([^)]+))?\)/.exec(src)
    assert.ok(portWait, 'не нашёл ожидание DevToolsActivePort')
    assert.equal(portWait[1]?.trim(), 'FIRST_LAUNCH_MS')
  })
})

describe('схема pult:// в сборке (docs/14 О3)', () => {
  it('electron-builder объявляет схему pult: из build.protocols он пишет CFBundleURLTypes в Info.plist', () => {
    const pkg = JSON.parse(readFileSync(path.join(path.dirname(SCRIPT), '..', 'package.json'), 'utf8')) as {
      build?: { protocols?: Array<{ name?: string; schemes?: string[] }> }
    }
    const protocols = pkg.build?.protocols ?? []
    assert.ok(protocols.some((p) => p.name === 'Pult' && p.schemes?.includes('pult')), JSON.stringify(protocols))
  })
  it('check-app сверяет CFBundleURLTypes собранного приложения', () => {
    const src = readFileSync(SCRIPT, 'utf8')
    assert.match(src, /plist\.CFBundleURLTypes/)
    assert.match(src, /CFBundleURLSchemes\.includes\('pult'\)/)
  })
})
