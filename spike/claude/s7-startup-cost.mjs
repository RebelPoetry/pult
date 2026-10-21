#!/usr/bin/env node
// S7 — what a node's cold start COSTS in tokens.
//   A: cwd = ME_ROOT (the folder above the repo), default settings  (loads that folder's CLAUDE.md +
//      AGENTS.md — roughly 26k tokens of project context on the machine it was measured on)
//   B: cwd = spike/sandbox-a, --setting-sources user      (project settings skipped)
// Same tiny prompt, same model. Compare usage.input_tokens and cache_creation_input_tokens of
// the FIRST turn: that difference is what Pult saves per cold node, and the price of the
// S3 finding (project workflows/skills are invisible under 'user').
// Cost: 2 tiny haiku turns.

// RUN 1 LESSON: both turns failed on a dead proxy and this check still said
// "works … saved 0". A comparison of two zeroes is not a measurement: unless BOTH turns
// complete with non-zero usage, the verdict is 'blocked'.

import { baseArgs, newSessionId, openLog, saveResult, oneTurn, resultSummary, looksNotLoggedIn, SANDBOX_A, ME_ROOT, logNetworkProfile, networkFailure, retryRecorder, egressGuard } from './lib.mjs'

const log = openLog('s7-startup-cost')
logNetworkProfile(log)
// Egress guard: no model turn until we know which country this traffic leaves from.
await egressGuard(log, 'S7-claude')
const PROMPT = 'reply with the single word OK'

async function probe(label, { cwd, settingSources }) {
  const sessionId = newSessionId()
  const args = baseArgs({ sessionId, settingSources })
  log.rec('probe_argv', { label, cwd, args })
  const { init, result, events } = await oneTurn({ prompt: PROMPT, args, cwd, onRetry: retryRecorder(log, label) })
  const u = (result && result.usage) || {}
  const row = {
    label, cwd, setting_sources: settingSources || '<default>',
    input_tokens: u.input_tokens ?? null,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? null,
    cache_read_input_tokens: u.cache_read_input_tokens ?? null,
    output_tokens: u.output_tokens ?? null,
    total_cost_usd: result && result.total_cost_usd,
    n_skills: init ? (init.skills || []).length : null,
    n_slash_commands: init ? (init.slash_commands || []).length : null,
    n_agents: init ? (init.agents || []).length : null,
  }
  const net = networkFailure(result)
  const usable = !net && result && result.is_error !== true
    && ((row.input_tokens || 0) + (row.cache_creation_input_tokens || 0) + (row.cache_read_input_tokens || 0)) > 0
  log.rec('probe_result', { ...row, usable, network: net || null, result: resultSummary(result) })
  return { row, usable, net, notLoggedIn: looksNotLoggedIn(events) }
}

// A first: it is the expensive one, so a limit hit shows up before we waste the second turn.
const a = await probe('A: Me root, default settings', { cwd: ME_ROOT, settingSources: null })
const b = (a.notLoggedIn || a.net)
  ? { row: null, usable: false, net: a.net, notLoggedIn: a.notLoggedIn }
  : await probe('B: sandbox-a, --setting-sources user', { cwd: SANDBOX_A, settingSources: 'user' })

const notLoggedIn = a.notLoggedIn || b.notLoggedIn
const net = a.net || b.net
let verdict = 'blocked'
let details = notLoggedIn ? 'claude not logged in'
  : net ? `blocked by network (${net.reason}): ${net.text}`
    : 'a turn completed without usable token usage — nothing to compare'
let impact = 'unknown until both turns complete'

if (!notLoggedIn && a.usable && b.usable) {
  // all three numbers, per run: a zero in one of them is exactly how run 1 lied.
  const bill = (r) => (r.input_tokens || 0) + (r.cache_creation_input_tokens || 0) + (r.cache_read_input_tokens || 0)
  const billedA = bill(a.row)
  const billedB = bill(b.row)
  const saved = billedA - billedB
  log.rec('comparison', {
    A: { input_tokens: a.row.input_tokens, cache_creation_input_tokens: a.row.cache_creation_input_tokens, cache_read_input_tokens: a.row.cache_read_input_tokens },
    B: { input_tokens: b.row.input_tokens, cache_creation_input_tokens: b.row.cache_creation_input_tokens, cache_read_input_tokens: b.row.cache_read_input_tokens },
    billed_A: billedA, billed_B: billedB, saved_tokens: saved,
  })
  verdict = 'works'
  details = `A (Me, default): in=${a.row.input_tokens} cache_creation=${a.row.cache_creation_input_tokens} cache_read=${a.row.cache_read_input_tokens} (total ${billedA}); `
    + `B (sandbox-a, --setting-sources user): in=${b.row.input_tokens} cache_creation=${b.row.cache_creation_input_tokens} cache_read=${b.row.cache_read_input_tokens} (total ${billedB}); saved ${saved}`
  impact = saved > 2000
    ? `--setting-sources user saves ~${saved} tokens per cold node, but hides project skills/workflows (see S3) — make it a per-node switch.`
    : 'the cheap profile saves little; default settings are fine.'
}

log.rec('verdict', { verdict, a_usable: a.usable, b_usable: b.usable, network_blocked: net || null })
saveResult({
  id: 'S7-claude',
  title: 'Cold-start token cost: default settings in Me vs --setting-sources user in sandbox-a',
  verdict, details,
  decisive_evidence: `${log.path} :: comparison`,
  design_impact: impact,
})
await log.close()
process.exit(verdict === 'works' ? 0 : 1)
