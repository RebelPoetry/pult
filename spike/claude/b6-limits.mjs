#!/usr/bin/env node
// B6 — reading subscription limits (REWRITTEN after run 2).
//
// RUN 2 LESSON: this check used to look ONLY at the statusLine command. That command is never
// invoked under `-p` (statusline_invocations is absent → the capture file is never created), so
// the check said 'fails'. It was looking at the wrong place: the stream itself carries
//   {"type":"rate_limit_event","rate_limit_info":{…},"session_id":…,"uuid":…}
// on every successful turn. That event IS the machine-readable limit source.
//
// So now:
//   (a) capture every `rate_limit_event`, dump the FULL structure of `rate_limit_info`
//       (key names at every level AND the values — they are usage numbers / timestamps /
//        status strings; anything that looks like an id, uuid, token or email is redacted);
//   (b) record HOW MANY arrive per turn and WHERE in the stream (before/after the assistant
//       message, before/after `result`);
//   (c) keep the statusLine probe as a negative control — it proves the command never runs;
//   (d) keep the exact limit-hit strings the adapter must match as a fallback source.
// Cost: 1 tiny haiku turn.

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { baseArgs, newSessionId, openLog, saveResult, startClaude, waitForResult, resultSummary, looksNotLoggedIn, HERE, NODE_BIN, logNetworkProfile, networkFailure, retryRecorder, keyNames, egressGuard } from './lib.mjs'

const log = openLog('b6-limits')
logNetworkProfile(log)
// Egress guard: no model turn until we know which country this traffic leaves from.
await egressGuard(log, 'B6-claude')
const CAPTURE = join(HERE, 'logs', 'b6-statusline-stdin.jsonl')
try { rmSync(CAPTURE, { force: true }) } catch { /* fresh */ }

// --- redaction ---------------------------------------------------------------
// The VALUES inside rate_limit_info are quota numbers, timestamps and status strings — those we
// want verbatim. Identifiers are not: any key that names an id/uuid/token/email/account, and any
// value that LOOKS like one, is replaced before it reaches the log.
const ID_KEY_RE = /(^|_)(id|uuid|ids|token|key|secret|email|account|user|org|organization|subject|sub)($|_)/i
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LONGHEX_RE = /^[0-9a-f]{24,}$/i

function redact(v) {
  if (v === null || v === undefined) return v ?? null
  if (Array.isArray(v)) return v.map(redact)
  if (typeof v === 'object') {
    const o = {}
    for (const k of Object.keys(v).sort()) o[k] = ID_KEY_RE.test(k) ? '<redacted:id-like-key>' : redact(v[k])
    return o
  }
  if (typeof v === 'string') {
    if (v.includes('@') && /\.[a-z]{2,}/i.test(v)) return '<redacted:email-like>'
    if (UUID_RE.test(v)) return '<redacted:uuid-like>'
    if (LONGHEX_RE.test(v)) return '<redacted:hex-like>'
  }
  return v
}

/** Every key path in the object, with the runtime type of its leaf — the SHAPE, at every level. */
function keyPaths(v, prefix = '', out = []) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of Object.keys(v).sort()) keyPaths(v[k], prefix ? `${prefix}.${k}` : k, out)
  } else if (Array.isArray(v)) {
    out.push(`${prefix}[] (${v.length} items, ${v.length ? typeof v[0] : 'empty'})`)
    if (v.length && v[0] && typeof v[0] === 'object') keyPaths(v[0], `${prefix}[0]`, out)
  } else {
    out.push(`${prefix} : ${v === null ? 'null' : typeof v}`)
  }
  return out
}

// The exact refusal texts Pult must recognise (docs/02-FACTS.md "Тексты отказа").
// These stay as the FALLBACK source: they appear in result.result once the limit is already hit,
// whereas rate_limit_event arrives on every healthy turn.
const LIMIT_STRINGS = [
  "You've hit your session limit · resets 3:45pm",
  "You've hit your weekly limit · resets Mon 12:00am",
]
const LIMIT_MATCHERS = [
  String(/You've hit your (session|weekly|5-hour|usage) limit/i),
  String(/resets\s/i),
]
log.rec('limit_strings_to_match', { strings: LIMIT_STRINGS, matchers: LIMIT_MATCHERS })

// statusLine kept as the negative control: if it never writes, the command never ran under -p.
const settings = {
  statusLine: {
    type: 'command',
    command: `${NODE_BIN} ${join(HERE, 'statusline-dump.mjs')} ${CAPTURE}`,
    padding: 0,
  },
}

const sessionId = newSessionId()
const args = baseArgs({ sessionId, extra: ['--settings', JSON.stringify(settings)] })
log.rec('argv', { args })

// --- stream position bookkeeping ---------------------------------------------
// We need to say WHERE rate_limit_event sits relative to the assistant message and the result.
const timeline = []           // [{ n, type, subtype, ms }] for every non-stream_event
let n = 0
const t0 = Date.now()
const s = startClaude({
  args,
  onEvent: (e) => {
    if (e.type === 'stream_event') return
    timeline.push({ n: n++, type: e.type, subtype: e.subtype ?? null, ms: Date.now() - t0 })
  },
})
s.send('reply with the single word OK')
s.endStdin()
const r = await waitForResult(s, 180000, { onRetry: retryRecorder(log, 'b6') })
if (s.alive()) s.kill()
await s.exited
log.rec('result', resultSummary(r))
log.rec('timeline', { events: timeline })

const notLoggedIn = looksNotLoggedIn(s.events)
const net = networkFailure(r)

// --- THE FINDING: rate_limit_event --------------------------------------------
const rleEvents = s.events.filter((e) => e.type === 'rate_limit_event')
log.rec('rate_limit_event_count', {
  n: rleEvents.length,
  num_turns: r && r.num_turns,
  per_turn: r && r.num_turns ? rleEvents.length / r.num_turns : null,
})

// position in the timeline, relative to the assistant message and to result
const posOf = (type) => timeline.findIndex((x) => x.type === type)
const firstAssistant = posOf('assistant')
const lastAssistant = timeline.map((x) => x.type).lastIndexOf('assistant')
const resultPos = posOf('result')
const rlePositions = timeline.filter((x) => x.type === 'rate_limit_event').map((x) => x.n)
log.rec('rate_limit_event_position', {
  rate_limit_event_indexes: rlePositions,
  first_assistant_index: firstAssistant,
  last_assistant_index: lastAssistant,
  result_index: resultPos,
  after_first_assistant: rlePositions.every((p) => p > firstAssistant),
  before_result: rlePositions.every((p) => resultPos < 0 || p < resultPos),
})

let info = null
for (const [i, e] of rleEvents.entries()) {
  info = e.rate_limit_info ?? null
  log.rec('rate_limit_event', {
    n: i + 1,
    event_keys: keyNames(e),
    rate_limit_info_keys: keyNames(info),
    rate_limit_info_key_paths: info ? keyPaths(info) : null,
    rate_limit_info: redact(info),          // VALUES, redacted only where id-like
  })
}

// --- what fields are actually there? ------------------------------------------
const paths = info ? keyPaths(info) : []
const flat = paths.join(' | ')
const has = (re) => paths.filter((p) => re.test(p))
const fields = {
  status: has(/status/i),
  reset: has(/reset/i),
  utilization: has(/utili[sz]ation|percent|used|remaining|usage/i),
  overage: has(/overage/i),
  window_five_hour: has(/five[_.]?hour|5h|session/i),
  window_seven_day: has(/seven[_.]?day|7d|week/i),
  type: has(/(^|\.)(rate_?limit_?type|type)\s*:/i),
}
log.rec('rate_limit_info_fields', fields)

const bothWindows = fields.window_five_hour.length > 0 && fields.window_seven_day.length > 0
log.rec('windows', {
  covers_five_hour: fields.window_five_hour.length > 0,
  covers_seven_day: fields.window_seven_day.length > 0,
  both_in_one_event: bothWindows,
  note: bothWindows
    ? 'one rate_limit_event carries BOTH windows'
    : 'the event carries only the BINDING window — the other one is not in the payload',
})

// --- negative control: the statusLine command ---------------------------------
let captured = null
let rateLimits = null
if (existsSync(CAPTURE)) {
  const lines = readFileSync(CAPTURE, 'utf8').split('\n').filter(Boolean)
  log.rec('statusline_invocations', { n: lines.length })
  for (const l of lines) {
    try {
      const j = JSON.parse(JSON.parse(l).raw)
      captured = Object.keys(j)
      if (j.rate_limits) rateLimits = j.rate_limits
    } catch { /* partial write */ }
  }
} else {
  log.rec('statusline_invocations', { n: 0, capture_file_created: false })
}
log.rec('statusline_stdin', { top_level_keys: captured, rate_limits: redact(rateLimits) })

// --- verdict ------------------------------------------------------------------
const machineReadable = !!info && (fields.status.length > 0 || fields.reset.length > 0 || fields.utilization.length > 0)

let verdict, details, impact
if (notLoggedIn) { verdict = 'blocked'; details = 'claude not logged in'; impact = 'unknown' }
else if (net) { verdict = 'blocked'; details = `blocked by network (${net.reason}): ${net.text}`; impact = 'unknown' }
else if (machineReadable) {
  verdict = 'works'
  details = `stream event rate_limit_event carries rate_limit_info; ${rleEvents.length} event(s) for num_turns=${r && r.num_turns}; fields: ${flat}`
  impact = bothWindows
    ? 'Quota & Failover reads rate_limit_event.rate_limit_info from the stream — no statusLine, no string matching needed; one event covers both windows.'
    : 'Quota & Failover reads rate_limit_event.rate_limit_info, but the event carries only the BINDING window — the other window is invisible until it becomes binding, so keep the limit-string matcher as a fallback.'
} else if (rleEvents.length) {
  verdict = 'partial'
  details = `rate_limit_event arrives (${rleEvents.length}) but rate_limit_info has no status/reset/utilisation field; paths: ${flat}`
  impact = 'Quota & Failover still needs the limit-hit string matcher — see limit_strings_to_match'
} else if (rateLimits) {
  verdict = 'partial'
  details = `no rate_limit_event; statusLine did run: rate_limits=${JSON.stringify(redact(rateLimits))}`
  impact = 'statusLine is the only source, and it is a command hook — awkward for a daemon'
} else {
  verdict = 'fails'
  details = 'neither rate_limit_event nor a statusLine invocation carried limit data'
  impact = 'Quota & Failover needs the limit-hit string matcher only — see limit_strings_to_match'
}

log.rec('verdict', { verdict, network_blocked: net || null })
saveResult({
  id: 'B6-claude',
  title: 'Claude subscription limits: stream event rate_limit_event.rate_limit_info (statusLine never runs under -p)',
  verdict,
  details,
  decisive_evidence: `${log.path} :: rate_limit_event + rate_limit_info_fields`,
  design_impact: impact,
})
await log.close()
process.exit(verdict === 'works' ? 0 : 1)
