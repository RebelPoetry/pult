#!/usr/bin/env node
// S9 (M8d, 19.10.2026) — «Всегда» для Claude: доходят ли `permission_suggestions` до
// `--permission-prompt-tool`, и исполняет ли CLI `updatedPermissions` в ответе allow?
//
//   claude -p --permission-prompts host --mcp-config <stub> --strict-mcp-config
//             --permission-prompt-tool mcp__pultask__ask --setting-sources project,local
//
// Заглушка (s9-stub.mjs) пишет КАЖДЫЙ вызов `ask` целиком в трассу и отвечает allow; если в
// аргументах есть `permission_suggestions`, она возвращает их в `updatedPermissions`, принудительно
// с `destination: "localSettings"` — правило может лечь ТОЛЬКО в .claude/settings.local.json
// временной папки, а не в настройки владельца.
//
// Ходы (haiku, low; ≤ 6 по брифу):
//   1. процесс A, ход 1: `touch alpha.txt` через Bash          → ждём вопрос (+ подсказки?)
//   2. процесс A, ход 2: та же команда ещё раз                 → спросит ли снова в ТОМ ЖЕ процессе
//   3. процесс B (--resume), ход 3: та же команда              → спросит ли в новом процессе (правило с диска)
//   4. процесс C, `--permission-mode bypassPermissions`, `touch beta.txt` → без вопроса, файл есть
// Что доказываем: поле в аргументах, запись правила на диск, второй вызов без вопроса.
// `--setting-sources project,local`: настройки владельца (`defaultMode`, allow-правила) не мешают
// замеру, а `local` нужен, чтобы процесс B прочёл записанное правило.

import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { baseArgs, newSessionId, openLog, saveResult, startClaude, waitForResult, resultSummary, looksNotLoggedIn, HERE, NODE_BIN, logNetworkProfile, scrubbedEnv, egressGuard } from './lib.mjs'

const ID = 'S9-claude'
const log = openLog(process.argv.includes('--craft') ? 's9-permission-craft' : 's9-permission-suggestions')
logNetworkProfile(log)
await egressGuard(log, [ID])

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pult-s9-')))
const TRACE = join(HERE, 'logs', process.argv.includes('--craft') ? 's9-craft-mcp-trace.jsonl' : 's9-mcp-trace.jsonl')
writeFileSync(TRACE, '')
const mcpConfig = join(dir, 'mcp.json')
writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { pultask: {
  command: NODE_BIN, args: [join(HERE, 's9-stub.mjs')], env: { S9_TRACE: TRACE },
} } }))
log.rec('setup', { dir })

const askCalls = () => readFileSync(TRACE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => r.dir === 'in' && r.msg?.method === 'tools/call')

const common = (extra = []) => [
  ...baseArgs({ sessionId: null, model: 'haiku', effort: 'low', settingSources: 'project,local', permissionPrompts: 'host' }),
  '--mcp-config', mcpConfig, '--strict-mcp-config', '--permission-prompt-tool', 'mcp__pultask__ask', ...extra,
]

const PROMPT = (f) => `Run exactly this shell command with the Bash tool and nothing else: touch ${f}  — then reply "done".`
const sid = newSessionId()

// --- `--craft`: ходы 5–6. CLI подсказок не шлёт (замер ходов 1–3), но, может быть, исполняет
// `updatedPermissions`, собранный хозяином сам? Процесс D: `touch gamma.txt` → заглушка (S9_CRAFT=1)
// отвечает allow + addRules Bash(touch gamma.txt) → localSettings. Процесс E (--resume): та же команда.
if (process.argv.includes('--craft')) {
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { pultask: {
    command: NODE_BIN, args: [join(HERE, 's9-stub.mjs')], env: { S9_TRACE: TRACE, S9_CRAFT: '1' },
  } } }))
  const d = startClaude({ args: common(['--session-id', sid]), cwd: dir, env: scrubbedEnv() })
  const t5 = await turn(d, PROMPT('gamma.txt'), 'D5 crafted rule')
  d.endStdin(); await d.exited
  const sp = join(dir, '.claude', 'settings.local.json')
  const body = existsSync(sp) ? readFileSync(sp, 'utf8') : null
  log.rec('settings_after_t5', { exists: body !== null, body })
  const e = startClaude({ args: common(['--resume', sid]), cwd: dir, env: scrubbedEnv() })
  const t6 = await turn(e, PROMPT('gamma.txt'), 'E6 same command, new process')
  e.endStdin(); await e.exited
  const v = { crafted_rule_written: body !== null, settings_local: body, t5_asks: t5.asks.length, asked_again_new_process: t6.asks.length > 0 }
  log.rec('verdict_craft', v)
  await log.close()
  process.exit(0)
}

async function turn(s, text, label) {
  const from = s.mark()
  const before = askCalls().length
  s.send(text)
  const r = await waitForResult(s, 180000, { from })
  const asks = askCalls().slice(before)
  log.rec('turn', { label, result: resultSummary(r), asks: asks.length, ask_args: asks.map((a) => a.msg.params.arguments) })
  if (looksNotLoggedIn(s.events)) { log.rec('verdict', { verdict: 'blocked', reason: 'not logged in' }); process.exit(2) }
  return { r, asks }
}

// --- процесс A: ходы 1 и 2 ------------------------------------------------------
const a = startClaude({ args: common(['--session-id', sid]), cwd: dir, env: scrubbedEnv() })
const t1 = await turn(a, PROMPT('alpha.txt'), 'A1 first touch')
const settingsPath = join(dir, '.claude', 'settings.local.json')
const afterT1 = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : null
log.rec('settings_after_t1', { exists: afterT1 !== null, body: afterT1 })
const t2 = await turn(a, PROMPT('alpha.txt'), 'A2 same command, same process')
a.endStdin(); await a.exited

// --- процесс B: --resume, ход 3 -------------------------------------------------
const b = startClaude({ args: common(['--resume', sid]), cwd: dir, env: scrubbedEnv() })
const t3 = await turn(b, PROMPT('alpha.txt'), 'B3 same command, new process')
b.endStdin(); await b.exited

// --- процесс C: bypassPermissions ------------------------------------------------
const c = startClaude({ args: common(['--session-id', newSessionId(), '--permission-mode', 'bypassPermissions']), cwd: dir, env: scrubbedEnv() })
const t4 = await turn(c, PROMPT('beta.txt'), 'C4 bypassPermissions')
c.endStdin(); await c.exited

const suggestions = t1.asks[0]?.msg?.params?.arguments?.permission_suggestions
const verdict = {
  suggestions_delivered: Array.isArray(suggestions) && suggestions.length > 0,
  suggestions,
  rule_written: afterT1 !== null,
  settings_local: afterT1,
  asked_again_same_process: t2.asks.length > 0,
  asked_again_new_process: t3.asks.length > 0,
  alpha_exists: existsSync(join(dir, 'alpha.txt')),
  bypass_asked: t4.asks.length > 0,
  bypass_file: existsSync(join(dir, 'beta.txt')),
}
log.rec('verdict', verdict)
saveResult({
  id: ID,
  title: 'Claude: permission_suggestions in --permission-prompt-tool args and updatedPermissions honoured (M8d «Всегда»)',
  verdict: verdict.suggestions_delivered && verdict.rule_written && !verdict.asked_again_new_process ? 'works' : 'fails',
  details: JSON.stringify(verdict),
  decisive_evidence: `${log.path} :: verdict; ${TRACE}`,
  script: 's9-permission-suggestions.mjs',
})
await log.close()
