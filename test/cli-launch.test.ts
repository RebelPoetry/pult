// Лаунчер команды `service/pult`: команда `pult` без системного node. Выбор node — как у лаунчера
// службы: свой node Пульта по указателю runtime/active (исполняемый и собран под эту машину — по
// имени каталога, без запуска), затем системный >= 22 (PATH → node-path → известные места);
// точка входа — установленная версия, затем рабочая копия. Всё — во временной папке.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { platformKey } from '../dist/update/runtime.js'

const LAUNCH = fileURLToPath(new URL('../service/pult', import.meta.url))
const KEY = platformKey() ?? 'darwin-arm64'
const OTHER_KEY = KEY === 'linux-x64' ? 'darwin-arm64' : 'linux-x64'

describe('service/pult — лаунчер команды', () => {
  let tmp = ''
  let pultHome = ''
  let stubs = ''
  let oldNodeDir = ''
  // CLI-заглушка: печатает, каким node её запустили, и свои аргументы.
  const CLI = 'process.stdout.write(JSON.stringify({ execPath: process.execPath, argv: process.argv.slice(2), home: process.env.PULT_HOME }) + "\\n")\n'

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pc-'))
    stubs = join(tmp, 'stubs')
    oldNodeDir = join(stubs, 'old')
    mkdirSync(oldNodeDir, { recursive: true })
    // Системный node СТАРШЕ 22 первым в PATH: на `-v` — v18, остальное не умеет.
    writeFileSync(join(oldNodeDir, 'node'), '#!/bin/sh\n[ "$1" = "-v" ] && echo v18.20.0 && exit 0\nexit 1\n')
    chmodSync(join(oldNodeDir, 'node'), 0o755)
  })
  after(() => { rmSync(tmp, { recursive: true, force: true }) })

  beforeEach(() => {
    pultHome = join(tmp, 'home', '.pult')
    rmSync(join(tmp, 'home'), { recursive: true, force: true })
    mkdirSync(pultHome, { recursive: true })
  })

  /** Свой node: sh-обёртка над настоящим node теста, оставляет след `used` рядом с bin/. */
  function ownNode(key: string, version = '24.21.0'): string {
    const node = join(pultHome, 'runtime', `node-v${version}-${key}`, 'bin', 'node')
    mkdirSync(dirname(node), { recursive: true })
    writeFileSync(node, `#!/bin/sh\n[ "$1" = "-v" ] && echo v${version} && exit 0\nprintf x > "$(dirname "$0")/../used"\nexec ${JSON.stringify(process.execPath)} "$@"\n`)
    chmodSync(node, 0o755)
    writeFileSync(join(pultHome, 'runtime', 'active'), `${node}\n`)
    return node
  }

  /** Активная версия: `installed` — раскладка npm --global --prefix, `dev` — рабочая копия. */
  function version(layout: 'installed' | 'dev', marker: string = layout): string {
    const v = join(pultHome, 'versions', marker)
    const entry = layout === 'installed' ? join(v, 'lib', 'node_modules', 'pult', 'dist', 'cli', 'main.js') : join(v, 'dist', 'cli', 'main.js')
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, `// ${marker}\n${CLI}`)
    rmSync(join(pultHome, 'current'), { force: true })
    symlinkSync(join('versions', marker), join(pultHome, 'current'))
    // Лаунчер называет точку входа через `current`, а не через versions/<v>.
    return join(pultHome, 'current', entry.slice(v.length + 1))
  }

  function run(path: string, args: string[] = [], extra: Record<string, string> = {}): { code: number | null; out: Record<string, unknown> | null; stdout: string; stderr: string } {
    const r = spawnSync('/bin/sh', [LAUNCH, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { HOME: join(tmp, 'home'), PATH: path, PULT_HOME: pultHome, ...extra },
    })
    let out: Record<string, unknown> | null = null
    try { out = JSON.parse((r.stdout ?? '').trim().split('\n').pop() ?? '') as Record<string, unknown> } catch { /* не JSON */ }
    return { code: r.status, out, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }

  it('свой node Пульта — первым, даже когда системного нет; аргументы доходят как есть', () => {
    const node = ownNode(KEY)
    const entry = version('installed')
    // В PATH только СТАРЫЙ node: системного годного нет.
    const r = run(`${oldNodeDir}:/usr/bin:/bin`, ['agent', 'ls', '--json', 'с пробелом'])
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(r.out?.['argv'], ['agent', 'ls', '--json', 'с пробелом'])
    assert.equal(r.out?.['home'], pultHome)
    assert.ok(existsSync(join(dirname(dirname(node)), 'used')), 'CLI поднят не своим node')
    const dry = run(`${oldNodeDir}:/usr/bin:/bin`, [], { PULT_LAUNCH_DRY_RUN: '1' })
    assert.deepEqual(dry.out, { node, own: true, entry })
  })

  it('указатель на node чужой платформы или не исполняемый — системный node из PATH', () => {
    version('dev')
    ownNode(OTHER_KEY)
    const sysDir = dirname(process.execPath)
    const r = run(`${sysDir}:/usr/bin:/bin`, [], { PULT_LAUNCH_DRY_RUN: '1' })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.out?.['own'], false)
    assert.equal(r.out?.['node'], join(sysDir, 'node'))

    const own = ownNode(KEY)
    chmodSync(own, 0o644)
    const r2 = run(`${sysDir}:/usr/bin:/bin`, [], { PULT_LAUNCH_DRY_RUN: '1' })
    assert.equal(r2.out?.['own'], false)
    assert.equal(r2.out?.['node'], join(sysDir, 'node'))
  })

  it('Apple Silicon: node darwin-x64 (поставлен из-под Rosetta) годен — по железу, а не по uname процесса', (t) => {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') { t.skip('только на Apple Silicon'); return }
    const node = ownNode('darwin-x64')
    version('dev')
    const r = run('/usr/bin:/bin', [], { PULT_LAUNCH_DRY_RUN: '1' })
    assert.equal(r.out?.['own'], true, r.stderr)
    assert.equal(r.out?.['node'], node)
  })

  it('PULT_HOME не задан: дом — каталог над bin/ лаунчера, симлинк <bin-dir>/pult раскрывается', () => {
    ownNode(KEY)
    version('installed')
    const launcher = join(pultHome, 'bin', 'pult')
    mkdirSync(dirname(launcher), { recursive: true })
    copyFileSync(LAUNCH, launcher)
    chmodSync(launcher, 0o755)
    const binDir = join(tmp, 'bindir')
    mkdirSync(binDir, { recursive: true })
    rmSync(join(binDir, 'pult'), { force: true })
    symlinkSync(launcher, join(binDir, 'pult'))
    const r = spawnSync(join(binDir, 'pult'), ['x'], { encoding: 'utf8', timeout: 30_000, env: { HOME: join(tmp, 'other-home'), PATH: '/usr/bin:/bin' } })
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout.trim()) as Record<string, unknown>
    assert.equal(out['home'], pultHome)
    assert.deepEqual(out['argv'], ['x'])
    // Лаунчер из рабочей копии (над service/ нет current и versions/) — ~/.pult по умолчанию.
    const dev = spawnSync('/bin/sh', [LAUNCH], { encoding: 'utf8', timeout: 30_000, env: { HOME: join(tmp, 'other-home'), PATH: '/usr/bin:/bin' } })
    assert.equal(dev.status, 78)
    assert.match(dev.stderr, new RegExp(`${join(tmp, 'other-home', '.pult').replace(/[.]/g, '\\.')}`))
  })

  it('без своего node: старый node в PATH пропускается, берётся node-path', () => {
    version('dev')
    writeFileSync(join(pultHome, 'node-path'), `${process.execPath}\n`)
    const r = run(`${oldNodeDir}:/usr/bin:/bin`, ['--version'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.out?.['execPath'], process.execPath)
    assert.deepEqual(r.out?.['argv'], ['--version'])
  })

  it('установленная версия главнее рабочей копии; активной версии нет — код 78 и подсказка', () => {
    ownNode(KEY)
    const installed = version('installed', 'both')
    const devEntry = join(pultHome, 'versions', 'both', 'dist', 'cli', 'main.js')
    mkdirSync(dirname(devEntry), { recursive: true })
    writeFileSync(devEntry, CLI)
    assert.equal(run('/usr/bin:/bin', [], { PULT_LAUNCH_DRY_RUN: '1' }).out?.['entry'], installed)

    rmSync(join(pultHome, 'current'))
    const none = run('/usr/bin:/bin')
    assert.equal(none.code, 78)
    assert.match(none.stderr, /активной версии нет/)
  })

  it('нет ни своего node, ни системного >= PULT_MIN_NODE — код 78, подсказка про install.sh', () => {
    version('dev')
    // Порог выше любого настоящего node: «известные места» на машине теста тоже не годятся.
    const r = run(`${oldNodeDir}:/usr/bin:/bin`, [], { PULT_MIN_NODE: '999' })
    assert.equal(r.code, 78)
    assert.match(r.stderr, /нет node >= 999/)
    assert.match(r.stderr, /install\.sh/)
  })
})
