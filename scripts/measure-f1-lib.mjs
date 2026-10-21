// measure-f1-lib.mjs — ЧИСТЫЕ части замеров В5 (scripts/measure-f1.mjs).
//
// ПОЧЕМУ отдельным модулем. Сам замер ходит в настоящие `claude` и `codex`, тратит подписку и
// запускается лидом один раз — в CI его не прогнать. А решения, от которых зависит честность
// цифр (пускать ли ход при такой стране выхода, что считать «первым событием», какие папки
// `~/.claude/projects` наши и можно сносить, что такое «перекрёстный ответ»), — обычные функции.
// Их и гоняет test/measure-f1.test.ts на фальшивках. Ни сети, ни процессов, ни файлов здесь нет.

/**
 * Пускать ли следующий шаг замера. Та же логика, что у стража демона (инвариант 2), но СТРОЖЕ:
 * `check.ok` мало — страна обязана быть известна и не стоять в списке-страже. Демон перед ходом
 * всё равно проверит сам; этот страж нужен, чтобы замер останавливался ЦЕЛИКОМ, а не мерил
 * «ход заблокирован за 300 мс» как латентность.
 * @param {{ ok?: boolean, loc?: string|null, reason?: string }|null|undefined} check результат checkNetwork
 * @param {string[]} guard список-страж (например ['RU'])
 * @returns {{ go: boolean, why: string }}
 */
export function guardDecision(check, guard) {
  if (!check) return { go: false, why: 'проверки выхода нет' }
  const loc = typeof check.loc === 'string' ? check.loc.toUpperCase() : null
  if (!loc || !/^[A-Z]{2}$/.test(loc)) return { go: false, why: 'страна выхода неизвестна' }
  if (guard.map((c) => c.toUpperCase()).includes(loc)) return { go: false, why: `выход ${loc} в списке-страже` }
  if (check.ok !== true) return { go: false, why: `страж отказал: ${check.reason ?? 'причина не названа'}` }
  return { go: true, why: `выход ${loc}` }
}

const STEPS = ['a', 'b', 'c']

/**
 * Значение `--only`. null — все шаги. Иначе только a, b, c: опечатка (`A`, `x`, пустое значение,
 * соседний флаг вместо значения) раньше молча выключала все шаги, и замер без единой строки
 * объявлялся «пройден: 0 из 0» с кодом 0 — ровно то, что приёмка считает успехом.
 * @param {string|null|undefined} arg
 * @returns {{ steps: string[] } | { error: string }}
 */
export function parseOnly(arg) {
  if (arg === null || arg === undefined) return { steps: [...STEPS] }
  const parts = String(arg).split(',').map((s) => s.trim()).filter(Boolean)
  const bad = parts.filter((s) => !STEPS.includes(s))
  if (!parts.length || bad.length) return { error: `--only принимает a,b,c через запятую; получено «${arg}»` }
  return { steps: STEPS.filter((s) => parts.includes(s)) }
}

const WARM_GAIN_NOTE = 'справочно: p50 --resume − p50 --warm; ≤ 0 — тёплый процесс не быстрее процесса на ход (решение лида 28.09.2026)'

/**
 * Строка «выигрыш тёплого процесса». СПРАВОЧНАЯ, не гейт (решение лида 28.09.2026): замер
 * 28.09.2026 на Claude Code 2.1.283 показал холодный `--resume` (процесс на ход) БЫСТРЕЕ тёплого
 * процесса (p50 1.89 с против 2.28 с) — тёплый процесс не даёт выигрыша, и требовать value > 0
 * значит проваливать замер за факт, который сам по себе не нарушает приёмку Ф1: гейт — это
 * абсолютная латентность (тёплая < 3 с, процесс на ход < 4 с), а не то, кто из двух быстрее.
 * ok — как только обе серии дошли до конца (p50 посчитан не по огрызку); отрицательное или
 * нулевое значение — законный результат, а не провал. ok:false остаётся только когда серия
 * оборвалась или p50 не посчитан.
 */
export function warmGain({ warmP50, coldP50, warmFail, coldFail }) {
  const value = warmP50 !== null && coldP50 !== null ? coldP50 - warmP50 : null
  return {
    value,
    ok: !warmFail && !coldFail && value !== null,
    note: warmFail ?? coldFail ?? WARM_GAIN_NOTE,
  }
}

/**
 * Код выхода замера. Ни одной строки — тоже провал: «ничего не измерено» не равно «всё ok».
 * Ненулевой код стража (4) или ошибки не перетирается.
 */
export function exitCodeFor(rows, exitCode) {
  if (exitCode) return exitCode
  return !rows.length || rows.some((r) => !r.ok) ? 1 : 0
}

/**
 * Ждать, пока процесс уйдёт, но не дольше потолка. Нужна после `daemon stop`: тот отвечает, как
 * только снят lock, а демон снимает его ПОСЛЕДНИМ шагом уборки и ещё закрывает журнал и выходит.
 * Одна проверка сразу после stop в ~20% прогонов видела живой pid и писала ложный провал уборки.
 * @param {() => boolean} isAlive
 * @returns {Promise<boolean>} true — всё ещё жив после потолка
 */
export async function waitGone(isAlive, { timeoutMs = 3000, stepMs = 100, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const deadline = now() + timeoutMs
  for (;;) {
    if (!isAlive()) return false
    if (now() >= deadline) return true
    await sleep(stepMs)
  }
}

/** Обёртка «один раз»: второй и следующие вызовы получают тот же промис. */
export function onceAsync(fn) {
  let p = null
  return () => (p ??= Promise.resolve().then(fn))
}

/** 128 + номер сигнала — как у шелла. */
export const signalExitCode = (signal) => (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)

/**
 * Ctrl+C или SIGTERM посреди замера. По умолчанию node выходит по сигналу, НЕ выполняя `finally`:
 * отсоединённый демон замера оставался жить со своими claude/codex, временные папки и разговоры
 * замера в ~/.claude/projects — на диске. Ловушка зовёт ту же уборку и выходит кодом 130/143.
 * `once`: второй Ctrl+C — обычное убийство, если сама уборка зависла.
 * @param {{ once: Function }} proc process (в тестах — EventEmitter)
 */
export function trapSignals(proc, { cleanup, onSignal, exit, signals = ['SIGINT', 'SIGTERM'] }) {
  for (const s of signals) {
    proc.once(s, () => {
      onSignal?.(s)
      Promise.resolve().then(() => cleanup()).catch(() => { /* уборка best-effort */ }).then(() => exit(signalExitCode(s)))
    })
  }
}

/** Медиана (p50). Пустой список — null, а не 0: «не измерено» и «0 мс» — разные вещи. */
export function p50(values) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b)
  if (!xs.length) return null
  const mid = Math.floor(xs.length / 2)
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2)
}

/**
 * Имя папки разговоров Claude Code для cwd: `~/.claude/projects/<cwd, где всё кроме [A-Za-z0-9] — «-»>`.
 * Вывод по раскладке на машине владельца (`/Users/you/src/pult` → `-Users-you-src-pult`), не документ.
 */
export function claudeProjectDirName(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

/**
 * Какие папки `~/.claude/projects` снести после замера. Только те, что ПОЯВИЛИСЬ за прогон
 * И несут имя одной из наших временных рабочих папок. Одно условие без другого опасно:
 * «новая» — это и сессия, которую владелец открыл в соседнем терминале, пока шёл замер;
 * «с токеном» — это и старая папка, которую замер не создавал.
 * @param {string[]} before имена до прогона
 * @param {string[]} after имена после
 * @param {string[]} tokens уникальные куски имён наших рабочих папок (basename mkdtemp)
 */
export function projectsToClean(before, after, tokens) {
  const had = new Set(before)
  const toks = tokens.filter((t) => typeof t === 'string' && t.length >= 8).map(claudeProjectDirName)
  return after.filter((name) => !had.has(name) && toks.some((t) => name.includes(t)))
}

/**
 * Перекрёстный ответ: каждая из двух параллельных сессий обязана вернуть СВОЙ маркер и не
 * вернуть чужой. Если демультиплексор перепутает сессии (у codex — один процесс на всех,
 * инвариант 6), ответ одной уедет в другую — это и ловится.
 */
export function crossTalk(answerA, markA, answerB, markB) {
  const a = String(answerA ?? '')
  const b = String(answerB ?? '')
  const ownA = a.includes(markA)
  const ownB = b.includes(markB)
  const foreign = a.includes(markB) || b.includes(markA)
  return { ownA, ownB, foreign, ok: ownA && ownB && !foreign }
}

const MODEL_KINDS = new Set(['message.delta', 'message.done', 'tool.called'])

/**
 * Время до первого события хода — по журналу демона, а не по часам CLI: `prompt --wait`
 * возвращается только в конце хода. Считаются события ПОСЛЕ курсора (id > since), служебные
 * события демона (`daemon.*`) не в счёт — они про процесс, а не про ход.
 * @param {Array<{id:number, ts:string, kind:string}>} events
 * @param {number} since курсор до реплики
 * @param {number} t0 момент отправки реплики (мс эпохи)
 * @returns {{ firstEventMs: number|null, firstModelMs: number|null, firstKind: string|null }}
 */
export function firstEventTimes(events, since, t0) {
  let firstEventMs = null
  let firstModelMs = null
  let firstKind = null
  const sorted = [...events].filter((e) => e && typeof e.id === 'number' && e.id > since).sort((x, y) => x.id - y.id)
  for (const e of sorted) {
    if (typeof e.kind !== 'string' || e.kind.startsWith('daemon.')) continue
    const at = Date.parse(e.ts)
    if (!Number.isFinite(at)) continue
    // Событие раньше отправки реплики — чужое (прошлый ход), даже если id после курсора: так
    // бывает, когда курсор не узнали и он упал в 0. Раньше время прижималось к 0 и замер
    // записывал «0.00 с, ok» — выдуманную латентность. Пропускаем.
    if (at < t0) continue
    if (firstEventMs === null) { firstEventMs = at - t0; firstKind = e.kind }
    if (firstModelMs === null && MODEL_KINDS.has(e.kind)) firstModelMs = at - t0
    if (firstEventMs !== null && firstModelMs !== null) break
  }
  return { firstEventMs, firstModelMs, firstKind }
}

/** NDJSON-строки `pult agent read --format json` → события; битые строки пропускаются. */
export function parseEventLines(stdout) {
  const out = []
  for (const line of String(stdout ?? '').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t)) } catch { /* не событие */ }
  }
  return out
}

const fmtMs = (v) => (v === null || v === undefined ? '—' : `${(v / 1000).toFixed(2)} с`)

function fmtValue(row) {
  if (row.value === null || row.value === undefined) return '—'
  if (row.unit === 'ms') return fmtMs(row.value)
  if (row.unit === 'x') return `×${Number(row.value).toFixed(2)}`
  if (row.unit === 'bool') return row.value ? 'да' : 'нет'
  return String(row.value)
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')

/**
 * Markdown-отчёт для docs/11-MEASURE-F1.md. Строка на метрику; «итог» — ok только если ВСЕ
 * строки ok: замер, где один шаг провален, не выдаёт себя за пройденный.
 * @param {Array<{ step:string, provider:string, metric:string, value:unknown, unit:string, ok:boolean, note?:string }>} rows
 * @param {{ date:string, versions:Record<string,string>, egress:string, aborted?:string|null, steps?:string[] }} meta
 */
export function renderMarkdown(rows, meta) {
  const failed = rows.filter((r) => !r.ok).length
  // Какие шаги шли: частичный прогон (`--only a`) не выдаёт себя за полную приёмку.
  const steps = meta.steps?.length ? ` (шаги ${meta.steps.join(', ')})` : ''
  const verdict = meta.aborted
    ? `ПРЕРВАН: ${meta.aborted}`
    : !rows.length ? 'ПРОВАЛ: ни одной строки замера'
      : failed ? `ПРОВАЛ${steps}: ${failed} из ${rows.length} строк` : `пройден${steps}: ${rows.length} из ${rows.length} строк`
  const lines = [
    '# Замеры приёмки Ф1 (В5)',
    '',
    `Снято: ${meta.date} · \`node scripts/measure-f1.mjs\` на настоящих CLI · выход: ${meta.egress}`,
    `Версии: ${Object.entries(meta.versions).map(([k, v]) => `${k} \`${v}\``).join(' · ')}`,
    `Итог: **${verdict}**`,
    '',
    'Модели: claude — haiku, усилие low; codex — усилие low. Реплики крошечные. Время «до первого события» —',
    'по журналу демона (`ts` события) от момента отправки реплики; полное время реплики — `pult agent prompt --wait`.',
    '',
    '| Шаг | Провайдер | Метрика | Значение | Итог | Примечание |',
    '|---|---|---|---|---|---|',
  ]
  for (const r of rows) {
    lines.push(`| ${cell(r.step)} | ${cell(r.provider)} | ${cell(r.metric)} | ${cell(fmtValue(r))} | ${r.ok ? 'ok' : '**ПРОВАЛ**'} | ${cell(r.note ?? '')} |`)
  }
  lines.push('')
  return lines.join('\n')
}
