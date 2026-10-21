#!/usr/bin/env node
// B4 — subagent visibility: parent -> child in the event stream.
// Asserts the chain documented in docs/02-FACTS.md: a subagent's messages carry
// parent_tool_use_id == the id of the Task/Agent tool_use block that spawned it; the main
// conversation carries null. --forward-subagent-text is what makes the child's TEXT appear.
// Cost: 1 tiny haiku turn (+ the subagent's own turn).

import { baseArgs, newSessionId, openLog, saveResult, startClaude, waitForResult, resultSummary, looksNotLoggedIn, logNetworkProfile, networkFailure, retryRecorder, egressGuard } from './lib.mjs'

const log = openLog('b4-subagent')
logNetworkProfile(log)
// Egress guard: no model turn until we know which country this traffic leaves from.
await egressGuard(log, 'B4-claude')
const sessionId = newSessionId()

const args = baseArgs({
  sessionId,
  forwardSubagentText: true,
  extra: ['--allowedTools', 'Task'],
})
log.rec('argv', { args })

const taskUseIds = new Set()
const childMsgs = []

const s = startClaude({
  args,
  onEvent: (e) => {
    if (e.type === 'stream_event') return
    const content = (e.message && e.message.content) || []
    for (const b of Array.isArray(content) ? content : []) {
      if (b && b.type === 'tool_use' && (b.name === 'Task' || b.name === 'Agent')) {
        taskUseIds.add(b.id)
        log.rec('task_tool_use', { id: b.id, name: b.name, subagent_type: b.input && b.input.subagent_type, description: b.input && b.input.description })
      }
    }
    if (e.parent_tool_use_id) {
      childMsgs.push({ type: e.type, parent_tool_use_id: e.parent_tool_use_id, uuid: e.uuid })
      log.rec('child_event', { type: e.type, parent_tool_use_id: e.parent_tool_use_id })
    }
  },
})

s.send('Use the Task tool to spawn exactly one subagent of type Explore whose entire job is to reply with the single word OK. Do not do the work yourself. When it returns, reply with the single word DONE.')
s.endStdin()

const r = await waitForResult(s, 300000, { onRetry: retryRecorder(log, 'b4') })
if (s.alive()) s.kill()
await s.exited
log.rec('result', resultSummary(r))
log.rec('subagent_stats', { stats: r && r.subagent_stats })

const notLoggedIn = looksNotLoggedIn(s.events)
const net = networkFailure(r)
const chained = childMsgs.filter((m) => taskUseIds.has(m.parent_tool_use_id))
const ok = !notLoggedIn && !net && taskUseIds.size > 0 && chained.length > 0
const verdict = ok ? 'works' : (notLoggedIn || net) ? 'blocked' : 'fails'

log.rec('summary', { task_tool_use_ids: [...taskUseIds], child_msgs: childMsgs.length, chained_to_a_task_id: chained.length })
log.rec('verdict', { verdict, network_blocked: net || null })
saveResult({
  id: 'B4-claude',
  title: 'Claude subagent visibility: parent_tool_use_id chain in the stream',
  verdict,
  details: notLoggedIn ? 'claude not logged in'
    : net ? `blocked by network (${net.reason}): ${net.text}`
      : `${taskUseIds.size} Task tool_use ids, ${chained.length} child messages chained to one of them`,
  decisive_evidence: `${log.path} :: summary`,
  design_impact: 'none',
})
await log.close()
process.exit(ok ? 0 : 1)
