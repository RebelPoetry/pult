#!/usr/bin/env node
// OFFLINE probe 3 — what EXACTLY a stream-json `claude -p` run produces when not logged in.
// One attempt, scrubbed env. Spends no quota (the request never reaches the model).
// The adapter has to recognise this shape, and the trap is real: `subtype` is still "success".
// Also records, NAMES ONLY, which ANTHROPIC_*/CLAUDE_* variables the ambient environment
// carries — the ones the daemon must scrub before spawning `claude`.

import { baseArgs, newSessionId, openLog, saveResult, startClaude, waitForResult, resultSummary, leakedEnvNames, authStatus, SANDBOX_A, logNetworkProfile } from '../lib.mjs'

const log = openLog('offline-probe-notloggedin')
logNetworkProfile(log)

const names = leakedEnvNames()
log.rec('ambient_env_names_scrubbed', { count: names.length, names })

const auth = authStatus()
log.rec('auth_status', { loggedIn: auth.loggedIn, authMethod: auth.authMethod, apiProvider: auth.apiProvider })

// This probe only means something while NOT logged in. Once the owner has logged in the same
// code would spend a real (if tiny) model turn and then overwrite a good row with 'not_run'.
// So: stop here, keep the row that the not-logged-in run already produced.
if (auth.loggedIn) {
  log.rec('skipped', {
    reason: 'logged in — the not-logged-in failure shape cannot be reproduced without logging out',
    evidence_kept: 'logs/run1-proxy-down/offline-probe-notloggedin.jsonl',
  })
  log.rec('verdict', { verdict: 'kept', note: 'existing results.json row left untouched' })
  await log.close()
  process.exit(0)
}

const sessionId = newSessionId()
const args = baseArgs({ sessionId })
log.rec('argv', { args, cwd: SANDBOX_A })

const s = startClaude({ args })
s.send('reply with the single word OK')
s.endStdin()
const r = await waitForResult(s, 60000).catch((e) => ({ type: 'result', is_error: true, result: String(e) }))
await s.exited

const errEvt = s.events.find((e) => e.error === 'authentication_failed')
log.rec('auth_error_event', errEvt ? {
  type: errEvt.type,
  error: errEvt.error,
  is_api_error_message: errEvt.is_api_error_message,
  model: errEvt.message && errEvt.message.model,
  text: errEvt.message && errEvt.message.content && errEvt.message.content[0] && errEvt.message.content[0].text,
} : null)
log.rec('result', resultSummary(r))
log.rec('trap', {
  note: 'result.subtype is "success" even on an auth failure — the adapter must key off is_error / terminal_reason, never subtype',
  subtype: r && r.subtype,
  is_error: r && r.is_error,
  terminal_reason: r && r.terminal_reason,
})

const captured = !!errEvt
log.rec('verdict', { verdict: captured ? 'works' : 'not_run' })
saveResult({
  id: 'PREP3-notloggedin-claude',
  title: 'Exact failure shape of a stream-json `claude -p` run when not logged in, and the env names the daemon must scrub',
  verdict: captured ? 'works' : 'not_run',
  details: `assistant event carries error:"authentication_failed", is_api_error_message:true, text "Failed to authenticate: OAuth session expired and could not be refreshed"; result has is_error:true, terminal_reason:"api_error" BUT subtype:"success". `
    + `${names.length} ANTHROPIC_*/CLAUDE_* variables present in the ambient env (names only): ${names.join(', ')}.`,
  decisive_evidence: `${log.path} :: auth_error_event + trap`,
  design_impact: 'The adapter must key completion off is_error / terminal_reason, never result.subtype. The daemon must build every child env from an allowlist — ANTHROPIC_BASE_URL alone would redirect the API endpoint.',
})
await log.close()
process.exit(captured ? 0 : 1)
