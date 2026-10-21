#!/usr/bin/env node
// stub-probe.mjs — второй проход спайка Hermes (docs/09-DELTA-hermes-spike.md §6): закрывает пробелы
// судьи БЕЗ единого вызова модели. Бюджет живых ходов исчерпан (12/12), поэтому вместо Anthropic —
// локальная заглушка Messages API.
//
//   node spike/hermes/stub-probe.mjs <шаг>   шаги: setup k2 k2c usage k4 delegate k1 k5 proxy auth
//
// Как это устроено (всё под LAB, см. README.md, раздел «Второй проход»):
//   hermes acp (настоящий, pinned) → плагин directsdk (настоящий) → настоящий `claude` через
//   lab/claude-fixture.sh (ключ-фикстура, пустой CLAUDE_CONFIG_DIR) → relay плагина →
//   lab/sitecustomize.py переводит его единственное соединение с api.anthropic.com на заглушку ниже.
// Заглушка отвечает по сценарию, который выбирает метка [[...]] в последней реплике пользователя,
// и пишет в LAB/raw/stub-<шаг>-upstream.jsonl размер и состав каждого запроса (без значений заголовков).
// Страховка: запрос с заголовком `authorization` (OAuth-вход владельца) заглушка не обслуживает и шаг падает.

import http from 'node:http'
import net from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  Acp, Egress, childEnv as baseChildEnv, descendants, exitCheck, tempRepo, kinds, textOf, jlog, readJson, writeJson, sleep, now,
  LAB, RAW, REPO, HERE,
} from './acp-probe.mjs'

const REAL_CLAUDE = execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim()
const STUBPY = join(LAB, 'stubpy')
const HOME_PROD = join(LAB, 'home-stub')        // копия home + «боевой» конфиг (tirith off, aux on)
const HOME_LABCFG = join(LAB, 'home-stub-lab')  // копия home с конфигом первого прохода (aux off)
const CLAUDE_STUB_DIR = join(LAB, 'claude-stub')
const HTTPS_LOG = join(RAW, 'stub-https.jsonl')

// ---------------- заглушка Messages API ----------------
// Сценарий: fn({marker, step, kind, body, hermes}) → ответ. step — сколько ответов ассистента уже было
// после реплики с меткой (0 — первый вызов хода). kind: main (есть инструменты Hermes/claude), aux.
const USAGE = { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

function sse(model, blocks, stop, usage) {
  const ev = []
  ev.push({ type: 'message_start', message: { id: 'msg_stub_' + randomUUID().slice(0, 8), type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } })
  blocks.forEach((b, i) => {
    if (b.type === 'text') {
      ev.push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } })
      ev.push({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text } })
    } else {
      ev.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: 'toolu_stub_' + randomUUID().slice(0, 8), name: b.name, input: {} } })
      ev.push({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } })
    }
    ev.push({ type: 'content_block_stop', index: i })
  })
  ev.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } })
  ev.push({ type: 'message_stop' })
  return ev.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

function textOfContent(c) {
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
}

function analyse(body) {
  const tools = (body.tools || []).map((t) => t.name)
  const hermes = tools.some((n) => n === 'mcp__hermes__terminal')
  const native = tools.includes('Bash')
  let marker = null, step = 0
  const msgs = body.messages || []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role === 'assistant') { step++; continue }
    const mm = textOfContent(m.content).match(/\[\[([^\]]+)\]\]/g)
    if (mm) { marker = mm[mm.length - 1].slice(2, -2); break }
  }
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
  const lastHasToolResult = Array.isArray(lastUser?.content) && lastUser.content.some((b) => b.type === 'tool_result')
  return { tools, hermes, native, marker, step, lastHasToolResult, kind: hermes || native ? 'main' : 'aux' }
}

class Stub {
  constructor(file, scenario) {
    this.file = file; this.scenario = scenario; this.n = 0; this.violations = 0; this.requests = []
    this.server = http.createServer((req, res) => this.onRequest(req, res))
  }
  async start() { await new Promise((r) => this.server.listen(0, '127.0.0.1', r)); this.port = this.server.address().port; return this }
  stop() { return new Promise((r) => this.server.close(() => r())) }
  onRequest(req, res) {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      const raw = Buffer.concat(chunks)
      const auth = req.headers.authorization ? 'authorization' : req.headers['x-api-key'] ? 'x-api-key' : 'none'
      const row = { t: now(), n: ++this.n, method: req.method, path: req.url.replace(/\?.*/, ''), auth, bytes: raw.length }
      if (auth === 'authorization') {
        // Сюда мог прийти только настоящий OAuth-вход — в лаборатории его быть не должно. Не обслуживаем.
        this.violations++
        row.violation = 'oauth-header'
        jlog(this.file, row)
        res.writeHead(500); res.end(); return
      }
      if (req.method !== 'POST' || !/\/v1\/messages$/.test(row.path)) {
        jlog(this.file, row); res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}'); return
      }
      let body = {}
      try { body = JSON.parse(raw.toString('utf8')) } catch { /* пусто */ }
      const a = analyse(body)
      const sys = typeof body.system === 'string' ? body.system : JSON.stringify(body.system || '')
      Object.assign(row, {
        model: body.model, kind: a.kind, marker: a.marker, step: a.step, toolsCount: a.tools.length,
        systemBytes: Buffer.byteLength(sys), toolsBytes: Buffer.byteLength(JSON.stringify(body.tools || [])),
        messagesBytes: Buffer.byteLength(JSON.stringify(body.messages || [])), messages: (body.messages || []).length,
        lastUser: textOfContent([...(body.messages || [])].reverse().find((m) => m.role === 'user')?.content).slice(0, 160),
        maxTokens: body.max_tokens, thinking: body.thinking?.type || null,
      })
      let out
      try { out = (await this.scenario({ ...a, body, raw: raw.toString('utf8'), n: this.n })) || { text: 'OK' } } catch (e) { out = { text: 'stub error ' + e.message } }
      row.reply = out.status ? `http ${out.status}` : out.tool ? `tool ${out.tool.name}` : `text ${String(out.text).slice(0, 40)}`
      if (out.find) row.found = Object.fromEntries(out.find.map((s) => [s, raw.includes(s)]))
      this.requests.push(row)
      jlog(this.file, row)
      if (out.delayMs) await sleep(out.delayMs)
      if (out.status) {
        res.writeHead(out.status, { 'content-type': 'application/json', 'request-id': `req_stub_${this.n}`, ...(out.headers || {}) })
        res.end(JSON.stringify(out.body || { type: 'error', error: { type: 'api_error', message: 'stub' } }))
        return
      }
      const usage = { ...USAGE, ...(out.usage || {}) }
      const blocks = out.tool ? [...(out.text ? [{ type: 'text', text: out.text }] : []), { type: 'tool_use', ...out.tool }] : [{ type: 'text', text: out.text }]
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': `req_stub_${this.n}` })
      res.end(sse(body.model || 'claude-haiku-4-5-20251001', blocks, out.tool ? 'tool_use' : 'end_turn', usage))
    })
  }
}

// Инструменты по «диалекту» запроса: Hermes (mcp__hermes__*) или сам claude (Bash/Write).
const T = {
  sh: (a, command) => a.hermes ? { name: 'mcp__hermes__terminal', input: { command } } : { name: 'Bash', input: { command, description: 'stub' } },
  write: (a, path, content) => a.hermes ? { name: 'mcp__hermes__write_file', input: { path, content } } : { name: 'Write', input: { file_path: path, content } },
}

// ---------------- окружение Hermes под заглушку ----------------
async function stubEnv({ home = HOME_PROD, stub, extra = {}, prodEnv = true } = {}) {
  const env = await baseChildEnv({ HERMES_HOME: home })
  Object.assign(env, {
    PYTHONPATH: STUBPY,
    PULT_LAB_STUB_UPSTREAM: `127.0.0.1:${stub.port}`,
    PULT_LAB_HTTPS_LOG: HTTPS_LOG,
    CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND: join(STUBPY, 'claude-fixture.sh'),
    PULT_LAB_REAL_CLAUDE: REAL_CLAUDE,
    PULT_LAB_STUB_CLAUDE_DIR: CLAUDE_STUB_DIR,
  })
  if (prodEnv) {
    // «Боевое» окружение из DELTA §4: без ленивых установок, всё XDG под LAB, PATH без gh.
    Object.assign(env, {
      HERMES_DISABLE_LAZY_INSTALLS: '1', UV_CACHE_DIR: join(LAB, 'uv-cache'),
      XDG_STATE_HOME: join(LAB, 'xdg', 'state'), XDG_DATA_HOME: join(LAB, 'xdg', 'data'), XDG_CACHE_HOME: join(LAB, 'xdg', 'cache'),
      PATH: `${join(LAB, 'venv', 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    })
  }
  Object.assign(env, extra)
  for (const k of Object.keys(env)) {
    if (/^(ANTHROPIC_|OPENAI_|HERMES_YOLO)/.test(k)) throw new Error(`env leak guard: ${k}`)
    if (/^CLAUDE_/.test(k) && k !== 'CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND') throw new Error(`env leak guard: ${k}`)
  }
  return env
}

const LIVE = new Set()
async function open(step, opts) {
  const a = new Acp({ step, ...opts })
  LIVE.add(a)
  await a.initialize()
  return a
}
async function killAll() { for (const a of LIVE) await a.kill().catch(() => {}); LIVE.clear() }

async function hardKill(a) {
  // SIGKILL всего дерева (ребёнок claude и инструмент — в своих группах), затем группы hermes.
  const tree = descendants(a.pid)
  for (const p of tree.slice(1).reverse()) { try { process.kill(p, 'SIGKILL') } catch { /* ушёл */ } }
  try { process.kill(-a.pid, 'SIGKILL') } catch { /* нет */ }
  const ex = await a.exitP
  LIVE.delete(a)
  return { tree, exit: ex }
}

async function newSession(a, cwd) { return a.request('session/new', { cwd, mcpServers: [] }, 120000) }

async function prompt(a, sessionId, text, { timeoutMs = 240000 } = {}) {
  const since = now() - a.t0
  const stderrFrom = a.stderr.length
  const t = now()
  let res, err
  try { res = await a.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, timeoutMs) } catch (e) { err = { message: e.message, rpc: e.rpc } }
  const upd = a.updates.filter((u) => u.t >= since && u.sessionId === sessionId)
  return { ms: now() - t, res, err, kinds: kinds(upd), text: textOf(upd).slice(0, 400), stderr: a.stderr.slice(stderrFrom).map((x) => x.line) }
}

function sql(db, q) {
  try { return JSON.parse(execFileSync('sqlite3', ['-json', db, q], { encoding: 'utf8' }) || '[]') } catch (e) { return [{ error: String(e.message).slice(0, 200) }] }
}

function summary(step, o) {
  writeJson(join(RAW, `stub-${step}-summary.json`), o)
  console.log(JSON.stringify(o, null, 2).slice(0, 6000))
}

const pick = (lines, re) => lines.filter((l) => re.test(l))

// ---------------- шаги ----------------
const steps = {}

// Подготовка: копии HERMES_HOME (боевой конфиг и конфиг первого прохода), stubpy, пустой каталог claude.
steps.setup = async () => {
  mkdirSync(STUBPY, { recursive: true })
  copyFileSync(join(HERE, 'lab', 'sitecustomize.py'), join(STUBPY, 'sitecustomize.py'))
  copyFileSync(join(HERE, 'lab', 'claude-fixture.sh'), join(STUBPY, 'claude-fixture.sh'))
  execFileSync('chmod', ['+x', join(STUBPY, 'claude-fixture.sh')])
  mkdirSync(CLAUDE_STUB_DIR, { recursive: true })
  for (const d of ['state', 'data', 'cache']) mkdirSync(join(LAB, 'xdg', d), { recursive: true })
  for (const h of [HOME_PROD, HOME_LABCFG]) {
    if (!existsSync(h)) cpSync(join(LAB, 'home'), h, { recursive: true })
    for (const f of ['auth.lock', 'state.db.fts_rebuild.lock']) rmSync(join(h, f), { force: true })
  }
  // Боевой конфиг: то же, что в первом проходе, но tirith выключен, а память, куратор и aux — по умолчанию (вкл).
  writeFileSync(join(HOME_PROD, 'config.yaml'), `plugins:
  enabled:
  - claude-subscription-directsdk-experimental
model:
  provider: claude-subscription-directsdk-experimental
  default: haiku
fallback_providers: []
approvals:
  mode: manual
  timeout: 3600
skills:
  write_approval: true
memory:
  write_approval: true
terminal:
  backend: local
security:
  tirith_enabled: false
`)
  const cfg = readFileSync(join(HOME_PROD, 'config.yaml'), 'utf8')
  const labCfg = readFileSync(join(HOME_LABCFG, 'config.yaml'), 'utf8')
  console.log({ realClaude: REAL_CLAUDE, prodConfig: cfg, labConfigHasNudge0: /nudge_interval: 0/.test(labCfg) })
}

// K2: как лимит (429) и перегрузка (529) видны через ACP. Ноль вызовов модели.
steps.k2 = async () => {
  exitCheck('stub-k2')
  const reset = Math.floor(Date.now() / 1000) + 3600
  const stub = await new Stub(join(RAW, 'stub-k2-upstream.jsonl'), (a) => {
    if (a.kind !== 'main') return { text: 'Stub title' }
    if (a.marker === 'api429') return { status: 429, headers: { 'retry-after': '3' }, body: { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit. Please try again in 3 seconds.' } } }
    if (a.marker === 'sub429') return { status: 429, headers: { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String(reset), 'anthropic-ratelimit-unified-representative-claim': 'five_hour' }, body: { type: 'error', error: { type: 'rate_limit_error', message: 'Error' } } }
    if (a.marker === 'o529') return { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }
    return { text: 'OK' }
  }).start()
  const cwd = tempRepo('stub-k2')
  const a = await open('stub-k2', { env: await stubEnv({ stub }), cwd })
  try {
    const out = {}
    for (const m of ['ok', 'api429', 'sub429', 'o529']) {
      const ns = await newSession(a, cwd)
      const r = await prompt(a, ns.sessionId, `[[${m}]] Reply OK`)
      const reqs = stub.requests.filter((x) => x.marker === m && x.kind === 'main')
      out[m] = {
        res: r.res, err: r.err, ms: r.ms, kinds: r.kinds, text: r.text,
        upstreamAttempts: reqs.length, attemptGapsMs: reqs.slice(1).map((x, i) => x.t - reqs[i].t),
        errorTypes: [...new Set(pick(r.stderr, /error_type=/).map((l) => (l.match(/error_type=(\S+)/) || [])[1]))],
        failLines: pick(r.stderr, /API call failed|Retrying API call|rate.?limit|resets/i).map((l) => l.replace(/^\S+ \S+ /, '').slice(0, 300)).slice(0, 8),
      }
    }
    summary('k2', { stubViolations: stub.violations, ...out })
  } finally { await killAll(); await stub.stop() }
}

// K2 правило «end_turn без usage = провал»: ложные срабатывания и привязка stderr к сессии.
steps.k2c = async () => {
  exitCheck('stub-k2c')
  const stub = await new Stub(join(RAW, 'stub-k2c-upstream.jsonl'), async (a) => {
    if (a.kind !== 'main') return { text: 'Stub title' }
    if (a.marker === 'fail') return { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } } }
    if (a.marker === 'slow') return { text: 'SLOW-DONE', delayMs: 6000 }
    return { text: 'OK' }
  }).start()
  const cwd = tempRepo('stub-k2c')
  const a = await open('stub-k2c', { env: await stubEnv({ stub }), cwd })
  try {
    const A = (await newSession(a, cwd)).sessionId // упадёт по 429
    const B = (await newSession(a, cwd)).sessionId // /help — слэш-команда
    const C = (await newSession(a, cwd)).sessionId // долгий ход + вторая реплика в него же
    const D = (await newSession(a, cwd)).sessionId // пустой промпт и обычный ход
    const pA = prompt(a, A, '[[fail]] Reply OK')
    const pC1 = prompt(a, C, '[[slow]] Reply OK')
    await sleep(800)
    const pB = prompt(a, B, '/help')
    const pC2 = prompt(a, C, '[[ok]] second prompt while the first is running')
    const pD0 = prompt(a, D, '   ')
    const [rA, rB, rC1, rC2, rD0] = await Promise.all([pA, pB, pC1, pC2, pD0])
    const rD = await prompt(a, D, '[[ok]] Reply OK')
    const all = a.stderr.map((x) => x.line)
    const sessLines = pick(all, /Prompt on session|API call failed|error_type=|Retrying API call/).map((l) => l.replace(/^\S+ \S+ /, '').slice(0, 220))
    const threads = [...new Set(pick(all, /error_type=/).map((l) => (l.match(/thread=(\S+?):/) || [])[1]))]
    const noUsage = (r) => r.res && !r.res.usage
    summary('k2c', {
      stubViolations: stub.violations,
      sessions: { A, B, C, D },
      A_fail: { res: rA.res, text: rA.text, noUsage: noUsage(rA) },
      B_slash_help: { res: rB.res, text: rB.text.slice(0, 120), noUsage: noUsage(rB) },
      C1_running: { res: rC1.res, text: rC1.text, noUsage: noUsage(rC1) },
      C2_absorbed: { res: rC2.res, text: rC2.text, noUsage: noUsage(rC2) },
      D0_empty: { res: rD0.res, noUsage: noUsage(rD0) },
      D_ok: { res: rD.res, noUsage: noUsage(rD) },
      failureThreads: threads,
      sessionIdInFailureLines: pick(all, /error_type=/).some((l) => [A, B, C, D].some((s) => l.includes(s))),
      stderrTimeline: sessLines.slice(0, 30),
    })
  } finally { await killAll(); await stub.stop() }
}

// K5-usage-granularity: PromptResponse.usage — счётчик сессии или процесса?
steps.usage = async () => {
  exitCheck('stub-usage')
  const U = { A: { input_tokens: 1000, output_tokens: 10 }, B: { input_tokens: 50000, output_tokens: 500 } }
  const stub = await new Stub(join(RAW, 'stub-usage-upstream.jsonl'), (a) => {
    if (a.kind !== 'main') return { text: 'Stub title', usage: { input_tokens: 7, output_tokens: 1 } }
    const who = (a.marker || '').split(':')[1]
    return { text: `OK ${who}`, usage: U[who] || {} }
  }).start()
  const cwd = tempRepo('stub-usage')
  const a = await open('stub-usage', { env: await stubEnv({ stub }), cwd })
  try {
    const A = (await newSession(a, cwd)).sessionId
    const B = (await newSession(a, cwd)).sessionId
    const seq = []
    for (const [s, who] of [[A, 'A'], [B, 'B'], [A, 'A'], [B, 'B']]) {
      const r = await prompt(a, s, `[[u:${who}]] Reply OK`)
      seq.push({ who, usage: r.res?.usage })
    }
    // Перезапуск и session/load: счётчик после загрузки.
    await a.kill(); LIVE.delete(a)
    const b = await open('stub-usage-reload', { env: await stubEnv({ stub }), cwd })
    await b.request('session/load', { sessionId: A, cwd, mcpServers: [] }, 120000)
    const r = await prompt(b, A, '[[u:A]] Reply OK')
    seq.push({ who: 'A after reload', usage: r.res?.usage })
    summary('usage', { stubViolations: stub.violations, stubUsagePerCall: U, seq,
      upstreamMain: stub.requests.filter((x) => x.kind === 'main').length, upstreamAux: stub.requests.filter((x) => x.kind === 'aux').length })
  } finally { await killAll(); await stub.stop() }
}

// K4: SIGKILL между ходами и посреди хода, затем session/load; восстановление cwd.
steps.k4 = async () => {
  exitCheck('stub-k4')
  const stub = await new Stub(join(RAW, 'stub-k4-upstream.jsonl'), (a) => {
    if (a.kind !== 'main') return { text: 'Stub title' }
    if (a.marker === 'sleep' && a.step === 0) return { tool: T.sh(a, 'sleep 20') }
    if (a.marker === 'pwd' && a.step === 0) return { tool: T.sh(a, 'pwd') }
    if (a.marker === 'recall') return { text: 'RECALL', find: ['K4-FIRST-TURN', 'sleep 20', 'SLEEP-INTERRUPTED-MARK'] }
    return { text: `DONE ${a.marker}` }
  }).start()
  const cwd1 = tempRepo('stub-k4-a')
  const cwd2 = tempRepo('stub-k4-b')
  const db = join(HOME_PROD, 'state.db')
  const out = {}
  try {
    // (1) между ходами: завершённый ход → SIGKILL простаивающего процесса → load.
    let a = await open('stub-k4-idle', { env: await stubEnv({ stub }), cwd: cwd1 })
    const X = (await newSession(a, cwd1)).sessionId
    const r1 = await prompt(a, X, '[[first]] K4-FIRST-TURN reply')
    out.idleKill = { turn: r1.res, kill: await hardKill(a) }
    a = await open('stub-k4-idle-load', { env: await stubEnv({ stub }), cwd: cwd1 })
    let before = a.updates.length
    let id = a.nextId
    const l1 = await a.request('session/load', { sessionId: X, cwd: cwd1, mcpServers: [] }, 120000)
    out.idleKill.load = { ok: !!l1?.models, replay: a.respAt.get(id) - before, replayKinds: kinds(a.updates.slice(before, a.respAt.get(id))) }
    const r2 = await prompt(a, X, '[[recall]] what did I say first?')
    out.idleKill.recall = { res: r2.res, found: stub.requests.at(-1)?.found }
    await a.kill(); LIVE.delete(a)

    // (2) посреди хода: инструмент `sleep 20` идёт → SIGKILL всего дерева → load с ДРУГИМ cwd.
    a = await open('stub-k4-mid', { env: await stubEnv({ stub }), cwd: cwd1 })
    const Y = (await newSession(a, cwd1)).sessionId
    const pY = prompt(a, Y, '[[sleep]] SLEEP-INTERRUPTED-MARK run sleep')
    for (let i = 0; i < 300 && !a.updates.some((u) => u.sessionId === Y && u.update?.sessionUpdate === 'tool_call'); i++) await sleep(100)
    await sleep(1500)
    const dbBefore = sql(db, `select id, cwd, message_count, ended_at, end_reason from sessions where id='${Y}'`)
    const msgsBefore = sql(db, `select role, substr(content,1,80) as c from messages where session_id='${Y}' order by id`)
    out.midKill = { toolCallSeen: a.updates.some((u) => u.sessionId === Y && u.update?.sessionUpdate === 'tool_call'), kill: await hardKill(a), dbAfterKill: dbBefore, messagesAfterKill: msgsBefore }
    await pY.catch(() => {})
    const sleepLeft = (() => { try { return execFileSync('pgrep', ['-f', '^sleep 20$'], { encoding: 'utf8' }).trim() } catch { return '' } })()
    out.midKill.orphanSleep = sleepLeft || null
    if (sleepLeft) for (const p of sleepLeft.split('\n')) { try { process.kill(Number(p), 'SIGKILL') } catch { /* нет */ } }
    a = await open('stub-k4-mid-load', { env: await stubEnv({ stub }), cwd: cwd2 })
    before = a.updates.length
    id = a.nextId
    const l2 = await a.request('session/load', { sessionId: Y, cwd: cwd2, mcpServers: [] }, 120000)
    const replay = a.updates.slice(before, a.respAt.get(id))
    out.midKill.load = {
      ok: !!l2?.models, provenance: l2?._meta?.hermes?.sessionProvenance || l2?._meta || null,
      replay: replay.length, replayKinds: kinds(replay),
      replayUserText: replay.filter((u) => u.update?.sessionUpdate === 'user_message_chunk').map((u) => u.update.content?.text?.slice(0, 80)),
      replayTools: replay.filter((u) => u.update?.sessionUpdate === 'tool_call').map((u) => ({ id: u.update.toolCallId, title: u.update.title, status: u.update.status })),
    }
    out.midKill.dbAfterLoad = sql(db, `select id, cwd from sessions where id='${Y}'`)
    const r3 = await prompt(a, Y, '[[pwd]] where am I?')
    const pwdOut = a.updates.filter((u) => u.sessionId === Y && u.update?.sessionUpdate === 'tool_call_update').map((u) => JSON.stringify(u.update.content || u.update.rawOutput || '')).join(' ')
    out.midKill.pwdTurn = { res: r3.res, cwd1, cwd2, pwdSaysCwd2: pwdOut.includes(cwd2), pwdSaysCwd1: pwdOut.includes(cwd1) }
    const r4 = await prompt(a, Y, '[[recall]] what happened?')
    out.midKill.recall = { res: r4.res, found: stub.requests.at(-1)?.found }
    summary('k4', { stubViolations: stub.violations, ...out })
  } finally { await killAll(); await stub.stop() }
}

// delegate_task: доставляется ли ответ фонового ребёнка через ACP — в простое, на следующий ход, после рестарта.
steps.delegate = async () => {
  exitCheck('stub-delegate')
  const CHILD = 'CHILD-ANSWER-7731'
  const stub = await new Stub(join(RAW, 'stub-delegate-upstream.jsonl'), (a) => {
    if (a.kind !== 'main') return { text: 'Stub title' }
    if (a.marker === 'child') return { text: CHILD }
    if (a.marker === 'delegate' && a.step === 0) return { tool: { name: 'mcp__hermes__delegate_task', input: { goal: '[[child]] Reply with the codeword.' } } }
    if (a.marker === 'delegate') return { text: 'Dispatched.' }
    return { text: `AFTER ${a.marker}`, find: [CHILD, 'duration_seconds', 'exit_reason'] }
  }).start()
  const cwd = tempRepo('stub-deleg')
  const db = join(HOME_PROD, 'state.db')
  const out = {}
  try {
    let a = await open('stub-delegate', { env: await stubEnv({ stub }), cwd })
    const S = (await newSession(a, cwd)).sessionId
    const r1 = await prompt(a, S, '[[delegate]] delegate it')
    out.turn1 = { res: r1.res, text: r1.text, kinds: r1.kinds }
    const idleFrom = a.updates.length
    const tIdle = now()
    await sleep(30000)
    out.idle30s = { unsolicitedUpdates: a.updates.slice(idleFrom).map((u) => u.update?.sessionUpdate), childRequests: stub.requests.filter((x) => x.marker === 'child').length }
    out.dbAfterIdle = sql(db, `select delegation_id, state, delivery_state, delivery_attempts from async_delegations where parent_session_id in (select id from sessions where id='${S}' or parent_session_id='${S}') or origin_session_id='${S}' order by dispatched_at desc limit 3`)
    const r2 = await prompt(a, S, '[[next]] anything new?')
    out.turn2 = { res: r2.res, text: r2.text, requestFound: stub.requests.filter((x) => x.marker === 'next').map((x) => x.found) }
    out.dbAfterTurn2 = sql(db, `select delegation_id, state, delivery_state, delivery_attempts from async_delegations order by dispatched_at desc limit 3`)
    await a.kill(); LIVE.delete(a)
    // Рестарт: restore_undelivered_completions кладёт хвосты в очередь — дойдут ли до хода?
    a = await open('stub-delegate-reload', { env: await stubEnv({ stub }), cwd })
    await a.request('session/load', { sessionId: S, cwd, mcpServers: [] }, 120000)
    const r3 = await prompt(a, S, '[[afterreload]] anything new?')
    out.turn3AfterReload = { res: r3.res, requestFound: stub.requests.filter((x) => x.marker === 'afterreload').map((x) => x.found) }
    // Настоящая сессия первого прохода (копия БД): тот же вопрос про её висящую доставку deleg_661b8408.
    const real = '41566e78-3d1a-41d3-a57c-51b569156c2a'
    await a.request('session/load', { sessionId: real, cwd, mcpServers: [] }, 120000)
    const r4 = await prompt(a, real, '[[realnext]] anything new?')
    out.realSession = { res: r4.res, requestFound: stub.requests.filter((x) => x.marker === 'realnext').map((x) => x.found),
      db: sql(db, `select delegation_id, state, delivery_state, delivery_attempts from async_delegations where delegation_id='deleg_661b8408'`) }
    out.idleMs = now() - tIdle
    summary('delegate', { stubViolations: stub.violations, ...out })
  } finally { await killAll(); await stub.stop() }
}

// K1 в боевом конфиге (tirith off, без ленивых установок, PATH без gh): эквиваленты разрушительных
// команд, режимы сессии и «allow_always».
steps.k1 = async () => {
  exitCheck('stub-k1')
  const CMDS = {
    c1: 'rm -rf ./j1', c2: 'rm j2.txt', c3: 'find ./j3 -delete', c4: `python3 -c "import shutil; shutil.rmtree('j4')"`,
    c5: 'mv j5.txt ../moved-j5.txt', c6: 'truncate -s 0 j6.txt', c8: 'rm -rf ./j8', c10a: 'rm -rf ./j10a', c10b: 'rm -rf ./j10b', c11: 'rm -rf ./j11',
  }
  const stub = await new Stub(join(RAW, 'stub-k1-upstream.jsonl'), (a) => {
    if (a.kind !== 'main') return { text: 'Stub title' }
    if (a.step === 0 && CMDS[a.marker]) return { tool: T.sh(a, CMDS[a.marker]) }
    if (a.step === 0 && a.marker === 'w9') return { tool: T.write(a, 'w9.txt', 'hi') }
    return { text: `DONE ${a.marker}` }
  }).start()
  const cwd = tempRepo('stub-k1')
  for (const d of ['j1', 'j3', 'j4', 'j8', 'j10a', 'j10b', 'j11']) { mkdirSync(join(cwd, d), { recursive: true }); writeFileSync(join(cwd, d, 'x'), 'x\n') }
  for (const f of ['j2.txt', 'j5.txt', 'j6.txt']) writeFileSync(join(cwd, f), 'keep me\n')
  const cfgBefore = readFileSync(join(HOME_PROD, 'config.yaml'), 'utf8')
  let answer = 'deny'
  const perms = []
  let current = ''
  const a = await open('stub-k1', { env: await stubEnv({ stub }), cwd, onPermission: (p) => { perms.push({ phase: current, toolCallId: p.toolCall?.toolCallId, command: p.toolCall?.rawInput?.command || p.toolCall?.rawInput?.tool, options: p.options?.map((o) => o.optionId), answered: answer }); return answer } })
  const gone = (p) => !existsSync(join(cwd, p)) || (p.endsWith('.txt') && readFileSync(join(cwd, p), 'utf8') === '')
  try {
    const S = (await newSession(a, cwd)).sessionId
    const rows = []
    const run = async (sid, m, target) => {
      current = m
      const n = perms.length
      const r = await prompt(a, sid, `[[${m}]] run it`)
      rows.push({ m, cmd: CMDS[m] || 'write_file w9.txt', asked: perms.length > n, answered: perms.length > n ? perms.at(-1).answered : null, destroyed: target ? gone(target) : null, stop: r.res?.stopReason })
    }
    for (const [m, t] of [['c1', 'j1'], ['c2', 'j2.txt'], ['c3', 'j3'], ['c4', 'j4'], ['c5', 'j5.txt'], ['c6', 'j6.txt']]) await run(S, m, t)
    await a.request('session/set_mode', { sessionId: S, modeId: 'dont_ask' })
    await run(S, 'c8', 'j8')
    await a.request('session/set_mode', { sessionId: S, modeId: 'accept_edits' })
    await run(S, 'w9', null)
    rows.at(-1).destroyed = existsSync(join(cwd, 'w9.txt')) ? 'written' : 'not written'
    await a.request('session/set_mode', { sessionId: S, modeId: 'default' })
    answer = 'allow_always'
    await run(S, 'c10a', 'j10a')
    answer = 'deny'
    await run(S, 'c10b', 'j10b')
    const S2 = (await newSession(a, cwd)).sessionId
    await run(S2, 'c11', 'j11')
    const cfgAfter = readFileSync(join(HOME_PROD, 'config.yaml'), 'utf8')
    summary('k1', { stubViolations: stub.violations, rows, perms, configChangedByAllowAlways: cfgBefore !== cfgAfter,
      configNewLines: cfgAfter.split('\n').filter((l) => !cfgBefore.split('\n').includes(l)).slice(0, 20) })
  } finally { await killAll(); await stub.stop() }
}

// K5: одна и та же задача из 3 ходов через Hermes (боевой конфиг и конфиг первого прохода) и через
// путь claude Пульта. Сравнение — объём и число запросов к Messages API (цены без живых вызовов нет).
const K5_TURNS = [['k5ok', 'Reply with exactly the two letters: OK'], ['k5ls', 'Run the shell command `ls` in the current directory and reply with the file names only.'], ['k5write', 'Create a file named hello.txt in the current directory containing exactly the word hi.']]
function k5Scenario(a) {
  if (a.kind !== 'main') return { text: 'Stub title' }
  if (a.marker === 'k5ls' && a.step === 0) return { tool: T.sh(a, 'ls') }
  if (a.marker === 'k5write' && a.step === 0) return { tool: T.write(a, 'hello.txt', 'hi') }
  if (a.marker === 'k5ok') return { text: 'OK' }
  if (a.marker === 'review' && a.step === 0) return { text: 'Nothing worth saving.' }
  return { text: a.marker === 'k5ls' ? 'README.md' : 'Done.' }
}
function k5Tally(reqs) {
  const by = (f) => reqs.filter(f)
  const sum = (rs, k) => rs.reduce((s, x) => s + (x[k] || 0), 0)
  const main = by((x) => x.kind === 'main'), aux = by((x) => x.kind === 'aux')
  return {
    requests: reqs.length, main: main.length, aux: aux.length,
    bytes: sum(reqs, 'bytes'), mainBytes: sum(main, 'bytes'), auxBytes: sum(aux, 'bytes'),
    firstMain: main[0] ? { systemBytes: main[0].systemBytes, toolsBytes: main[0].toolsBytes, toolsCount: main[0].toolsCount, messagesBytes: main[0].messagesBytes } : null,
    perTurn: Object.fromEntries(K5_TURNS.map(([m]) => [m, { main: main.filter((x) => x.marker === m).length, bytes: sum(main.filter((x) => x.marker === m), 'bytes') }])),
    auxKinds: aux.map((x) => `${x.model}:${x.maxTokens}:${x.lastUser.slice(0, 50)}`),
  }
}

async function k5Hermes(label, home, stub, { nudge } = {}) {
  const cwd = tempRepo(`stub-k5-${label}`)
  const from = stub.requests.length
  const a = await open(`stub-k5-${label}`, { env: await stubEnv({ stub, home }), cwd, onPermission: () => 'allow_once' })
  try {
    const S = (await newSession(a, cwd)).sessionId
    const res = []
    for (const [m, text] of K5_TURNS) res.push((await prompt(a, S, `[[${m}]] ${text}`)).res)
    await sleep(8000) // фоновые aux-вызовы (заголовок, разбор) успевают дойти до заглушки
    const db = join(home, 'state.db')
    return { label, nudge, stop: res.map((r) => r?.stopReason), usage: res.map((r) => r?.usage), tally: k5Tally(stub.requests.slice(from)),
      db: sql(db, `select id, parent_session_id, api_call_count, input_tokens, output_tokens from sessions where id='${S}' or parent_session_id='${S}'`) }
  } finally { await a.kill(); LIVE.delete(a) }
}

async function k5Pult(stub) {
  const { buildClaudeArgv, userTurnLine } = await import(join(REPO, 'dist', 'adapters', 'claude', 'argv.js'))
  const cfgDir = join(LAB, 'claude-stub-pult')
  mkdirSync(cfgDir, { recursive: true })
  const env = await baseChildEnv({})
  delete env.HERMES_HOME; delete env.HERMES_ACP_SKIP_CONFIGURED_MCP
  // Путь claude Пульта против заглушки: ключ-фикстура и пустой каталог — ни логина владельца, ни Anthropic.
  Object.assign(env, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`, ANTHROPIC_API_KEY: 'fixture-not-a-real-key', CLAUDE_CONFIG_DIR: cfgDir,
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1' })
  const cwd = tempRepo('stub-k5-pult')
  const sessionId = randomUUID()
  const from = stub.requests.length
  const res = []
  for (const [i, [m, text]] of K5_TURNS.entries()) {
    const argv = buildClaudeArgv({ sessionId, resume: i > 0, model: 'haiku', extra: ['--allowedTools', 'Bash(ls),Write'] })
    const c = spawn(REAL_CLAUDE, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    const file = join(RAW, 'stub-k5-pult.jsonl')
    let result = null
    const done = new Promise((resolve) => {
      createInterface({ input: c.stdout }).on('line', (line) => { let o; try { o = JSON.parse(line) } catch { return } if (o.type === 'result') { result = o; resolve() } })
      c.on('exit', () => resolve())
    })
    createInterface({ input: c.stderr }).on('line', (l) => jlog(file, { ev: 'stderr', line: l.slice(0, 300) }))
    c.stdin.write(userTurnLine(`[[${m}]] ${text}`))
    await Promise.race([done, sleep(120000)])
    try { c.stdin.end() } catch { /* закрыт */ }
    await sleep(500)
    try { process.kill(-c.pid, 'SIGTERM') } catch { /* ушёл */ }
    res.push({ subtype: result?.subtype, isError: result?.is_error, text: String(result?.result || '').slice(0, 80) })
    jlog(file, { ev: 'turn', m, result: res.at(-1) })
  }
  return { label: 'pult-claude', res, tally: k5Tally(stub.requests.slice(from)), helloWritten: existsSync(join(cwd, 'hello.txt')) }
}

steps.k5 = async () => {
  exitCheck('stub-k5')
  const stub = await new Stub(join(RAW, 'stub-k5-upstream.jsonl'), k5Scenario).start()
  const nt = startNettop('stub-k5')
  try {
    const prod = await k5Hermes('prod', HOME_PROD, stub, { nudge: 'default 10' })
    const labc = await k5Hermes('labcfg', HOME_LABCFG, stub, { nudge: '0 (off)' })
    const pult = await k5Pult(stub)
    const ratio = (x) => +(x.tally.bytes / pult.tally.bytes).toFixed(2)
    summary('k5', { stubViolations: stub.violations, prod, labcfg: labc, pult,
      bytesRatioVsPult: { prod: ratio(prod), labcfg: ratio(labc) },
      requestsVsPult: { prod: prod.tally.requests, labcfg: labc.tally.requests, pult: pult.tally.requests },
      nettop: await nt.stop() })
  } finally { await killAll(); await stub.stop() }
}

// Цена «ревью памяти/скиллов»: nudge_interval=1, чтобы фоновый разбор запустился уже после 1-го хода.
steps.review = async () => {
  exitCheck('stub-review')
  const home = join(LAB, 'home-stub-review')
  if (!existsSync(home)) cpSync(HOME_PROD, home, { recursive: true })
  const cfg = readFileSync(join(HOME_PROD, 'config.yaml'), 'utf8')
    .replace('memory:\n  write_approval: true\n', 'memory:\n  write_approval: true\n  nudge_interval: 1\n')
    .replace('skills:\n  write_approval: true\n', 'skills:\n  write_approval: true\n  creation_nudge_interval: 1\n')
  if (!/nudge_interval: 1/.test(cfg) || !/creation_nudge_interval: 1/.test(cfg)) throw new Error('review config patch failed')
  writeFileSync(join(home, 'config.yaml'), cfg)
  const stub = await new Stub(join(RAW, 'stub-review-upstream.jsonl'), k5Scenario).start()
  try {
    const r = await k5Hermes('review', home, stub, { nudge: 'memory 1, skills 1' })
    await sleep(10000)
    summary('review', { stubViolations: stub.violations, run: r, allAfterWait: k5Tally(stub.requests) })
  } finally { await killAll(); await stub.stop() }
}

// S6: HTTPS_PROXY выставлен — кто через него идёт, а кто мимо (relay плагина — http.client без прокси).
function startProxy(file) {
  const srv = net.createServer((sock) => {
    sock.once('data', (buf) => {
      const head = buf.toString('latin1').split('\r\n')[0]
      const [method, target] = head.split(' ')
      jlog(file, { ev: 'proxy', method, target })
      if (method === 'CONNECT') {
        const [host, port] = target.split(':')
        if (/anthropic\.com$/.test(host)) { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return } // в лаборатории — никогда
        const up = net.connect(Number(port) || 443, host, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(sock); sock.pipe(up) })
        up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy())
      } else {
        sock.end('HTTP/1.1 403 Forbidden\r\n\r\n') // plain-HTTP через прокси не пускаем, только пишем
      }
    })
  })
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)))
}

function startNettop(step) {
  const file = join(RAW, `stub-${step}-nettop.csv`)
  const p = spawn('nettop', ['-L', '0', '-s', '1', '-n', '-x', '-m', 'tcp'], { stdio: ['ignore', 'pipe', 'ignore'] })
  const rows = []
  let proc = ''
  createInterface({ input: p.stdout }).on('line', (l) => {
    appendFileSync(file, l + '\n')
    const cols = l.split(',')
    if (!cols[1]) return
    if (!cols[1].startsWith('tcp')) { proc = cols[1]; return }
    if (!/python|hermes|claude|tirith|uv\.|git|node|gh\.|curl/i.test(proc)) return
    const m = cols[1].match(/<->([^,]+)$/)
    const remote = m ? m[1] : ''
    if (/^(127\.0\.0\.1|::1|\*)/.test(remote)) return
    rows.push({ proc, remote, iface: cols[2] })
  })
  return {
    stop: async () => {
      try { p.kill('SIGTERM') } catch { /* нет */ }
      await sleep(300)
      const uniq = new Map()
      for (const r of rows) uniq.set(`${r.proc.replace(/\.\d+$/, '')}|${r.remote.replace(/[.:]\d+$/, '')}|${r.iface}`, r)
      const flows = [...uniq.keys()].map((k) => { const [proc, remote, iface] = k.split('|'); return { proc, remote, iface } })
      return { flows, ifaces: [...new Set(flows.map((f) => f.iface))], nonTunnel: flows.filter((f) => f.iface && !/^utun/.test(f.iface)) }
    },
  }
}

steps.proxy = async () => {
  exitCheck('stub-proxy')
  const out = {}
  const variants = {
    // (a) все прокси-переменные: так их выставляет типичный «прокси-VPN» (Clash/V2rayN в режиме системного прокси)
    all: (u) => ({ HTTPS_PROXY: u, HTTP_PROXY: u, https_proxy: u, http_proxy: u }),
    // (b) только HTTPS_PROXY и NO_PROXY для loopback — relay плагина доступен claude напрямую
    httpsOnly: (u) => ({ HTTPS_PROXY: u, https_proxy: u, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }),
  }
  for (const [name, mk] of Object.entries(variants)) {
    const plog = join(RAW, `stub-proxy-${name}-connects.jsonl`)
    const proxy = await startProxy(plog)
    const purl = `http://127.0.0.1:${proxy.address().port}`
    const stub = await new Stub(join(RAW, `stub-proxy-${name}-upstream.jsonl`), (a) => a.kind !== 'main' ? { text: 'Stub title' } : { text: 'OK' }).start()
    const httpsFrom = existsSync(HTTPS_LOG) ? readFileSync(HTTPS_LOG, 'utf8').split('\n').filter(Boolean).length : 0
    const nt = startNettop(`stub-proxy-${name}`)
    const cwd = tempRepo(`stub-proxy-${name}`)
    const a = await open(`stub-proxy-${name}`, { env: await stubEnv({ stub, extra: mk(purl) }), cwd })
    try {
      const S = (await newSession(a, cwd)).sessionId
      const r = await prompt(a, S, '[[ok]] Reply OK')
      await sleep(3000)
      const https = readFileSync(HTTPS_LOG, 'utf8').split('\n').filter(Boolean).slice(httpsFrom).map((l) => JSON.parse(l))
      const connects = existsSync(plog) ? readFileSync(plog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
      out[name] = { stubViolations: stub.violations, turn: r.res, text: r.text.slice(0, 200), stubRequests: stub.requests.length,
        proxiedTargets: [...new Set(connects.map((c) => `${c.method} ${String(c.target).replace(/admit\/[^/]+/, 'admit/<route>')}`))],
        pythonHttps: [...new Set(https.map((x) => `${x.ev}:${x.host || x.target || x.to}:${x.redirect ?? ''}`))],
        relayUsedTunnel: https.some((x) => x.ev === 'set_tunnel' && x.target === 'api.anthropic.com'),
        nettop: await nt.stop() }
    } finally { await killAll(); await stub.stop(); proxy.close() }
  }
  summary('proxy', out)
}

// Заимствование логина Claude Code: с `auth.adopt_external_logins: false` Hermes не читает Keychain и
// ~/.claude/.credentials.json и не ходит на /v1/models с чужим OAuth. Кэш каталога моделей удалён,
// чтобы старт гарантированно полез за каталогом. Контроль без выключателя НЕ запускается нарочно:
// он снова прочитал бы логин владельца (случайное срабатывание уже поймано в stub-k5, запрос №8).
steps.adopt = async () => {
  exitCheck('stub-adopt')
  const home = join(LAB, 'home-stub-adopt')
  if (!existsSync(home)) cpSync(HOME_PROD, home, { recursive: true })
  rmSync(join(home, 'provider_models_cache.json'), { force: true })
  writeFileSync(join(home, 'config.yaml'), readFileSync(join(HOME_PROD, 'config.yaml'), 'utf8') + 'auth:\n  adopt_external_logins: false\n')
  const stub = await new Stub(join(RAW, 'stub-adopt-upstream.jsonl'), () => ({ text: 'OK' })).start()
  const cwd = tempRepo('stub-adopt')
  const a = await open('stub-adopt', { env: await stubEnv({ stub, home }), cwd })
  try {
    const ns = await newSession(a, cwd)
    await sleep(8000)
    const all = a.stderr.map((x) => x.line)
    summary('adopt', { stubViolations: stub.violations, requests: stub.requests.length,
      nonMessages: stub.requests.filter((x) => !/\/v1\/messages$/.test(x.path || '')).map((x) => `${x.method} ${x.path} auth=${x.auth}`),
      availableModelsProviders: [...new Set((ns.models?.availableModels || []).map((m) => String(m.modelId).split(':')[0]))],
      notice: pick(all, /adopt_external_logins|external login|not adopt/i).map((l) => l.replace(/^\S+ \S+ /, '').slice(0, 300)) })
  } finally { await killAll(); await stub.stop() }
}

// Токен GitHub: PATH без gh не помогает (Hermes ищет gh ещё и в каталогах Homebrew). Проверяем
// выключатель — suppressed_sources у провайдера copilot в auth.json — плюс adopt_external_logins: false.
steps.ghsuppress = async () => {
  exitCheck('stub-ghsuppress')
  const home = join(LAB, 'home-stub-gh')
  if (!existsSync(home)) cpSync(HOME_PROD, home, { recursive: true })
  rmSync(join(home, 'provider_models_cache.json'), { force: true })
  writeFileSync(join(home, 'config.yaml'), readFileSync(join(HOME_PROD, 'config.yaml'), 'utf8') + 'auth:\n  adopt_external_logins: false\n')
  const auth = readJson(join(home, 'auth.json'), { version: 1 })
  if (auth.credential_pool) delete auth.credential_pool.copilot
  auth.suppressed_sources = { copilot: ['gh_cli', 'env:COPILOT_GITHUB_TOKEN', 'env:GH_TOKEN', 'env:GITHUB_TOKEN'] }
  writeJson(join(home, 'auth.json'), auth)
  const stub = await new Stub(join(RAW, 'stub-ghsuppress-upstream.jsonl'), () => ({ text: 'OK' })).start()
  const cwd = tempRepo('stub-ghsuppress')
  const a = await open('stub-ghsuppress', { env: await stubEnv({ stub, home }), cwd })
  try {
    await newSession(a, cwd)
    await sleep(10000)
    const https = readFileSync(HTTPS_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.pid === a.pid)
    const after = readJson(join(home, 'auth.json'), {})
    summary('ghsuppress', { stubViolations: stub.violations, pid: a.pid,
      githubConnections: https.filter((x) => /github/.test(x.host || '')).map((x) => `${x.host}:${x.thread}`),
      copilotPoolAfter: !!after.credential_pool?.copilot, suppressedAfter: after.suppressed_sources })
  } finally { await killAll(); await stub.stop() }
}

// probe-timing-skew: сколько блокирует цикл событий один сэмпл egress (execFileSync pgrep/ps/lsof).
steps.sampler = async () => {
  exitCheck('stub-sampler')
  const stub = await new Stub(join(RAW, 'stub-sampler-upstream.jsonl'), (a) => a.kind !== 'main' ? { text: 'Stub title' } : { text: 'OK' }).start()
  const cwd = tempRepo('stub-sampler')
  const a = await open('stub-sampler', { env: await stubEnv({ stub }), cwd })
  try {
    const S = (await newSession(a, cwd)).sessionId
    // Цикл событий: насколько запаздывает таймер 10 мс без сэмплера и с ним.
    const lag = async (ms) => { const d = []; const end = now() + ms; while (now() < end) { const t = performance.now(); await sleep(10); d.push(performance.now() - t - 10) } d.sort((x, y) => x - y); return { p50: +d[d.length >> 1].toFixed(1), p99: +d[Math.floor(d.length * 0.99)].toFixed(1), max: +d.at(-1).toFixed(1) } }
    const idleLag = await lag(3000)
    const eg = new Egress('stub-sampler', a.pid); eg.start()
    const pT = prompt(a, S, '[[ok]] Reply OK')
    const busyLag = await lag(3000)
    await pT
    const e = eg.stop()
    summary('sampler', { loopLagMsWithoutSampler: idleLag, loopLagMsWithSampler: busyLag, sampleCallMs: e.sampleMs })
  } finally { await killAll(); await stub.stop() }
}

// Проверка утверждения DELTA §3 про тип подписки: только поля без персональных данных.
steps.auth = async () => {
  let raw = '', code = 0
  try { raw = execFileSync(REAL_CLAUDE, ['auth', 'status', '--json'], { encoding: 'utf8', env: { HOME: process.env.HOME, PATH: process.env.PATH, USER: process.env.USER } }) } catch (e) { raw = String(e.stdout || ''); code = e.status }
  let st = {}
  try { st = JSON.parse(raw) } catch { st = {} }
  const keep = { loggedIn: st.loggedIn, authMethod: st.authMethod, apiProvider: st.apiProvider, subscriptionType: st.subscriptionType, exitCode: code, fields: Object.keys(st).sort() }
  summary('auth', keep)
}

const step = process.argv[2]
if (!steps[step]) { console.error(`usage: stub-probe.mjs <${Object.keys(steps).join('|')}>`); process.exit(2) }
try {
  await steps[step]()
} catch (e) {
  console.error(`[${step}] ${e.stack || e.message}`)
  process.exitCode = 1
} finally {
  await killAll()
  const left = (() => { try { return execFileSync('pgrep', ['-fl', 'hermes|acp_adapter'], { encoding: 'utf8' }).trim() } catch { return '' } })()
  if (left) console.error(`[leftover processes]\n${left}`)
}
