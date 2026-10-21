#!/usr/bin/env node
// acp-probe.mjs — спайк «Hermes Agent как провайдер №4 Пульта через ACP» (docs/09-DELTA-hermes-spike.md).
// Ноль зависимостей: только node >= 22. Фрейминг — NDJSON JSON-RPC, как в src/adapters/codex/client.ts.
//
//   node spike/hermes/acp-probe.mjs <шаг>       шаги: s1 s2 s3 s4 s5 s7 s8 delegate redact
//
// Всё, что относится к Hermes, живёт под LAB (по умолчанию ~/.pult-lab/hermes, см. README.md):
//   LAB/venv — pinned hermes-agent, LAB/home — HERMES_HOME, LAB/repos — временные git-репо,
//   LAB/raw — сырые транскрипты (в репозиторий идут только после `redact`).
// S6 (egress) не отдельный шаг: сэмплер lsof работает во время КАЖДОГО хода с моделью.
//
// Правила безопасности (зашиты в код, а не в память оператора):
//   * перед каждым шагом, который может дойти до модели, — curl trace до api.anthropic.com;
//     страна не известная или RU → шаг не запускается (STOP, без обхода);
//   * бюджет ходов: ≤ 12 промптов через Hermes, ≤ 3 через путь claude Пульта (LAB/budget.json);
//   * окружение ребёнка — белый список Пульта (dist/env/allowlist.js buildChildEnv) + HERMES_HOME,
//     HERMES_ACP_SKIP_CONFIGURED_MCP=1, TMPDIR под LAB. Ни одной ANTHROPIC_*/CLAUDE_*/OPENAI_*;
//   * ребёнок запускается в своей группе процессов и убивается целиком в finally.

import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const HOME = process.env.HOME
const LAB = process.env.HERMES_LAB || join(HOME, '.pult-lab', 'hermes')
const RAW = join(LAB, 'raw')
const REPOS = join(LAB, 'repos')
const STATE_FILE = join(LAB, 'state.json')
const BUDGET_FILE = join(LAB, 'budget.json')
const EXIT_LOG = join(RAW, 'exit-checks.jsonl')
const EGRESS_LOG = join(RAW, 'egress.jsonl')
const HERMES_BIN = join(LAB, 'venv', 'bin', 'hermes')
const BUDGET = { hermes: 12, pult: 3 }
const OK_COUNTRIES_BAD = new Set(['RU', 'XX', 'T1', ''])

for (const d of [RAW, REPOS, join(LAB, 'tmp')]) mkdirSync(d, { recursive: true })

// ---------- мелочи ----------
const now = () => Date.now()
const readJson = (f, dflt) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return dflt } }
const writeJson = (f, o) => writeFileSync(f, JSON.stringify(o, null, 2) + '\n')
const jlog = (f, o) => appendFileSync(f, JSON.stringify({ t: now(), ...o }) + '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const state = readJson(STATE_FILE, {})
const saveState = () => writeJson(STATE_FILE, state)

function spend(kind, note) {
  const b = readJson(BUDGET_FILE, { hermes: 0, pult: 0, log: [] })
  if (b[kind] + 1 > BUDGET[kind]) throw new Error(`BUDGET: ${kind} turns exhausted (${b[kind]}/${BUDGET[kind]})`)
  b[kind] += 1
  b.log.push({ t: new Date().toISOString(), kind, note })
  writeJson(BUDGET_FILE, b)
  return b[kind]
}

// Инвариант 2: страна выхода ДО шага. Запись каждой проверки — в LAB/raw/exit-checks.jsonl.
function exitCheck(step) {
  let out = ''
  try {
    out = execFileSync('curl', ['-q', '-s', '-m', '8', 'https://api.anthropic.com/cdn-cgi/trace'], { encoding: 'utf8' })
  } catch (e) { out = String(e.stdout || '') }
  const loc = (out.match(/^loc=(\S*)/m) || [])[1] || ''
  const ok = !OK_COUNTRIES_BAD.has(loc)
  jlog(EXIT_LOG, { step, loc, ok })
  console.log(`[exit-check] ${step}: loc=${loc || '(none)'} → ${ok ? 'OK' : 'STOP'}`)
  if (!ok) throw new Error(`STOP: exit country "${loc}" before ${step}`)
  return loc
}

// Окружение ребёнка: белый список Пульта из собранного пакета, иначе его точная копия.
async function childEnv(extra = {}) {
  let build
  try {
    ({ buildChildEnv: build } = await import(join(REPO, 'dist', 'env', 'allowlist.js')))
  } catch {
    build = (parent, opts) => {
      const env = Object.create(null)
      for (const k of ['HOME', 'USER', 'PATH', 'LANG', 'TERM', 'TMPDIR']) if (parent[k]) env[k] = parent[k]
      if (!env.PATH) env.PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
      Object.assign(env, opts.extra || {})
      return env
    }
  }
  const env = build(process.env, {
    extra: {
      TMPDIR: join(LAB, 'tmp'),
      HERMES_HOME: join(LAB, 'home'),
      HERMES_ACP_SKIP_CONFIGURED_MCP: '1',
      ...extra,
    },
  })
  for (const k of Object.keys(env)) {
    if (/^(ANTHROPIC_|OPENAI_|HERMES_YOLO)/.test(k) || (/^CLAUDE_/.test(k) && k !== 'CLAUDE_CONFIG_DIR')) {
      throw new Error(`env leak guard: ${k} would reach the child`)
    }
  }
  return env
}

// ---------- egress-сэмплер (S6) ----------
function descendants(pid) {
  const out = [pid]
  for (let i = 0; i < out.length; i++) {
    try {
      const kids = execFileSync('pgrep', ['-P', String(out[i])], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number)
      out.push(...kids)
    } catch { /* нет детей */ }
  }
  return out
}

class Egress {
  constructor(step, rootPid) {
    this.step = step; this.rootPid = rootPid; this.seen = new Map(); this.timer = null; this.pids = new Map()
  }
  sample() {
    // Замер собственной цены: execFileSync блокирует цикл событий Node, и все метки dt
    // во время хода сдвигаются на эту величину (пробел «probe-timing-skew» второго прохода).
    const t0 = process.hrtime.bigint()
    try { this._sample() } finally { (this.costs ||= []).push(Number(process.hrtime.bigint() - t0) / 1e6) }
  }
  _sample() {
    const pids = descendants(this.rootPid)
    for (const p of pids) {
      if (this.pids.has(p)) continue
      try { this.pids.set(p, execFileSync('ps', ['-o', 'comm=', '-p', String(p)], { encoding: 'utf8' }).trim()) } catch { /* ушёл */ }
    }
    let out = ''
    try { out = execFileSync('lsof', ['-nP', '-i', '-a', '-p', pids.join(',')], { encoding: 'utf8' }) } catch (e) { out = String(e.stdout || '') }
    for (const line of out.split('\n').slice(1)) {
      if (!line.trim()) continue
      const cols = line.trim().split(/\s+/)
      const name = cols.slice(8).join(' ')
      const key = `${cols[0]}|${cols[1]}|${name.replace(/\(.*\)/, '').trim()}`
      if (!this.seen.has(key)) this.seen.set(key, { cmd: cols[0], pid: Number(cols[1]), proto: cols[7], name, first: now() })
    }
  }
  start(ms = 200) { this.sample(); this.timer = setInterval(() => this.sample(), ms) }
  stop() {
    clearInterval(this.timer)
    const rows = [...this.seen.values()]
    const remote = new Map()
    for (const r of rows) {
      const m = r.name.match(/->([\d.:[\]a-f]+):(\d+)/i)
      if (!m) continue
      const ip = m[1].replace(/^\[|\]$/g, '')
      if (!remote.has(ip)) {
        let iface = ''
        try { iface = (execFileSync('route', ['-n', 'get', ip], { encoding: 'utf8' }).match(/interface:\s*(\S+)/) || [])[1] || '' } catch { /* v6 и т. п. */ }
        remote.set(ip, { ip, port: m[2], iface, cmds: new Set() })
      }
      remote.get(ip).cmds.add(`${r.cmd}(${r.pid})`)
    }
    const summary = [...remote.values()].map((x) => ({ ...x, cmds: [...x.cmds] }))
    const c = [...(this.costs || [])].sort((x, y) => x - y)
    const sampleMs = c.length ? { n: c.length, p50: +c[c.length >> 1].toFixed(1), max: +c[c.length - 1].toFixed(1) } : null
    jlog(EGRESS_LOG, { step: this.step, procs: Object.fromEntries(this.pids), sockets: rows, remotes: summary, sampleMs })
    return { procs: Object.fromEntries(this.pids), remotes: summary, sockets: rows.length, sampleMs }
  }
}

// ---------- ACP-клиент ----------
class Acp {
  constructor({ step, env, cwd, onPermission, bin = HERMES_BIN }) {
    this.step = step
    this.file = join(RAW, `${step}.jsonl`)
    this.nextId = 1
    this.pending = new Map()
    this.updates = []
    this.stderr = []
    this.serverRequests = []
    // id запроса → сколько session/update пришло ДО разбора строки ответа (метрика реплея S5).
    this.respAt = new Map()
    this.onPermission = onPermission || (() => 'deny')
    this.t0 = now()
    this.proc = spawn(bin, ['acp'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    this.pid = this.proc.pid
    this.exited = null
    this.exitP = new Promise((r) => this.proc.on('exit', (code, sig) => { this.exited = { code, sig }; this.log({ ev: 'exit', code, sig }); r(this.exited) }))
    createInterface({ input: this.proc.stdout, crlfDelay: Infinity }).on('line', (line) => {
      if (!line.trim()) return
      let msg
      try { msg = JSON.parse(line) } catch { this.log({ ev: 'unparsed', line: line.slice(0, 400) }); return }
      this.log({ dir: 'in', msg })
      this.handle(msg)
    })
    createInterface({ input: this.proc.stderr, crlfDelay: Infinity }).on('line', (line) => {
      this.stderr.push({ t: now() - this.t0, line })
      this.log({ ev: 'stderr', line: line.slice(0, 2000) })
    })
    this.log({ ev: 'spawn', pid: this.pid, argv: [bin, 'acp'], envKeys: Object.keys(env).sort() })
  }
  log(o) { jlog(this.file, { dt: now() - this.t0, ...o }) }
  send(obj) { this.log({ dir: 'out', msg: obj }); this.proc.stdin.write(JSON.stringify(obj) + '\n') }
  request(method, params, timeoutMs = 180000) {
    const id = this.nextId++
    const p = new Promise((resolve, reject) => {
      const to = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`timeout ${method}`)) }, timeoutMs)
      this.pending.set(id, { resolve: (v) => { clearTimeout(to); resolve(v) }, reject: (e) => { clearTimeout(to); reject(e) } })
    })
    this.send({ jsonrpc: '2.0', id, method, params })
    return p
  }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }) }
  respond(id, result) { this.send({ jsonrpc: '2.0', id, result }) }
  async handle(msg) {
    if (msg.id !== undefined && msg.method) {
      this.serverRequests.push({ t: now() - this.t0, ...msg })
      if (msg.method === 'session/request_permission') {
        const ans = await this.onPermission(msg.params, msg.id)
        if (ans === null || ans === undefined) return // держим запрос без ответа (S4)
        if (ans === 'cancelled') this.respond(msg.id, { outcome: { outcome: 'cancelled' } })
        else this.respond(msg.id, { outcome: { outcome: 'selected', optionId: ans } })
      } else {
        this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `client does not implement ${msg.method}` } })
      }
      return
    }
    if (msg.id !== undefined) {
      this.respAt.set(msg.id, this.updates.length)
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error }))
      else p.resolve(msg.result)
      return
    }
    if (msg.method === 'session/update') this.updates.push({ t: now() - this.t0, ...msg.params })
  }
  async initialize() {
    const t = now()
    const r = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'pult-spike', title: 'Pult hermes spike', version: '0.0.1' },
    }, 120000)
    return { ms: now() - t, coldMs: now() - this.t0, r }
  }
  async kill() {
    if (this.exited) return this.exited
    // Плагин держит claude в СВОЕЙ группе процессов — сначала всё дерево поимённо, потом группу.
    for (const p of descendants(this.pid).slice(1).reverse()) { try { process.kill(p, 'SIGTERM') } catch { /* ушёл */ } }
    try { process.kill(-this.pid, 'SIGTERM') } catch { /* уже нет */ }
    const done = await Promise.race([this.exitP, sleep(4000).then(() => null)])
    if (!done) { try { process.kill(-this.pid, 'SIGKILL') } catch { /* нет */ } await this.exitP }
    // Внуки в своей группе (claude в отдельной группе процессов у плагина) — добиваем по дереву.
    return this.exited
  }
}

const LIVE = new Set()
async function killAll() { for (const a of LIVE) await a.kill().catch(() => {}); LIVE.clear() }
process.on('SIGINT', async () => { await killAll(); process.exit(130) })

async function openAcp(step, { cwd, extraEnv, onPermission } = {}) {
  const env = await childEnv(extraEnv)
  const a = new Acp({ step, env, cwd: cwd || LAB, onPermission })
  LIVE.add(a)
  return a
}

function tempRepo(name) {
  const dir = join(REPOS, `${name}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', dir])
  writeFileSync(join(dir, 'README.md'), '# spike sandbox\n')
  execFileSync('git', ['-C', dir, '-c', 'user.email=spike@localhost', '-c', 'user.name=spike', 'add', '.'])
  execFileSync('git', ['-C', dir, '-c', 'user.email=spike@localhost', '-c', 'user.name=spike', 'commit', '-qm', 'init'])
  return dir
}

function kinds(updates) {
  const m = new Map()
  for (const u of updates) { const k = u.update?.sessionUpdate || '?'; m.set(k, (m.get(k) || 0) + 1) }
  return Object.fromEntries(m)
}
function textOf(updates, since = 0) {
  return updates.filter((u) => u.t >= since && u.update?.sessionUpdate === 'agent_message_chunk')
    .map((u) => u.update?.content?.text || '').join('')
}

// Один ход: промпт, ожидание PromptResponse, сэмплер egress, время до первого куска текста.
async function turn(a, sessionId, text, { note, egress = true, cancelAfterMs, onStart } = {}) {
  const n = spend('hermes', `${a.step}: ${note || text.slice(0, 40)}`)
  const since = now() - a.t0
  const eg = egress ? new Egress(`${a.step}:${note || 'turn'}`, a.pid) : null
  eg?.start()
  const t = now()
  const p = a.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 240000)
  onStart?.()
  let cancelSent = null
  if (cancelAfterMs) setTimeout(() => { cancelSent = now() - t; a.notify('session/cancel', { sessionId }) }, cancelAfterMs)
  let res, err
  try { res = await p } catch (e) { err = { message: e.message, rpc: e.rpc } }
  const ms = now() - t
  const eg2 = eg?.stop()
  const upd = a.updates.filter((u) => u.t >= since)
  const first = upd.find((u) => u.update?.sessionUpdate === 'agent_message_chunk')
  const out = {
    turnNo: n, note, ms, res, err, cancelSentMs: cancelSent,
    firstChunkMs: first ? first.t - since : null,
    kinds: kinds(upd), text: textOf(a.updates, since).slice(0, 400),
    egress: eg2,
  }
  a.log({ ev: 'turn', ...out })
  return out
}

function p(o) {
  console.log(JSON.stringify(o, null, 2))
  writeJson(join(RAW, `${process.argv[2]}-summary.jsonl`.replace('.jsonl', '.json')), o)
}

// ---------- шаги ----------
const steps = {}

steps.s1 = async () => {
  exitCheck('s1')
  const ver = execFileSync(HERMES_BIN, ['acp', '--version'], { env: await childEnv(), encoding: 'utf8' }).trim()
  const a = await openAcp('s1')
  const eg = new Egress('s1:startup', a.pid); eg.start()
  try {
    const init = await a.initialize()
    const cwd = tempRepo('s1')
    const t = now()
    const ns = await a.request('session/new', { cwd, mcpServers: [] }, 120000)
    const nsMs = now() - t
    await sleep(1500)
    p({ version: ver, coldToInitMs: init.coldMs, initRttMs: init.ms, init: init.r, newSessionMs: nsMs, newSession: ns,
      updatesAfterNew: kinds(a.updates), egress: eg.stop() })
  } finally { await killAll() }
}

steps.s2 = async () => {
  exitCheck('s2')
  const cwd = tempRepo('s2')
  const a = await openAcp('s2', { cwd })
  try {
    await a.initialize()
    const ns = await a.request('session/new', { cwd, mcpServers: [] }, 120000)
    state.s2 = { sessionId: ns.sessionId, cwd, model: ns.models?.currentModelId }
    saveState()
    const r = await turn(a, ns.sessionId, 'Reply with exactly the two letters: OK', { note: 'say-ok' })
    await sleep(1500)
    p({ sessionId: ns.sessionId, currentModel: ns.models?.currentModelId, turn: r, lateUpdates: kinds(a.updates.slice(-5)) })
  } finally { await killAll() }
}

steps.s3 = async () => {
  exitCheck('s3')
  const cwd = tempRepo('s3')
  mkdirSync(join(cwd, 'junk'), { recursive: true }); writeFileSync(join(cwd, 'junk', 'x.txt'), 'x\n')
  const perms = []
  let answer = 'allow_once'
  let current = ''
  const a = await openAcp('s3', {
    cwd,
    onPermission: (params) => {
      perms.push({ phase: current, toolCall: params.toolCall, options: params.options?.map((o) => `${o.optionId}:${o.kind}`), answered: answer })
      return answer
    },
  })
  try {
    await a.initialize()
    const ns = await a.request('session/new', { cwd, mcpServers: [] }, 120000)
    state.s3 = { sessionId: ns.sessionId, cwd }
    saveState()
    const res = {}
    current = 'ls'; answer = 'allow_once'
    res.ls = await turn(a, ns.sessionId, 'Run the shell command `ls` in the current directory and reply with the file names only.', { note: 'ls' })
    current = 'write'; answer = 'allow_once'
    res.write = await turn(a, ns.sessionId, 'Create a file named hello.txt in the current directory containing exactly the word hi. Use your file-writing tool, not the shell.', { note: 'write' })
    current = 'rm-deny'; answer = 'deny'
    res.rmDeny = await turn(a, ns.sessionId, 'Run exactly this shell command and nothing else, do not use any other tool: rm -rf ./junk', { note: 'rm-deny' })
    const junkAfterDeny = existsSync(join(cwd, 'junk'))
    current = 'rm-allow'; answer = 'allow_once'
    res.rmAllow = await turn(a, ns.sessionId, 'Now run exactly that command again: rm -rf ./junk (I approve it this time).', { note: 'rm-allow' })
    const junkAfterAllow = existsSync(join(cwd, 'junk'))
    const hello = existsSync(join(cwd, 'hello.txt')) ? readFileSync(join(cwd, 'hello.txt'), 'utf8') : null
    const toolCalls = a.updates.filter((u) => u.update?.sessionUpdate === 'tool_call')
      .map((u) => ({ id: u.update.toolCallId, title: u.update.title, kind: u.update.kind, rawInput: u.update.rawInput }))
    p({ perms, junkAfterDeny, junkAfterAllow, hello, toolCalls, turns: Object.fromEntries(Object.entries(res).map(([k, v]) => [k, { ms: v.ms, res: v.res, kinds: v.kinds, text: v.text }])) })
  } finally { await killAll() }
}

steps.s4 = async () => {
  exitCheck('s4')
  const cwd = tempRepo('s4')
  mkdirSync(join(cwd, 'junk2'), { recursive: true })
  let hold = true
  let permSeen = null
  const a = await openAcp('s4', {
    cwd,
    onPermission: (params, id) => { permSeen = { id, toolCallId: params.toolCall?.toolCallId, at: now() }; return hold ? null : 'deny' },
  })
  try {
    await a.initialize()
    const ns = await a.request('session/new', { cwd, mcpServers: [] }, 120000)
    // (a) отмена, пока висит запрос разрешения: ждём запрос, потом session/cancel, ответ не шлём.
    const pA = turn(a, ns.sessionId, 'Run exactly this shell command and nothing else: rm -rf ./junk2', { note: 'cancel-with-pending-perm' })
    for (let i = 0; i < 600 && !permSeen; i++) await sleep(100)
    const permAt = permSeen ? permSeen.at : null
    if (permSeen) a.notify('session/cancel', { sessionId: ns.sessionId })
    const tA = await Promise.race([pA, sleep(60000).then(() => ({ timeout: true }))])
    const reqAfterCancel = a.serverRequests.slice(-3).map((r) => ({ method: r.method, id: r.id }))
    const junk2Exists = existsSync(join(cwd, 'junk2'))
    // (b) отмена в середине обычного хода (без разрешения): долгий sleep идёт без спроса.
    hold = false
    const tB = await turn(a, ns.sessionId, 'Run the shell command `sleep 25` and then reply done.', { note: 'cancel-mid-turn', cancelAfterMs: 9000 })
    await sleep(2000)
    p({ permSeen, cancelSentAfterPermMs: permAt ? 'immediately' : null, turnA: tA, reqAfterCancel, junk2Exists,
      turnB: { ms: tB.ms, res: tB.res, cancelSentMs: tB.cancelSentMs, kinds: tB.kinds, text: tB.text } })
  } finally { await killAll() }
}

steps.s5 = async () => {
  exitCheck('s5')
  const old = state.s3
  if (!old) throw new Error('run s3 first (need a session with history)')
  let a = await openAcp('s5a', { cwd: old.cwd })
  await a.initialize()
  const pid1 = a.pid
  await a.kill(); LIVE.delete(a)
  a = await openAcp('s5b', { cwd: old.cwd, onPermission: () => 'deny' })
  try {
    await a.initialize()
    const before = a.updates.length
    const t = now()
    const loadId = a.nextId
    const lr = await a.request('session/load', { sessionId: old.sessionId, cwd: old.cwd, mcpServers: [] }, 120000)
    const loadMs = now() - t
    const replay = a.updates.slice(before)
    const replayKinds = kinds(replay)
    // Число обновлений, разобранных ДО строки ответа на session/load (снимок в handle()).
    const replayBeforeResponse = a.respAt.get(loadId) - before
    await sleep(1500)
    const lateKinds = kinds(a.updates.slice(before + replay.length))
    // Контекст восстановлен? Один крошечный ход по загруженной сессии.
    const r = await turn(a, old.sessionId, 'Earlier in this session you created a file. What was its name? Reply with the file name only.', { note: 'post-load' })
    let bogus, bogusErr
    try { bogus = await a.request('session/load', { sessionId: 'bogus-' + randomUUID(), cwd: old.cwd, mcpServers: [] }, 60000) } catch (e) { bogusErr = { message: e.message, rpc: e.rpc } }
    let promptBogus, promptBogusErr
    try { promptBogus = await a.request('session/prompt', { sessionId: 'bogus-' + randomUUID(), prompt: [{ type: 'text', text: 'x' }] }, 60000) } catch (e) { promptBogusErr = { message: e.message, rpc: e.rpc } }
    p({ oldPid: pid1, newPid: a.pid, loadMs, loadResponseKeys: lr ? Object.keys(lr) : lr, replayCount: replay.length, replayKinds, replayBeforeResponse,
      lateKindsAfterLoad: lateKinds, replaySample: replay.slice(0, 3).map((u) => u.update),
      postLoad: { ms: r.ms, res: r.res, text: r.text }, bogus, bogusErr, promptBogus, promptBogusErr })
  } finally { await killAll() }
}

steps.s7 = async () => {
  const empty = join(LAB, 'claude-empty')
  mkdirSync(empty, { recursive: true })
  const env = await childEnv({ CLAUDE_CONFIG_DIR: empty })
  let st
  // `claude auth status` выходит с 1, когда не залогинен, — JSON всё равно лежит в stdout.
  let raw = '', code = 0
  try { raw = execFileSync('claude', ['auth', 'status', '--json'], { env, encoding: 'utf8' }) } catch (e) { raw = String(e.stdout || ''); code = e.status }
  try { st = JSON.parse(raw) } catch { st = { raw: raw.slice(0, 200) } }
  st.exitCode = code
  const loggedIn = st.loggedIn
  console.log(`[s7] claude auth status under empty CLAUDE_CONFIG_DIR: loggedIn=${loggedIn} authMethod=${st.authMethod}`)
  if (loggedIn !== false) { p({ skipped: true, reason: 'auth status did not report logged out', loggedIn }); return }
  exitCheck('s7')
  const cwd = tempRepo('s7')
  const a = await openAcp('s7', { cwd, extraEnv: { CLAUDE_CONFIG_DIR: empty } })
  try {
    await a.initialize()
    const ns = await a.request('session/new', { cwd, mcpServers: [] }, 120000)
    const stderrBefore = a.stderr.length
    const r = await turn(a, ns.sessionId, 'Reply with exactly: OK', { note: 'logged-out' })
    await sleep(1000)
    p({ authStatus: { loggedIn: st.loggedIn, authMethod: st.authMethod, exitCode: st.exitCode }, turn: { ms: r.ms, res: r.res, err: r.err, kinds: r.kinds, text: r.text },
      stderrDuringTurn: a.stderr.slice(stderrBefore).map((x) => x.line).filter((l) => !/^\s*$/.test(l)).slice(0, 40) })
  } finally { await killAll() }
}

steps.delegate = async () => {
  exitCheck('delegate')
  const cwd = tempRepo('deleg')
  const a = await openAcp('delegate', { cwd, onPermission: () => 'deny' })
  try {
    await a.initialize()
    const ns = await a.request('session/new', { cwd, mcpServers: [] }, 120000)
    const r = await turn(a, ns.sessionId, 'Use the delegate_task tool exactly once to give a subagent this task: "Reply with exactly: CHILD-OK". Then reply with the subagent\'s answer only.', { note: 'delegate' })
    const tc = a.updates.filter((u) => ['tool_call', 'tool_call_update'].includes(u.update?.sessionUpdate))
      .map((u) => ({ su: u.update.sessionUpdate, id: u.update.toolCallId, title: u.update.title, kind: u.update.kind, status: u.update.status, rawInput: u.update.rawInput, meta: u.update._meta }))
    p({ turn: { ms: r.ms, res: r.res, kinds: r.kinds, text: r.text }, toolUpdates: tc, egress: r.egress })
  } finally { await killAll() }
}

// S8: тот же крошечный ход через путь claude Пульта (argv и env — из собранного пакета).
steps.s8 = async () => {
  exitCheck('s8')
  const { buildClaudeArgv, userTurnLine } = await import(join(REPO, 'dist', 'adapters', 'claude', 'argv.js'))
  const env = await childEnv()
  delete env.HERMES_HOME; delete env.HERMES_ACP_SKIP_CONFIGURED_MCP
  const prompts = [
    ['say-ok', 'Reply with exactly the two letters: OK'],
    ['ls', 'Run the shell command `ls` in the current directory and reply with the file names only.'],
  ]
  const out = []
  for (const [note, text] of prompts) {
    spend('pult', `s8: ${note}`)
    const cwd = tempRepo(`s8-${note}`)
    const argv = buildClaudeArgv({ sessionId: randomUUID(), resume: false, model: 'haiku' })
    const file = join(RAW, `s8-pult-${note}.jsonl`)
    const t0 = now()
    const c = spawn('claude', argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    jlog(file, { ev: 'spawn', argv: ['claude', ...argv], envKeys: Object.keys(env).sort() })
    const eg = new Egress(`s8-pult:${note}`, c.pid); eg.start()
    let result = null, first = null
    const done = new Promise((resolve) => {
      createInterface({ input: c.stdout }).on('line', (line) => {
        let m; try { m = JSON.parse(line) } catch { return }
        jlog(file, { dir: 'in', msg: m })
        if (!first && m.type === 'stream_event' && m.event?.type === 'content_block_delta') first = now() - t0
        if (m.type === 'result') { result = m; resolve() }
      })
      c.on('exit', () => resolve())
    })
    createInterface({ input: c.stderr }).on('line', (l) => jlog(file, { ev: 'stderr', line: l.slice(0, 500) }))
    c.stdin.write(userTurnLine(text))
    await Promise.race([done, sleep(180000)])
    const egr = eg.stop()
    try { c.stdin.end() } catch { /* закрыт */ }
    try { process.kill(-c.pid, 'SIGTERM') } catch { /* ушёл */ }
    out.push({ note, ms: now() - t0, firstDeltaMs: first, subtype: result?.subtype, isError: result?.is_error, usage: result?.usage,
      modelUsage: result?.modelUsage, costUsd: result?.total_cost_usd, numTurns: result?.num_turns, text: String(result?.result || '').slice(0, 200), egress: egr })
  }
  p(out)
}

// Редакция сырых транскриптов в фикстуры репозитория.
steps.redact = async () => {
  const dst = join(HERE, 'logs')
  mkdirSync(dst, { recursive: true })
  const home = HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const lab = LAB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rules = [
    [new RegExp(`${lab}/home`, 'g'), '$HERMES_HOME'],
    [new RegExp(lab, 'g'), '$LAB'],
    [new RegExp(home, 'g'), '$HOME'],
    [/\/Users\/[A-Za-z0-9._-]+/g, '/Users/USER'],
    [/-Users-[A-Za-z0-9._]+(?=-)/g, '-Users-USER'],
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '<email>'],
    [/sk-ant-[A-Za-z0-9_-]{10,}/g, '<token>'],
    [/\bsk-[A-Za-z0-9]{20,}/g, '<token>'],
    [/Bearer\s+[A-Za-z0-9._~+/-]{10,}=*/g, 'Bearer <token>'],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<jwt>'],
    [/"(access_?token|refresh_?token|id_?token|api_?key|authorization|x-api-key)"\s*:\s*"[^"]*"/gi, '"$1":"<redacted>"'],
    [/("(?:orgId|organizationUuid|accountUuid|org_id|account_id)"\s*:\s*)"[^"]*"/gi, '$1"<redacted>"'],
  ]
  let n = 0
  for (const f of readdirSync(RAW).filter((x) => x.endsWith('.jsonl') || x.endsWith('-summary.json'))) {
    let s = readFileSync(join(RAW, f), 'utf8')
    for (const [re, rep] of rules) s = s.replace(re, rep)
    writeFileSync(join(dst, f), s)
    n++
  }
  console.log(`redacted ${n} files → ${dst}`)
}

steps.clean = async () => { rmSync(RAW, { recursive: true, force: true }); console.log('raw cleared') }

export { Acp, Egress, childEnv, descendants, exitCheck, tempRepo, kinds, textOf, jlog, readJson, writeJson, sleep, now,
  LAB, RAW, REPOS, HERE, REPO, EXIT_LOG, HERMES_BIN }

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href
if (isMain) {
  const step = process.argv[2]
  if (!steps[step]) { console.error(`usage: acp-probe.mjs <${Object.keys(steps).join('|')}>`); process.exit(2) }
  try {
    await steps[step]()
  } catch (e) {
    console.error(`[${step}] ${e.message}`)
    process.exitCode = 1
  } finally {
    await killAll()
    const left = (() => { try { return execFileSync('pgrep', ['-fl', 'hermes|acp_adapter'], { encoding: 'utf8' }).split('\n').filter((l) => l && !l.startsWith(`${process.pid} `)).join('\n') } catch { return '' } })()
    if (left) console.error(`[leftover processes]\n${left}`)
  }
}
