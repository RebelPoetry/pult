#!/usr/bin/env node
// synth-claude-fixtures.mjs — две СИНТЕТИЧЕСКИЕ фикстуры Claude.
//
//   node scripts/synth-claude-fixtures.mjs
//
// Почему их нельзя записать настоящим прогоном:
//   08 «не залогинен» — воспроизводится только выходом владельца из аккаунта (`claude logout`),
//      после чего он теряет рабочую сессию. Форма взята ДОСЛОВНО из спайка:
//      spike/claude/offline/probe-notloggedin.mjs :: details — событие `assistant` с
//      error:"authentication_failed", is_api_error_message:true, текстом
//      "Failed to authenticate: OAuth session expired and could not be refreshed";
//      у `result` is_error:true, terminal_reason:"api_error", НО subtype:"success".
//   09 «блок аккаунта или региона» — зависит от отказа платформы, повторить по требованию
//      нельзя. Текст дословный из docs/06-DELTA-v0.5-spike-claude.md §1 (наблюдался 21.09.2026
//      с HTTP 403).
//
// Обе помечены в test/fixtures/claude/README.md как синтетические. Всё, что в них можно было
// взять из настоящей записи (форма system/init, конверт result), взято из 01-simple-turn.jsonl.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(resolve(HERE, '..'), 'test', 'fixtures', 'claude')

const SESSION_ID = '00000000-0000-4000-8000-00000000fa11'

/** Конверт `system/init` берём из настоящей записи и переписываем только идентификаторы. */
function initFrom(sample) {
  const init = JSON.parse(sample.split('\n')[0])
  init.session_id = SESSION_ID
  init.uuid = '00000000-0000-4000-8000-000000000001'
  init.cwd = '/tmp/pult-fixture'
  return init
}

const sample = readFileSync(join(OUT, '01-simple-turn.jsonl'), 'utf8')
const baseResult = (() => {
  const lines = sample.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return lines.find((e) => e.type === 'result')
})()

function resultEnvelope(over) {
  return {
    ...baseResult,
    session_id: SESSION_ID,
    uuid: '00000000-0000-4000-8000-0000000000ff',
    num_turns: 1,
    usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    total_cost_usd: 0,
    permission_denials: [],
    ...over,
  }
}

const write = (name, events) => {
  writeFileSync(join(OUT, `${name}.jsonl`), events.map((e) => JSON.stringify(e) + '\n').join(''))
  writeFileSync(join(OUT, `${name}.timing.json`), JSON.stringify(events.map((_, i) => i * 40)) + '\n')
  console.log(`   ${name}.jsonl — ${events.length} строк (СИНТЕТИКА)`)
}

// --- 08 — вход не выполнен ----------------------------------------------------
const AUTH_TEXT = 'Failed to authenticate: OAuth session expired and could not be refreshed'
write('08-not-logged-in', [
  initFrom(sample),
  { type: 'system', subtype: 'status', status: 'requesting', session_id: SESSION_ID, uuid: '00000000-0000-4000-8000-000000000002' },
  {
    type: 'assistant',
    error: 'authentication_failed',
    is_api_error_message: true,
    message: {
      model: 'claude-haiku-4-5-20251001',
      id: 'msg_synthetic_notloggedin',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: AUTH_TEXT }],
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: '00000000-0000-4000-8000-000000000003',
  },
  resultEnvelope({
    subtype: 'success',
    is_error: true,
    terminal_reason: 'api_error',
    api_error_status: 401,
    stop_reason: null,
    result: AUTH_TEXT,
  }),
])

// --- 09 — блок аккаунта или региона -------------------------------------------
// Строка дословно из DELTA v0.5 §1; адаптер ловит её по /disabled Claude subscription access/.
const BLOCK_TEXT = 'Your organization has disabled Claude subscription access for Claude Code · '
  + 'Use an Anthropic API key instead, or ask your admin to enable access'
write('09-account-region-block', [
  initFrom(sample),
  { type: 'system', subtype: 'status', status: 'requesting', session_id: SESSION_ID, uuid: '00000000-0000-4000-8000-000000000012' },
  {
    type: 'assistant',
    error: 'api_error',
    is_api_error_message: true,
    message: {
      model: 'claude-haiku-4-5-20251001',
      id: 'msg_synthetic_accountblock',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: `API Error: 403 ${BLOCK_TEXT}` }],
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: '00000000-0000-4000-8000-000000000013',
  },
  resultEnvelope({
    subtype: 'success',
    is_error: true,
    terminal_reason: 'api_error',
    api_error_status: 403,
    stop_reason: null,
    result: BLOCK_TEXT,
  }),
])

// --- 90, 91 — ДЕМО окна (Ф2, О1) ------------------------------------------------
// Не про поведение CLI, а про то, КАК ОКНО ЭТО ПОКАЗЫВАЕТ: сценарии для e2e и скриншотов
// (shell/test/e2e/screens.test.ts). Формы событий — те же, что в настоящих записях:
// `assistant`/`user` с `parent_tool_use_id` у субагента (06), `stream_event` с text_delta (01),
// `rate_limit_event` (01), Edit с old_string/new_string (04). Тексты русские и вымышленные.
const DEMO_SESSION = '00000000-0000-4000-8000-0000000de4a0'
const demoInit = () => ({ ...initFrom(sample), session_id: DEMO_SESSION, model: 'claude-sonnet-4-6', cwd: '/tmp/pult-demo' })
let demoUuid = 0x100
const uuid = () => `00000000-0000-4000-8000-${(demoUuid++).toString(16).padStart(12, '0')}`
const assistant = (content, parent = null) => ({
  type: 'assistant',
  message: { model: 'claude-sonnet-4-6', id: `msg_demo_${demoUuid}`, type: 'message', role: 'assistant', content, stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } },
  parent_tool_use_id: parent, session_id: DEMO_SESSION, uuid: uuid(),
})
const toolResult = (id, content, parent = null, isError = false) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
  parent_tool_use_id: parent, session_id: DEMO_SESSION, uuid: uuid(),
})
const delta = (text, parent = null) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  parent_tool_use_id: parent, session_id: DEMO_SESSION, uuid: uuid(),
})
const rateLimit = (five, seven) => ({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed', resetsAt: 1790011200, rateLimitType: 'five_hour', isUsingOverage: false,
    unifiedWindows: { five_hour: { utilization: five, resetsAt: 1790011200 }, seven_day: { utilization: seven, resetsAt: 1790546400 } },
  },
  session_id: DEMO_SESSION, uuid: uuid(),
})
const demoResult = (text) => resultEnvelope({ session_id: DEMO_SESSION, uuid: uuid(), subtype: 'success', is_error: false, terminal_reason: 'completed', result: text, total_cost_usd: 0.0412, num_turns: 3 })

const writeTimed = (name, rows) => {
  writeFileSync(join(OUT, `${name}.jsonl`), rows.map(([e]) => JSON.stringify(e) + '\n').join(''))
  writeFileSync(join(OUT, `${name}.timing.json`), JSON.stringify(rows.map(([, ms]) => ms)) + '\n')
  console.log(`   ${name}.jsonl — ${rows.length} строк (ДЕМО, синтетика)`)
}

// 90 — ход идёт: инструмент закончен, субагент ищет и «печатает»; дальше — пауза 10 минут.
const AGENT = 'toolu_demo_agent_01'
writeTimed('90-demo-working', [
  [demoInit(), 0],
  [rateLimit(0.42, 0.23), 120],
  [assistant([{ type: 'text', text: 'Посмотрю, как шапка считает лимиты, и проверю округление процентов.' }]), 400],
  [assistant([{ type: 'tool_use', id: 'toolu_demo_read_01', name: 'Read', input: { file_path: 'ui/src/components/Header.tsx' } }]), 600],
  [toolResult('toolu_demo_read_01', '1\t// Шапка (docs/12 §3 п.4): демон, страж сети, лимиты\n2\timport type { ReactElement } from \'react\'\n3\timport { formatPct } from \'../model/usage.js\''), 900],
  [assistant([{ type: 'tool_use', id: AGENT, name: 'Agent', input: { subagent_type: 'Explore', description: 'Найти, где форматируются проценты', prompt: 'Найди все места, где проценты лимитов превращаются в текст.' } }]), 1100],
  [assistant([{ type: 'tool_use', id: 'toolu_demo_grep_01', name: 'Grep', input: { pattern: 'formatPct|toFixed', path: 'ui/src' } }], AGENT), 1400],
  [toolResult('toolu_demo_grep_01', 'ui/src/model/usage.ts:52: export function formatPct(u)\nui/src/components/Header.tsx:88: <span>{formatPct(u)}</span>', AGENT), 1700],
  [delta('Нашёл два места: `formatPct` в модели и ', AGENT), 2000],
  [delta('подпись метра в шапке. Проверяю, как округляется 99,6 %', AGENT), 2300],
  // Здесь ход «думает» 10 минут: окно видно в состоянии «идёт». Демо снимает его стопом.
  [assistant([{ type: 'text', text: 'Нашёл два места: `formatPct` в модели и подпись метра в шапке. Округление — Math.round.' }], AGENT), 602300],
  [toolResult(AGENT, [{ type: 'text', text: 'formatPct: ui/src/model/usage.ts:52; Header.tsx:88' }]), 602400],
  [assistant([{ type: 'text', text: 'Готово: процент считается в одном месте, правка нужна только в `formatPct`.' }]), 602600],
  [demoResult('Готово: процент считается в одном месте, правка нужна только в `formatPct`.'), 602700],
])

// 91 — просит правку файла: вопрос уходит на строке Edit (fake-claude `askInline`).
const EDIT = { replace_all: false, file_path: 'ui/src/model/usage.ts', old_string: 'export function formatPct(u: number | null): string {\n  if (u === null) return \'—\'\n  return `${Math.round(u * 100)}%`\n}', new_string: 'export function formatPct(u: number | null): string {\n  if (u === null) return \'—\'\n  // Вниз: 99,6 % — ещё не «100 %», лимит не исчерпан.\n  return `${Math.floor(u * 100)}%`\n}' }
writeTimed('91-demo-edit', [
  [demoInit(), 0],
  [assistant([{ type: 'text', text: 'Причина нашлась: `formatPct` округляет к ближайшему, и 99,6 % показывается как 100 %. Поправлю на округление вниз.' }]), 300],
  [assistant([{ type: 'tool_use', id: 'toolu_demo_edit_01', name: 'Edit', input: EDIT }]), 600],
  [toolResult('toolu_demo_edit_01', 'The file ui/src/model/usage.ts has been updated successfully.'), 800],
  [assistant([{ type: 'text', text: 'Готово: проценты округляются вниз, 99,6 % → 99 %.' }]), 1000],
  [demoResult('Готово: проценты округляются вниз, 99,6 % → 99 %.'), 1100],
])
// Хвост того же хода после ОТКАЗА: fake-claude переключается на него, если человек сказал «нет».
writeTimed('91-demo-edit-denied', [
  [toolResult('toolu_demo_edit_01', 'pult: отказано человеком', null, true), 0],
  [assistant([{ type: 'text', text: 'Понял, правку не вношу. Могу предложить вариант с тестом сначала.' }]), 200],
  [demoResult('Понял, правку не вношу. Могу предложить вариант с тестом сначала.'), 300],
])
