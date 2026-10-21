// Лаунчер службы `service/pultd-launch` — перенос spike/env/test-launch.mjs (проверка S9d) на
// продуктовый лаунчер плюс то, что добавила веха В4 (docs/08 §3): порядок поиска точки входа
// (явный PULT_ENTRY → установленная версия → рабочая копия), код 78 на ошибки конфигурации,
// обрезка service.log больше 5 МБ.
//
// Всё — во временной папке: лаунчер пишет файл состояния node-path, и в рабочее дерево он
// не должен попасть никогда (так в спайке однажды портились отслеживаемые stubs/*).

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const LAUNCH = fileURLToPath(new URL('../service/pultd-launch', import.meta.url))

describe('pultd-launch', () => {
  let tmp = ''
  let fakeHome = ''
  let pultHome = ''
  let stateFile = ''
  let stubs = ''
  let oldNode = ''
  let notExec = ''
  let shellStub = ''
  let entry = ''

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pl-'))
    fakeHome = join(tmp, 'home')
    pultHome = join(fakeHome, '.pult')
    stateFile = join(pultHome, 'node-path')
    stubs = join(tmp, 'stubs')
    mkdirSync(stubs, { recursive: true })
    // Фальшивый СТАРЫЙ node: на `-v` отвечает v18.20.0 и больше ничего не умеет.
    oldNode = join(stubs, 'old-node')
    writeFileSync(oldNode, '#!/bin/sh\n[ "$1" = "-v" ] && echo v18.20.0 && exit 0\nexit 1\n')
    chmodSync(oldNode, 0o755)
    // Файл есть, но НЕ исполняемый.
    notExec = join(stubs, 'not-exec-node')
    writeFileSync(notExec, '#!/bin/sh\necho v24.0.0\n')
    chmodSync(notExec, 0o644)
    // Логин-шелл-заглушка: на раннере нет zsh с rc-файлами, а ветка «нашли через логин-шелл»
    // должна быть детерминированной. Возвращает ровно тот node, которым идёт тест.
    shellStub = join(stubs, 'login-shell')
    writeFileSync(shellStub, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(process.execPath)}\n`)
    chmodSync(shellStub, 0o755)
    entry = join(tmp, 'entry.mjs')
    writeFileSync(entry, 'process.stdout.write(JSON.stringify({daemon:"started",node:process.version,argv:process.argv.slice(2),svc:process.env.PULT_SERVICE??null})+"\\n")\n')
  })

  after(() => { rmSync(tmp, { recursive: true, force: true }) })

  beforeEach(() => {
    rmSync(pultHome, { recursive: true, force: true })
    mkdirSync(join(pultHome, 'logs'), { recursive: true })
  })

  interface Run { code: number | null; stdout: string; stderr: string; dry: Record<string, unknown> | null }

  function run(extra: Record<string, string> = {}, args: string[] = []): Run {
    const r = spawnSync('/bin/sh', [LAUNCH, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        HOME: fakeHome,
        SHELL: shellStub,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin', // как у агента launchd: node здесь НЕТ
        PULT_HOME: pultHome,
        PULT_ENTRY: entry,
        ...extra,
      },
    })
    let dry: Record<string, unknown> | null = null
    try { dry = JSON.parse((r.stdout ?? '').trim()) as Record<string, unknown> } catch { /* не JSON */ }
    return { code: r.status, stdout: (r.stdout ?? '').trim(), stderr: r.stderr ?? '', dry }
  }
  const state = (): string | null => (existsSync(stateFile) ? readFileSync(stateFile, 'utf8').trim() : null)

  /** Годный node: dry-run напечатал путь, версия >= 22, и именно он записан в файл состояния. */
  function assertHealed(r: Run): void {
    assert.equal(r.code, 0, r.stderr)
    assert.ok(r.dry && typeof r.dry['node'] === 'string', r.stdout)
    assert.match(String(r.dry?.['nodeVersion']), /^v(2[2-9]|[3-9]\d)\./)
    assert.equal(state(), r.dry?.['node'])
  }

  it('S9d-1: файла состояния нет — node находится и записывается', () => {
    assertHealed(run({ PULT_DRY_RUN: '1' }))
  })

  it('S9d-2: годный сохранённый путь берётся как есть', () => {
    writeFileSync(stateFile, `${process.execPath}\n`)
    const r = run({ PULT_DRY_RUN: '1' })
    assert.equal(r.code, 0)
    assert.equal(r.dry?.['node'], process.execPath)
    assert.match(r.stderr, /сохранённый node годен/)
  })

  it('S9d-3: сохранённого пути нет на диске — самолечение', () => {
    writeFileSync(stateFile, '/opt/homebrew/Cellar/node/19.0.0/bin/node\n')
    const r = run({ PULT_DRY_RUN: '1' })
    assertHealed(r)
    assert.notEqual(state(), '/opt/homebrew/Cellar/node/19.0.0/bin/node')
  })

  it('S9d-4: сохранённый путь не исполняемый — самолечение', () => {
    writeFileSync(stateFile, `${notExec}\n`)
    const r = run({ PULT_DRY_RUN: '1' })
    assertHealed(r)
    assert.match(r.stderr, /не исполняемый/)
  })

  it('S9d-5: сохранённый node v18 < 22 — самолечение', () => {
    writeFileSync(stateFile, `${oldNode}\n`)
    const r = run({ PULT_DRY_RUN: '1' })
    assertHealed(r)
    assert.notEqual(state(), oldNode)
  })

  it('S9d-6: тот же v18 проходит при PULT_MIN_NODE=18 — отвергает именно порог версии', () => {
    writeFileSync(stateFile, `${oldNode}\n`)
    const r = run({ PULT_DRY_RUN: '1', PULT_MIN_NODE: '18' })
    assert.equal(r.code, 0)
    assert.equal(r.dry?.['node'], oldNode)
    assert.equal(r.dry?.['nodeVersion'], 'v18.20.0')
  })

  it('S9d-7: явной точки входа нет — код 78 и никакого exec, даже если есть current', () => {
    // Явный PULT_ENTRY, которого нет, — ошибка конфигурации, а не повод молча взять другую точку.
    const cur = join(pultHome, 'current', 'dist', 'daemon')
    mkdirSync(cur, { recursive: true })
    writeFileSync(join(cur, 'main.js'), '')
    const r = run({ PULT_ENTRY: join(pultHome, 'nope.mjs') })
    assert.equal(r.code, 78)
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /ОШИБКА КОНФИГУРАЦИИ: нет точки входа/)
  })

  it('S9d-8: настоящий exec точки входа, аргументы и окружение проходят насквозь', () => {
    const r = run({ PULT_SERVICE: '1' }, ['--spike'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.dry?.['daemon'], 'started')
    assert.deepEqual(r.dry?.['argv'], ['--spike'])
    assert.equal(r.dry?.['svc'], '1')
  })

  it('S9d-9: node не найден нигде — код 78', () => {
    writeFileSync(stateFile, '/nope/node\n')
    const empty = join(stubs, 'emptyhome')
    const r = spawnSync('/bin/sh', [LAUNCH], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        HOME: empty, SHELL: '/bin/sh', PATH: '/nonexistent',
        PULT_HOME: join(empty, '.pult'), PULT_ENTRY: entry,
        PULT_MIN_NODE: '99', // порог 99: ни один node на машине его не пройдёт
      },
    })
    assert.equal(r.status, 78, r.stderr)
    assert.match(r.stderr, /нет node >= 99/)
  })

  it('пустой PATH не ломает лаунчер: он сам ставит себе системный пол', () => {
    writeFileSync(stateFile, `${process.execPath}\n`)
    const r = run({ PULT_DRY_RUN: '1', PATH: '' })
    assert.equal(r.code, 0, r.stderr)
    assert.ok(!/command not found/.test(r.stderr), r.stderr)
  })

  it('пустой PATH не превращается в «текущая папка первой»: чужой ./date из cwd не исполняется', () => {
    // `${PATH:-}:/usr/bin…` при пустом PATH давал `:/usr/bin…`, а пустой элемент PATH — это cwd:
    // `date`, `wc`, `mkdir` искались сначала в текущей папке.
    const cwd = join(tmp, 'hostile-cwd')
    mkdirSync(cwd, { recursive: true })
    const hijack = join(tmp, 'hijacked')
    rmSync(hijack, { force: true })
    for (const tool of ['date', 'wc', 'head', 'mkdir', 'mv', 'tr', 'cat']) {
      writeFileSync(join(cwd, tool), `#!/bin/sh\necho ${tool} >> '${hijack}'\n`)
      chmodSync(join(cwd, tool), 0o755)
    }
    writeFileSync(stateFile, `${process.execPath}\n`)
    const r = spawnSync('/bin/sh', [LAUNCH], {
      encoding: 'utf8',
      timeout: 30_000,
      cwd,
      env: { HOME: fakeHome, SHELL: shellStub, PATH: '', PULT_HOME: pultHome, PULT_ENTRY: entry, PULT_DRY_RUN: '1' },
    })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(existsSync(hijack) ? readFileSync(hijack, 'utf8') : '', '', 'лаунчер исполнил программы из текущей папки')
  })

  describe('раскладки точки входа (docs/08 §2)', () => {
    const noEntry = { PULT_ENTRY: '' }

    it('установленная версия: current/lib/node_modules/pult/dist/daemon/main.js', () => {
      writeFileSync(stateFile, `${process.execPath}\n`)
      const v = join(pultHome, 'versions', '1.2.3', 'lib', 'node_modules', 'pult', 'dist', 'daemon')
      mkdirSync(v, { recursive: true })
      writeFileSync(join(v, 'main.js'), '')
      symlinkSync('versions/1.2.3', join(pultHome, 'current'))
      const r = run({ ...noEntry, PULT_DRY_RUN: '1' })
      assert.equal(r.code, 0, r.stderr)
      assert.equal(r.dry?.['entry'], join(pultHome, 'current', 'lib', 'node_modules', 'pult', 'dist', 'daemon', 'main.js'))
    })

    it('рабочая копия (--dev): current/dist/daemon/main.js', () => {
      writeFileSync(stateFile, `${process.execPath}\n`)
      const root = join(tmp, 'workcopy')
      mkdirSync(join(root, 'dist', 'daemon'), { recursive: true })
      writeFileSync(join(root, 'dist', 'daemon', 'main.js'), '')
      mkdirSync(join(pultHome, 'versions'), { recursive: true })
      symlinkSync(root, join(pultHome, 'versions', '0.1.0-dev'))
      symlinkSync('versions/0.1.0-dev', join(pultHome, 'current'))
      const r = run({ ...noEntry, PULT_DRY_RUN: '1' })
      assert.equal(r.code, 0, r.stderr)
      assert.equal(r.dry?.['entry'], join(pultHome, 'current', 'dist', 'daemon', 'main.js'))
    })

    it('установленная раскладка важнее рабочей копии, если есть обе', () => {
      writeFileSync(stateFile, `${process.execPath}\n`)
      const base = join(pultHome, 'versions', '2.0.0')
      mkdirSync(join(base, 'lib', 'node_modules', 'pult', 'dist', 'daemon'), { recursive: true })
      mkdirSync(join(base, 'dist', 'daemon'), { recursive: true })
      writeFileSync(join(base, 'lib', 'node_modules', 'pult', 'dist', 'daemon', 'main.js'), '')
      writeFileSync(join(base, 'dist', 'daemon', 'main.js'), '')
      symlinkSync('versions/2.0.0', join(pultHome, 'current'))
      const r = run({ ...noEntry, PULT_DRY_RUN: '1' })
      assert.match(String(r.dry?.['entry']), /lib\/node_modules\/pult\/dist\/daemon\/main\.js$/)
    })

    it('активной версии нет вовсе — код 78, а не падение node на несуществующем файле', () => {
      writeFileSync(stateFile, `${process.execPath}\n`)
      const r = run(noEntry)
      assert.equal(r.code, 78)
      assert.match(r.stderr, /current\/dist\/daemon\/main\.js/)
    })
  })

  describe('service.log', () => {
    const log = (): string => join(pultHome, 'logs', 'service.log')

    it('больше 5 МБ — обрезается до нуля перед exec', () => {
      writeFileSync(stateFile, `${process.execPath}\n`)
      writeFileSync(log(), '')
      truncateSync(log(), 5 * 1024 * 1024 + 1)
      const r = run({ PULT_DRY_RUN: '1' })
      assert.equal(r.code, 0, r.stderr)
      assert.equal(statSync(log()).size, 0)
      assert.match(r.stderr, /обрезан/)
    })

    it('ровно 5 МБ и меньше — не трогается', () => {
      writeFileSync(stateFile, `${process.execPath}\n`)
      writeFileSync(log(), '')
      truncateSync(log(), 5 * 1024 * 1024)
      run({ PULT_DRY_RUN: '1' })
      assert.equal(statSync(log()).size, 5 * 1024 * 1024)
    })
  })

  it('SIGTERM, пока лаунчер ищет node (до exec), — выход с кодом 0, а не смерть от сигнала', async () => {
    // Регрессия B1 повторной приёмки В4 (23.09.2026, настоящий launchd): `pult daemon stop` слал
    // `launchctl kill SIGTERM` процессу службы, пока тот был ещё sh-лаунчером без trap. Смерть от
    // сигнала для `KeepAlive {SuccessfulExit: false}` — «неуспешный выход», и launchd поднимал
    // службу, которую просили остановить. Окно лаунчера делаем долгим: сохранённый «node» на `-v`
    // засыпает на 3 с (и пишет свой pid, чтобы тест его добил).
    const mark = join(tmp, 'slow-node.pid')
    rmSync(mark, { force: true })
    const slowNode = join(stubs, 'slow-node')
    writeFileSync(slowNode, `#!/bin/sh\necho $$ > '${mark}'\nexec sleep 3\n`)
    chmodSync(slowNode, 0o755)
    writeFileSync(stateFile, `${slowNode}\n`)
    const child = spawn('/bin/sh', [LAUNCH], {
      stdio: 'ignore',
      env: { HOME: fakeHome, SHELL: shellStub, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', PULT_HOME: pultHome, PULT_ENTRY: entry },
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.on('exit', (code, signal) => r({ code, signal })))
    try {
      const deadline = Date.now() + 10_000
      while (!existsSync(mark) && Date.now() < deadline) await new Promise<void>((r) => setTimeout(r, 20))
      assert.ok(existsSync(mark), 'лаунчер не дошёл до проверки node')
      child.kill('SIGTERM')
      assert.deepEqual(await exited, { code: 0, signal: null })
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      const pid = existsSync(mark) ? Number(readFileSync(mark, 'utf8').trim()) : 0
      if (pid > 0) { try { process.kill(pid, 'SIGKILL') } catch { /* ушёл */ } }
    }
  })

  it('POSIX sh: sh -n (и dash -n, если он есть)', () => {
    assert.equal(spawnSync('/bin/sh', ['-n', LAUNCH]).status, 0)
    const dash = spawnSync('/bin/dash', ['-n', LAUNCH])
    if (!dash.error) assert.equal(dash.status, 0)
  })

  it('лаунчер в пакете исполняемый', () => {
    assert.ok((statSync(LAUNCH).mode & 0o111) !== 0)
  })
})
