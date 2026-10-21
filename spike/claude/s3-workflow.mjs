#!/usr/bin/env node
// S3 — launching a SAVED workflow from `claude -p` with the utterance `Run /<name> …`.
// The workflow is sandbox-a/.claude/workflows/pult-echo.js (one haiku agent, schema output).
//
// ALREADY PROVEN OFFLINE (offline/probe-flags.mjs, and re-asserted here before the turn):
//   a project-level workflow is NOT registered as a slash command under `--setting-sources user`.
//   It appears only with `--setting-sources user,project` (or with no --setting-sources at all).
//   That is why this check deliberately uses 'user,project' and S7's cheap profile cannot be
//   combined with project-local workflows.
//
// RUN 2 LESSON: the utterance made claude call the tool **Skill** with
//   {"skill":"pult-echo","args":"{\"word\":\"OK\"}"}
// — NOT a tool named `Workflow`. The allow rule was `Workflow(pult-echo)`, so with
// `--permission-prompts none` the call was auto-denied:
//   "Permission for this tool use was denied. It requires approval, and this session has no
//    approval surface…"
// This check now tries the NARROWEST rule first and widens only if that is still denied, and
// records WHICH exact rule was needed.
//
// Attempt 1: --allowedTools "Skill(pult-echo)" "Workflow(pult-echo)"
// Attempt 2 (only if still denied): --allowedTools "Skill" "Workflow"
// Cost: 1 tiny haiku turn per attempt (+ the workflow's own agent turn).

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { baseArgs, newSessionId, openLog, saveResult, startClaude, waitForResult, resultSummary, looksNotLoggedIn, SANDBOX_A, logNetworkProfile, networkFailure, retryRecorder, egressGuard } from './lib.mjs'

const log = openLog('s3-workflow')
logNetworkProfile(log)
// Egress guard: no model turn until we know which country this traffic leaves from.
await egressGuard(log, 'S3-claude')
const WF = join(SANDBOX_A, '.claude', 'workflows', 'pult-echo.js')
if (!existsSync(WF)) {
  log.rec('verdict', { verdict: 'blocked', reason: `workflow file missing: ${WF}` })
  saveResult({ id: 'S3-claude', title: 'Claude: launch a saved workflow by the utterance `Run /pult-echo …`', verdict: 'blocked', details: `missing ${WF}`, decisive_evidence: `${log.path} :: verdict`, design_impact: 'none' })
  await log.close(); process.exit(1)
}
log.rec('workflow_file', { path: WF })

const UTTERANCE = 'Run /pult-echo with args {"word":"OK"}'

/** One attempt with a given allow rule set. Costs one tiny turn (+ the workflow's agent turn). */
async function attempt(label, allowedTools) {
  const sessionId = newSessionId()
  const args = baseArgs({
    sessionId,
    settingSources: 'user,project',
    extra: ['--allowedTools', ...allowedTools],
  })
  log.rec('attempt_argv', { label, allowed_tools: allowedTools, args })

  const seenTools = []
  const childEvents = []     // events carrying parent_tool_use_id — the workflow's agent() leg
  const toolResults = []
  let initHasSlash = null

  const s = startClaude({
    args,
    onEvent: (e) => {
      if (e.type === 'stream_event') return
      if (e.type === 'system' && e.subtype === 'init') {
        initHasSlash = (e.slash_commands || []).includes('pult-echo')
        log.rec('init', {
          label,
          pult_echo_in_slash_commands: initHasSlash,
          n_slash_commands: (e.slash_commands || []).length,
          tools_has_Skill: (e.tools || []).includes('Skill'),
          tools_has_Workflow: (e.tools || []).includes('Workflow'),
        })
        return
      }
      const content = (e.message && e.message.content) || []
      for (const b of Array.isArray(content) ? content : []) {
        if (b && b.type === 'tool_use') {
          seenTools.push({ name: b.name, input: b.input, id: b.id, parent_tool_use_id: e.parent_tool_use_id || null })
          log.rec('tool_use', { label, name: b.name, input: b.input, tool_use_id: b.id, parent_tool_use_id: e.parent_tool_use_id || null })
        }
        if (b && b.type === 'tool_result') {
          const preview = JSON.stringify(b.content)
          toolResults.push({ tool_use_id: b.tool_use_id, is_error: b.is_error, content: b.content })
          log.rec('tool_result', { label, tool_use_id: b.tool_use_id, is_error: b.is_error, parent_tool_use_id: e.parent_tool_use_id || null, preview: preview && preview.slice(0, 1200) })
        }
      }
      if (e.parent_tool_use_id) {
        childEvents.push({ type: e.type, subtype: e.subtype ?? null, parent_tool_use_id: e.parent_tool_use_id })
        log.rec('child_event', { label, type: e.type, subtype: e.subtype ?? null, parent_tool_use_id: e.parent_tool_use_id })
      } else log.rec('event', { label, type: e.type, subtype: e.subtype })
    },
  })

  s.send(UTTERANCE)
  s.endStdin()
  const r = await waitForResult(s, 300000, { onRetry: retryRecorder(log, label) })
  if (s.alive()) s.kill()
  await s.exited
  log.rec('attempt_result', { label, ...resultSummary(r) })

  const denials = (r && r.permission_denials) || []
  const denied = denials.length > 0
    || s.events.some((e) => e.type === 'system' && e.subtype === 'permission_denied')
  log.rec('attempt_summary', {
    label,
    allowed_tools: allowedTools,
    denied,
    permission_denials: denials,
    tools_seen: seenTools.map((t) => t.name),
    child_event_types: [...new Set(childEvents.map((c) => `${c.type}/${c.subtype ?? '-'}`))],
    n_child_events: childEvents.length,
    parent_tool_use_ids: [...new Set(childEvents.map((c) => c.parent_tool_use_id))],
    num_turns: r && r.num_turns,
    total_cost_usd: r && r.total_cost_usd,
  })
  return { label, allowedTools, r, seenTools, childEvents, toolResults, denied, initHasSlash, notLoggedIn: looksNotLoggedIn(s.events), net: networkFailure(r) }
}

// --- attempt 1: the NARROWEST rule -------------------------------------------
let a = await attempt('narrow', ['Skill(pult-echo)', 'Workflow(pult-echo)'])
let ruleNeeded = 'Skill(pult-echo) + Workflow(pult-echo)'

// --- attempt 2: widen, only if still denied ----------------------------------
if (a.denied && !a.notLoggedIn && !a.net) {
  log.rec('widening', { reason: 'attempt "narrow" was still denied', permission_denials: (a.r.permission_denials || []).map((d) => d.tool_name) })
  a = await attempt('broad', ['Skill', 'Workflow'])
  ruleNeeded = a.denied ? 'NONE of the tried rules allowed it' : 'Skill + Workflow (bare tool names; the scoped form Skill(pult-echo) was NOT enough)'
}

const r = a.r
const skillCall = a.seenTools.find((t) => t.name === 'Skill')
const wfCall = a.seenTools.find((t) => t.name === 'Workflow')
const agentLeg = a.childEvents.length > 0
const finalText = typeof r.result === 'string' ? r.result : JSON.stringify(r.result)
// the workflow's returned value: it comes back inside the Skill/Workflow tool_result
const wfResultRaw = a.toolResults.map((tr) => JSON.stringify(tr.content)).join(' || ')
const argsType = /"args_type"\s*:\s*"([a-z]+)"/.exec(wfResultRaw + ' ' + finalText)
const returnedEchoed = /"echoed"\s*:\s*"([^"]*)"/.exec(wfResultRaw + ' ' + finalText)

log.rec('workflow_return', {
  rule_needed: ruleNeeded,
  tool_used_by_model: skillCall ? 'Skill' : (wfCall ? 'Workflow' : null),
  skill_tool_input: skillCall && skillCall.input,
  args_arrived_as: argsType ? argsType[1] : null,
  echoed: returnedEchoed ? returnedEchoed[1] : null,
  tool_result_preview: wfResultRaw.slice(0, 1500),
  final_result_text: finalText && finalText.slice(0, 600),
})

const net = a.net
const notLoggedIn = a.notLoggedIn
const ok = !notLoggedIn && !net && !a.denied && (!!skillCall || !!wfCall) && !r.is_error

log.rec('summary', {
  rule_needed: ruleNeeded,
  skill_tool_called: !!skillCall,
  workflow_tool_called: !!wfCall,
  agent_leg_visible_as_child_events: agentLeg,
  n_child_events: a.childEvents.length,
  parent_tool_use_ids: [...new Set(a.childEvents.map((c) => c.parent_tool_use_id))],
  args_arrived_as: argsType ? argsType[1] : null,
  num_turns: r && r.num_turns,
  total_cost_usd: r && r.total_cost_usd,
  tools_seen: a.seenTools.map((t) => t.name),
})
log.rec('verdict', { verdict: ok ? 'works' : (notLoggedIn || net) ? 'blocked' : 'fails', network_blocked: net || null })

const verdict = ok ? 'works' : (notLoggedIn || net) ? 'blocked' : 'fails'
saveResult({
  id: 'S3-claude',
  title: 'Claude: launch a saved workflow by the utterance `Run /pult-echo …` from -p',
  verdict,
  details: notLoggedIn ? 'claude not logged in'
    : net ? `blocked by network (${net.reason}): ${net.text}`
      : `rule needed: ${ruleNeeded}; the model calls the tool **Skill** (not Workflow) with input ${JSON.stringify(skillCall && skillCall.input)}; args arrived as ${argsType ? argsType[1] : 'unknown'}; agent() leg visible as child events: ${agentLeg} (n=${a.childEvents.length}); num_turns=${r && r.num_turns} cost=${r && r.total_cost_usd}; slash command registered: ${a.initHasSlash}`,
  decisive_evidence: `${log.path} :: summary + workflow_return`,
  design_impact: 'An utterance `Run /<name> …` is dispatched through the **Skill** tool, not `Workflow` — the allow rule (and any Pult permission UI) must key off Skill. A project workflow is also invisible under --setting-sources user, so a node that uses project skills/workflows cannot use the cheap S7 profile.',
})
await log.close()
process.exit(ok ? 0 : 1)
