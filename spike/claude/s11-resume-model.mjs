#!/usr/bin/env node
// S11 (M8f, 20.10.2026) — смена модели у живой сессии: `--resume <uuid>` с ДРУГИМ `--model` (план 13, проверка 3).
// Заодно — смена усилия и режима подтверждений на resume (`--permission-mode manual --disallowedTools …`, план 15 К0 п.3).
//
// Ходы (3, по процессу на ход — как режим Пульта «процесс на ход»), временная папка, `--setting-sources project,local`,
// `--permission-prompts none` (вопросов не будет — инструменты не нужны):
//   1. haiku / low:  «запомни кодовое слово» → OK;
//   2. --resume, sonnet / low: «какое слово?» → то же слово, а `system/init.model` — sonnet;
//   3. --resume, haiku / medium + manual + --disallowedTools: «какое слово?» → то же слово; init: permissionMode,
//      инструментов правки нет.
// После прогона папка проекта этой временной папки в ~/.claude/projects удаляется (только она — по имени).

import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { baseArgs, newSessionId, openLog, saveResult, startClaude, waitForResult, resultSummary, looksNotLoggedIn, logNetworkProfile, scrubbedEnv, egressGuard } from './lib.mjs'

const ID = 'S11-claude'
const DENIED = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'ExitPlanMode']
const WORD = `PELICAN-${Math.floor(Math.random() * 9000) + 1000}`
const log = openLog('s11-resume-model')
logNetworkProfile(log)
await egressGuard(log, [ID])

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pult-s11-')))
const sid = newSessionId()

async function turn(label, { resume, model, effort, extra = [] }, text) {
  const args = baseArgs({ sessionId: resume ? null : sid, model, effort, settingSources: 'project,local', permissionPrompts: 'none', extra })
  if (resume) args.push('--resume', sid)
  const s = startClaude({ args, cwd: dir, env: scrubbedEnv() })
  s.send(text)
  const r = await waitForResult(s, 180000)
  s.endStdin()
  await s.exited
  if (looksNotLoggedIn(s.events)) { log.rec('verdict', { verdict: 'blocked', reason: 'not logged in' }); process.exit(2) }
  const init = s.events.find((e) => e.type === 'system' && e.subtype === 'init')
  const tools = Array.isArray(init?.tools) ? init.tools : []
  const row = {
    label, argv_model: model, argv_effort: effort, resume,
    init_model: init?.model ?? null, init_session_id: init?.session_id ?? null, init_permission_mode: init?.permissionMode ?? null,
    init_denied_present: DENIED.filter((t) => tools.includes(t)),
    model_usage: r?.modelUsage ? Object.keys(r.modelUsage) : null,
    result: resultSummary(r),
  }
  log.rec('turn', row)
  return { row, text: typeof r?.result === 'string' ? r.result : '' }
}

const t1 = await turn('T1 haiku', { resume: false, model: 'haiku', effort: 'low' },
  `Remember this codeword for later: ${WORD}. Reply with exactly: OK`)
const t2 = await turn('T2 resume sonnet', { resume: true, model: 'sonnet', effort: 'low' },
  'What codeword did I ask you to remember? Reply with only the codeword.')
const t3 = await turn('T3 resume haiku medium read-only', { resume: true, model: 'haiku', effort: 'medium', extra: ['--permission-mode', 'manual', '--disallowedTools', ...DENIED] },
  'Repeat the codeword once more. Reply with only the codeword.')

const verdict = {
  word: WORD,
  t1_ok: !t1.row.result?.is_error,
  t2_same_session: t2.row.init_session_id === sid,
  t2_model: t2.row.init_model,
  t2_model_is_sonnet: /sonnet/i.test(String(t2.row.init_model ?? '')),
  t2_recalls_word: t2.text.includes(WORD),
  t3_model: t3.row.init_model,
  t3_recalls_word: t3.text.includes(WORD),
  t3_permission_mode: t3.row.init_permission_mode,
  t3_denied_present: t3.row.init_denied_present,
}
log.rec('verdict', verdict)
const works = verdict.t1_ok && verdict.t2_same_session && verdict.t2_model_is_sonnet && verdict.t2_recalls_word && verdict.t3_recalls_word
saveResult({
  id: ID,
  title: 'Claude: --resume <uuid> with a different --model / --effort / --permission-mode keeps the conversation',
  verdict: works ? 'works' : 'fails',
  details: JSON.stringify(verdict),
  decisive_evidence: 'spike/claude/logs/s11-resume-model.jsonl :: verdict',
  script: 's11-resume-model.mjs',
})

// Уборка: только папка разговора ЭТОЙ временной папки (имя — путь с «/» и «.» → «-»).
const projDir = join(homedir(), '.claude', 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'))
if (existsSync(projDir)) { rmSync(projDir, { recursive: true, force: true }); log.rec('cleanup', { removed: projDir }) }
else log.rec('cleanup', { missing: projDir })
rmSync(dir, { recursive: true, force: true })
await log.close()
