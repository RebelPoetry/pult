// Поиск по разговорам (О2, docs/14 «Поиск, метки, экспорт»): RPC `events.search`, ⌘⇧F в окне.
//
// ЧТО ИЩЕТСЯ. Реплики человека (`message.user`), итоговые тексты модели (`message.done`) и вызовы
// инструментов (`tool.called`: имя + команда, путь, шаблон, описание). Выводы инструментов
// (`tool.finished`, 61 % журнала) и дельты — нет: вывод `cat` на сотню килобайт находил бы всё подряд,
// а дельты дублируют итог. Регистр не важен, в том числе у кириллицы (флаги `iu` у RegExp —
// юникодное сравнение без регистра); пробелы запроса совпадают с любыми пробелами текста.
//
// ГДЕ. Файлы сессий `events/<сессия>.jsonl`, а не общий журнал: так поиск по одной сессии читает
// только её файл, а удалённые сессии не всплывают — ищем только по заведённым (реестр), и в файле
// всё до последнего `session.ended {reason: rm}` — остатки прежней сессии с тем же именем.
//
// НЕ ДЕРЖАТЬ ЦИКЛ. Журнал владельца — 18,6 МБ на 14.10.2026 и растёт. Файл читается асинхронно кусками
// по 1 МиБ, а разбор уступает циклу (`setImmediate`) каждые SLICE_MS: hello новых клиентов и
// `agent.list` окна отвечают и посреди поиска (test/search.test.ts меряет на 20 МБ). Строку разбираем,
// только если вид из её головы — один из искомых: выводы инструментов не превращаются даже в строку, а
// строка длиннее куска (вывод `cat` в мегабайты) не копится — её байты пропускаются до перевода строки.

import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { PultEvent } from './events.js'
import { sessionFileName } from './store.js'

export const SEARCH_LIMIT_DEFAULT = 100
export const SEARCH_LIMIT_MAX = 200
/** Длина отрывка вокруг совпадения, в знаках UTF-16, с многоточиями. */
export const SNIPPET_CHARS = 200
/** Запрос длиннее — отказ: это уже не поиск, а вставка простыни. */
export const QUERY_MAX_CHARS = 200
/** Сколько разбор держит цикл подряд, прежде чем уступить. */
export const SLICE_MS = 8
const CHUNK_BYTES = 1024 * 1024
/**
 * Вид события стоит в первых байтах строки (`{"id":…,"ts":…,"sessionId":…,"parentId":…,"provider":…,"kind":…`);
 * 4 КБ — с запасом на длинный `parentId`.
 */
export const HEAD_BYTES = 4096
/** Строку, вид которой по голове не понять, разбираем целиком, только если она не длиннее этого. */
export const PARSE_MAX_BYTES = 4 * 1024 * 1024

export const SEARCH_KINDS: ReadonlySet<string> = new Set(['message.user', 'message.done', 'tool.called'])

export interface SearchHit {
  sessionId: string
  eventId: number
  kind: string
  ts: string
  /** До SNIPPET_CHARS знаков вокруг совпадения, пробелы схлопнуты в один. */
  snippet: string
  /** Совпадение внутри `snippet`: [начало, конец). */
  match: [number, number]
  /** Событие субагента: id его вызова — окно ищет элемент в его блоке ленты. */
  parentId?: string
}

export interface SearchResult {
  /** Новые первыми (по номеру события). */
  results: SearchHit[]
  /** Совпадений больше, чем `limit`: показаны самые новые. */
  truncated: boolean
  /** Запрос отменён: тот же клиент прислал новый или отключился. */
  superseded?: boolean
  scanned: { files: number; bytes: number }
  ms: number
}

/** Входные поля инструмента, по которым его находят: что запускали, где и что искали. */
const TOOL_FIELDS = ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'description', 'url', 'query'] as const

/** Текст события, по которому ищем; `null` — событие поиску не интересно. */
export function searchableText(ev: Pick<PultEvent, 'kind' | 'data'>): string | null {
  const d = (ev.data ?? {}) as Record<string, unknown>
  if (ev.kind === 'message.user' || ev.kind === 'message.done') {
    const t = d['text']
    return typeof t === 'string' && t.trim() ? t : null
  }
  if (ev.kind === 'tool.called') {
    const name = typeof d['name'] === 'string' ? d['name'] : 'tool'
    return `${name}: ${toolSummaryText(d['input'])}`.trim()
  }
  return null
}

/** Строка входа инструмента для поиска и экспорта: поля TOOL_FIELDS через « · ». */
export function toolSummaryText(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ''
  const o = input as Record<string, unknown>
  const parts: string[] = []
  for (const k of TOOL_FIELDS) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) parts.push(v)
    else if (k === 'command' && Array.isArray(v)) parts.push(v.filter((x) => typeof x === 'string').join(' '))
  }
  return parts.join(' · ')
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ')
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Запрос в виде, в котором его ищут: обрезан, пробелы схлопнуты. Пусто — искать нечего. */
export function normalizeQuery(q: string): string {
  return collapse(q).trim()
}

/** Регулярка запроса: без регистра (кириллица тоже), пробел запроса — любые пробелы текста. */
export function queryRegExp(query: string): RegExp {
  return new RegExp(normalizeQuery(query).split(' ').map(escapeRe).join('\\s+'), 'iu')
}

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff
/** Не резать суррогатную пару: отрывок на половине эмодзи — битый символ в окне. */
function cleanEdges(s: string): string {
  let a = 0
  let b = s.length
  if (b > a && isLow(s.charCodeAt(a))) a++
  if (b > a && isHigh(s.charCodeAt(b - 1))) b--
  return a === 0 && b === s.length ? s : s.slice(a, b)
}

/**
 * Совпадение и отрывок вокруг него (не длиннее `max`, пробелы схлопнуты). Контекста после
 * совпадения больше, чем до: дочитать фразу важнее, чем видеть её начало. `null` — не совпало.
 */
export function matchSnippet(text: string, re: RegExp, max: number = SNIPPET_CHARS): { snippet: string; match: [number, number] } | null {
  const m = re.exec(text)
  if (!m) return null
  const idx = m.index
  const end = idx + m[0].length
  let mc = collapse(m[0])
  if (mc.length >= max) {
    mc = cleanEdges(mc.slice(0, max - 1)) + '…'
    return { snippet: mc, match: [0, mc.length] }
  }
  const window = 2 * max
  const preSrc = text.slice(Math.max(0, idx - window), idx)
  const postSrc = text.slice(end, end + window)
  const preC = collapse(preSrc).replace(/^ /, '')
  const postC = collapse(postSrc).replace(/ $/, '')
  const preCutSrc = idx > window
  const postCutSrc = end + window < text.length
  const room = max - mc.length
  const preBudget = Math.min(preC.length, Math.max(Math.floor(room / 3), room - postC.length))
  const postBudget = Math.min(postC.length, room - preBudget)
  // Край обрезан — многоточие на его месте (входит в предел); места под него нет — край пустой.
  const pre = preBudget < preC.length || preCutSrc
    ? (preBudget > 1 ? '…' + cleanEdges(preC.slice(preC.length - (preBudget - 1))) : '')
    : preC
  const post = postBudget < postC.length || postCutSrc
    ? (postBudget > 1 ? cleanEdges(postC.slice(0, postBudget - 1)) + '…' : '')
    : postC
  return { snippet: pre + mc + post, match: [pre.length, pre.length + mc.length] }
}

const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

export interface ScanOptions {
  /** Отмена: проверяется на каждой уступке циклу. */
  shouldStop?: () => boolean
  sliceMs?: number
}

/**
 * Решение по голове строки (первые HEAD_BYTES): `true` — строка нужна, `false` — нет, `null` — по голове
 * не понять (вида в ней нет). Нужно, чтобы строку в мегабайты (вывод `cat`) не собирать в память ради
 * того, чтобы выбросить.
 */
export type HeadDecision = (buf: Buffer, start: number, end: number) => boolean | null

/**
 * Читает файл асинхронно кусками и отдаёт строки (без `\n`) колбэку как `Buffer` и границы. Читается
 * ровно то, что было в файле на момент открытия: дописанное во время чтения подождёт следующего запроса,
 * недописанный хвост без `\n` пропускается. Строка длиннее куска копится по частям, но только пока она
 * нужна: `head` по первым HEAD_BYTES говорит «не нужна» — дальше её байты пропускаются до `\n`; «не
 * понять» — копится не дальше PARSE_MAX_BYTES. Возвращает прочитанные байты и `stopped`, если отменили.
 */
export async function scanLines(
  file: string,
  onLine: (buf: Buffer, start: number, end: number) => void,
  opts: ScanOptions & { head?: HeadDecision } = {},
): Promise<{ bytes: number; stopped: boolean }> {
  const sliceMs = opts.sliceMs ?? SLICE_MS
  let fh
  try {
    fh = await open(file, 'r')
  } catch {
    return { bytes: 0, stopped: false }
  }
  try {
    const size = (await fh.stat()).size
    let pos = 0
    /** Начало строки из прошлых кусков: части и их длина. */
    let pending: Buffer[] = []
    let pendingLen = 0
    /** null — по голове ещё не решали (или голова короче HEAD_BYTES). */
    let verdict: boolean | null | undefined
    let skipping = false
    let sliceStart = Date.now()
    /** Хвост куска без `\n` — в копилку; решение по голове, как только её хватает. */
    const hold = (part: Buffer): void => {
      pending.push(part)
      pendingLen += part.length
      if (verdict === undefined && pendingLen >= HEAD_BYTES && opts.head) {
        const head = pending.length === 1 ? (pending[0] as Buffer) : Buffer.concat(pending, Math.min(pendingLen, HEAD_BYTES * 2))
        verdict = opts.head(head, 0, Math.min(head.length, HEAD_BYTES))
      }
      if (verdict === false || (verdict === null && pendingLen > PARSE_MAX_BYTES)) {
        pending = []
        pendingLen = 0
        skipping = true
      }
    }
    while (pos < size) {
      const want = Math.min(CHUNK_BYTES, size - pos)
      const chunk = Buffer.allocUnsafe(want)
      const { bytesRead } = await fh.read(chunk, 0, want, pos)
      if (bytesRead <= 0) break
      pos += bytesRead
      const data = chunk.subarray(0, bytesRead)
      let start = 0
      if (skipping || pendingLen) {
        const nl = data.indexOf(0x0a)
        if (nl === -1) {
          if (!skipping) hold(data)
        } else {
          if (!skipping) {
            const line = Buffer.concat([...pending, data.subarray(0, nl)])
            onLine(line, 0, line.length)
          }
          pending = []
          pendingLen = 0
          verdict = undefined
          skipping = false
          start = nl + 1
        }
        if (nl === -1) start = data.length
      }
      while (start < data.length) {
        const nl = data.indexOf(0x0a, start)
        if (nl === -1) { verdict = undefined; hold(data.subarray(start)); break }
        if (nl > start) onLine(data, start, nl)
        start = nl + 1
        if (Date.now() - sliceStart >= sliceMs) {
          await yieldLoop()
          if (opts.shouldStop?.()) return { bytes: pos, stopped: true }
          sliceStart = Date.now()
        }
      }
      await yieldLoop()
      if (opts.shouldStop?.()) return { bytes: pos, stopped: true }
      sliceStart = Date.now()
    }
    return { bytes: pos, stopped: false }
  } finally {
    await fh.close().catch(() => { /* уже закрыт */ })
  }
}

/**
 * Вид события из головы строки — без разбора всей строки (выводы инструментов бывают по мегабайту).
 * `null` — вида в первых HEAD_BYTES нет (длинный `parentId` или чужой порядок полей): такую строку
 * разбирают целиком, если она не длиннее PARSE_MAX_BYTES.
 */
export function kindOfLine(buf: Buffer, start: number, end: number): string | null {
  const head = buf.toString('latin1', start, Math.min(end, start + HEAD_BYTES))
  const at = head.indexOf('"kind":"')
  if (at === -1) return null
  const from = at + 8
  const to = head.indexOf('"', from)
  return to === -1 ? null : head.slice(from, to)
}

/** Нужна ли строка с этими видами (+ `session.ended` — граница удаления): решение по голове. */
export function wantKinds(kinds: ReadonlySet<string>): HeadDecision {
  return (buf, start, end) => {
    const kind = kindOfLine(buf, start, end)
    return kind === null ? null : kind === 'session.ended' || kinds.has(kind)
  }
}

/** Полная строка: решение по голове, а без вида в голове — разбор, если строка не слишком длинна. */
function pick(decide: HeadDecision, buf: Buffer, start: number, end: number): boolean {
  const v = decide(buf, start, end)
  return v === null ? end - start <= PARSE_MAX_BYTES : v
}

function parseLine(buf: Buffer, start: number, end: number): PultEvent | null {
  try {
    const x = JSON.parse(buf.toString('utf8', start, end)) as unknown
    if (x === null || typeof x !== 'object' || Array.isArray(x)) return null
    const ev = x as Partial<PultEvent>
    if (typeof ev.id !== 'number' || !Number.isSafeInteger(ev.id) || ev.id <= 0 || typeof ev.sessionId !== 'string') return null
    return x as PultEvent
  } catch {
    return null
  }
}

/**
 * События одной сессии из её файла после последнего `session.ended rm` — асинхронно, с уступками
 * циклу. `kinds` — только эти виды (плюс `session.ended` ради границы); `map` — что от события
 * хранить (экспорт держит от выводов инструментов только исход, а не мегабайты вывода).
 */
export async function readSessionAsync(
  eventsDir: string,
  sessionId: string,
  opts: ScanOptions & { kinds?: ReadonlySet<string>; map?: (ev: PultEvent) => PultEvent } = {},
): Promise<{ events: PultEvent[]; bytes: number; stopped: boolean }> {
  let events: PultEvent[] = []
  let last = 0
  const decide = opts.kinds ? wantKinds(opts.kinds) : (): boolean => true
  const r = await scanLines(join(eventsDir, sessionFileName(sessionId)), (buf, start, end) => {
    if (!pick(decide, buf, start, end)) return
    const ev = parseLine(buf, start, end)
    if (!ev || ev.sessionId !== sessionId || ev.id <= last) return
    last = ev.id
    if (ev.kind === 'session.ended' && ev.data?.['reason'] === 'rm') { events = []; return }
    if (opts.kinds && !opts.kinds.has(ev.kind)) return
    events.push(opts.map ? opts.map(ev) : ev)
  }, { ...opts, head: decide })
  return { events, bytes: r.bytes, stopped: r.stopped }
}

export interface SearchOptions extends ScanOptions {
  eventsDir: string
  query: string
  /** Заведённые сессии, по которым искать (реестр). */
  sessionIds: readonly string[]
  limit?: number
}

/** Поиск по файлам сессий: самые новые совпадения первыми, не больше `limit`. */
export async function searchEvents(opts: SearchOptions): Promise<SearchResult> {
  const t0 = Date.now()
  const limit = Math.max(1, Math.min(SEARCH_LIMIT_MAX, Math.floor(opts.limit ?? SEARCH_LIMIT_DEFAULT)))
  const re = queryRegExp(opts.query)
  const decide = wantKinds(SEARCH_KINDS)
  const all: SearchHit[] = []
  let total = 0
  let bytes = 0
  let files = 0
  for (const sessionId of new Set(opts.sessionIds)) {
    let hits: SearchHit[] = []
    let count = 0
    let last = 0
    const r = await scanLines(join(opts.eventsDir, sessionFileName(sessionId)), (buf, start, end) => {
      if (!pick(decide, buf, start, end)) return
      const ev = parseLine(buf, start, end)
      if (!ev || ev.sessionId !== sessionId || ev.id <= last) return
      last = ev.id
      // Сессию удаляли и завели заново с тем же именем: всё, что было до, — чужое.
      if (ev.kind === 'session.ended') { if (ev.data?.['reason'] === 'rm') { hits = []; count = 0 } return }
      if (!SEARCH_KINDS.has(ev.kind)) return
      const text = searchableText(ev)
      if (text === null) return
      const m = matchSnippet(text, re)
      if (!m) return
      count += 1
      hits.push({ sessionId, eventId: ev.id, kind: ev.kind, ts: ev.ts, snippet: m.snippet, match: m.match, ...(ev.parentId !== undefined ? { parentId: ev.parentId } : {}) })
      // Нужны только самые новые: память не растёт с числом совпадений.
      if (hits.length > limit * 2) hits = hits.slice(-limit)
    }, { ...opts, head: decide })
    files += 1
    bytes += r.bytes
    if (r.stopped) return { results: [], truncated: false, superseded: true, scanned: { files, bytes }, ms: Date.now() - t0 }
    total += count
    all.push(...hits.slice(-limit))
  }
  all.sort((a, b) => b.eventId - a.eventId)
  return { results: all.slice(0, limit), truncated: total > limit, scanned: { files, bytes }, ms: Date.now() - t0 }
}
