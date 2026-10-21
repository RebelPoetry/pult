#!/usr/bin/env node
// B1 — event stream: one utterance -> structured events until end of turn.
// Records every event type/subtype seen, and the fields of `result` the adapter will read
// (total_cost_usd, usage, permission_denials, terminal_reason).
// Cost: 1 tiny haiku turn.

import { baseArgs, newSessionId, openLog, saveResult, startClaude, waitForResult, resultSummary, looksNotLoggedIn, SANDBOX_A, leakedEnvNames, logNetworkProfile, networkFailure, retryRecorder, egressGuard } from './lib.mjs'

const log = openLog('b1-stream')
logNetworkProfile(log)
// Egress guard: no model turn until we know which country this traffic leaves from.
await egressGuard(log, 'B1-claude')
const sessionId = newSessionId()
log.rec('start', { sessionId, cwd: SANDBOX_A, scrubbed_env_names_removed: leakedEnvNames() })

const args = baseArgs({ sessionId })
log.rec('argv', { bin: 'claude', args })

const kinds = new Map()
const s = startClaude({
  args,
  onEvent: (e) => {
    const k = e.type === 'system' ? `system/${e.subtype}`
      : e.type === 'stream_event' ? `stream_event/${e.event && e.event.type}`
        : e.type
    kinds.set(k, (kinds.get(k) || 0) + 1)
    if (e.type !== 'stream_event') {
      log.rec('event', { type: e.type, subtype: e.subtype, parent_tool_use_id: e.parent_tool_use_id ?? null, uuid: e.uuid })
    }
  },
  onRaw: (line) => log.rec('raw', { line: line.slice(0, 300) }),
})

s.send('reply with the single word OK')
s.endStdin()

const result = await waitForResult(s, 180000, { onRetry: retryRecorder(log, 'b1') })
if (s.alive()) s.kill()
await s.exited

const notLoggedIn = looksNotLoggedIn(s.events)
const net = networkFailure(result)
log.rec('event_kinds', { kinds: Object.fromEntries([...kinds].sort()) })
log.rec('result', resultSummary(result))

const ok = !notLoggedIn && !net && result && result.is_error !== true
  && kinds.has('system/init') && kinds.has('assistant') && kinds.has('stream_event/message_start')

const verdict = ok ? 'works' : (notLoggedIn || net) ? 'blocked' : 'fails'
const details = notLoggedIn ? 'claude not logged in'
  : net ? `blocked by network (${net.reason}): ${net.text}`
    : `event kinds: ${[...kinds.keys()].sort().join(', ')}`

log.rec('verdict', { verdict, network_blocked: net || null })
saveResult({
  id: 'B1-claude',
  title: 'Claude event stream: utterance -> structured events to end of turn',
  verdict,
  details,
  decisive_evidence: `${log.path} :: ${JSON.stringify(resultSummary(result)).slice(0, 300)}`,
  design_impact: 'none',
})
await log.close()
process.exit(ok ? 0 : 1)
