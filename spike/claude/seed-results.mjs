#!/usr/bin/env node
// seed-results.mjs — make sure results.json lists EVERY check of this leg, so a check that never
// ran is visible as 'blocked'/'not_run' instead of silently missing. Rows that already carry a
// real verdict are left alone; each check script overwrites its own row when it runs.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HERE, CHECK_META } from './lib.mjs'

const BLOCKED = 'claude not logged in (`claude auth status --json` -> loggedIn:false, authMethod:none); run `claude` -> /login, then ./run-all.sh'

// Titles live in lib.mjs (CHECK_META), so a row rewritten by the egress guard keeps its title.
const ROWS = Object.entries(CHECK_META).map(([id, m]) => [id, m.title, m.script])

const path = join(HERE, 'results.json')
let doc
try { doc = JSON.parse(readFileSync(path, 'utf8')) } catch { doc = {} }
if (!doc.leg) doc.leg = 'claude'
if (!Array.isArray(doc.checks)) doc.checks = []
if (!Array.isArray(doc.surprises)) doc.surprises = []
if (!Array.isArray(doc.scripts)) doc.scripts = []
if (typeof doc.cleanup !== 'string') doc.cleanup = ''

let added = 0
for (const [id, title, script] of ROWS) {
  if (doc.checks.some((c) => c.id === id)) continue
  doc.checks.push({
    id, title, verdict: 'blocked', details: BLOCKED,
    decisive_evidence: `logs/offline-probe-notloggedin.jsonl :: {"kind":"auth_status","loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}`,
    design_impact: 'none',
    script,
  })
  added++
}
writeFileSync(path, JSON.stringify(doc, null, 2) + '\n')
console.log(`seed-results: ${added} row(s) added, ${doc.checks.length} total -> ${path}`)
