// Файлы службы и разбор ответов менеджеров служб — без единого запуска launchctl/systemctl.
// Главное здесь — экранирование: PULT_HOME с пробелом и `&` обязан пережить plist (XML) и юнит
// (кавычки и `%`), иначе launchd молча не грузит файл, а systemd подставляет свои `%h`/`%u`.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { layout } from '../dist/core/paths.js'
import { serviceContext, SYSTEM_BINS } from '../dist/service/context.js'
import { tccWarning } from '../dist/service/install.js'
import { formatServiceLine, sameDir } from '../dist/service/status.js'
import { launchdNotLoaded, parseLaunchctlPrint, parseSystemctlShow } from '../dist/service/manager.js'
import {
  plistProcessType, RenderError, renderPlist, renderUnit, serviceHomeOf, serviceLauncherOf, servicePath, xmlEscape,
} from '../dist/service/render.js'
import type { RenderInput } from '../dist/service/render.js'

const FIXTURES = fileURLToPath(new URL('../test/fixtures/service/', import.meta.url))

const WEIRD_HOME = '/tmp/Мой дом & 100% "pult" $HOME'

function input(platform: 'darwin' | 'linux', pultHome = WEIRD_HOME): RenderInput {
  return {
    platform,
    name: platform === 'darwin' ? 'dev.pult.daemon' : 'pultd.service',
    launcher: join(pultHome, 'bin', 'pultd-launch'),
    pultHome,
    serviceLog: join(pultHome, 'logs', 'service.log'),
    home: '/Users/user',
    nodeExec: '/opt/homebrew/Cellar/node/22.9.0/bin/node',
  }
}

describe('plist', () => {
  it('экранирует PULT_HOME с пробелами, & и кавычками и возвращает его разбором обратно', () => {
    const text = renderPlist(input('darwin'))
    assert.ok(!text.includes('Мой дом & 100%'), 'голый & в XML — битый plist')
    assert.ok(text.includes('Мой дом &amp; 100% &quot;pult&quot; $HOME'))
    assert.equal(serviceHomeOf('darwin', text), WEIRD_HOME)
    assert.equal(serviceLauncherOf('darwin', text), join(WEIRD_HOME, 'bin', 'pultd-launch'))
  })

  it('ключи по docs/08 §2: KeepAlive/SuccessfulExit=false, ThrottleInterval 10, service.log, PULT_SERVICE=1', () => {
    const t = renderPlist(input('darwin', '/Users/user/.pult'))
    assert.match(t, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/)
    assert.match(t, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/)
    assert.match(t, /<key>RunAtLoad<\/key>\s*<true\/>/)
    assert.match(t, /<key>StandardOutPath<\/key>\s*<string>\/Users\/user\/\.pult\/logs\/service\.log<\/string>/)
    assert.match(t, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/user\/\.pult\/logs\/service\.log<\/string>/)
    assert.match(t, /<key>PULT_SERVICE<\/key>\s*<string>1<\/string>/)
    // Standard, а не Background: фоновый приоритет наследуют claude/codex, которых запускает демон
    // (замер 30.09.2026 на настоящем launchd: 22,8 с против 1,3 с на одном и том же наборе запусков).
    assert.match(t, /<key>ProcessType<\/key>\s*<string>Standard<\/string>/)
    assert.equal(plistProcessType(t), 'Standard')
    assert.equal(plistProcessType(t.replace('<string>Standard</string>', '<string>Background</string>')), 'Background')
    assert.equal(plistProcessType('<plist><dict></dict></plist>'), null)
    assert.match(t, /<key>WorkingDirectory<\/key>\s*<string>\/Users\/user<\/string>/)
    assert.ok(!t.includes('pultd.log'), 'служба пишет в service.log, а не в JSONL демона')
    // Комментарий XML не может содержать «--»: plutil ругнётся, launchd не загрузит.
    for (const c of t.match(/<!--([\s\S]*?)-->/g) ?? []) assert.ok(!c.slice(4, -3).includes('--'), c)
  })

  it('plutil -lint принимает plist со странным PULT_HOME (только macOS)', { skip: process.platform !== 'darwin' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-'))
    try {
      const f = join(dir, 'x.plist')
      writeFileSync(f, renderPlist(input('darwin')))
      const r = spawnSync('/usr/bin/plutil', ['-lint', f], { encoding: 'utf8' })
      assert.equal(r.status, 0, r.stdout + r.stderr)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('перевод строки в пути отвергается, а не пишется в файл', () => {
    assert.throws(() => renderPlist(input('darwin', '/tmp/a\nb')), RenderError)
    assert.throws(() => renderUnit(input('linux', '/tmp/a\nb')), RenderError)
  })

  it('xmlEscape экранирует все пять сущностей', () => {
    assert.equal(xmlEscape(`<a & 'b' "c">`), '&lt;a &amp; &apos;b&apos; &quot;c&quot;&gt;')
  })
})

describe('юнит systemd', () => {
  it('экранирует %, кавычки и $ и возвращает PULT_HOME и лаунчер разбором обратно', () => {
    const t = renderUnit(input('linux'))
    // Голый `%` systemd понял бы как спецификатор: `100% "` → мусор или отказ разбора.
    assert.ok(!/[^%]%[^%]/.test(t.split('\n').filter((l) => !l.startsWith('#')).join('\n')), 'одиночный % в юните')
    assert.match(t, /^Environment="PULT_HOME=\/tmp\/Мой дом & 100%% \\"pult\\" \$HOME"$/m)
    // В ExecStart доллар раскрывается как переменная — он удвоен.
    assert.match(t, /^ExecStart="\/tmp\/Мой дом & 100%% \\"pult\\" \$\$HOME\/bin\/pultd-launch"$/m)
    assert.equal(serviceHomeOf('linux', t), WEIRD_HOME)
    assert.equal(serviceLauncherOf('linux', t), join(WEIRD_HOME, 'bin', 'pultd-launch'))
  })

  it('StartLimit* в [Unit], Restart=on-failure, append: в service.log, нет After=default.target', () => {
    const t = renderUnit(input('linux', '/home/user/.pult'))
    const unitSection = t.slice(t.search(/^\[Unit\]$/m), t.search(/^\[Service\]$/m))
    assert.match(unitSection, /^StartLimitIntervalSec=60$/m)
    assert.match(unitSection, /^StartLimitBurst=5$/m)
    assert.match(t, /^Restart=on-failure$/m)
    assert.match(t, /^StandardOutput=append:\/home\/user\/\.pult\/logs\/service\.log$/m)
    assert.match(t, /^StandardError=append:\/home\/user\/\.pult\/logs\/service\.log$/m)
    assert.match(t, /^Environment="PULT_SERVICE=1"$/m)
    assert.match(t, /^WantedBy=default\.target$/m)
    // After=default.target вместе с WantedBy=default.target — цикл упорядочения: цель сама
    // получает After= на все свои Wants= (systemd.target(5)). Спайковый юнит его содержал.
    assert.ok(!/^After=default\.target$/m.test(t))
    assert.ok(!t.includes('%h'), 'PULT_HOME абсолютный, без спецификаторов')
  })
})

describe('PATH службы', () => {
  it('каталог node первым, без дублей, с системным полом', () => {
    const p = servicePath('darwin', '/usr/local/bin/node', '/Users/user')
    assert.equal(p, '/usr/local/bin:/opt/homebrew/bin:/Users/user/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin')
    const l = servicePath('linux', '/home/user/.nvm/versions/node/v22.9.0/bin/node', '/home/user')
    assert.ok(l.startsWith('/home/user/.nvm/versions/node/v22.9.0/bin:'))
    assert.ok(!l.includes('/opt/homebrew'))
  })
})

describe('разбор ответов менеджеров служб', () => {
  // Образцы — НАСТОЯЩИЙ вывод launchctl, записанный лидом 23.09.2026 (test/fixtures/service/README.md).
  // Прежние синтетические образцы врали: у работающей службы стояло `last exit code = 0`, а смерть
  // от сигнала не было чем показать — `pult daemon status` после kill -9 печатал «последний код —».
  it('launchctl print (настоящий): работает — pid, выхода ещё не было, вложенные state не путают', () => {
    const r = parseLaunchctlPrint(readFileSync(join(FIXTURES, 'launchctl-print-running.txt'), 'utf8'))
    assert.deepEqual(r, { state: 'running', pid: 24594, lastExitCode: null, lastSignal: null, runs: 1 })
  })

  it('launchctl print (настоящий): после kill -9 — «last terminating signal», строки кода нет', () => {
    const r = parseLaunchctlPrint(readFileSync(join(FIXTURES, 'launchctl-print-after-kill.txt'), 'utf8'))
    assert.deepEqual(r, { state: 'spawn scheduled', pid: null, lastExitCode: null, lastSignal: { num: 9, name: 'Killed' }, runs: 1 })
  })

  it('launchctl print: выход 78 с расшифровкой, строки pid нет', () => {
    const r = parseLaunchctlPrint(readFileSync(join(FIXTURES, 'launchctl-print-exited-78.txt'), 'utf8'))
    assert.deepEqual(r, { state: 'spawn scheduled', pid: null, lastExitCode: 78, lastSignal: null, runs: 1 })
  })

  it('строка службы: смерть от сигнала — «сигнал 9 (Killed)», а не «—»', () => {
    const p = parseLaunchctlPrint(readFileSync(join(FIXTURES, 'launchctl-print-after-kill.txt'), 'utf8'))
    const line = formatServiceLine({
      platform: 'darwin', name: 'dev.pult.acc', file: '/x/dev.pult.acc.plist', installed: true, fileHome: '/h', ours: true,
      launcher: '/h/bin/pultd-launch', stale: null, launcherOk: true,
      manager: { loaded: true, running: false, pid: p.pid, lastExitCode: p.lastExitCode, lastSignal: p.lastSignal, runs: p.runs, state: p.state },
    })
    assert.match(line, /не запущена \(spawn scheduled\) · последний выход: сигнал 9 \(Killed\)/)
    const never = parseLaunchctlPrint(readFileSync(join(FIXTURES, 'launchctl-print-running.txt'), 'utf8'))
    const running = formatServiceLine({
      platform: 'darwin', name: 'dev.pult.acc', file: '/x/dev.pult.acc.plist', installed: true, fileHome: '/h', ours: true,
      launcher: '/h/bin/pultd-launch', stale: null, launcherOk: true,
      manager: { loaded: true, running: true, pid: never.pid, lastExitCode: never.lastExitCode, lastSignal: never.lastSignal, runs: never.runs, state: never.state },
    })
    assert.match(running, /pid 24594 · последний выход: ещё не выходила/)
  })

  it('строка службы: установлена, но не загружена — сразу с командой, которая её вернёт', () => {
    // 30.09.2026: после `pult update` служба осталась снятой, и `pult daemon status` говорил только
    // «не загружена» — чем её вернуть, человек искал сам (помог ручной `launchctl bootstrap`).
    const line = formatServiceLine({
      platform: 'darwin', name: 'dev.pult.acc', file: '/x/dev.pult.acc.plist', installed: true, fileHome: '/h', ours: true,
      launcher: '/h/bin/pultd-launch', stale: null, launcherOk: true,
      manager: { loaded: false, running: false, pid: null, lastExitCode: null, lastSignal: null, runs: null, state: null },
    })
    assert.match(line, /не загружена \(загрузить: pult daemon install\)/)
  })

  it('launchctl (настоящий): print/bootout/kickstart незагруженной метки — «не загружена»', () => {
    const text = readFileSync(join(FIXTURES, 'launchctl-missing.txt'), 'utf8')
    const blocks = text.split(/^## /m).filter(Boolean).map((b) => {
      const lines = b.trim().split('\n')
      const exit = Number((lines.pop() ?? '').replace('exit=', ''))
      return { name: lines[0], status: exit, stderr: lines.slice(1).join('\n') + '\n' }
    })
    assert.deepEqual(blocks.map((b) => [b.name, b.status]), [['print missing', 113], ['bootout missing', 3], ['kickstart missing', 113]])
    for (const b of blocks) assert.ok(launchdNotLoaded({ status: b.status, stdout: '', stderr: b.stderr, cmd: '' }), b.name)
  })

  it('systemctl show: ключ=значение', () => {
    assert.deepEqual(parseSystemctlShow('LoadState=loaded\nActiveState=failed\nMainPID=0\nExecMainStatus=78\n'),
      { LoadState: 'loaded', ActiveState: 'failed', MainPID: '0', ExecMainStatus: '78' })
  })

  it('«не загружена» у launchd узнаётся по обоим видам ответа', () => {
    assert.ok(launchdNotLoaded({ status: 3, stdout: '', stderr: 'Boot-out failed: 3: No such process\n', cmd: '' }))
    assert.ok(launchdNotLoaded({ status: 113, stdout: '', stderr: 'Could not find service "x" in domain for user gui: 501\n', cmd: '' }))
    assert.ok(!launchdNotLoaded({ status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error\n', cmd: '' }))
  })
})

describe('швы службы', () => {
  const paths = layout('/tmp/ph')

  it('без PULT_TEST=1 швы игнорируются: системные бинари и настоящий каталог служб', () => {
    const ctx = serviceContext(paths, {
      HOME: '/Users/user', PULT_SERVICE_PLATFORM: 'linux', PULT_LAUNCHCTL: '/tmp/fake', PULT_SYSTEMCTL: '/tmp/fake',
      PULT_SERVICE_DIR: '/tmp/svc',
    })
    assert.equal(ctx.platform, process.platform === 'linux' ? 'linux' : 'darwin')
    assert.equal(ctx.launchctl, SYSTEM_BINS.launchctl)
    assert.equal(ctx.systemctl, SYSTEM_BINS.systemctl)
    assert.notEqual(ctx.dir, '/tmp/svc')
  })

  it('при PULT_TEST=1 без фальшивок бинарей нет и файла службы нет — настоящее не трогается', () => {
    const ctx = serviceContext(paths, { HOME: '/Users/user', PULT_TEST: '1', PULT_SERVICE_PLATFORM: 'darwin' })
    assert.equal(ctx.launchctl, null)
    assert.equal(ctx.file, null)
  })

  it('PULT_SERVICE_NAME работает и в бою, но только с безопасными символами', () => {
    const ctx = serviceContext(paths, { HOME: '/Users/user', PULT_TEST: '1', PULT_SERVICE_PLATFORM: 'linux', PULT_SERVICE_NAME: 'pultd-lead' })
    assert.equal(ctx.name, 'pultd-lead.service')
    assert.throws(() => serviceContext(paths, { HOME: '/x', PULT_SERVICE_NAME: '../evil' }), /PULT_SERVICE_NAME/)
  })
})

describe('чья служба', () => {
  it('один дом через симлинк — тот же дом (иначе своя служба считалась бы чужой)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-'))
    try {
      const real = join(dir, 'real-home')
      mkdirSync(real)
      const link = join(dir, 'link-home')
      symlinkSync(real, link)
      assert.ok(sameDir(link, real))
      assert.ok(sameDir(join(real, '.'), real))
      assert.ok(!sameDir(join(dir, 'other'), real))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('предупреждение о ~/Desktop (TCC)', () => {
  it('рабочая копия внутри ~/Desktop на macOS — предупреждение, на Linux — нет', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-'))
    try {
      const home = join(dir, 'home')
      const pkg = join(home, 'Desktop', 'dev', 'pult')
      mkdirSync(pkg, { recursive: true })
      assert.match(tccWarning('darwin', home, [pkg]) ?? '', /Desktop.*диалог/s)
      assert.equal(tccWarning('linux', home, [pkg]), null)
      assert.equal(tccWarning('darwin', home, [join(home, 'code', 'pult')]), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
