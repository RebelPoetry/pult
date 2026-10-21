// `pult ui` (docs/12 §4, О3): выбор окна — чистая функция на подставной ФС, плюс сквозной прогон
// собранного CLI с `--print`. Ни одного настоящего окна тесты не запускают: `--print` только
// печатает план, а запуск проверяется на заведомо несуществующих и падающих командах.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { appDirs, launchUi, planUi } from '../dist/cli/ui.js'
import type { PlanInput, UiProbe } from '../dist/cli/ui.js'

const CLI = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url))

/** Подставная ФС: множество каталогов, файлов и текстов. */
function probe(dirs: string[], files: Record<string, string>): UiProbe {
  return {
    isDir: (p) => dirs.includes(p),
    isFile: (p) => p in files,
    read: (p) => files[p] ?? null,
  }
}

/** Файлы собранной рабочей копии с окном. */
function devTree(root: string): Record<string, string> {
  return {
    [join(root, 'dist', 'ui', 'index.html')]: '',
    [join(root, 'dist', 'cli', 'startOnDemand.js')]: '',
    [join(root, 'shell', 'dist', 'main.js')]: '',
    [join(root, 'shell', 'node_modules', 'electron', 'path.txt')]: 'Electron.app/Contents/MacOS/Electron\n',
    [join(root, 'shell', 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')]: '',
  }
}

function input(over: Partial<PlanInput>): PlanInput {
  return {
    env: { PULT_TEST: '1', PULT_TEST_APP_DIRS: '/A:/B' },
    platform: 'darwin',
    selfRoot: '/self',
    nodePath: '/n/node',
    dev: false,
    fs: probe([], {}),
    ...over,
  }
}

describe('pult ui: выбор окна', () => {
  it('под PULT_TEST Pult.app ищется только в PULT_TEST_APP_DIRS, по умолчанию нигде', () => {
    assert.deepEqual(appDirs({ PULT_TEST: '1' }), [])
    assert.deepEqual(appDirs({ PULT_TEST: '1', PULT_TEST_APP_DIRS: '/x:/y' }), ['/x', '/y'])
    const real = appDirs({})
    assert.equal(real[0], '/Applications')
    assert.match(real[1] ?? '', /\/Applications$/)
  })

  it('поставленное Pult.app — первым, в порядке каталогов; через open -a с домом и node', () => {
    const plan = planUi(input({
      env: { PULT_TEST: '1', PULT_TEST_APP_DIRS: '/A:/B', PULT_HOME: '/h' },
      fs: probe(['/A/Pult.app', '/B/Pult.app'], devTree('/self')),
    }))
    assert.equal(plan.kind, 'app')
    if (plan.kind !== 'app') return
    assert.equal(plan.app, '/A/Pult.app')
    assert.equal(plan.command, 'open')
    assert.deepEqual(plan.args, ['-a', '/A/Pult.app', '--env', 'PULT_NODE=/n/node', '--env', 'PULT_HOME=/h', '--env', 'PULT_TEST=1'])
  })

  it('--dev и не-macOS пропускают Pult.app', () => {
    const fs = probe(['/A/Pult.app'], devTree('/self'))
    assert.equal(planUi(input({ fs, dev: true })).kind, 'dev')
    assert.equal(planUi(input({ fs, platform: 'linux' })).kind, 'dev')
  })

  it('без Pult.app — рабочая копия этого пакета: Electron оболочки, PULT_UI_ROOT на корень', () => {
    const plan = planUi(input({ fs: probe([], devTree('/self')) }))
    assert.equal(plan.kind, 'dev')
    if (plan.kind !== 'dev') return
    assert.equal(plan.root, '/self')
    assert.equal(plan.command, '/self/shell/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    assert.deepEqual(plan.args, ['/self/shell'])
    assert.equal(plan.env['PULT_UI_ROOT'], '/self')
    assert.equal(plan.env['PULT_NODE'], '/n/node')
  })

  it('PULT_UI_ROOT важнее своего корня; PULT_NODE из окружения важнее node CLI', () => {
    const plan = planUi(input({
      env: { PULT_TEST: '1', PULT_UI_ROOT: '/wc', PULT_NODE: '/my/node' },
      fs: probe([], { ...devTree('/self'), ...devTree('/wc') }),
    }))
    assert.equal(plan.kind, 'dev')
    if (plan.kind !== 'dev') return
    assert.equal(plan.root, '/wc')
    assert.equal(plan.env['PULT_NODE'], '/my/node')
  })

  it('недособранная копия (нет shell/dist или electron) — kind none с подсказкой', () => {
    const tree = devTree('/self')
    delete tree['/self/shell/dist/main.js']
    const a = planUi(input({ fs: probe([], tree) }))
    assert.equal(a.kind, 'none')
    const b = planUi(input({ env: { PULT_TEST: '1', PULT_UI_ROOT: '/wc' }, fs: probe([], devTree('/self')) }))
    assert.equal(b.kind, 'none')
    if (b.kind === 'none') {
      assert.match(b.hint, /PULT_UI_ROOT=\/wc/)
      assert.match(b.hint, /npm run dist:mac/)
    }
  })

  it('установленная раскладка (~/.pult/current/lib/node_modules/pult) без Pult.app — none', () => {
    const root = '/h/current/lib/node_modules/pult'
    const plan = planUi(input({
      selfRoot: root,
      fs: probe([], { [join(root, 'dist', 'ui', 'index.html')]: '', [join(root, 'dist', 'cli', 'startOnDemand.js')]: '' }),
    }))
    assert.equal(plan.kind, 'none')
  })
})

describe('pult ui: запуск', () => {
  it('open с ненулевым кодом — ошибка с кодом в тексте', async () => {
    await assert.rejects(
      launchUi({ kind: 'app', app: '/A/Pult.app', command: '/usr/bin/false', args: [], env: {} }, process.env),
      /код 1/,
    )
  })
  it('несуществующий бинарь оболочки — ошибка спавна, а не молчаливый успех', async () => {
    await assert.rejects(
      launchUi({ kind: 'dev', root: '/nope', command: '/nonexistent/pult-electron', args: [], env: {} }, process.env),
      /ENOENT/,
    )
  })
})

describe('pult ui: собранный CLI', () => {
  let dir = ''
  before(() => { dir = mkdtempSync(join(tmpdir(), 'pu-')) })
  after(() => rmSync(dir, { recursive: true, force: true }))

  function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const clean = { ...process.env }
      delete clean['PULT_UI_ROOT']
      const child = spawn(process.execPath, [CLI, ...args], {
        env: { ...clean, PULT_HOME: join(dir, 'home'), PULT_TEST: '1', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d })
      child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d })
      child.on('close', (code) => resolve({ code, stdout, stderr }))
    })
  }

  it('--print с Pult.app в каталоге теста печатает open -a и выходит 0, ничего не запуская', async (t) => {
    if (process.platform !== 'darwin') { t.skip('Pult.app — только macOS'); return }
    const apps = join(dir, 'apps')
    mkdirSync(join(apps, 'Pult.app'), { recursive: true })
    const r = await run(['ui', '--print'], { PULT_TEST_APP_DIRS: apps })
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, new RegExp(`окно: ${join(apps, 'Pult.app').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.match(r.stdout, /open -a /)
  })

  it('PULT_UI_ROOT на пустую папку — код 1 и подсказка, как получить окно', async () => {
    const empty = join(dir, 'empty')
    mkdirSync(empty, { recursive: true })
    writeFileSync(join(empty, 'package.json'), '{}')
    const r = await run(['ui', '--print'], { PULT_UI_ROOT: empty })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /pult ui: PULT_UI_ROOT=/)
    assert.match(r.stderr, /npm run dist:mac/)
    assert.equal(r.stdout, '')
  })

  it('--help перечисляет pult ui', async () => {
    const r = await run(['--help'], {})
    assert.equal(r.code, 0)
    assert.match(r.stdout, /pult ui \[--dev\] \[--print\]/)
  })
})
