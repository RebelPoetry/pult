#!/usr/bin/env node
// B5 — structured output by JSON schema: --json-schema <schema> -> result.structured_output.
// This is the "arrow contract" of the node board (docs/04-DELTA-v0.3.md §200).
// Cost: 1 tiny haiku turn.

import { baseArgs, newSessionId, openLog, saveResult, startClaude, waitForResult, resultSummary, looksNotLoggedIn, logNetworkProfile, networkFailure, retryRecorder, egressGuard } from './lib.mjs'

const log = openLog('b5-schema')
logNetworkProfile(log)
// Egress guard: no model turn until we know which country this traffic leaves from.
await egressGuard(log, 'B5-claude')
const sessionId = newSessionId()

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    word: { type: 'string' },
    confident: { type: 'boolean' },
  },
  required: ['word', 'confident'],
}

const args = baseArgs({ sessionId, extra: ['--json-schema', JSON.stringify(SCHEMA)] })
log.rec('argv', { args })
log.rec('schema', { schema: SCHEMA })

const s = startClaude({ args })
s.send('Put the single word OK in "word" and true in "confident".')
s.endStdin()
const r = await waitForResult(s, 180000, { onRetry: retryRecorder(log, 'b5') })
if (s.alive()) s.kill()
await s.exited

log.rec('result', resultSummary(r))
log.rec('structured_output', { structured_output: r && r.structured_output })

const notLoggedIn = looksNotLoggedIn(s.events)
const net = networkFailure(r)
const so = r && r.structured_output
const ok = !notLoggedIn && !net && so && typeof so === 'object' && typeof so.word === 'string' && typeof so.confident === 'boolean'
const verdict = ok ? 'works' : (notLoggedIn || net) ? 'blocked' : 'fails'

log.rec('verdict', { verdict, network_blocked: net || null })
saveResult({
  id: 'B5-claude',
  title: 'Claude structured output: --json-schema -> result.structured_output',
  verdict,
  details: notLoggedIn ? 'claude not logged in'
    : net ? `blocked by network (${net.reason}): ${net.text}`
      : `structured_output = ${JSON.stringify(so)}`,
  decisive_evidence: `${log.path} :: structured_output`,
  design_impact: 'none',
})
await log.close()
process.exit(ok ? 0 : 1)
