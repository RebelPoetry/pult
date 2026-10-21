// Импорт чужого треда Codex сквозным прогоном: демон → `thread/fork` отдельным app-server →
// агент `cold` с историей → реплика → общий app-server ВОЗОБНОВЛЯЕТ КОПИЮ, а не заводит пустой тред
// и не трогает исходный. Без этого импорт молча терял бы весь контекст разговора.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { connectClient } from '../dist/cli/client.js'
import { ensureLayout, layout } from '../dist/core/paths.js'
import type { PultPaths } from '../dist/core/paths.js'
import { FAKE_CODEX } from './helpers.js'

const CLI = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url))
const SOURCE = '01a11209-e63b-74b2-98f9-51ddad8d7509'
const FORK = '05291e2f-16e8-4903-8312-8b8a67274299'

function runCli(paths: PultPaths, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, PULT_HOME: paths.home, PULT_TEST: '1', PULT_TEST_NET: 'ok', PULT_CODEX_BIN: FAKE_CODEX },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`pult ${args.join(' ')} не завершился`)) }, 25_000)
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }) })
  })
}

let dir: string
let paths: PultPaths
let work: string

const serverLog = (): Array<Record<string, unknown>> => {
  const file = join(paths.home, 'server.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []
}
const calls = (method: string): Array<Record<string, unknown>> =>
  serverLog().flatMap((r) => { const m = r['msg'] as { method?: string; params?: Record<string, unknown> } | undefined; return m?.method === method ? [m.params ?? {}] : [] })

describe('импорт треда Codex', () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'pt-cximp-'))
    paths = layout(join(dir, 'h'))
    ensureLayout(paths)
    work = join(dir, 'work')
    mkdirSync(work, { recursive: true })
    writeFileSync(join(paths.home, '.pult-fake-codex.json'), JSON.stringify({
      scenario: 'simple', speed: 0, logOut: join(paths.home, 'server.jsonl'),
      externalThreads: [{ id: SOURCE, cwd: work, name: 'Разговор из Codex', updatedAt: 1_790_000_000 }],
      externalItems: { [SOURCE]: [
        { type: 'userMessage', content: [{ type: 'text', text: 'Вопрос из Codex' }] },
        { type: 'agentMessage', text: 'Ответ из Codex' },
      ] },
    }))
  })
  after(async () => {
    await runCli(paths, ['daemon', 'stop'])
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  it('агент из копии: история в журнале, первая реплика возобновляет копию', async () => {
    assert.equal((await runCli(paths, ['agent', 'list'])).code, 0)
    const c = await connectClient(paths)
    try {
      const rec = await c.request('agent.import', { provider: 'codex', id: SOURCE, name: 'imp' }, { timeoutMs: 20_000 }) as Record<string, unknown>
      assert.equal(rec['providerSessionId'], FORK)
      assert.equal(rec['provider'], 'codex')
      assert.equal(rec['cwd'], work)
    } finally { c.close() }
    assert.deepEqual(calls('thread/fork').map((p) => [p['threadId'], p['excludeTurns']]), [[SOURCE, true]])

    const history = (await runCli(paths, ['agent', 'read', 'imp'])).stdout
    assert.match(history, /Ответ из Codex/)

    const r = await runCli(paths, ['agent', 'prompt', 'imp', 'продолжай', '--wait'])
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(calls('thread/resume').map((p) => p['threadId']), [FORK], 'реплика обязана возобновить копию')
    assert.ok(!calls('thread/resume').some((p) => p['threadId'] === SOURCE), 'исходный тред не трогаем')
    const turn = calls('turn/start').at(-1)
    assert.equal(turn?.['threadId'], FORK)
  })
})
