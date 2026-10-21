#!/usr/bin/env node
// OFFLINE probe 1 — does the INSTALLED parser accept every flag the harness uses?
// Method: run `claude <flag>` with the argument missing. commander prints
//   "error: option '--x <y>' argument missing"   -> the flag EXISTS (value flags)
//   "error: unknown option '--x'"                -> the flag does NOT exist
// Boolean flags are checked against `claude --help`. This also covers the HIDDEN
// --permission-prompt-tool, which does not appear in --help at all.
//
// Also probes, for free (the init event is emitted before the auth failure):
//   whether a project-level workflow registers as a slash command under each
//   --setting-sources profile.
// Costs nothing: no model turn is ever completed.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CLAUDE_BIN, openLog, saveResult, scrubbedEnv, SANDBOX_A, startClaude, waitForInit, logNetworkProfile } from '../lib.mjs'

const log = openLog('offline-probe-flags')
logNetworkProfile(log)

const VALUE_FLAGS = [
  '--permission-prompt-tool', '--permission-prompts', '--permission-mode',
  '--json-schema', '--session-id', '--setting-sources', '--mcp-config', '--settings',
  '--model', '--effort', '--input-format', '--output-format', '--allowedTools', '--tools',
  '--agents', '--add-dir', '--system-prompt', '--fallback-model', '--max-budget-usd',
]
const BOOL_FLAGS = [
  '-p', '--verbose', '--include-partial-messages', '--forward-subagent-text',
  '--strict-mcp-config', '--fork-session', '--include-hook-events', '--replay-user-messages',
  '--no-session-persistence',
]
const CONTROL = '--pult-definitely-not-a-flag'

function probe(flag) {
  try {
    const out = execFileSync(CLAUDE_BIN, [flag], { env: scrubbedEnv(), encoding: 'utf8', cwd: SANDBOX_A, stdio: ['ignore', 'pipe', 'pipe'] })
    return { flag, stdout: String(out).slice(0, 200), verdict: 'no-error' }
  } catch (e) {
    const text = String((e.stderr || '') + (e.stdout || '')).trim().slice(0, 300)
    return { flag, text, verdict: /argument missing/.test(text) ? 'accepted' : /unknown option/.test(text) ? 'unknown' : 'other' }
  }
}

const help = execFileSync(CLAUDE_BIN, ['--help'], { env: scrubbedEnv(), encoding: 'utf8', cwd: SANDBOX_A })

const valueRows = VALUE_FLAGS.map(probe)
for (const r of valueRows) log.rec('value_flag', r)
const control = probe(CONTROL)
log.rec('control_flag', control)

// A flag is "listed" only when it starts an option line in --help; a mention inside another
// option's prose does not count (that is exactly how --permission-prompt-tool sneaks in: it is
// named in the --permission-prompts description but has no option line of its own).
const listedInHelp = (flag) => new RegExp(`^\\s+(-\\w, )?${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(,|\\s|$)`, 'm').test(help)

const boolRows = BOOL_FLAGS.map((f) => ({ flag: f, listed_in_help: listedInHelp(f) }))
for (const r of boolRows) log.rec('bool_flag', r)

// hidden-flag note: accepted by the parser, absent from the --help option list
const hidden = valueRows.filter((r) => r.verdict === 'accepted' && !listedInHelp(r.flag)).map((r) => r.flag)
log.rec('hidden_but_accepted', { flags: hidden })

// --- workflow discovery vs --setting-sources ---------------------------------
const WF = join(SANDBOX_A, '.claude', 'workflows', 'pult-echo.js')
async function initFor(settingSources) {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'haiku']
  if (settingSources) args.push('--setting-sources', settingSources)
  // NO turn is completed here: `system/init` is emitted BEFORE the first API call, so we wait
  // for it and kill the child. (While not logged in the turn died by itself; once the owner is
  // logged in, waiting for a result would quietly spend quota in the "offline" stage.)
  // `claude` emits init only after the first user message arrives, so one must be written —
  // but the child is killed the moment init lands, long before the turn could complete.
  const s = startClaude({ args })
  s.send('hi')
  const init = await waitForInit(s, 30000)
  s.kill()
  await s.exited
  return {
    setting_sources: settingSources || '<default>',
    pult_echo_in_slash_commands: init ? (init.slash_commands || []).includes('pult-echo') : null,
    n_slash_commands: init ? (init.slash_commands || []).length : null,
    n_skills: init ? (init.skills || []).length : null,
  }
}

const discovery = []
if (existsSync(WF)) {
  for (const src of ['user', 'user,project', null]) discovery.push(await initFor(src))
  for (const d of discovery) log.rec('workflow_discovery', d)
} else {
  log.rec('workflow_discovery', { skipped: `missing ${WF}` })
}

const allAccepted = valueRows.every((r) => r.verdict === 'accepted')
  && boolRows.every((r) => r.listed_in_help)
  && control.verdict === 'unknown'
log.rec('verdict', { verdict: allAccepted ? 'works' : 'fails', hidden })

const userProfile = discovery.find((d) => d.setting_sources === 'user')
saveResult({
  id: 'PREP1-flags-claude',
  title: 'Every flag the harness uses is accepted by the installed parser (claude 2.1.278)',
  verdict: allAccepted ? 'works' : 'fails',
  details: `${valueRows.length} value flags accepted, ${boolRows.length} boolean flags listed in --help, control flag correctly "unknown option". Hidden but accepted: ${hidden.join(', ') || 'none'}.`
    + (userProfile ? ` Workflow discovery: pult-echo in slash_commands under --setting-sources user = ${userProfile.pult_echo_in_slash_commands}.` : ''),
  decisive_evidence: `${log.path} :: hidden_but_accepted + workflow_discovery`,
  design_impact: userProfile && userProfile.pult_echo_in_slash_commands === false
    ? '--setting-sources user hides project-level workflows and skills; the cheap-start profile and project workflows are mutually exclusive (see S3/S7).'
    : 'none',
})
await log.close()
process.exit(allAccepted ? 0 : 1)
