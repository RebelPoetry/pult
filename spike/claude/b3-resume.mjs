#!/usr/bin/env node
// B3 — resume: continue the SAME session after the process was killed.
// Turn 1 plants a fact, the process is SIGKILLed, a new process is started with
// --resume <same uuid> and asked a context-dependent follow-up.
// Cost: 2 tiny haiku turns.

import { baseArgs, newSessionId, openLog, saveResult, startClaude, waitForResult, resultSummary, looksNotLoggedIn, SANDBOX_A, logNetworkProfile, networkFailure, retryRecorder, egressGuard } from './lib.mjs'

const log = openLog('b3-resume')
logNetworkProfile(log)
// Egress guard: no model turn until we know which country this traffic leaves from.
await egressGuard(log, 'B3-claude')
const sessionId = newSessionId()
const SECRET = 'PULTSPIKE7'

// --- turn 1 -------------------------------------------------------------------
const s1 = startClaude({ args: baseArgs({ sessionId }) })
s1.send(`Remember this codeword: ${SECRET}. Reply with the single word OK.`)
const r1 = await waitForResult(s1, 180000, { onRetry: retryRecorder(log, 'turn1') })
log.rec('turn1_result', resultSummary(r1))

const net1 = networkFailure(r1)
if (looksNotLoggedIn(s1.events) || net1) {
  s1.kill(); await s1.exited
  const details = net1 ? `blocked by network (${net1.reason}): ${net1.text}` : 'claude not logged in'
  log.rec('verdict', { verdict: 'blocked', reason: details })
  saveResult({ id: 'B3-claude', title: 'Claude resume of the same session after the process is killed', verdict: 'blocked', details, decisive_evidence: `${log.path} :: turn1_result`, design_impact: 'none' })
  await log.close(); process.exit(1)
}

// --- kill the process mid-session (no graceful stdin close) -------------------
s1.kill('SIGKILL')
const gone = await s1.exited
log.rec('killed', { code: gone.code, signal: gone.signal, alive: s1.alive() })

// --- turn 2: resume -----------------------------------------------------------
// --resume <uuid> reuses the SAME session id; --fork-session would mint a new one.
const args2 = baseArgs({ sessionId: null, extra: ['--resume', sessionId] })
log.rec('argv_resume', { args: args2 })
const s2 = startClaude({ args: args2 })
s2.send('What was the codeword I asked you to remember? Reply with just the codeword.')
s2.endStdin()
const r2 = await waitForResult(s2, 180000, { onRetry: retryRecorder(log, 'turn2') })
if (s2.alive()) s2.kill()
await s2.exited
log.rec('turn2_result', resultSummary(r2))

const text = typeof r2.result === 'string' ? r2.result : JSON.stringify(r2.result || '')
const sameSession = r2.session_id === sessionId
const remembered = text.includes(SECRET)
const net2 = networkFailure(r2)
const ok = !net2 && !r2.is_error && remembered
const verdict = ok ? 'works' : net2 ? 'blocked' : 'fails'

log.rec('summary', { sessionId, resumed_session_id: r2.session_id, same_session_id: sameSession, remembered })
log.rec('verdict', { verdict, network_blocked: net2 || null })
saveResult({
  id: 'B3-claude',
  title: 'Claude resume of the same session after the process is killed',
  verdict,
  details: net2 ? `blocked by network (${net2.reason}): ${net2.text}` : `session_id reused: ${sameSession}; codeword recalled: ${remembered}`,
  decisive_evidence: `${log.path} :: turn2_result`,
  design_impact: 'none',
})
await log.close()
process.exit(ok ? 0 : 1)
