// Страж утечек `scripts/ci-leakguard.mjs` (раздел F в ci-check.sh): ловит личные данные в любой форме,
// в которой они уже попадали в записи, и пропускает заглушки. Файлы — во временной папке.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { ROOT } from './pack-helpers.js'

const GUARD = join(ROOT, 'scripts', 'ci-leakguard.mjs')

describe('ci-leakguard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lg-'))
  after(() => { rmSync(dir, { recursive: true, force: true }) })

  function scan(text: string): { code: number | null; rules: string[] } {
    const f = join(dir, `f-${Math.random().toString(36).slice(2)}.txt`)
    writeFileSync(f, text)
    const r = spawnSync(process.execPath, [GUARD], { input: `${f}\n`, encoding: 'utf8' })
    const rules = [...(r.stderr ?? '').matchAll(/:\d+: ([a-z-]+) — /g)].map((m) => m[1] ?? '')
    return { code: r.status, rules }
  }

  // Улики собираются из частей: этот файл сам проходит через стража в CI и не должен в него попадать.
  const login = ['j', 'doe'].join('')
  const tmpId = ['k3j4h5g6f7d8s9', 'a0_q1w2e3r4t5y6u7'].join('')

  it('ловит домашний путь, его кодировку в папке проекта Claude, личную временную папку macOS и почту на любом домене', () => {
    const r = scan([
      `"cwd":"/Users/${login}/src/app"`,
      `"auto":"/Users/you/.claude/projects/-Users-${login}-src-app/memory/"`,
      `/private/var/folders/ab/${tmpId}/T/pult-rec-x`,
      `-private-var-folders-ab-${tmpId}-T-pult-rec-x`,
      `кэш: /var/folders/ab/${tmpId}/C/com.apple`,
      `хвост имени: "-Users-${login}" и '/x/-home-${login}'`,
      `автор: ${login}@corp.tech, второй ящик — ${login}@mail.kz`,
      // `.md` и `.zip` — настоящие домены верхнего уровня, а не расширения файлов.
      `${login}@notes.md, ${login}@files.zip`,
    ].join('\n'))
    assert.equal(r.code, 1)
    assert.deepEqual(r.rules, ['foreign-home', 'encoded-home', 'macos-user-tmp', 'macos-user-tmp', 'macos-user-tmp',
      'encoded-home', 'encoded-home', 'email', 'email', 'email', 'email'])
  })

  it('ловит ссылку на страницу claude.ai — артефакт аккаунта, но не адреса продукта', () => {
    const host = ['claude', 'ai'].join('.')
    const r = scan([
      `план: https://${host}/artifact/Wo8j9Y9HrwBe5zUXg5nn1W`,
      `код: https://${host}/code/artifact/0c4e2a51-7d0b-4f7e-9a3c-5b1d2e8f6a90`,
      `продукт: https://${host}/code и irm https://${host}/install.ps1 | iex`,
    ].join('\n'))
    assert.equal(r.code, 1)
    assert.deepEqual(r.rules, ['claude-artifact', 'claude-artifact'])
  })

  it('пропускает заглушки, адреса-примеры и имена файлов с @', () => {
    const r = scan([
      '/Users/you/x /home/runner/work -Users-you-Desktop-x /Users/user/y',
      '/var/folders/xy/0000000000000000000000000000gn/T/a -private-var-folders-xy-0000000000000000000000000000gn-T-b',
      'noreply@anthropic.com me@example.com pult-test@example.invalid',
      'trayTemplate@2x.png plugins.codex-app-tools@openai-bundled.mcp icon@3x.avif photo@2x.heic doc@2x.pdf',
      // CSS-переменные и флаги с -home-/-Users- — не пути.
      '--home-bg-color: #fff; var(--Users-list-width); sh install.sh --home-dir x',
      // Адреса машин-заглушек и версии пакетов.
      'user@host.local admin@db.internal me@nas.lan',
      'npm i pkg@1.0.0-beta.foo react@19.3.0 lib@v2.1.0-rc.next',
    ].join('\n'))
    assert.equal(r.code, 0, r.rules.join(' '))
  })
})
