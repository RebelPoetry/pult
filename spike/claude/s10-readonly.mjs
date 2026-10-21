#!/usr/bin/env node
// S10 (ревью M8d, 19.10.2026) — режим Claude «только чтение»: `--permission-mode manual` + `--disallowedTools` для
// правок и ExitPlanMode. Ревью показало, что `plan` не read-only: haiku писал `~/.claude/plans/…md` без вопроса,
// а ExitPlanMode выводил из плана одним общим «да» в Inbox.
//
// Ходы (haiku, low, 2): одна сессия, временная папка, `--setting-sources project,local`, заглушка s9-stub (allow):
//   1. «создай note.txt инструментом Write» → Write запрещён: файла нет, вопроса о Write нет;
//   2. «touch probe.txt через Bash» → вопрос ДОЛЖЕН прийти в заглушку (manual спрашивает), заглушка разрешает.
// Заодно: список инструментов из system/init — точные имена (Write, Edit, MultiEdit, NotebookEdit, ExitPlanMode).

import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { baseArgs, newSessionId, openLog, saveResult, startClaude, waitForResult, resultSummary, looksNotLoggedIn, HERE, NODE_BIN, logNetworkProfile, scrubbedEnv, egressGuard } from './lib.mjs'

const ID = 'S10-claude'
export const DENIED = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'ExitPlanMode']
const log = openLog('s10-readonly')
logNetworkProfile(log)
await egressGuard(log, [ID])

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pult-s10-')))
const TRACE = join(HERE, 'logs', 's10-mcp-trace.jsonl')
writeFileSync(TRACE, '')
const mcpConfig = join(dir, 'mcp.json')
writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { pultask: { command: NODE_BIN, args: [join(HERE, 's9-stub.mjs')], env: { S9_TRACE: TRACE } } } }))
const asks = () => readFileSync(TRACE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => r.dir === 'in' && r.msg?.method === 'tools/call').map((r) => r.msg.params.arguments)

const s = startClaude({
  args: [
    ...baseArgs({ sessionId: newSessionId(), model: 'haiku', effort: 'low', settingSources: 'project,local', permissionPrompts: 'host' }),
    '--permission-mode', 'manual', '--disallowedTools', ...DENIED,
    '--mcp-config', mcpConfig, '--strict-mcp-config', '--permission-prompt-tool', 'mcp__pultask__ask',
  ],
  cwd: dir, env: scrubbedEnv(),
})
const turn = async (text, label) => {
  const from = s.mark()
  const before = asks().length
  s.send(text)
  const r = await waitForResult(s, 180000, { from })
  if (looksNotLoggedIn(s.events)) { log.rec('verdict', { verdict: 'blocked', reason: 'not logged in' }); process.exit(2) }
  const a = asks().slice(before)
  log.rec('turn', { label, result: resultSummary(r), asks: a.map((x) => ({ tool_name: x.tool_name, input: x.input })) })
  return a
}
const t1 = await turn('Use the Write tool to create the file note.txt with the content "hi". Do not use any other tool. Then reply "done".', 'T1 Write')
const t2 = await turn('Run exactly this shell command with the Bash tool and nothing else: touch probe.txt — then reply "done".', 'T2 Bash')
s.endStdin(); await s.exited
const init = s.events.find((e) => e.type === 'system' && e.subtype === 'init')
const tools = Array.isArray(init?.tools) ? init.tools : []
const verdict = {
  init_tools_have_denied: DENIED.filter((t) => tools.includes(t)),
  init_tools_count: tools.length,
  write_file_exists: existsSync(join(dir, 'note.txt')),
  write_asked: t1.some((a) => a.tool_name === 'Write'),
  bash_asked: t2.some((a) => a.tool_name === 'Bash'),
  probe_exists: existsSync(join(dir, 'probe.txt')),
  permission_mode: init?.permissionMode ?? null,
}
log.rec('verdict', verdict)
saveResult({
  id: ID,
  title: 'Claude read-only: --permission-mode manual + --disallowedTools Write Edit MultiEdit NotebookEdit ExitPlanMode',
  verdict: !verdict.write_file_exists && !verdict.write_asked && verdict.bash_asked ? 'works' : 'fails',
  details: JSON.stringify(verdict),
  decisive_evidence: "spike/claude/logs/s10-readonly.jsonl :: verdict; spike/claude/logs/s10-mcp-trace.jsonl",
  script: 's10-readonly.mjs',
})
await log.close()
