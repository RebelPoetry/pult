// lib.mjs — shared plumbing for the Pult Ф0 Claude leg.
// Zero dependencies, plain Node ESM. Node >= 22.
//
// Everything here exists to answer one question per check with EVIDENCE:
// every script appends JSONL records to spike/claude/logs/<check>.jsonl and prints the same
// records on stdout. A record is {t, check, kind, ...}; `kind: "verdict"` is the last one.

import { spawn, execFileSync } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const SPIKE = resolve(HERE, '..')
export const SANDBOX_A = join(SPIKE, 'sandbox-a')
export const SANDBOX_B = join(SPIKE, 'sandbox-b')
export const LOGS = join(HERE, 'logs')
export const ME_ROOT = resolve(SPIKE, '..', '..', '..') // три уровня над spike/: папка, в которой лежит каталог с репозиторием

export const CLAUDE_BIN = process.env.PULT_CLAUDE_BIN || '/opt/homebrew/bin/claude'
export const NODE_BIN = process.execPath

// --- network profile (docs/04-DELTA-v0.3.md §4) ------------------------------
// Claude Code does not support SOCKS proxies; 127.0.0.1:10808 is a MIXED port, so the
// HTTP entrance is the one we use. NO_PROXY keeps loopback (and the MCP stub) off the proxy.
//
// RUN 1 LESSON (logs/run1-proxy-down/): this profile used to be HARDCODED. The local proxy was
// down, api.anthropic.com was reachable directly, and every single check burned ~3 minutes on
// `system/api_retry` before returning
//   {"subtype":"success","is_error":true,"terminal_reason":"api_error",
//    "result":"API Error: Connection refused — a firewall or proxy may be blocking it (ConnectionRefused)"}
// The harness, not `claude`, was at fault. The profile is now PICKED at startup by probing the
// port, and `pultd` must do the same instead of trusting a configured proxy.
export const PROXY_PORT = Number(process.env.PULT_PROXY_PORT || 10808)
export const PROXY_HOST = '127.0.0.1'
export const PROXY_URL = `http://${PROXY_HOST}:${PROXY_PORT}`
export const NO_PROXY_VALUE = 'localhost,127.0.0.1,::1'

export const PROXY_PROFILE = { HTTPS_PROXY: PROXY_URL, NO_PROXY: NO_PROXY_VALUE }
export const DEAD_PROXY_PROFILE = {
  HTTPS_PROXY: 'http://127.0.0.1:9', // discard port: nothing listens
  NO_PROXY: NO_PROXY_VALUE,
}

/** TCP-probe a port. Resolves true only on a real connection inside `ms`. */
export function probePort(host = PROXY_HOST, port = PROXY_PORT, ms = 300) {
  return new Promise((res) => {
    let done = false
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy() } catch { /* gone */ } res(v) }
    const timer = setTimeout(() => finish(false), ms)
    const sock = connect({ host, port })
    sock.once('connect', () => finish(true))
    sock.once('error', () => finish(false))
  })
}

/**
 * Decide the network profile ONCE per process.
 *   PULT_PROXY=auto (default) — proxy when the port answers, otherwise DIRECT (no proxy vars).
 *   PULT_PROXY=off            — always direct, no probe.
 *   PULT_PROXY=required       — proxy or abort (exit 3); nothing is spent.
 * Direct mode sets NO proxy variables at all: HTTPS_PROXY/NO_PROXY are simply absent.
 */
export async function pickProfile() {
  const mode = String(process.env.PULT_PROXY || 'auto').toLowerCase()
  const portOpen = mode === 'off' ? false : await probePort()
  if (mode === 'required' && !portOpen) {
    process.stderr.write(
      `ABORT: PULT_PROXY=required, но прокси ${PROXY_URL} не отвечает (порт закрыт).\n` +
      `Подними прокси или запусти с PULT_PROXY=auto / PULT_PROXY=off. Ничего не потрачено.\n`,
    )
    process.exit(3)
  }
  const useProxy = mode === 'required' || (mode === 'auto' && portOpen)
  return {
    mode: useProxy ? 'proxy' : 'direct',
    port_open: portOpen,
    requested: mode,
    env: useProxy ? { ...PROXY_PROFILE } : {},
  }
}

// Resolved once, at import time: every script in this leg shares one decision.
export const NETWORK = await pickProfile()
export const NETWORK_ENV = NETWORK.env

// --- egress guard --------------------------------------------------------------
// RUN 2 LESSON (logs/s1-warm-ttl.jsonl, 2026-09-21): the profile was `direct` because the local
// proxy port was closed, so every turn left the machine from the owner's own country. After a
// 20-minute idle the second turn came back in 858 ms with
//   {"subtype":"success","is_error":true,"terminal_reason":"api_error","api_error_status":403,
//    "result":"Your organization has disabled Claude subscription access for Claude Code · …"}
// Whatever the true cause, the harness must never again spend a turn over an unknown network
// path. So: before any model turn we ask the network itself where it thinks we are.
//
// BLOCKED_COUNTRIES is a CONSERVATIVE GUARD LIST chosen by this harness. It is NOT Anthropic's
// official list of unsupported regions and makes no claim to match it. Being wrong here costs an
// aborted run (exit 5) and never a wasted turn — that is the trade we want.
export const BLOCKED_COUNTRIES = ['RU', 'BY', 'CN', 'IR', 'KP', 'SY', 'CU']
// Tried in order; the first one that yields a `loc=XX` line wins.
// api.anthropic.com is first on purpose: it is Cloudflare-fronted and serves the same
// /cdn-cgi/trace, so a hit there measures the EXACT host the child will talk to. The other two
// are fallbacks for the case where only that host is unreachable.
export const EGRESS_URLS = [
  'https://api.anthropic.com/cdn-cgi/trace',
  'https://cloudflare.com/cdn-cgi/trace',
  'https://www.cloudflare.com/cdn-cgi/trace',
]
export const EGRESS_URL = EGRESS_URLS[0]
export const EGRESS_EXIT = 5

/** curl, run with the SAME scrubbed env + network profile the `claude` child gets. */
function runCurl(args, hardMs = 15000) {
  return new Promise((res) => {
    let out = '', err = ''
    let c
    try {
      c = spawn('curl', args, { env: scrubbedEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return res({ code: -1, out: '', err: String((e && e.message) || e) })
    }
    const timer = setTimeout(() => { try { c.kill('SIGKILL') } catch { /* gone */ } }, hardMs)
    c.stdout.setEncoding('utf8'); c.stdout.on('data', (d) => { out += d })
    c.stderr.setEncoding('utf8'); c.stderr.on('data', (d) => { err += d })
    c.on('error', (e) => { clearTimeout(timer); res({ code: -1, out, err: String((e && e.message) || e) }) })
    c.on('close', (code) => { clearTimeout(timer); res({ code, out, err }) })
  })
}

/**
 * Where does traffic actually leave from, ON THE PROFILE THE CHILD WILL USE?
 * proxy mode -> `curl -x http://127.0.0.1:10808` (the mixed port's HTTP face — the same entrance
 * `claude` gets through HTTPS_PROXY, so a working answer here also proves the CONNECT tunnel
 * works); direct mode -> plain curl. Chosen over a hand-written node:net/tls CONNECT tunnel
 * because curl exercises the identical code path the child uses and adds no code to audit.
 *
 * Returns { mode, loc, ms, blocked, reachable, curl_exit, skipped }.
 * `loc` is null when the probe could not tell — which counts as blocked.
 */
export async function egressCheck() {
  if (String(process.env.PULT_EGRESS || '').toLowerCase() === 'skip') {
    process.stderr.write(
      '!!! PULT_EGRESS=skip — ПРОВЕРКА ВЫХОДА В СЕТЬ ОТКЛЮЧЕНА. Ходы пойдут по непроверенному\n' +
      '!!! маршруту. Это аварийный режим; убирай переменную сразу после отладки.\n',
    )
    return { mode: NETWORK.mode, loc: null, ms: 0, blocked: false, reachable: false, curl_exit: null, skipped: true }
  }
  const t0 = Date.now()
  const tried = []
  let loc = null, url = null, code = null
  for (const u of EGRESS_URLS) {
    const args = ['-s', '-m', '8']
    if (NETWORK.mode === 'proxy') args.push('-x', PROXY_URL)
    args.push(u)
    const r = await runCurl(args)
    const m = /^loc=([A-Za-z]{2})\s*$/m.exec(r.out)
    tried.push({ url: u, curl_exit: r.code, loc: m ? m[1].toUpperCase() : null })
    code = r.code
    if (m) { loc = m[1].toUpperCase(); url = u; break }
  }
  return {
    mode: NETWORK.mode,
    loc,
    url,
    ms: Date.now() - t0,
    reachable: !!loc,
    curl_exit: code,
    tried,
    // Unknown counts as blocked: a probe that cannot say where we are is not permission to spend.
    blocked: loc === null || BLOCKED_COUNTRIES.includes(loc),
    skipped: false,
  }
}

/** One line for a human: `direct · loc=XX · 412 ms`. */
export function egressLine(e) {
  if (!e) return 'egress: unknown'
  if (e.skipped) return `egress: ПРОПУЩЕНА (PULT_EGRESS=skip), профиль ${e.mode}`
  return `egress: профиль ${e.mode}, loc=${e.loc || 'unknown'}, ${e.ms} ms${e.blocked ? ' — ЗАБЛОКИРОВАНО' : ''}`
}

/**
 * Gate a check BEFORE its first model turn. Bad egress -> the check's results.json row becomes
 * 'blocked' and the process exits 5 without ever starting `claude`.
 * `ids` is a check id or a list of them (b2-s6-permission owns two rows).
 */
export async function egressGuard(log, ids) {
  const e = await egressCheck()
  log.rec('egress', { mode: e.mode, loc: e.loc, ms: e.ms, blocked: e.blocked, skipped: e.skipped, url: e.url, tried: e.tried, curl_exit: e.curl_exit, guard_list: BLOCKED_COUNTRIES })
  if (!e.blocked) return e
  const details = `выход в сеть: ${e.loc || 'unknown'} — ходы не запускались`
  log.rec('verdict', { verdict: 'blocked', reason: details, egress: { mode: e.mode, loc: e.loc } })
  for (const id of [].concat(ids)) {
    const meta = CHECK_META[id] || {}
    saveResult({
      id,
      title: meta.title || id,
      verdict: 'blocked',
      details,
      decisive_evidence: `${log.path} :: egress`,
      design_impact: 'unknown until run',
      ...(meta.script ? { script: meta.script } : {}),
    })
  }
  process.stderr.write(
    `\nABORT (egress): ${egressLine(e)}\n` +
    `Список-страж: ${BLOCKED_COUNTRIES.join(',')} (консервативный список харнесса, не официальный список Anthropic).\n` +
    `Подними VPN (ожидаемый выход — Финляндия) и запусти снова. Ни один ход не сделан.\n`,
  )
  await log.close()
  process.exit(EGRESS_EXIT)
}

/** Every script logs this record, so a log always says which network it ran on. */
export function logNetworkProfile(log, extra = {}) {
  log.rec('network_profile', {
    mode: NETWORK.mode,
    port_open: NETWORK.port_open,
    requested: NETWORK.requested,
    https_proxy: NETWORK_ENV.HTTPS_PROXY || null,
    ...extra,
  })
}

// --- env hygiene -------------------------------------------------------------
// This spike is normally started FROM the Claude desktop app, so the ambient environment is
// full of ANTHROPIC_* / CLAUDE_* variables that would reconfigure the spawned `claude`
// (ANTHROPIC_BASE_URL redirects the API, CLAUDE_CODE_MESSAGING_SOCKET/TOKEN wire the child
// back into the host session, CLAUDE_CODE_ENTRYPOINT changes telemetry, ...).
// The daemon must do exactly what this function does: build the child env from an ALLOWLIST.
const ENV_ALLOWLIST = ['HOME', 'USER', 'PATH', 'LANG', 'TERM', 'TMPDIR']
const LEAK_RE = /^(ANTHROPIC|CLAUDE)/i

export function scrubbedEnv(extra = {}) {
  const env = Object.create(null)
  for (const k of ENV_ALLOWLIST) if (process.env[k]) env[k] = process.env[k]
  if (!env.PATH) env.PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
  // NETWORK_ENV is {} in direct mode: no HTTPS_PROXY, no NO_PROXY, nothing to honour.
  return { ...env, ...NETWORK_ENV, ...extra }
}

/** Names only — never values. Used as a design finding, and to prove the scrub is needed. */
export function leakedEnvNames() {
  return Object.keys(process.env).filter((k) => LEAK_RE.test(k)).sort()
}

// --- logging -----------------------------------------------------------------
export function openLog(check) {
  mkdirSync(LOGS, { recursive: true })
  const path = join(LOGS, `${check}.jsonl`)
  const out = createWriteStream(path, { flags: 'w' })
  const rec = (kind, data = {}) => {
    const line = JSON.stringify({ t: new Date().toISOString(), check, kind, ...data })
    out.write(line + '\n')
    process.stdout.write(line + '\n')
  }
  return { path, rec, close: () => new Promise((r) => out.end(r)) }
}

// --- check registry ------------------------------------------------------------
// One place for id -> {title, script}. seed-results.mjs seeds rows from it and egressGuard
// rewrites rows from it, so a blocked row never loses its title.
export const CHECK_META = {
  'B1-claude': { title: 'Claude event stream: utterance -> structured events to end of turn', script: 'b1-stream.mjs' },
  'B2-claude': { title: 'Claude answers a permission request: host replies deny (turn 1) and allow (turn 2)', script: 'b2-s6-permission.mjs' },
  'B3-claude': { title: 'Claude resume of the same session after the process is killed', script: 'b3-resume.mjs' },
  'B4-claude': { title: 'Claude subagent visibility: parent_tool_use_id chain in the stream', script: 'b4-subagent.mjs' },
  'B5-claude': { title: 'Claude structured output: --json-schema -> result.structured_output', script: 'b5-schema.mjs' },
  'B6-claude': { title: 'Claude subscription limits via the statusLine command JSON (rate_limits.five_hour / seven_day)', script: 'b6-limits.mjs' },
  'S1-claude': { title: 'Idle TTL of a warm `claude -p --input-format stream-json` session', script: 's1-warm-ttl.mjs' },
  'S3-claude': { title: 'Claude: launch a saved workflow by the utterance `Run /pult-echo …` from -p', script: 's3-workflow.mjs' },
  'S5-claude': { title: 'Dead-port test: HTTPS_PROXY=http://127.0.0.1:9 must break `claude`', script: 's5-deadport.mjs' },
  'S6-claude': { title: 'Claude: full --permission-prompt-tool circuit with a hand-written stdio MCP stub talking to a unix-socket host', script: 'b2-s6-permission.mjs' },
  'S7-claude': { title: 'Cold-start token cost: default settings in Me vs --setting-sources user in sandbox-a', script: 's7-startup-cost.mjs' },
}

/** Writes spike/claude/results.json, merging this check's row into whatever is already there. */
export function saveResult(row) {
  const path = join(HERE, 'results.json')
  let doc = { leg: 'claude', checks: [], surprises: [], scripts: [], cleanup: '' }
  try { doc = JSON.parse(readFileSync(path, 'utf8')) } catch { /* first writer */ }
  if (!Array.isArray(doc.checks)) doc.checks = []
  const i = doc.checks.findIndex((c) => c.id === row.id)
  if (i >= 0) doc.checks[i] = row; else doc.checks.push(row)
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n')
  return path
}

// --- claude process -----------------------------------------------------------
export const newSessionId = () => randomUUID()

/**
 * Base argv for a warm, structured `claude -p` session, exactly as the Claude Adapter would
 * build it (docs/02-FACTS.md "Протокол управления").
 * `settingSources` defaults to 'user': that is the S7 token-saving profile. Pass
 * 'user,project' when the node needs project-local skills/workflows (see S3 — a project
 * workflow is NOT discovered under 'user').
 */
export function baseArgs({
  sessionId,
  model = 'haiku',
  effort = 'low',
  settingSources = 'user',
  partial = true,
  forwardSubagentText = true,
  // Default 'none': anything that would prompt is denied automatically. Without a permission
  // handler a prompting tool has nobody to answer it, and the run would just sit there.
  // B2/S6 is the one check that sets 'host' — it SUPPLIES the handler.
  permissionPrompts = 'none',
  extra = [],
} = {}) {
  const a = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
  ]
  if (partial) a.push('--include-partial-messages')
  if (forwardSubagentText) a.push('--forward-subagent-text')
  if (sessionId) a.push('--session-id', sessionId)
  if (model) a.push('--model', model)
  if (effort) a.push('--effort', effort)
  if (settingSources) a.push('--setting-sources', settingSources)
  if (permissionPrompts) a.push('--permission-prompts', permissionPrompts)
  return a.concat(extra)
}

/** A user turn in stream-json INPUT format. */
export function userTurn(text) {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  }) + '\n'
}

/**
 * Spawn `claude` and parse its stdout as JSONL.
 * Returns { child, send(text), endStdin(), kill(), onEvent, exited, events }.
 * `opts.onEvent(evt)` is called for every parsed object; unparsable lines go to onRaw.
 */
export function startClaude({ args, cwd = SANDBOX_A, env = scrubbedEnv(), onEvent, onRaw, bin = CLAUDE_BIN }) {
  const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const startedAt = Date.now()
  const events = []
  const listeners = new Set()
  let buf = ''
  let stderr = ''

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      let evt
      try { evt = JSON.parse(line) } catch { onRaw && onRaw(line); continue }
      events.push(evt)
      const idx = events.length - 1
      onEvent && onEvent(evt)
      for (const l of [...listeners]) { try { l(evt, idx) } catch { /* a listener must never kill the parser */ } }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (c) => { stderr += c })
  // EPIPE on a killed child is expected; without this handler it would be an unhandled error.
  child.stdin.on('error', () => { /* pipe closed under us */ })

  const exited = new Promise((res) => {
    child.on('close', (code, signal) => res({ code, signal, stderr }))
  })

  return {
    child,
    events,
    exited,
    startedAt,
    get stderr() { return stderr },
    /** Index of the next event to arrive — the "from" marker for waitForResult. */
    mark: () => events.length,
    on: (l) => { listeners.add(l) },
    off: (l) => { listeners.delete(l) },
    // After a fast-fail kill the pipe is gone; writing to it must not crash the check.
    send: (text) => { try { return child.stdin.write(userTurn(text)) } catch { return false } },
    endStdin: () => { try { child.stdin.end() } catch { /* already closed */ } },
    kill: (sig = 'SIGKILL') => { try { child.kill(sig) } catch { /* already gone */ } },
    alive: () => child.exitCode === null && child.signalCode === null,
  }
}

/**
 * Wait for THIS turn's `result` event. Never rejects — it always resolves with a result-shaped
 * object, so a caller can key off `is_error` alone.
 *
 * opts.from       index into session.events; events before it are ignored. Pass `session.mark()`
 *                 taken BEFORE writing a second user message, or a stale result from turn 1 is
 *                 returned instantly (the run-1 S1 bug: "turn2 latency_ms: 2").
 * opts.maxRetries stop after N CONSECUTIVE `system`/`api_retry` events, kill the child and
 *                 resolve {network_error:true, retries, last_error}. Default 3.
 *                 Run 1 measured `claude` doing 10 retries over ~147 s before giving up: it does
 *                 NOT fail fast on a dead proxy, so the harness has to.
 * opts.onRetry    (evt, n, msSinceStart) — used to record the FULL payload of the first retry.
 */
export function waitForResult(session, ms = 180000, opts = {}) {
  const from = opts.from ?? 0
  const maxRetries = opts.maxRetries ?? 3
  return new Promise((resolve) => {
    let retries = 0
    let lastError = null
    let firstRetryMs = null
    let done = false

    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      session.off(handler)
      resolve(value)
    }

    const handler = (evt, idx) => {
      if (idx < from) return
      if (evt.type === 'result') {
        // Flag it here, not only in networkFailure(): a check that never consults the classifier
        // must still make the whole run stop (exit 6) instead of burning turns into a wall.
        if (isAccountOrRegionBlock(evt)) noteAccountBlock(accountBlockText(evt))
        return finish(evt)
      }
      if (evt.type === 'system' && evt.subtype === 'api_retry') {
        retries += 1
        if (firstRetryMs === null) firstRetryMs = Date.now() - session.startedAt
        lastError = evt.error ?? evt.message ?? evt.detail ?? null
        opts.onRetry && opts.onRetry(evt, retries, Date.now() - session.startedAt)
        if (retries >= maxRetries) {
          session.kill()
          finish({
            type: 'result',
            network_error: true,
            is_error: true,
            terminal_reason: 'api_retry_storm',
            retries,
            last_error: lastError,
            first_retry_ms: firstRetryMs,
            result: `network: ${retries} consecutive system/api_retry events, child killed`,
          })
        }
        return
      }
      // anything real from the model means the transport recovered
      if (evt.type === 'assistant' || evt.type === 'user') retries = 0
    }

    const timer = setTimeout(() => finish({
      type: 'result',
      is_error: true,
      timeout: true,
      retries,
      first_retry_ms: firstRetryMs,
      result: `Error: timeout after ${ms}ms waiting for result`,
    }), ms)

    session.on(handler)
    // replay whatever already arrived at or after `from`
    for (let i = from; i < session.events.length && !done; i++) handler(session.events[i], i)

    session.exited.then(() => {
      if (done) return
      for (let i = from; i < session.events.length && !done; i++) handler(session.events[i], i)
      finish({
        type: 'result',
        is_error: true,
        exited_without_result: true,
        retries,
        first_retry_ms: firstRetryMs,
        result: 'process exited without a result event',
      })
    })
  })
}

/**
 * Resolve as soon as `system`/`init` arrives (or ms elapses), WITHOUT completing a turn.
 * init is emitted before the first API call, so this costs nothing — which is the only reason
 * the offline probes may run while the owner is logged in.
 */
export function waitForInit(session, ms = 30000) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); session.off(handler); resolve(v) }
    const handler = (evt) => { if (evt.type === 'system' && evt.subtype === 'init') finish(evt) }
    const timer = setTimeout(() => finish(null), ms)
    session.on(handler)
    for (const e of session.events) handler(e)
    session.exited.then(() => finish(session.events.find((e) => e.type === 'system' && e.subtype === 'init') || null))
  })
}

// --- account / region block -----------------------------------------------------
// The decisive string, matched case-insensitively on result.result (and on any error text).
export const ACCOUNT_BLOCK_RE = /disabled Claude subscription access/i
export const ACCOUNT_BLOCK_EXIT = 6

function textOf(r) {
  if (!r) return ''
  const bits = [r.result, r.error, r.message, r.last_error]
  return bits.map((b) => (typeof b === 'string' ? b : b ? JSON.stringify(b) : '')).join(' ')
}

/** True for the api_error that means the ACCOUNT (or the region it is seen from) is refused. */
export function isAccountOrRegionBlock(r) {
  return ACCOUNT_BLOCK_RE.test(textOf(r))
}

export function accountBlockText(r) {
  const m = typeof r?.result === 'string' ? r.result : textOf(r)
  return m.slice(0, 400)
}

// Set once, anywhere in the process. An `exit` handler turns it into exit code 6, so a check
// script does not have to thread the condition through its own verdict logic.
let ACCOUNT_BLOCK_SEEN = null
export function noteAccountBlock(text) {
  if (ACCOUNT_BLOCK_SEEN) return
  ACCOUNT_BLOCK_SEEN = text || 'account_or_region'
}
export const accountBlockSeen = () => ACCOUNT_BLOCK_SEEN

process.on('exit', () => {
  if (!ACCOUNT_BLOCK_SEEN) return
  process.stderr.write(
    '\n=== СТОП: доступ аккаунта к Claude Code отклонён ===\n' +
    `  ${ACCOUNT_BLOCK_SEEN}\n` +
    '  Это не поломка проверки. Не перезапускать в цикле — каждый повтор бьётся в ту же стену.\n' +
    '  1. проверь VPN (ожидаемый выход — Финляндия), 2. убедись, что порт 127.0.0.1:10808 открыт,\n' +
    '  3. сделай один ручной `claude -p "ok"` и только потом запускай прогон снова.\n',
  )
  process.exitCode = ACCOUNT_BLOCK_EXIT
})

/**
 * Was this turn stopped by the NETWORK rather than by the thing under test?
 * Returns null when the turn is a legitimate pass/fail, otherwise {reason, text}.
 * A check that gets a non-null answer must report 'blocked' — never 'works', never 'fails'.
 */
export function networkFailure(r) {
  if (!r) return null
  // Account- or region-level refusal. Measured verbatim on 2026-09-21 with HTTP 403:
  //   "Your organization has disabled Claude subscription access for Claude Code · Use an
  //    Anthropic API key instead, or ask your admin to enable access"
  // It is NOT a failure of the thing under test, so it can never be 'fails'; and retrying it in a
  // loop is the worst possible response, so it also aborts the whole run (exit 6).
  if (isAccountOrRegionBlock(r)) {
    noteAccountBlock(accountBlockText(r))
    return { reason: 'account_or_region', text: accountBlockText(r), fatal: true }
  }
  if (r.network_error) {
    return { reason: 'network', text: r.last_error ? JSON.stringify(r.last_error).slice(0, 400) : String(r.result) }
  }
  if (r.is_error === true && r.terminal_reason === 'api_error') {
    return { reason: 'api_error', text: typeof r.result === 'string' ? r.result : JSON.stringify(r.result) }
  }
  if (r.timeout || r.exited_without_result) {
    return { reason: r.timeout ? 'timeout' : 'no_result', text: String(r.result) }
  }
  return null
}

/** One tiny turn, from a fresh process; resolves { init, result, events }. Costs 1 model turn. */
export async function oneTurn({ prompt, args, cwd, env, timeoutMs = 180000, onRetry }) {
  const s = startClaude({ args, cwd, env })
  s.send(prompt)
  s.endStdin()
  const result = await waitForResult(s, timeoutMs, { onRetry })
  if (s.alive()) s.kill()
  await s.exited
  return { init: s.events.find((e) => e.type === 'system' && e.subtype === 'init'), result, events: s.events }
}

/** Key names only — used to learn the SHAPE of an event without printing its contents. */
export function keyNames(obj) {
  return obj && typeof obj === 'object' ? Object.keys(obj).sort() : null
}

/**
 * Records the FULL payload of the first api_retry seen (field names are undocumented —
 * this is how the spike learns them) and a one-line count of the rest.
 */
export function retryRecorder(log, label = '') {
  return (evt, count, msSinceStart) => {
    if (count === 1) log.rec('api_retry_first', { label, ms_since_start: msSinceStart, keys: keyNames(evt), payload: evt })
    else log.rec('api_retry', { label, n: count, ms_since_start: msSinceStart })
  }
}

// --- auth gate ----------------------------------------------------------------
/** `claude auth status --json` with a scrubbed env. Returns the parsed object. */
// NOTE (measured on claude 2.1.278): this command EXITS 1 when loggedIn is false, while still
// printing valid JSON on stdout. `pult doctor` must parse stdout and must not treat a non-zero
// exit as "the command is broken".
export function authStatus() {
  let out
  try {
    out = execFileSync(CLAUDE_BIN, ['auth', 'status', '--json'], {
      env: scrubbedEnv(), encoding: 'utf8', cwd: SANDBOX_A,
    })
  } catch (e) {
    out = String(e.stdout || '')
    if (!out.trim()) throw e
  }
  return JSON.parse(out)
}

/** Terse summary of a result event — the fields the adapter will actually read. */
export function resultSummary(r) {
  if (!r) return null
  return {
    subtype: r.subtype,
    is_error: r.is_error,
    terminal_reason: r.terminal_reason,
    api_error_status: r.api_error_status,
    num_turns: r.num_turns,
    duration_ms: r.duration_ms,
    total_cost_usd: r.total_cost_usd,
    usage: r.usage ? {
      input_tokens: r.usage.input_tokens,
      cache_creation_input_tokens: r.usage.cache_creation_input_tokens,
      cache_read_input_tokens: r.usage.cache_read_input_tokens,
      output_tokens: r.usage.output_tokens,
    } : null,
    permission_denials: r.permission_denials,
    structured_output: r.structured_output,
    network_error: r.network_error ?? false,
    // true => the account (or the region it was seen from) is refused, NOT a defect of the check
    account_or_region_block: isAccountOrRegionBlock(r),
    retries: r.retries ?? 0,
    // the verbatim text of result.result — the adapter matches limit/refusal strings on it
    result: typeof r.result === 'string' ? r.result.slice(0, 400) : r.result,
  }
}

/** The one decisive line: an auth failure looks like this and MUST abort the whole run. */
export function looksNotLoggedIn(events) {
  return events.some((e) => e.error === 'authentication_failed')
    || events.some((e) => e.type === 'result' && typeof e.result === 'string' && /Failed to authenticate/i.test(e.result))
}
