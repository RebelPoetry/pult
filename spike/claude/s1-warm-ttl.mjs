#!/usr/bin/env node
// S1 — how long an IDLE `claude -p --input-format stream-json` session stays usable.
// This decides whether Pult can keep "warm" sessions at all (Ф1 acceptance: a warm utterance
// under 3 s), or whether every node must pay a cold --resume each time.
//
// For each N in --minutes: fresh process -> turn 1 -> idle N minutes with stdin HELD OPEN
// -> turn 2. Records liveness after the idle and the latency of turn 2.
//
//   node s1-warm-ttl.mjs                      # 2, 5, 9 minutes  (spike default, 6 tiny turns)
//   node s1-warm-ttl.mjs --minutes 20,40,60   # overnight mode   (documented, ~2h wall clock)
//
// Cost: 2 tiny haiku turns per interval.

// RUN 1 BUG, fixed here: turn 2 reported latency_ms 2 and turn 1's duration_ms, because
// waitForResult scanned the WHOLE event list and handed back the result of turn 1. The second
// turn now waits from a mark taken BEFORE the write, so only a FRESH result counts.

import { baseArgs, newSessionId, openLog, saveResult, startClaude, waitForResult, resultSummary, looksNotLoggedIn, logNetworkProfile, networkFailure, retryRecorder, egressGuard, egressCheck, BLOCKED_COUNTRIES } from './lib.mjs'

const argv = process.argv.slice(2)
const mi = argv.indexOf('--minutes')
const MINUTES = (mi >= 0 && argv[mi + 1] ? argv[mi + 1] : '2,5,9')
  .split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 0)

const log = openLog('s1-warm-ttl')
logNetworkProfile(log)
// Egress guard: no model turn until we know which country this traffic leaves from.
await egressGuard(log, 'S1-claude')
log.rec('plan', { minutes: MINUTES, mode: MINUTES.some((m) => m >= 20) ? 'overnight' : 'spike', turns: MINUTES.length * 2 })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rows = []
let blocked = false
let blockReason = 'claude not logged in'

for (const m of MINUTES) {
  const sessionId = newSessionId()
  const s = startClaude({ args: baseArgs({ sessionId }) })

  const t0 = Date.now()
  s.send('reply with the single word OK')
  const r1 = await waitForResult(s, 180000, { onRetry: retryRecorder(log, `turn1/${m}min`) })
  const lat1 = Date.now() - t0
  log.rec('turn1', { minutes: m, sessionId, latency_ms: lat1, duration_ms: r1 && r1.duration_ms, result: resultSummary(r1) })

  const net1 = networkFailure(r1)
  if (looksNotLoggedIn(s.events) || net1) {
    blocked = true
    if (net1) blockReason = `blocked by network (${net1.reason}): ${net1.text}`
    s.kill(); await s.exited; break
  }

  // idle with stdin held open — this is exactly how a warm Pult session waits
  log.rec('idle_start', { minutes: m })
  await sleep(m * 60_000)
  const aliveAfterIdle = s.alive()
  log.rec('idle_end', { minutes: m, alive: aliveAfterIdle, exitCode: s.child.exitCode, signal: s.child.signalCode })

  // RE-CHECK THE EGRESS AFTER A LONG IDLE. The VPN can drop while we sleep, and the run-2
  // failure (403 "disabled Claude subscription access") landed exactly here: after 20 idle
  // minutes on the `direct` profile. If the egress went bad during the idle, the second turn
  // would measure the network, not the TTL — so we do not send it at all, and the interval is
  // 'blocked', never 'failed'.
  let egressLost = null
  if (aliveAfterIdle && m * 60 > 60) {
    const e2 = await egressCheck()
    log.rec('egress', { when: 'after_idle', minutes: m, mode: e2.mode, loc: e2.loc, ms: e2.ms, blocked: e2.blocked, skipped: e2.skipped })
    if (e2.blocked) {
      egressLost = e2
      log.rec('egress_lost', { minutes: m, mode: e2.mode, loc: e2.loc, ms: e2.ms, guard_list: BLOCKED_COUNTRIES, note: 'second turn NOT sent' })
      blocked = true
      blockReason = `выход в сеть пропал во время простоя (${m} мин): loc=${e2.loc || 'unknown'} — второй ход не отправлялся`
    }
  }

  let lat2 = null, r2 = null, secondTurnOk = false, net2 = null
  if (aliveAfterIdle && !egressLost) {
    // THE FIX: mark the stream BEFORE writing, and wait only for events after that mark.
    // Without it, turn 1's result event is still the first `result` in the list.
    const mark = s.mark()
    const t1 = Date.now()
    s.send('reply with the single word OK again')
    r2 = await waitForResult(s, 180000, { from: mark, onRetry: retryRecorder(log, `turn2/${m}min`) })
    lat2 = Date.now() - t1
    net2 = networkFailure(r2)
    // liveness = the child was still running AND the fresh turn came back clean
    secondTurnOk = !!r2 && r2.is_error !== true && !net2
  }
  log.rec('turn2', {
    minutes: m,
    from_mark: true,
    sent: !egressLost,
    skipped_reason: egressLost ? 'egress_lost' : null,
    latency_ms: lat2,                       // measured from the write of the SECOND message
    duration_ms: r2 && r2.duration_ms,      // the second turn's own duration, per claude
    ok: secondTurnOk,
    network: net2 || null,
    result: resultSummary(r2),
  })

  if (net2) { blocked = true; blockReason = `blocked by network (${net2.reason}): ${net2.text}` }

  s.endStdin()
  s.kill()
  await s.exited
  log.rec('killed', { minutes: m, alive: s.alive() })

  rows.push({
    minutes: m,
    alive_after_idle: aliveAfterIdle,
    second_turn_ok: secondTurnOk,
    // 'blocked' intervals measured the network, not the TTL: they are neither survived nor died.
    blocked: !!egressLost || !!net2,
    blocked_reason: egressLost ? `egress_lost loc=${egressLost.loc || 'unknown'}` : net2 ? net2.reason : null,
    turn1_ms: lat1,
    turn2_ms: lat2,
    turn2_duration_ms: r2 && r2.duration_ms,
  })
  if (blocked) break
}

log.rec('rows', { rows })
const survived = rows.filter((r) => r.second_turn_ok).map((r) => r.minutes)
const died = rows.filter((r) => !r.second_turn_ok && !r.blocked).map((r) => r.minutes)
const verdict = blocked ? 'blocked' : died.length === 0 ? 'works' : survived.length ? 'partial' : 'fails'

log.rec('verdict', { verdict, survived_minutes: survived, failed_minutes: died })
saveResult({
  id: 'S1-claude',
  title: 'Idle TTL of a warm `claude -p --input-format stream-json` session',
  verdict,
  details: blocked ? blockReason : `second turn OK after ${survived.join(',') || 'none'} min; failed after ${died.join(',') || 'none'} min`,
  decisive_evidence: `${log.path} :: rows`,
  design_impact: blocked ? 'unknown until run' : died.length ? `warm sessions must be recycled before ${Math.min(...died)} min idle; beyond that the node falls back to --resume` : 'none',
})
await log.close()
process.exit(verdict === 'works' ? 0 : 1)
