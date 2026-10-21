#!/usr/bin/env node
// OFFLINE probe 2 — drive mcp-ask-stub.mjs with a FAKE MCP client and a real unix-socket host.
// Proves, without any model turn:
//   * initialize / tools/list / tools/call answer correctly over newline-delimited JSON-RPC 2.0
//   * the `ask` tool result has the documented shape: content[0].text is JSON with `behavior`
//   * the unix-socket handshake works, and a WRONG token is rejected
//   * a missing host fails CLOSED (deny), never open
// Costs nothing.

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

// ПОЧЕМУ здесь нет `import … from '../lib.mjs'`, хотя раньше был:
//   1. lib.mjs на импорте делает `await pickProfile()` — TCP-проба прокси. На раннере CI это
//      лишние 300 мс и зависимость от сети, которой у проверки быть не должно.
//   2. lib.mjs-овский openLog() открывает spike/claude/logs/<check>.jsonl с флагом 'w', то есть
//      ОБНУЛЯЕТ отслеживаемый git-ом файл-доказательство, а saveResult() переписывает
//      spike/claude/results.json. Эти файлы принадлежат прогонам спайка; проверка в CI обязана
//      оставлять `git status` чистым и не имеет права затирать чужие улики.
// Всё, что от lib.mjs было нужно, — две константы; они считаются здесь и ничего не стоят.
const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..')   // spike/claude
const NODE_BIN = process.execPath

const STUB = join(HERE, 'mcp-ask-stub.mjs')
const TOKEN = randomBytes(16).toString('hex')
const tmp = mkdtempSync(join(tmpdir(), 'pult-stubtest-'))
const SOCK = join(tmp, 'ask.sock')

// Журнал — внутри временной папки (удаляется в конце) плюс те же строки на stdout.
// PULT_LOG_DIR позволяет прогону спайка положить улику куда ему надо, не трогая умолчание.
const log = (() => {
  const path = join(process.env.PULT_LOG_DIR || tmp, 'offline-test-mcp-stub.jsonl')
  return {
    path,
    rec: (kind, data = {}) => {
      const line = JSON.stringify({ t: new Date().toISOString(), check: 'offline-test-mcp-stub', kind, ...data })
      try { appendFileSync(path, line + '\n') } catch { /* журнал — не цель проверки */ }
      process.stdout.write(line + '\n')
    },
    close: async () => {},
  }
})()

let fail = 0
const check = (name, ok, got) => { log.rec('assert', { name, ok, got }); if (!ok) fail++ }

// --- host --------------------------------------------------------------------
const asks = []
let nextDecision = (ask) => ({ behavior: 'allow', updatedInput: ask.input || {} })
let handshakeSeen = null

const server = createServer((sock) => {
  let buf = ''; let hs = false
  sock.setEncoding('utf8')
  sock.on('data', (c) => {
    buf += c
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      if (!hs) {
        handshakeSeen = { hello: msg.hello, token_matches: msg.token === TOKEN }
        const ok = msg.hello === 'pult-mcp-ask/1' && msg.token === TOKEN
        sock.write(JSON.stringify(ok ? { ok: true } : { ok: false, error: 'bad token' }) + '\n')
        if (!ok) return sock.end()
        hs = true; continue
      }
      asks.push(msg.ask)
      sock.write(JSON.stringify({ decision: nextDecision(msg.ask) }) + '\n')
    }
  })
})
await new Promise((r) => server.listen(SOCK, r))

// --- fake MCP client ----------------------------------------------------------
function client(env) {
  const p = spawn(NODE_BIN, [STUB], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  let buf = ''
  p.stdout.setEncoding('utf8')
  p.stdout.on('data', (c) => {
    buf += c
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      const m = JSON.parse(line)
      const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m) }
    }
  })
  let id = 0
  return {
    proc: p,
    call: (method, params) => new Promise((res, rej) => {
      const myId = ++id
      pending.set(myId, res)
      setTimeout(() => { if (pending.delete(myId)) rej(new Error(`timeout on ${method}`)) }, 15000)
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n')
    }),
    notify: (method, params) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'),
    stop: () => { p.stdin.end(); return new Promise((r) => p.on('close', r)) },
  }
}

// === happy path ==============================================================
const c = client({ PULT_ASK_SOCK: SOCK, PULT_ASK_TOKEN: TOKEN, PULT_ASK_SERVER: 'pultask' })

const init = await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pult-fake-client', version: '0' } })
check('initialize returns protocolVersion', !!(init.result && init.result.protocolVersion), init.result && init.result.protocolVersion)
check('initialize returns serverInfo.name', init.result && init.result.serverInfo && init.result.serverInfo.name === 'pultask', init.result && init.result.serverInfo)
check('initialize advertises tools capability', !!(init.result && init.result.capabilities && init.result.capabilities.tools), init.result && init.result.capabilities)

c.notify('notifications/initialized', {})

const list = await c.call('tools/list', {})
const tools = (list.result && list.result.tools) || []
check('tools/list returns exactly one tool named ask', tools.length === 1 && tools[0].name === 'ask', tools.map((t) => t.name))
check('ask has an object inputSchema requiring tool_name+input',
  tools[0] && tools[0].inputSchema && tools[0].inputSchema.type === 'object'
  && (tools[0].inputSchema.required || []).includes('tool_name')
  && (tools[0].inputSchema.required || []).includes('input'),
  tools[0] && tools[0].inputSchema && tools[0].inputSchema.required)

// allow, with an input the host echoes back
const bashInput = { command: 'echo hi', description: 'say hi' }
const allow = await c.call('tools/call', { name: 'ask', arguments: { tool_name: 'Bash', input: bashInput, tool_use_id: 'toolu_fake_1' } })
const allowText = allow.result && allow.result.content && allow.result.content[0] && allow.result.content[0].text
const allowDec = JSON.parse(allowText || '{}')
check('tools/call returns one text content block', !!(allow.result && Array.isArray(allow.result.content) && allow.result.content[0].type === 'text'), allow.result && allow.result.content)
check('allow decision round-trips behavior=allow', allowDec.behavior === 'allow', allowDec)
check('allow decision carries updatedInput', JSON.stringify(allowDec.updatedInput) === JSON.stringify(bashInput), allowDec.updatedInput)
check('host saw tool_name=Bash with the original input', asks[0] && asks[0].tool_name === 'Bash' && asks[0].input.command === 'echo hi', asks[0])
check('host saw tool_use_id', asks[0] && asks[0].tool_use_id === 'toolu_fake_1', asks[0] && asks[0].tool_use_id)
check('handshake used pult-mcp-ask/1 and the right token', handshakeSeen && handshakeSeen.hello === 'pult-mcp-ask/1' && handshakeSeen.token_matches === true, handshakeSeen)

// deny
nextDecision = () => ({ behavior: 'deny', message: 'nope' })
const editInput = { file_path: '/tmp/x.txt', old_string: 'before', new_string: 'OK' }
const deny = await c.call('tools/call', { name: 'ask', arguments: { tool_name: 'Edit', input: editInput, tool_use_id: 'toolu_fake_2' } })
const denyDec = JSON.parse(deny.result.content[0].text)
check('deny decision round-trips behavior=deny with message', denyDec.behavior === 'deny' && denyDec.message === 'nope', denyDec)
check('host saw tool_name=Edit with file_path/old_string/new_string',
  asks[1] && asks[1].tool_name === 'Edit' && Object.keys(asks[1].input).sort().join(',') === 'file_path,new_string,old_string',
  asks[1] && Object.keys(asks[1].input || {}))

// unknown method + unknown tool
const bad = await c.call('nope/whatever', {})
check('unknown method -> JSON-RPC error -32601', bad.error && bad.error.code === -32601, bad.error)
const badTool = await c.call('tools/call', { name: 'notask', arguments: {} })
check('unknown tool -> JSON-RPC error -32602', badTool.error && badTool.error.code === -32602, badTool.error)
const ping = await c.call('ping', {})
check('ping answered', !!ping.result, ping.result)

await c.stop()

// === wrong token: the host must reject, and the stub must fail CLOSED =========
const c2 = client({ PULT_ASK_SOCK: SOCK, PULT_ASK_TOKEN: 'wrong-token', PULT_ASK_SERVER: 'pultask' })
await c2.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } })
const rejected = await c2.call('tools/call', { name: 'ask', arguments: { tool_name: 'Bash', input: { command: 'rm -rf /' } } })
const rejDec = JSON.parse(rejected.result.content[0].text)
check('bad token -> deny (fail closed)', rejDec.behavior === 'deny' && /handshake rejected/.test(rejDec.message || ''), rejDec)
await c2.stop()

// === no host at all: still deny ==============================================
const c3 = client({ PULT_ASK_SOCK: join(tmp, 'nothing-here.sock'), PULT_ASK_TOKEN: TOKEN })
await c3.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } })
const noHost = await c3.call('tools/call', { name: 'ask', arguments: { tool_name: 'Bash', input: { command: 'x' } } })
const noHostDec = JSON.parse(noHost.result.content[0].text)
check('dead host -> deny (fail closed)', noHostDec.behavior === 'deny' && /unreachable/.test(noHostDec.message || ''), noHostDec)
await c3.stop()

// --- cleanup ------------------------------------------------------------------
await new Promise((r) => server.close(r))

log.rec('verdict', { verdict: fail === 0 ? 'works' : 'fails', failed_assertions: fail })
await log.close()
// Временную папку сносим последней: журнал лежит в ней, и он уже выведен на stdout.
rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
