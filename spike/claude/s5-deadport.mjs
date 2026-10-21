#!/usr/bin/env node
// S5 — "dead port": point HTTPS_PROXY at a port nothing listens on. `claude` MUST fail with a
// connection error. If it succeeds, the proxy env was ignored and every "the proxy works"
// claim on this machine is meaningless (a system VPN would be doing the work).
//
// RUN 1 TAUGHT US THE HARD WAY: without a BASELINE this check lies. In run 1 the picked profile
// itself was broken (proxy down), the dead-port run therefore also failed, and S5 reported
// 'works' — a false pass, because "it failed" only means something when "it works" was proven
// first in the same session.
//
// Order:
//   1. BASELINE turn on the picked profile — must succeed (is_error false, output tokens > 0).
//      It does not succeed -> verdict 'blocked': nothing about the proxy can be concluded.
//   2. DEAD-PORT run with HTTPS_PROXY=http://127.0.0.1:9, capped at 45 s.
//      api_retry / connection refused and NO success -> 'works'  (env honoured)
//      the turn completes                            -> 'fails'  (env ignored)
//
// Cost: 1 tiny haiku turn (the baseline). The dead-port run bills nothing.

import { baseArgs, newSessionId, openLog, saveResult, startClaude, waitForResult, resultSummary,
  looksNotLoggedIn, scrubbedEnv, DEAD_PROXY_PROFILE, NETWORK, logNetworkProfile, networkFailure,
  retryRecorder, egressGuard } from './lib.mjs'

const log = openLog('s5-deadport')
logNetworkProfile(log)
// Egress guard: no model turn until we know which country this traffic leaves from.
await egressGuard(log, 'S5-claude')

const DEADPORT_CAP_MS = 45_000

// --- 1. baseline on the picked profile ---------------------------------------
const baseSession = startClaude({ args: baseArgs({ sessionId: newSessionId() }) })
baseSession.send('reply with the single word OK')
baseSession.endStdin()
const rBase = await waitForResult(baseSession, 180000, { onRetry: retryRecorder(log, 'baseline') })
if (baseSession.alive()) baseSession.kill()
await baseSession.exited
log.rec('baseline_result', resultSummary(rBase))

const baseOut = (rBase && rBase.usage && rBase.usage.output_tokens) || 0
const baseNet = networkFailure(rBase)
const baselineOk = !baseNet && rBase && rBase.is_error !== true && baseOut > 0 && !looksNotLoggedIn(baseSession.events)
log.rec('baseline', { ok: baselineOk, output_tokens: baseOut, network: baseNet || null, profile: NETWORK.mode })

// --- 2. dead-port run ---------------------------------------------------------
let rDead = null, deadSession = null, firstRetryMs = null, retries = 0
if (baselineOk) {
  const env = { ...scrubbedEnv(), ...DEAD_PROXY_PROFILE }
  log.rec('deadport_env', { HTTPS_PROXY: env.HTTPS_PROXY, NO_PROXY: env.NO_PROXY })
  deadSession = startClaude({ args: baseArgs({ sessionId: newSessionId() }), env })
  deadSession.send('reply with the single word OK')
  deadSession.endStdin()
  const rec = retryRecorder(log, 'deadport')
  rDead = await waitForResult(deadSession, DEADPORT_CAP_MS, {
    onRetry: (evt, n, ms) => { retries = n; if (firstRetryMs === null) firstRetryMs = ms; rec(evt, n, ms) },
  })
  if (deadSession.alive()) deadSession.kill()
  await deadSession.exited
  log.rec('deadport_result', resultSummary(rDead))
  log.rec('deadport_stderr', { stderr: String(deadSession.stderr || '').slice(0, 800) })
  log.rec('deadport_timing', { ms_to_first_api_retry: firstRetryMs, retries, cap_ms: DEADPORT_CAP_MS })
}

// --- verdict -------------------------------------------------------------------
const CONN_ERR = /ECONNREFUSED|ECONNRESET|Connection refused|Connection error|socket hang up|fetch failed|proxy|ENOTFOUND|EHOSTUNREACH/i
const blob = deadSession ? JSON.stringify(deadSession.events) + String(deadSession.stderr || '') : ''
const connError = !!deadSession && (CONN_ERR.test(blob) || (rDead && rDead.network_error === true))
const deadSucceeded = !!rDead && rDead.is_error !== true

// run-1 fact, kept in the record because it is a DESIGN fact, not an accident:
const RUN1 = 'run 1 (logs/run1-proxy-down/b1-stream.jsonl): with a dead proxy `claude` emitted 10 '
  + 'system/api_retry events over ~147 s before returning terminal_reason:"api_error" — it does NOT '
  + 'fail fast, so the caller must cap the wait itself.'

let verdict, details, impact = 'none'
if (!baselineOk) {
  verdict = 'blocked'
  details = `baseline turn on the picked profile (${NETWORK.mode}) did not complete`
    + `${baseNet ? ` — ${baseNet.reason}: ${baseNet.text}` : ''}; nothing can be concluded about the proxy env. ${RUN1}`
  impact = 'inconclusive until a baseline turn passes'
} else if (deadSucceeded) {
  verdict = 'fails'
  details = `claude completed a turn with HTTPS_PROXY pointing at a dead port — the proxy env is NOT honoured. ${RUN1}`
  impact = 'Pult cannot promise per-node network profiles for claude; the UI must not claim the proxy is applied.'
} else if (connError) {
  verdict = 'works'
  details = `baseline OK on the ${NETWORK.mode} profile; with HTTPS_PROXY=http://127.0.0.1:9 the run died at the `
    + `transport (first api_retry after ${firstRetryMs} ms, ${retries} retries, capped at ${DEADPORT_CAP_MS} ms). ${RUN1}`
  impact = `claude honours HTTPS_PROXY, but retries for minutes before reporting it: pultd must watch system/api_retry and cut the turn itself.`
} else {
  verdict = 'partial'
  details = `baseline OK, dead-port run did not complete but the error was not recognisably connection-level; see log. ${RUN1}`
}

log.rec('verdict', { verdict, baselineOk, connError, deadSucceeded, ms_to_first_api_retry: firstRetryMs })
saveResult({
  id: 'S5-claude',
  title: 'Dead-port test: HTTPS_PROXY=http://127.0.0.1:9 must break `claude` (baseline first)',
  verdict,
  details,
  decisive_evidence: `${log.path} :: baseline + deadport_result + deadport_timing`,
  design_impact: impact,
})
await log.close()
process.exit(verdict === 'works' ? 0 : 1)
