#!/usr/bin/env node
// statusline-dump.mjs — a statusLine command that does nothing but capture its stdin JSON.
// Claude Code feeds the status-line command a JSON document on stdin; per
// code.claude.com/docs/en/statusline.md it carries rate_limits.five_hour / rate_limits.seven_day
// with used_percentage and resets_at. That JSON is the ONLY documented machine-readable form
// of the subscription limits (docs/02-FACTS.md "Лимиты подписки"), so Pult's Quota & Failover
// reads it exactly this way.
//
// argv[2] = file to write the raw stdin to (appended as JSONL: {t, raw}).

import { appendFileSync } from 'node:fs'

const OUT = process.argv[2]
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { buf += c })
process.stdin.on('end', () => {
  if (OUT) {
    try { appendFileSync(OUT, JSON.stringify({ t: new Date().toISOString(), raw: buf }) + '\n') } catch { /* best effort */ }
  }
  // the status line itself must print something short
  let pct = '?'
  try {
    const j = JSON.parse(buf)
    pct = j && j.rate_limits && j.rate_limits.five_hour ? String(j.rate_limits.five_hour.used_percentage) : '?'
  } catch { /* not JSON */ }
  process.stdout.write(`pult ${pct}\n`)
})
