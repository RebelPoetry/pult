#!/usr/bin/env node
// B2 + S6 — the FULL --permission-prompt-tool round trip.
//
//   claude -p  --mcp-config <json>  --strict-mcp-config
//              --permission-prompt-tool mcp__pultask__ask
//        |
//        +-- spawns mcp-ask-stub.mjs (stdio MCP server, hand-written)
//                  |
//                  +-- unix socket + token handshake --> THIS process (the "host")
//
// RUN 2 LESSON: turn 1 used to ask for Bash(`echo hi`) and expect a deny. `claude` ran it
// WITHOUT asking — permission_denials was [] and no host_ask arrived — because such read-only
// Bash commands are pre-approved. The DENY branch was therefore never exercised and the check
// said 'fails' for the wrong reason. Turn 1 now edits a file, which really does prompt.
//
// Turn 1: Edit(pult-spike-deny.txt)          -> host DENIES  -> file unchanged,
//         result.permission_denials carries the tool, result.is_error STAYS false
// Turn 2: Edit(pult-spike-note.txt)          -> host ALLOWS  -> the file changed (proven in run 2)
// Turn 3: Bash(`touch pult-probe.txt`)       -> host DENIES  -> does a WRITING Bash command
//         prompt at all? records tool_name + input keys, or their absence
//
// What we are actually proving:
//   * the hidden flag --permission-prompt-tool works with a plain MCP stub (no SDK)
//   * the tool name really is mcp__<server>__ask
//   * what the stub RECEIVES for an Edit call and for a Bash call (the adapter must render it)
//   * allow AND deny both take effect
//   * a denied tool is NOT a failed turn (is_error stays false)
//   * the permission tool is NOT in system/init `tools` although the MCP server is connected
// Cost: 3 tiny haiku turns.

import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { baseArgs, newSessionId, openLog, saveResult, startClaude, waitForResult, resultSummary, looksNotLoggedIn, SANDBOX_A, HERE, NODE_BIN, logNetworkProfile, networkFailure, retryRecorder, keyNames, egressGuard } from './lib.mjs'

const log = openLog('b2-s6-permission')
logNetworkProfile(log)
// Egress guard: no model turn until we know which country this traffic leaves from.
await egressGuard(log, ['B2-claude', 'S6-claude'])

const SERVER_NAME = 'pultask'
const TOOL = `mcp__${SERVER_NAME}__ask`
const TOKEN = randomBytes(24).toString('hex')
const tmp = mkdtempSync(join(tmpdir(), 'pult-ask-'))
const SOCK = join(tmp, 'ask.sock')
const TRACE = join(HERE, 'logs', 'b2-s6-mcp-trace.jsonl')
const NOTE = join(SANDBOX_A, 'pult-spike-note.txt')       // turn 2, ALLOW
const DENY_NOTE = join(SANDBOX_A, 'pult-spike-deny.txt')  // turn 1, DENY
const PROBE = join(SANDBOX_A, 'pult-probe.txt')           // turn 3, Bash write probe

// --- host: answers permission requests over the socket -----------------------
const seen = []            // every ask payload, in order
let decisionQueue = []     // what the host answers, in order

const server = createServer((sock) => {
  let buf = ''
  let handshaken = false
  sock.setEncoding('utf8')
  sock.on('data', (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { sock.end(JSON.stringify({ ok: false, error: 'bad json' }) + '\n'); return }
      if (!handshaken) {
        const ok = msg.hello === 'pult-mcp-ask/1' && msg.token === TOKEN
        log.rec('host_handshake', { ok, hello: msg.hello })
        sock.write(JSON.stringify(ok ? { ok: true } : { ok: false, error: 'bad token' }) + '\n')
        if (!ok) return sock.end()
        handshaken = true
        continue
      }
      const ask = msg.ask || {}
      seen.push(ask)
      const next = decisionQueue.shift()
      // "allow" MUST carry updatedInput; the host echoes the original input when it does not
      // rewrite anything, so the decision is built from the ask, not queued as a literal.
      const decision = typeof next === 'function'
        ? next(ask)
        : (next || { behavior: 'deny', message: 'pult spike: no decision queued' })
      // what the stub RECEIVED: the tool name and the KEY NAMES of its input (plus the values,
      // which are harmless here and show the adapter what it must render).
      log.rec('host_ask', {
        n: seen.length,
        tool_name: ask.tool_name,
        tool_use_id: ask.tool_use_id,
        input_keys: keyNames(ask.input),
        ask_keys: keyNames(ask),
        input: ask.input,
        decided: decision.behavior,
      })
      sock.write(JSON.stringify({ decision }) + '\n')
    }
  })
  sock.on('error', (e) => log.rec('host_sock_error', { error: String(e.message || e) }))
})

await new Promise((res, rej) => { server.once('error', rej); server.listen(SOCK, res) })
log.rec('host_listening', { sock: SOCK })

const mcpConfig = {
  mcpServers: {
    [SERVER_NAME]: {
      command: NODE_BIN,
      args: [join(HERE, 'mcp-ask-stub.mjs')],
      env: { PULT_ASK_SOCK: SOCK, PULT_ASK_TOKEN: TOKEN, PULT_ASK_SERVER: SERVER_NAME, PULT_ASK_TRACE: TRACE },
    },
  },
}

writeFileSync(NOTE, 'before\n')
writeFileSync(DENY_NOTE, 'before\n')
try { unlinkSync(PROBE) } catch { /* fresh */ }

const sessionId = newSessionId()
const args = baseArgs({
  sessionId,
  permissionPrompts: 'host', // this check supplies the handler
  extra: [
    '--mcp-config', JSON.stringify(mcpConfig),
    '--strict-mcp-config',
    '--permission-prompt-tool', TOOL,
  ],
})
log.rec('argv', { args: args.map((a) => (a.includes(TOKEN) ? '<mcp-config with token redacted>' : a)) })

// Text the model says back — recorded per turn, because a denied tool changes what it says.
const s = startClaude({
  args,
  onEvent: (e) => {
    if (e.type === 'stream_event') return
    if (e.type === 'system' && e.subtype === 'init') {
      log.rec('init', {
        mcp_servers: e.mcp_servers,
        // THE FINDING: the permission tool is connected but NOT offered to the model.
        tools_has_ask: (e.tools || []).includes(TOOL),
        n_tools: (e.tools || []).length,
        mcp_tools_in_list: (e.tools || []).filter((t) => String(t).startsWith('mcp__')),
      })
    } else log.rec('event', { type: e.type, subtype: e.subtype })
  },
})

// --- turn 1: DENY an Edit call (this one really prompts) ----------------------
decisionQueue = [{ behavior: 'deny', message: 'pult spike: denied on purpose' }]
const m1 = s.mark()
s.send('Use the Edit tool on the file pult-spike-deny.txt in the current directory: replace the text "before" with "DENIED-SHOULD-NOT-HAPPEN". Then reply with one word.')
const r1 = await waitForResult(s, 180000, { from: m1, onRetry: retryRecorder(log, 'turn1') })
const denyNoteAfter = existsSync(DENY_NOTE) ? readFileSync(DENY_NOTE, 'utf8') : '<missing>'
log.rec('turn1_result', resultSummary(r1))
log.rec('turn1_deny_assertions', {
  host_ask_arrived: seen.some((a) => a.tool_name === 'Edit'),
  file_unchanged: denyNoteAfter === 'before\n',
  file_content: denyNoteAfter.slice(0, 200),
  permission_denials: (r1 && r1.permission_denials) || [],
  denied_tool_names: ((r1 && r1.permission_denials) || []).map((d) => d.tool_name),
  is_error: r1 && r1.is_error,
  terminal_reason: r1 && r1.terminal_reason,
  model_says: typeof r1.result === 'string' ? r1.result.slice(0, 600) : r1.result,
})
const asksT1 = seen.slice()

// --- turn 2: ALLOW an Edit call ----------------------------------------------
const before2 = seen.length
const net1 = networkFailure(r1)
decisionQueue = [(ask) => ({ behavior: 'allow', updatedInput: ask.input || {} })]
// a FRESH mark: without it waitForResult would hand back turn 1's result instantly
const m2 = s.mark()
let r2 = { type: 'result', is_error: true, result: 'skipped: turn 1 was blocked by the network' }
if (!net1 && s.alive()) {
  s.send('Use the Edit tool on the file pult-spike-note.txt in the current directory: replace the text "before" with "OK". Then reply with one word.')
  r2 = await waitForResult(s, 180000, { from: m2, onRetry: retryRecorder(log, 'turn2') })
}
log.rec('turn2_result', resultSummary(r2))
log.rec('turn2_permission_denials', { permission_denials: (r2 && r2.permission_denials) || [] })
const asksT2 = seen.slice(before2)

// --- turn 3: does a WRITING Bash command prompt? ------------------------------
const before3 = seen.length
const net2 = networkFailure(r2)
decisionQueue = [{ behavior: 'deny', message: 'pult spike: denied on purpose (bash probe)' }]
const m3 = s.mark()
let r3 = { type: 'result', is_error: true, result: 'skipped: an earlier turn was blocked by the network' }
if (!net1 && !net2 && s.alive()) {
  s.send('Use the Bash tool to run exactly `touch pult-probe.txt` in the current directory. Nothing else. Then reply with one word.')
  r3 = await waitForResult(s, 180000, { from: m3, onRetry: retryRecorder(log, 'turn3') })
}
const asksT3 = seen.slice(before3)
const bashAsk = asksT3.find((a) => a.tool_name === 'Bash')
log.rec('turn3_result', resultSummary(r3))
log.rec('turn3_bash_probe', {
  command_requested: 'touch pult-probe.txt',
  host_ask_arrived: !!bashAsk,
  tool_name: bashAsk ? bashAsk.tool_name : null,
  input_keys: keyNames(bashAsk && bashAsk.input),
  input: bashAsk ? bashAsk.input : null,
  permission_denials: (r3 && r3.permission_denials) || [],
  // if nothing asked, the command ran unattended and the file exists: that is the proof
  probe_file_exists: existsSync(PROBE),
  is_error: r3 && r3.is_error,
  model_says: typeof r3.result === 'string' ? r3.result.slice(0, 400) : r3.result,
})

s.endStdin()
if (s.alive()) s.kill()
await s.exited

// the allow decision for Edit must carry updatedInput back; Claude requires the key to exist
// when behavior === "allow", so the host echoes the original input if it does not rewrite it.
const noteAfter = existsSync(NOTE) ? readFileSync(NOTE, 'utf8') : '<missing>'
log.rec('note_after', { content: noteAfter.slice(0, 200) })

const notLoggedIn = looksNotLoggedIn(s.events)
const net = net1 || net2 || networkFailure(r3)
const denyAsk = asksT1.find((a) => a.tool_name === 'Edit')
const editAsk = asksT2.find((a) => a.tool_name === 'Edit')
const denials1 = (r1 && r1.permission_denials) || []

const denyOk = !!denyAsk
  && denyNoteAfter === 'before\n'
  && denials1.some((d) => d.tool_name === 'Edit')
  && r1.is_error === false
const allowOk = !!editAsk && /OK/.test(noteAfter)
const ok = !notLoggedIn && !net && denyOk && allowOk

log.rec('summary', {
  tool_name_format: TOOL,
  deny_branch_ok: denyOk,
  allow_branch_ok: allowOk,
  deny_ask_input_keys: keyNames(denyAsk && denyAsk.input),
  edit_ask_input_keys: keyNames(editAsk && editAsk.input),
  bash_ask_input_keys: keyNames(bashAsk && bashAsk.input),
  bash_prompts: !!bashAsk,
  turn1_permission_denials: denials1,
  turn1_is_error: r1 && r1.is_error,
})

const verdict = ok ? 'works' : (notLoggedIn || net) ? 'blocked' : 'fails'
log.rec('verdict', { verdict, network_blocked: net || null })

const details = notLoggedIn ? 'claude not logged in'
  : net ? `blocked by network (${net.reason}): ${net.text}`
    : `tool=${TOOL}; DENY: ask=${!!denyAsk} file_unchanged=${denyNoteAfter === 'before\n'} denials=${JSON.stringify(denials1.map((d) => d.tool_name))} is_error=${r1 && r1.is_error}; ALLOW: ask=${!!editAsk} file="${noteAfter.trim()}"; Bash(touch) prompts=${!!bashAsk} input_keys=${JSON.stringify(keyNames(bashAsk && bashAsk.input))}`
saveResult({
  id: 'B2-claude',
  title: 'Claude answers a permission request: host replies deny (turn 1, Edit) and allow (turn 2, Edit); Bash write probe (turn 3)',
  verdict, details,
  decisive_evidence: `${log.path} :: turn1_deny_assertions + turn3_bash_probe`,
  design_impact: bashAsk
    ? 'none'
    : 'Pult cannot assume every Bash command reaches the host: read-only ones are pre-approved and run unattended. The approval UI only ever sees what claude decides to ask about.',
})
saveResult({
  id: 'S6-claude',
  title: 'Claude: full --permission-prompt-tool circuit with a hand-written stdio MCP stub talking to a unix-socket host',
  verdict, details,
  decisive_evidence: `${log.path} :: host_handshake + host_ask records`,
  design_impact: 'The permission tool is NOT listed in system/init `tools` (tools_has_ask:false) although the MCP server shows status "connected" — do not use the tools list to verify the circuit.',
})

// --- cleanup -----------------------------------------------------------------
await new Promise((r) => server.close(r))
try { unlinkSync(SOCK) } catch { /* server.close removes it */ }
rmSync(tmp, { recursive: true, force: true })
for (const f of [NOTE, DENY_NOTE, PROBE]) { try { unlinkSync(f) } catch { /* fine */ } }
log.rec('cleanup', { socket_removed: !existsSync(SOCK), tmp_removed: !existsSync(tmp), files_removed: [NOTE, DENY_NOTE, PROBE].every((f) => !existsSync(f)) })
await log.close()
process.exit(ok ? 0 : 1)
