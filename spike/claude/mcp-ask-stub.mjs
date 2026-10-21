#!/usr/bin/env node
// mcp-ask-stub.mjs — a hand-written stdio MCP server exposing ONE tool, `ask`.
// This is the shape `pult mcp-ask` will ship as (docs/04-DELTA-v0.3.md §2).
//
// Claude Code launches it via --mcp-config and routes every permission prompt to it via
//   --permission-prompt-tool mcp__<serverName>__ask
// The stub itself decides nothing: it forwards each request over a unix socket to the Pult
// host (token handshake) and returns whatever the host decides.
//
// No SDK, no dependencies. MCP stdio transport = newline-delimited JSON-RPC 2.0.
//
// Env:
//   PULT_ASK_SOCK   path to the host's unix socket (required)
//   PULT_ASK_TOKEN  shared secret for the handshake (required)
//   PULT_ASK_SERVER server name, only used in serverInfo (default "pultask")
//   PULT_ASK_TRACE  optional path; every JSON-RPC message in/out is appended as JSONL

import { createConnection } from 'node:net'
import { appendFileSync } from 'node:fs'

const SOCK = process.env.PULT_ASK_SOCK
const TOKEN = process.env.PULT_ASK_TOKEN
const SERVER_NAME = process.env.PULT_ASK_SERVER || 'pultask'
const TRACE = process.env.PULT_ASK_TRACE || ''

const PROTOCOL_VERSION = '2025-06-18'

function trace(dir, msg) {
  if (!TRACE) return
  try { appendFileSync(TRACE, JSON.stringify({ t: new Date().toISOString(), dir, msg }) + '\n') } catch { /* tracing is best-effort */ }
}

function write(msg) {
  trace('out', msg)
  process.stdout.write(JSON.stringify(msg) + '\n')
}

// --- the single tool ---------------------------------------------------------
// Claude Code calls the permission-prompt tool with the pending tool call. The documented
// contract is: the tool returns ONE text content block whose text is JSON, either
//   {"behavior":"allow","updatedInput":{...}}   or   {"behavior":"deny","message":"..."}
const ASK_TOOL = {
  name: 'ask',
  description: 'Pult permission prompt. Returns {"behavior":"allow","updatedInput":{...}} or {"behavior":"deny","message":"..."}.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string', description: 'Name of the tool asking for permission' },
      input: { type: 'object', description: 'The input the tool was called with' },
      tool_use_id: { type: 'string', description: 'Id of the tool_use block' },
    },
    required: ['tool_name', 'input'],
    additionalProperties: true,
  },
}

// --- host link ---------------------------------------------------------------
// One short-lived connection per decision keeps the stub stateless and makes a dead host
// an immediate, visible failure instead of a hang.
function askHost(payload, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    if (!SOCK || !TOKEN) return reject(new Error('PULT_ASK_SOCK / PULT_ASK_TOKEN not set'))
    const sock = createConnection(SOCK)
    let buf = ''
    let handshaken = false
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`host timeout after ${timeoutMs}ms`)) }, timeoutMs)
    const done = (fn, arg) => { clearTimeout(timer); sock.end(); fn(arg) }

    sock.setEncoding('utf8')
    sock.on('connect', () => {
      sock.write(JSON.stringify({ hello: 'pult-mcp-ask/1', token: TOKEN }) + '\n')
    })
    sock.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        let msg
        try { msg = JSON.parse(line) } catch { return done(reject, new Error('host sent non-JSON: ' + line.slice(0, 120))) }
        if (!handshaken) {
          if (msg.ok !== true) return done(reject, new Error('handshake rejected: ' + JSON.stringify(msg).slice(0, 160)))
          handshaken = true
          sock.write(JSON.stringify({ ask: payload }) + '\n')
          continue
        }
        return done(resolve, msg.decision)
      }
    })
    sock.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

// --- JSON-RPC loop -----------------------------------------------------------
async function handle(msg) {
  const { id, method, params } = msg

  // notifications carry no id — never answer them
  if (id === undefined || id === null) return

  if (method === 'initialize') {
    return write({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: '0.0.1' },
      },
    })
  }

  if (method === 'tools/list') {
    return write({ jsonrpc: '2.0', id, result: { tools: [ASK_TOOL] } })
  }

  if (method === 'tools/call') {
    const a = (params && params.arguments) || {}
    if ((params && params.name) !== ASK_TOOL.name) {
      return write({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${params && params.name}` } })
    }
    let decision
    try {
      decision = await askHost({
        tool_name: a.tool_name, input: a.input, tool_use_id: a.tool_use_id, raw_arguments: a,
      })
    } catch (e) {
      // fail CLOSED: a host we cannot reach must never mean "allow"
      decision = { behavior: 'deny', message: `pult host unreachable: ${String(e.message || e).slice(0, 160)}` }
    }
    if (!decision || (decision.behavior !== 'allow' && decision.behavior !== 'deny')) {
      decision = { behavior: 'deny', message: 'pult host returned no decision' }
    }
    return write({
      jsonrpc: '2.0', id,
      result: { content: [{ type: 'text', text: JSON.stringify(decision) }], isError: false },
    })
  }

  if (method === 'ping') return write({ jsonrpc: '2.0', id, result: {} })

  return write({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
}

let inbuf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  inbuf += chunk
  let nl
  while ((nl = inbuf.indexOf('\n')) >= 0) {
    const line = inbuf.slice(0, nl); inbuf = inbuf.slice(nl + 1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch {
      trace('in-bad', line.slice(0, 200))
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
      continue
    }
    trace('in', msg)
    handle(msg).catch((e) => trace('handler-error', String(e)))
  }
})
process.stdin.on('end', () => process.exit(0))
