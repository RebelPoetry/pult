// Канал обновлений (M8c) из конца в конец: настоящий CLI, настоящие тарболы (`npm pack --offline`),
// настоящий npm и проба. Сеть подменена PULT_TEST_UPDATE_DIR (файлы «релиза» по имени из адреса),
// ключ релизов — тестовый, через PULT_TEST_RELEASE_KEY. Правило https не ослаблено: адреса — https.
//
// Сценарий на одном доме: стоит 0.0.1 → --check (код 10) → pult update → 0.0.2 → --check (0) →
// старый манифест (0.0.1) — ничего → подменённый тарбол 0.0.3 (sha256, размер) — ничего не поставлено →
// подпись чужим ключом — отказ. Каждый поднятый демон гасится.

import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { layout } from '../dist/core/paths.js'
import type { PultPaths } from '../dist/core/paths.js'
import { publicOf, signEnvelope } from '../dist/update/manifest.js'
import { FAKE_CLAUDE, FAKE_CODEX, waitFor } from './helpers.js'
import { CLI, NODE_DIR, packPult, runProc } from './pack-helpers.js'
import type { Run } from './pack-helpers.js'

const BASE = 'https://example.invalid/releases/download'

let work = ''
let tgz: { A: string; B: string; C: string }
let key: KeyObject
let pub = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'pk-'))
  tgz = {
    A: packPult(work, { version: '0.0.1' }),
    B: packPult(work, { version: '0.0.2' }),
    C: packPult(work, { version: '0.0.3' }),
  }
  key = generateKeyPairSync('ed25519').privateKey
  pub = publicOf(key).raw.toString('base64')
})
after(() => { rmSync(work, { recursive: true, force: true }) })

interface Home { dir: string; paths: PultPaths; rel: string; env: Record<string, string> }

function makeHome(): Home {
  const dir = mkdtempSync(join(tmpdir(), 'pc-'))
  const paths = layout(join(dir, 'h'))
  const rel = join(dir, 'rel')
  mkdirSync(rel)
  mkdirSync(join(dir, 'home'))
  return {
    dir, paths, rel,
    env: {
      PATH: `${NODE_DIR}:${process.env['PATH'] ?? '/usr/bin:/bin'}`,
      HOME: join(dir, 'home'),
      USER: userInfo().username,
      ...(process.env['TMPDIR'] ? { TMPDIR: process.env['TMPDIR'] } : {}),
      PULT_HOME: paths.home,
      PULT_TEST: '1',
      PULT_CLAUDE_BIN: FAKE_CLAUDE,
      PULT_CODEX_BIN: FAKE_CODEX,
      PULT_UPDATE_URL: `${BASE}/latest.json`,
      PULT_TEST_UPDATE_DIR: rel,
      PULT_TEST_RELEASE_KEY: pub,
    },
  }
}

const cli = (h: Home, args: string[], extra: Record<string, string> = {}): Promise<Run> =>
  runProc(process.execPath, [CLI, ...args], { ...h.env, ...extra }).done

const sha = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex')

/** «Выложить релиз»: тарбол под именем из манифеста и подписанный latest.json. */
function publish(h: Home, version: string, file: string, over: { sha256?: string; size?: number; signer?: KeyObject } = {}): void {
  const name = `pult-${version}.tgz`
  copyFileSync(file, join(h.rel, name))
  const manifest = {
    schema: 1, version, released: '2026-10-19T10:00:00.000Z',
    notes: `https://github.com/pawellazarew/pult/releases/tag/v${version}`,
    package: { url: `${BASE}/v${version}/${name}`, sha256: over.sha256 ?? sha(file), size: over.size ?? statSync(file).size },
    app: { version: '0.1.14', minVersion: '0.1.13' },
  }
  writeFileSync(join(h.rel, 'latest.json'), signEnvelope(Buffer.from(JSON.stringify(manifest)), over.signer ?? key))
}

async function teardown(h: Home): Promise<void> {
  await cli(h, ['daemon', 'stop'])
  await waitFor(() => !existsSync(h.paths.lock), 10_000)
  rmSync(h.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

const current = (h: Home): string => readlinkSync(h.paths.current)
const versions = (h: Home): string[] => readdirSync(h.paths.versions).sort()
const downloads = (h: Home): string[] => { try { return readdirSync(h.paths.downloads) } catch { return [] } }

describe('pult update из канала: проверка, установка, отказы', () => {
  let h: Home
  before(async () => {
    h = makeHome()
    const r = await cli(h, ['update', '--from', tgz.A])
    assert.equal(r.code, 0, r.stderr)
  })
  after(async () => { await teardown(h) })

  it('--check: в канале новее — код 10, версия, «что нового»; --json — то же машинно', async () => {
    publish(h, '0.0.2', tgz.B)
    const r = await cli(h, ['update', '--check'])
    assert.equal(r.code, 10, r.stderr + r.stdout)
    assert.match(r.stdout, /доступна 0\.0\.2 \(сейчас 0\.0\.1, выпущена 2026-10-19\) — поставить: pult update/)
    assert.match(r.stdout, /что нового: https:\/\/github\.com\/pawellazarew\/pult\/releases\/tag\/v0\.0\.2/)
    const j = await cli(h, ['update', '--check', '--json'])
    assert.equal(j.code, 10)
    const rep = JSON.parse(j.stdout) as { current: string; available: boolean; latest: { version: string; app: { minVersion: string } } }
    assert.equal(rep.current, '0.0.1')
    assert.equal(rep.available, true)
    assert.equal(rep.latest.app.minVersion, '0.1.13')
    assert.equal(current(h), join('versions', '0.0.1'), '--check ничего не ставит')
  })

  it('pult update: скачал, сверил sha256, поставил тем же путём, что --from (проба); downloads пуст', async () => {
    const r = await cli(h, ['update'])
    assert.equal(r.code, 0, r.stderr + r.stdout)
    assert.match(r.stdout, /доступна 0\.0\.2 \(сейчас 0\.0\.1\) — скачиваю https:\/\/example\.invalid\//)
    assert.match(r.stdout, /sha256 сходится с подписанным манифестом/)
    assert.match(r.stdout, /pult обновлён: 0\.0\.1 → 0\.0\.2/)
    assert.equal(current(h), join('versions', '0.0.2'))
    assert.deepEqual(downloads(h), [])
    const st = JSON.parse(readFileSync(h.paths.updateState, 'utf8')) as { last: { action: string; result: string } }
    assert.deepEqual([st.last.action, st.last.result], ['channel', 'ok'])
  })

  it('та же версия — «уже последняя», код 0; --check — код 0', async () => {
    const r = await cli(h, ['update'])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /уже последняя: 0\.0\.2/)
    const c = await cli(h, ['update', '--check'])
    assert.equal(c.code, 0)
    assert.match(c.stdout, /pult 0\.0\.2 — последняя версия/)
  })

  it('старый подписанный манифест (0.0.1) — назад не откатывает', async () => {
    publish(h, '0.0.1', tgz.A)
    const r = await cli(h, ['update'])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /pult 0\.0\.2 новее канала \(0\.0\.1\) — ставить нечего/)
    assert.equal(current(h), join('versions', '0.0.2'))
  })

  it('sha256 не тот — отказ, 0.0.3 нигде нет, current прежний', async () => {
    publish(h, '0.0.3', tgz.C, { sha256: 'f'.repeat(64) })
    const r = await cli(h, ['update'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /sha256 .* не совпадает с манифестом/)
    assert.match(r.stderr, /ничего не поставлено/)
    assert.ok(!versions(h).some((v) => v.startsWith('0.0.3')))
    assert.equal(current(h), join('versions', '0.0.2'))
    assert.deepEqual(downloads(h), [])
  })

  it('размер не тот — отказ, ничего не поставлено', async () => {
    publish(h, '0.0.3', tgz.C, { size: statSync(tgz.C).size - 1 })
    const r = await cli(h, ['update'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /сервер обещает \d+ байт, манифест — \d+/)
    assert.ok(!versions(h).some((v) => v.startsWith('0.0.3')))
    assert.equal(current(h), join('versions', '0.0.2'))
  })

  it('подпись чужим ключом — отказ и в --check (код 1), и в update', async () => {
    publish(h, '0.0.3', tgz.C, { signer: generateKeyPairSync('ed25519').privateKey })
    const c = await cli(h, ['update', '--check'])
    assert.equal(c.code, 1)
    assert.match(c.stderr, /которому эта сборка не доверяет/)
    const r = await cli(h, ['update'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /не доверяет/)
    assert.equal(current(h), join('versions', '0.0.2'))
  })

  it('ключа релизов нет (без PULT_TEST_RELEASE_KEY) — «в этой сборке нет ключа релизов»', async () => {
    publish(h, '0.0.3', tgz.C)
    const r = await cli(h, ['update', '--check'], { PULT_TEST_RELEASE_KEY: '', PULT_TEST_NO_RELEASE_KEYS: '1' })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /в этой сборке нет ключа релизов/)
  })

  it('PULT_UPDATE_URL по http — отказ до сети', async () => {
    const r = await cli(h, ['update'], { PULT_UPDATE_URL: 'http://example.invalid/latest.json' })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /PULT_UPDATE_URL=http:\/\/example\.invalid\/latest\.json: только https/)
  })

  it('версия bad сама не ставится повторно', async () => {
    const st = JSON.parse(readFileSync(h.paths.updateState, 'utf8')) as Record<string, unknown>
    writeFileSync(h.paths.updateState, JSON.stringify({ ...st, bad: ['0.0.3'] }))
    publish(h, '0.0.3', tgz.C)
    const c = await cli(h, ['update', '--check'])
    assert.equal(c.code, 0)
    assert.match(c.stdout, /уже не прошла пробу на этой машине \(bad\)/)
    const r = await cli(h, ['update'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /pult update --to 0\.0\.3/)
  })

  it('режимы по одному: --check с --from — отказ', async () => {
    const r = await cli(h, ['update', '--check', '--from', tgz.C])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /по одному за раз/)
  })
})

describe('pult update из канала: --expect, окно, неподписанный каталог той же версии', () => {
  let h: Home
  let apps = ''
  before(async () => {
    h = makeHome()
    // Окно 0.1.12 при minVersion релиза 0.1.13: установка идёт, но CLI говорит, что делать с окном.
    apps = join(h.dir, 'apps')
    mkdirSync(join(apps, 'Pult.app', 'Contents'), { recursive: true })
    writeFileSync(join(apps, 'Pult.app', 'Contents', 'Info.plist'),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>0.1.12</string></dict></plist>')
    for (const t of [tgz.A, tgz.C]) assert.equal((await cli(h, ['update', '--from', t])).code, 0)
    assert.equal((await cli(h, ['update', '--to', '0.0.1'])).code, 0)
    publish(h, '0.0.3', tgz.C)
  })
  after(async () => { await teardown(h) })

  it('--expect другой версии — отказ, ничего не тронуто', async () => {
    const r = await cli(h, ['update', '--expect', '0.0.9'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /в канале уже 0\.0\.3, а ставить просили 0\.0\.9/)
    assert.equal(current(h), join('versions', '0.0.1'))
  })

  it('0.0.3 уже лежит из неподписанного --from — канал её переставляет из своего тарбола, метит sha; окно старое — предупреждение', async () => {
    const r = await cli(h, ['update', '--expect', '0.0.3'], { PULT_TEST_APP_DIRS: apps })
    assert.equal(r.code, 0, r.stderr + r.stdout)
    assert.match(r.stdout, /0\.0\.3 уже лежит в .*, но не из этого подписанного тарбола — переставляю/)
    assert.match(r.stdout, /0\.0\.3 поставлена в/)
    assert.match(r.stderr, /внимание: окно 0\.1\.12 старше нужного релизу \(0\.1\.13\) — после обновления скачай новое со страницы релиза/)
    assert.equal(readFileSync(join(h.paths.versions, '0.0.3', '.channel-sha256'), 'utf8').trim(), sha(tgz.C))
    assert.equal(current(h), join('versions', '0.0.3'))
  })

  it('тот же подписанный тарбол — каталог переиспользуется без переустановки', async () => {
    assert.equal((await cli(h, ['update', '--to', '0.0.1'])).code, 0)
    const r = await cli(h, ['update'])
    assert.equal(r.code, 0, r.stderr + r.stdout)
    assert.match(r.stdout, /0\.0\.3 уже лежит в .* — переключаюсь без переустановки/)
    assert.equal(current(h), join('versions', '0.0.3'))
  })
})
