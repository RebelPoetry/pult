#!/usr/bin/env node
// diff-codex-schema.mjs — что изменилось в протоколе `codex app-server` ДЛЯ АДАПТЕРА.
//
//   node scripts/diff-codex-schema.mjs <старая-папка> <новая-папка>
//   node scripts/diff-codex-schema.mjs spike/codex/schema/0.155.0-alpha.9.2/experimental \
//                                      spike/codex/schema/0.158.0-alpha.2.1/experimental
//
// Папка — та, куда `codex app-server generate-json-schema [--experimental] --out` положил схему
// (достаточно сводного `codex_app_server_protocol.schemas.json`, он и хранится в spike/).
//
// ЗАЧЕМ. `pult doctor` говорит только «слепок разошёлся» — sha набора не отвечает на вопрос
// «а адаптеру-то что». Протокол растёт каждую неделю (новые методы аккаунта, плагинов, MCP), и
// почти всё это адаптера не касается. Скрипт берёт методы, которыми адаптер ПОЛЬЗУЕТСЯ, идёт от
// их `params` (и `<…>Response`, где он есть) по всем `$ref` вглубь и показывает изменения только в
// этом замыкании. Всё прочее — одной строкой со счётчиками.
//
// Моделей не зовёт, сеть не трогает, в CI не запускается (там нет двух версий схемы).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Методы, от формы которых зависит адаптер (src/adapters/codex/adapter.ts и mapper.ts). Типы
// элементов (`agentMessage`, `commandExecution`, `subAgentActivity`, `collabAgentToolCall`, …)
// отдельно перечислять не нужно: они внутри `ThreadItem` и попадают в замыкание `item/*`.
const USED = {
  ClientRequest: [
    'initialize', 'thread/start', 'thread/resume', 'thread/unsubscribe',
    'turn/start', 'turn/interrupt', 'account/rateLimits/read',
  ],
  ServerNotification: [
    'turn/started', 'turn/completed', 'item/started', 'item/completed', 'item/agentMessage/delta',
    'error', 'warning', 'thread/started', 'thread/tokenUsage/updated', 'account/rateLimits/updated',
    'serverRequest/resolved', 'deprecationNotice', 'model/rerouted',
  ],
  ServerRequest: ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'],
}

const [oldDir, newDir] = process.argv.slice(2)
if (!oldDir || !newDir) {
  console.error('использование: node scripts/diff-codex-schema.mjs <старая-папка> <новая-папка>')
  process.exit(2)
}

const load = (dir) => JSON.parse(readFileSync(join(dir, 'codex_app_server_protocol.schemas.json'), 'utf8'))
const A = load(oldDir)
const B = load(newDir)

/** `#/definitions/v2/X` → объект; ключ возвращается как `v2/X`. */
const resolve = (root, ref) => {
  const parts = ref.replace(/^#\/definitions\//, '').split('/')
  let cur = root.definitions
  for (const p of parts) cur = cur?.[p]
  return cur
}
const methods = (root, union) => {
  const out = new Map()
  for (const v of root.definitions[union]?.oneOf ?? []) {
    const m = v.properties?.method?.enum?.[0]
    // params бывает не только `$ref`, но и `anyOf: [{$ref}, {type: null}]` — так у
    // `account/rateLimits/read` (params необязательны). Раньше брался только `$ref`: у этого
    // метода ссылка была null, ни Params, ни Response в замыкание не попадали, и дрейф ответа,
    // который читает адаптер, сверка объявляла «для адаптера ничего».
    const p = v.properties?.params
    if (m) out.set(m, p?.$ref ?? p?.anyOf?.find((x) => typeof x?.$ref === 'string')?.$ref ?? null)
  }
  return out
}
const refsIn = (node, acc) => {
  if (Array.isArray(node)) { for (const x of node) refsIn(x, acc); return acc }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') acc.add(v)
      else refsIn(v, acc)
    }
  }
  return acc
}
/** Все определения, достижимые из стартовых ссылок, — в обеих версиях сразу. */
const closure = (roots, starts) => {
  const seen = new Set()
  const queue = [...starts]
  while (queue.length) {
    const ref = queue.pop()
    if (seen.has(ref)) continue
    seen.add(ref)
    for (const root of roots) {
      const node = resolve(root, ref)
      if (node) for (const r of refsIn(node, new Set())) if (!seen.has(r)) queue.push(r)
    }
  }
  return seen
}
const responseRef = (paramsRef) => (paramsRef ? paramsRef.replace(/Params$/, 'Response') : null)

const starts = new Set()
const missing = []
const unresolved = []
for (const [union, list] of Object.entries(USED)) {
  const ma = methods(A, union)
  const mb = methods(B, union)
  const added = [...mb.keys()].filter((m) => !ma.has(m))
  const removed = [...ma.keys()].filter((m) => !mb.has(m))
  console.log(`${union}: ${ma.size} -> ${mb.size}`
    + (added.length ? `; + ${added.join(', ')}` : '')
    + (removed.length ? `; - ${removed.join(', ')}` : ''))
  for (const m of list) {
    if (!mb.has(m)) { missing.push(`${union} ${m}`); continue }
    // Ссылку не извлекли — метод выпал бы из сверки молча. Пусть это будет видно.
    // Касается всех трёх союзов: уведомление или серверный запрос с инлайн-params выпадал бы так же.
    if (!ma.get(m) && !mb.get(m)) unresolved.push(`${union} ${m}`)
    for (const ref of [ma.get(m), mb.get(m), responseRef(ma.get(m)), responseRef(mb.get(m))]) {
      if (ref && (resolve(A, ref) || resolve(B, ref))) starts.add(ref)
    }
  }
}

const touched = closure([A, B], starts)
const changed = []
for (const ref of [...touched].sort()) {
  const a = resolve(A, ref)
  const b = resolve(B, ref)
  if (JSON.stringify(a) === JSON.stringify(b)) continue
  changed.push(ref.replace(/^#\/definitions\//, ''))
}

// Точечный дифф: какие именно поля появились, пропали или поменялись.
const diff = (x, y, path, out) => {
  if (JSON.stringify(x) === JSON.stringify(y)) return
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  if (isObj(x) && isObj(y)) {
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) diff(x[k], y[k], `${path}.${k}`, out)
    return
  }
  if (Array.isArray(x) && Array.isArray(y)) {
    const sx = x.map((e) => JSON.stringify(e))
    const sy = y.map((e) => JSON.stringify(e))
    for (const e of sy) if (!sx.includes(e)) out.push(`${path} + ${e.slice(0, 200)}`)
    for (const e of sx) if (!sy.includes(e)) out.push(`${path} - ${e.slice(0, 200)}`)
    return
  }
  out.push(`${path}: ${JSON.stringify(x)?.slice(0, 160)} => ${JSON.stringify(y)?.slice(0, 160)}`)
}

console.log(`\nопределений в замыкании адаптера: ${touched.size}, изменилось: ${changed.length}`)
for (const name of changed) {
  const ref = `#/definitions/${name}`
  const lines = []
  diff(resolve(A, ref), resolve(B, ref), name, lines)
  for (const l of lines) console.log(`  ${l}`)
}
if (unresolved.length) console.log(`\nВНИМАНИЕ: у методов нет ссылки на params, их форма не сверена: ${unresolved.join('; ')}`)
if (missing.length) console.log(`\nПРОПАЛИ методы, которыми пользуется адаптер: ${missing.join('; ')}`)
// Несверенный метод — не «ничего»: его форма могла поменяться, а сверка этого не видит (тот же
// класс ошибки, что был у account/rateLimits/read). Поэтому и вердикт молчит, и код выхода 1 —
// скрипт, на который ссылается совет доктора, не объявляет безопасным то, чего не сравнивал.
if (!changed.length && !missing.length && !unresolved.length) console.log('для адаптера ничего')
process.exit(missing.length || unresolved.length ? 1 : 0)
