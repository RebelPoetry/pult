// Сквозной прогон CLI по `--kind codex` против настоящего демона с ФАЛЬШИВЫМ app-server:
// start → prompt --wait → read → tree → круг разрешений → stop → rm, плюс коды выхода.
// Всё то же, что В2 проверяла для Claude, — в этом и приёмка вехи.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ensureLayout, layout } from '../dist/core/paths.js'
import type { PultPaths } from '../dist/core/paths.js'
import { FAKE_CODEX, waitFor } from './helpers.js'

const CLI = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url))

interface Run { code: number; stdout: string; stderr: string }

/**
 * ГЕРМЕТИЧНОСТЬ. `PULT_TEST_NET` (работает только вместе с `PULT_TEST=1`) подменяет стража
 * страны выхода в демоне заранее известным ответом. Без неё сквозной прогон звал настоящий
 * `curl` к api.anthropic.com и зависел от того, где сейчас выход VPN у хозяина машины.
 */
let netMode: 'ok' | 'blocked' = 'ok'

function runCli(paths: PultPaths, args: string[], timeoutMs = 25_000): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, PULT_HOME: paths.home, PULT_TEST: '1', PULT_TEST_NET: netMode, PULT_CODEX_BIN: FAKE_CODEX },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`pult ${args.join(' ')} не завершился`)) }, timeoutMs)
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }) })
  })
}

let dir: string
let paths: PultPaths
let work: string

/** Настройка фальшивого app-server: он читает её из своего cwd, а это PULT_HOME. */
function tune(cfg: Record<string, unknown>): void {
  writeFileSync(join(paths.home, '.pult-fake-codex.json'), JSON.stringify({
    scenario: 'simple', speed: 0, logOut: join(paths.home, 'server.jsonl'), ...cfg,
  }))
}

function serverLog(): Array<Record<string, unknown>> {
  const file = join(paths.home, 'server.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
}

const boots = (): number => serverLog().filter((r) => r['ev'] === 'boot').length

describe('CLI: агенты codex сквозным прогоном', () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'pt-cxcli-'))
    paths = layout(join(dir, 'h'))
    ensureLayout(paths)
    work = join(dir, 'work')
    mkdirSync(work, { recursive: true })
    tune({})
  })
  after(async () => {
    await runCli(paths, ['daemon', 'stop'])
    // Фальшивые серверы обязаны уйти вместе с демоном.
    const survivors = serverLog().filter((r) => r['ev'] === 'boot')
      .map((r) => Number(r['pid']))
      .filter((pid) => { try { process.kill(pid, 0); return true } catch { return false } })
    rmSync(dir, { recursive: true, force: true })
    assert.deepEqual(survivors, [], `app-server пережил остановку демона: ${survivors.join(', ')}`)
  })

  it('agent start --kind codex заводит агента; list показывает провайдера', async () => {
    const start = await runCli(paths, ['agent', 'start', 'c', '--kind', 'codex', '--cwd', work, '--model', 'gpt-6-astra', '--effort', 'low'])
    assert.equal(start.code, 0, start.stderr)
    assert.match(start.stdout, /агент c заведён: codex/)
    const list = JSON.parse((await runCli(paths, ['agent', 'list', '--json'])).stdout) as {
      sessions: Array<{ name: string; provider: string; lastStatus: string }>
    }
    assert.equal(list.sessions[0]?.provider, 'codex')
    assert.equal(list.sessions[0]?.lastStatus, 'cold')
    assert.equal(boots(), 0, 'agent start не имеет права поднимать app-server')
  })

  it('prompt --wait печатает ответ модели и выходит 0', async () => {
    const r = await runCli(paths, ['agent', 'prompt', 'c', 'скажи OK', '--wait'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /OK/)
    assert.equal(boots(), 1)
  })

  it('agent read печатает текст, --format json — события с провайдером codex', async () => {
    const text = await runCli(paths, ['agent', 'read', 'c'])
    assert.match(text.stdout, /OK/)
    const events = (await runCli(paths, ['agent', 'read', 'c', '--format', 'json'])).stdout
      .trim().split('\n').map((l) => JSON.parse(l) as { kind: string; provider: string })
    assert.ok(events.some((e) => e.kind === 'session.started' && e.provider === 'codex'))
    assert.ok(events.some((e) => e.kind === 'usage.updated'))
  })

  it('usage показывает окна лимита codex', async () => {
    const r = JSON.parse((await runCli(paths, ['usage', '--json'])).stdout) as {
      usage: Array<{ session: string; provider: string; turns: number; rateLimit: { windows: { five_hour: { utilization: number } } } | null }>
    }
    const row = r.usage.find((u) => u.session === 'c')
    assert.ok(row)
    assert.equal(row.provider, 'codex')
    assert.ok(row.turns >= 1)
    assert.equal(typeof row.rateLimit?.windows.five_hour.utilization, 'number')
  })

  it('ВТОРОЙ агент codex идёт в ТОТ ЖЕ процесс: два дерева, один app-server', async () => {
    const work2 = join(dir, 'work2')
    mkdirSync(work2, { recursive: true })
    assert.equal((await runCli(paths, ['agent', 'start', 'd', '--kind', 'codex', '--cwd', work2])).code, 0)
    const r = await runCli(paths, ['agent', 'prompt', 'd', 'скажи OK', '--wait'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(boots(), 1, 'второй агент обязан идти в уже поднятый app-server')
  })

  it('agent tree рисует субагента отступами', async () => {
    const sub = join(dir, 'sub')
    mkdirSync(sub, { recursive: true })
    assert.equal((await runCli(paths, ['agent', 'start', 's', '--kind', 'codex', '--cwd', sub])).code, 0)
    const r = await runCli(paths, ['agent', 'prompt', 's', 'позови субагента [[subagent]]', '--wait', '--timeout', '20000'], 40_000)
    assert.equal(r.code, 0, r.stderr)
    const tree = await runCli(paths, ['agent', 'tree', 's'])
    assert.equal(tree.code, 0)
    assert.match(tree.stdout, /Agent\(\/root\/ping\)/)
    // Инструмент субагента (`wait`) висит в дереве, а не болтается сиротой.
    assert.match(tree.stdout, /wait/)
    const json = JSON.parse((await runCli(paths, ['agent', 'tree', 's', '--json'])).stdout) as {
      roots: Array<{ kind: string; children: unknown[] }>
      orphans: number
    }
    assert.ok(json.roots.some((n) => n.kind === 'agent'))
    assert.equal(json.orphans, 0)
  })

  it('stop и rm убирают агента, общий процесс жив', async () => {
    assert.equal((await runCli(paths, ['agent', 'stop', 's'])).code, 0)
    assert.equal((await runCli(paths, ['agent', 'rm', 's'])).code, 0)
    const gone = await runCli(paths, ['agent', 'prompt', 's', 'ау', '--wait'])
    assert.equal(gone.code, 1)
    assert.match(gone.stderr, /not_found/)
    assert.equal(boots(), 1)
  })

  it('КОД 3: ход встаёт на разрешении, perm list его показывает, approve отпускает', async () => {
    const w = join(dir, 'perm')
    mkdirSync(w, { recursive: true })
    assert.equal((await runCli(paths, ['agent', 'start', 'p', '--kind', 'codex', '--cwd', w])).code, 0)
    assert.equal((await runCli(paths, ['agent', 'prompt', 'p', 'правь файл [[permission-accept]]', '--json'])).code, 0)

    let pendingId = ''
    const seen = await waitFor(async () => {
      const r = await runCli(paths, ['perm', 'list', '--json'])
      const parsed = JSON.parse(r.stdout) as { pending: Array<{ id: string; sessionId: string; toolName: string }> }
      if (!parsed.pending.length) return false
      pendingId = parsed.pending[0]!.id
      assert.equal(parsed.pending[0]?.sessionId, 'p')
      assert.equal(parsed.pending[0]?.toolName, 'commandExecution')
      return true
    }, 15_000)
    assert.ok(seen, 'запрос разрешения должен попасть в pult perm list')

    const blocked = await runCli(paths, ['agent', 'wait', 'p', '--until', 'blocked', '--timeout', '5000'])
    assert.equal(blocked.code, 3, `stdout=${blocked.stdout} stderr=${blocked.stderr}`)

    assert.equal((await runCli(paths, ['perm', 'approve', pendingId])).code, 0)
    const done = await runCli(paths, ['agent', 'wait', 'p', '--timeout', '20000'], 30_000)
    assert.equal(done.code, 0, `stdout=${done.stdout} stderr=${done.stderr}`)
    const events = (await runCli(paths, ['agent', 'read', 'p', '--format', 'json'])).stdout
      .trim().split('\n').map((l) => JSON.parse(l) as { kind: string })
    assert.ok(events.some((e) => e.kind === 'permission.requested'))
    assert.ok(events.some((e) => e.kind === 'permission.resolved'))
  })

  it('КОД 2: таймаут ожидания', async () => {
    const slow = join(dir, 'slow')
    mkdirSync(slow, { recursive: true })
    assert.equal((await runCli(paths, ['agent', 'start', 'slow', '--kind', 'codex', '--cwd', slow])).code, 0)
    const r = await runCli(paths, ['agent', 'prompt', 'slow', 'думай долго [[hang]]', '--wait', '--timeout', '400'])
    assert.equal(r.code, 2, `stdout=${r.stdout} stderr=${r.stderr}`)
    assert.match(r.stderr, /таймаут/)
    await runCli(paths, ['agent', 'stop', 'slow'])
  })

  it('КОД 5: падение app-server, потолок перезапусков и provider reset codex', async () => {
    const crash = join(dir, 'crash')
    mkdirSync(crash, { recursive: true })
    assert.equal((await runCli(paths, ['agent', 'start', 'x', '--kind', 'codex', '--cwd', crash])).code, 0)

    // Одно падение = код 5 у ХОДА, но провайдер ещё работает: новые агенты заводятся.
    const first = await runCli(paths, ['agent', 'prompt', 'x', 'падай [[crash]]', '--wait', '--timeout', '20000'], 40_000)
    assert.equal(first.code, 5, `stdout=${first.stdout} stderr=${first.stderr}`)
    assert.match(first.stderr, /provider_unavailable/)
    assert.equal((await runCli(paths, ['agent', 'start', 'x1', '--kind', 'codex', '--cwd', crash])).code, 0,
      'с одного падения провайдер останавливаться не должен')

    // Дальше — до потолка перезапусков.
    for (let i = 0; i < 5; i++) {
      await runCli(paths, ['agent', 'prompt', 'x', `падай ещё ${i} [[crash]]`, '--wait', '--timeout', '20000'], 40_000)
      const probe = await runCli(paths, ['agent', 'start', `y${i}`, '--kind', 'codex', '--cwd', crash])
      if (probe.code === 5) break
    }
    const blockedStart = await runCli(paths, ['agent', 'start', 'x2', '--kind', 'codex', '--cwd', crash])
    assert.equal(blockedStart.code, 5, `провайдер обязан быть остановлен потолком: ${blockedStart.stdout}`)
    assert.match(blockedStart.stderr, /provider_unavailable/)

    const reset = await runCli(paths, ['provider', 'reset', 'codex'])
    assert.equal(reset.code, 0)
    assert.match(reset.stdout, /снята/)
    assert.equal((await runCli(paths, ['agent', 'start', 'x3', '--kind', 'codex', '--cwd', crash])).code, 0)
    const after = await runCli(paths, ['agent', 'prompt', 'x3', 'скажи OK', '--wait', '--timeout', '20000'], 40_000)
    assert.equal(after.code, 0, `после сброса ходы обязаны идти: ${after.stderr}`)
  })

  it('КОД 4: страж страны выхода запретил ход — и сказал ПОЧЕМУ', async () => {
    const blocked = join(dir, 'netblocked')
    mkdirSync(blocked, { recursive: true })
    await runCli(paths, ['daemon', 'stop'])
    netMode = 'blocked'
    try {
      assert.equal((await runCli(paths, ['agent', 'start', 'nb', '--kind', 'codex', '--cwd', blocked])).code, 0)
      const r = await runCli(paths, ['agent', 'prompt', 'nb', 'привет', '--wait', '--timeout', '20000'], 40_000)
      assert.equal(r.code, 4, `stdout=${r.stdout} stderr=${r.stderr}`)
      assert.match(r.stderr, /blocked_network/)
      // КОНТРАКТ 6 у самого края: человек обязан прочитать причину, а не пустой хвост.
      assert.match(r.stderr, /страж сети: blocked_country/)
      const events = (await runCli(paths, ['agent', 'read', 'nb', '--format', 'json'])).stdout
        .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string })
      assert.ok(events.some((e) => e.kind === 'net.blocked'), 'в журнале обязан быть net.blocked')
    } finally {
      netMode = 'ok'
      await runCli(paths, ['daemon', 'stop'])
    }
  })

  it('КОД 5: исчерпанный лимит — код 5 и ТЕКСТ провайдера на stderr', async () => {
    // Контракт 6: «текст ошибки никогда не теряется». До правки CLI печатал `result.text`
    // (у проваленного хода он пуст) и человек видел «ход не удался: limited — ».
    const lim = join(dir, 'limited')
    mkdirSync(lim, { recursive: true })
    assert.equal((await runCli(paths, ['agent', 'start', 'lim', '--kind', 'codex', '--cwd', lim])).code, 0)
    const r = await runCli(paths, ['agent', 'prompt', 'lim', 'трать [[usage-limit]]', '--wait', '--timeout', '20000'], 40_000)
    assert.equal(r.code, 5, `stdout=${r.stdout} stderr=${r.stderr}`)
    assert.match(r.stderr, /limited/)
    assert.match(r.stderr, /hit your usage limit/)
    const events = (await runCli(paths, ['agent', 'read', 'lim', '--format', 'json'])).stdout
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string })
    assert.ok(events.some((e) => e.kind === 'limit.hit'), 'в журнале обязан быть limit.hit')
  })

  it('КОД 4: сеть умерла посреди хода — шторм повторов, текст на stderr, net.blocked в журнале', async () => {
    const dead = join(dir, 'netdead')
    mkdirSync(dead, { recursive: true })
    assert.equal((await runCli(paths, ['agent', 'start', 'nd', '--kind', 'codex', '--cwd', dead])).code, 0)
    const r = await runCli(paths, ['agent', 'prompt', 'nd', 'иди [[retry-storm]]', '--wait', '--timeout', '20000'], 40_000)
    assert.equal(r.code, 4, `stdout=${r.stdout} stderr=${r.stderr}`)
    assert.match(r.stderr, /blocked_network/)
    assert.match(r.stderr, /Reconnecting/)
    const events = (await runCli(paths, ['agent', 'read', 'nd', '--format', 'json'])).stdout
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string })
    assert.ok(events.some((e) => e.kind === 'net.blocked'))
  })
})
