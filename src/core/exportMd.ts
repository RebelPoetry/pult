// Экспорт сессии в Markdown (О2, docs/14 «Поиск, метки, экспорт»): RPC `agent.export`, пункт меню
// сессии «Экспорт в Markdown», `pult agent export <имя>`.
//
// Источник — ПОЛНЫЙ файл сессии (`events/<сессия>.jsonl`), а не лёгкая история окна: итоговые тексты
// модели целиком, без урезанных входов. Всё до последнего `session.ended rm` — прежняя сессия с тем же
// именем, её нет. Формат — для чтения человеком и для вставки в заметку или задачу:
//   * шапка: название, имя, провайдер, модель, папка, ветка worktree, время заведения и выгрузки;
//   * ход за ходом (`message.user` в корне начинает ход): реплика человека цитатой, итоговые тексты
//     модели как есть (это уже Markdown), инструменты — строка на вызов `имя: что` с исходом (код
//     выхода, ошибка), субагенты — цитатой со своими строками, ошибки и лимиты — строкой «**Ошибка:**»;
//   * выводы инструментов, дельты и служебные события — нет.
// Файл — `PULT_HOME/exports/<имя>-<ГГГГММДД-ЧЧММСС>.md`, 0600, каталог 0700: в разговоре бывают пути,
// команды и куски кода владельца.

import { chmodSync, mkdirSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { PultEvent } from './events.js'
import type { PultPaths } from './paths.js'
import { attentionOf } from '../sessions/attention.js'
import { readSessionAsync, toolSummaryText } from './search.js'
import type { ScanOptions } from './search.js'

/** Что из реестра нужно шапке. */
export interface ExportRecord {
  name: string
  title?: string
  provider: string
  cwd: string
  model?: string
  effort?: string
  createdAt?: string
  worktree?: { path: string; branch: string }
}

/** Виды, которые попадают в экспорт (остальные даже не разбираются при чтении файла). */
export const EXPORT_KINDS: ReadonlySet<string> = new Set([
  'message.user', 'message.done', 'tool.called', 'tool.finished', 'agent.spawned', 'agent.finished',
  'permission.resolved', 'status.changed', 'limit.hit', 'net.blocked', 'provider.blocked', 'turn.stalled',
])

const TOOL_LINE_CHARS = 160

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

function clipChars(s: string, n: number): string {
  const chars = [...s]
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : s
}

/** Строка в `code`: обратные кавычки внутри — двойной оградой, как велит CommonMark. */
function code(s: string): string {
  if (!s.includes('`')) return `\`${s}\``
  return `\`\` ${s} \`\``
}

/** Время для людей: «2026-10-14 10:05:03» по часам машины — экспорт читают там же. */
function human(ts: string | undefined): string {
  const d = ts ? new Date(ts) : null
  if (!d || Number.isNaN(d.getTime())) return ts ?? ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Метка в имени файла: ГГГГММДД-ЧЧММСС по часам машины. */
export function fileStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

const quote = (text: string): string => text.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')

/** Блок субагента: его строки дописываются и после того, как в корне пошли следующие — место держит ссылка. */
interface Block { lines: Line[] }
type Line = string | Block

/** Последняя строка — пункт списка: следующий пункт пойдёт без пустой строки. */
const afterItem = (out: readonly Line[]): boolean => { const l = out[out.length - 1]; return typeof l === 'string' && l.startsWith('- ') }
/** Пункт списка инструментов: пустая строка перед первым отделяет список от текста. */
function item(out: Line[], line: string): void { if (out.length && !afterItem(out)) out.push(''); out.push(line) }

/** Исход вызова инструмента по его `tool.finished`. */
function toolOutcome(fin: PultEvent | undefined): string {
  if (!fin) return ''
  const d = fin.data ?? {}
  const parts: string[] = []
  if (typeof d['exitCode'] === 'number') parts.push(`код ${d['exitCode']}`)
  if (d['isError'] === true) parts.push('ошибка')
  return parts.length ? ` — ${parts.join(', ')}` : ''
}

/** Причина ошибки или лимита — одной строкой; `null` — событие не ошибка. */
function problemLine(ev: PultEvent): string | null {
  const d = ev.data ?? {}
  if (ev.kind === 'status.changed' && d['status'] === 'interrupted') return '**Ход прерван.**'
  const att = attentionOf(ev)
  if (!att || att.kind === 'done' || att.kind === 'ask') return null
  const what = att.kind === 'limit' ? 'Лимит' : att.kind === 'blocked' ? 'Заблокировано' : att.kind === 'stalled' ? 'Похоже, завис' : 'Ошибка'
  return `**${what}:** ${att.text ?? ev.kind}`
}

/** Markdown сессии по её событиям (в порядке номеров, уже после последнего `session.ended rm`). */
export function sessionMarkdown(rec: ExportRecord, events: readonly PultEvent[], now: Date = new Date()): string {
  const head: string[] = [`# ${oneLine(rec.title || rec.name)}`, '']
  head.push(`- Сессия: ${code(rec.name)}`)
  head.push(`- Провайдер: ${[rec.provider, rec.model, rec.effort].filter(Boolean).join(' · ')}`)
  head.push(`- Папка: ${code(rec.cwd)}`)
  if (rec.worktree) head.push(`- Worktree: ${code(rec.worktree.path)}, ветка ${code(rec.worktree.branch)}`)
  if (rec.createdAt) head.push(`- Заведена: ${human(rec.createdAt)}`)
  head.push(`- Выгружено: ${human(now.toISOString())}`)

  // Исходы инструментов и субагентов — по toolUseId: строка вызова пишется сразу с исходом.
  const finished = new Map<string, PultEvent>()
  for (const ev of events) {
    const id = ev.data?.['toolUseId']
    if ((ev.kind === 'tool.finished' || ev.kind === 'agent.finished') && typeof id === 'string') finished.set(id, ev)
  }
  // Области: корень ('') и блоки субагентов по toolUseId их вызова. Событие с неизвестным
  // родителем — в корень, как в ленте окна.
  const blocks = new Map<string, Block>()
  const root: Line[] = []
  const linesOf = (ev: PultEvent): Line[] => (ev.parentId !== undefined ? blocks.get(ev.parentId)?.lines : undefined) ?? root
  let turn = 0
  for (const ev of events) {
    const d = ev.data ?? {}
    const out = linesOf(ev)
    switch (ev.kind) {
      case 'message.user': {
        const text = typeof d['text'] === 'string' ? d['text'] : ''
        if (out === root) {
          turn += 1
          root.push('', `## Ход ${turn} · ${human(ev.ts)}`, '', '**Ты:**', '', quote(text.trim() || '(пусто)'))
        } else {
          out.push('', '**Ты:**', '', quote(text.trim()))
        }
        break
      }
      case 'message.done': {
        const text = typeof d['text'] === 'string' ? d['text'].trim() : ''
        if (!text && typeof d['error'] !== 'string') break
        out.push('', `**${rec.provider}:**`, '')
        if (text) out.push(text)
        if (typeof d['error'] === 'string') out.push('', `**Ошибка:** ${oneLine(d['error'])}`)
        break
      }
      case 'tool.called': {
        const name = typeof d['name'] === 'string' ? d['name'] : 'tool'
        const sum = clipChars(oneLine(toolSummaryText(d['input'])), TOOL_LINE_CHARS)
        const id = typeof d['toolUseId'] === 'string' ? d['toolUseId'] : ''
        item(out, `- ${code(sum ? `${name}: ${sum}` : name)}${toolOutcome(finished.get(id))}`)
        break
      }
      case 'agent.spawned': {
        const id = typeof d['toolUseId'] === 'string' ? d['toolUseId'] : null
        if (!id) break
        const block: Block = { lines: [] }
        blocks.set(id, block)
        const kind = typeof d['subagentType'] === 'string' ? d['subagentType'] : 'agent'
        const desc = typeof d['description'] === 'string' ? ` — ${oneLine(d['description'])}` : ''
        out.push('', `**Субагент ${code(kind)}${desc}**${toolOutcome(finished.get(id))}`, block)
        break
      }
      case 'permission.resolved': {
        const tool = typeof d['toolName'] === 'string' ? d['toolName'] : null
        const decision = d['decision'] === 'allow' ? 'разрешено' : 'отказано'
        if (tool) item(out, `- разрешение ${code(tool)}: ${decision}`)
        break
      }
      default: {
        const p = problemLine(ev)
        if (p) out.push('', p)
      }
    }
  }
  const flat = (lines: readonly Line[]): string[] => lines.flatMap((l) => {
    if (typeof l === 'string') return [l]
    const inner = flat(l.lines)
    while (inner.length && inner[0] === '') inner.shift()
    return inner.length ? ['', quote(inner.join('\n'))] : []
  })
  const body = flat(root)
  if (!turn && !body.some((l) => l.trim())) body.push('', '_Разговор пуст._')
  return `${[...head, ...body].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

/** Поля входа инструмента, которые нужны строке вызова (src/core/search.ts toolSummaryText). */
const INPUT_FIELDS = ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'description', 'url', 'query'] as const

/**
 * Что экспорт держит от события в памяти, пока читает файл: от выводов инструментов и субагентов — только
 * исход (`toolUseId`, `exitCode`, `isError`), от вызова — поля строки вызова, урезанные. Вывод `cat` на
 * мегабайты и полный вход `Write` в Markdown не идут, и держать их до конца чтения незачем.
 */
export function slimEvent(ev: PultEvent): PultEvent {
  const d = ev.data ?? {}
  if (ev.kind === 'tool.finished' || ev.kind === 'agent.finished') {
    return { ...ev, data: {
      ...(typeof d['toolUseId'] === 'string' ? { toolUseId: d['toolUseId'] } : {}),
      ...(typeof d['exitCode'] === 'number' ? { exitCode: d['exitCode'] } : {}),
      ...(d['isError'] === true ? { isError: true } : {}),
    } }
  }
  if (ev.kind === 'tool.called') {
    const raw = d['input'] && typeof d['input'] === 'object' && !Array.isArray(d['input']) ? d['input'] as Record<string, unknown> : {}
    const input: Record<string, unknown> = {}
    for (const k of INPUT_FIELDS) {
      const v = raw[k]
      if (typeof v === 'string') input[k] = v.slice(0, TOOL_LINE_CHARS * 2)
      else if (Array.isArray(v)) input[k] = v.filter((x) => typeof x === 'string').join(' ').slice(0, TOOL_LINE_CHARS * 2)
    }
    return { ...ev, data: { ...(typeof d['toolUseId'] === 'string' ? { toolUseId: d['toolUseId'] } : {}), ...(typeof d['name'] === 'string' ? { name: d['name'] } : {}), input } }
  }
  return ev
}

/** Имя файла экспорта: имя сессии (оно уже безопасно — `[A-Za-z0-9._-]`) и время. */
export function exportFileName(name: string, now: Date): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[.]+/, '_') || 'session'
  return `${safe}-${fileStamp(now)}.md`
}

/**
 * Выгрузить сессию в `PULT_HOME/exports/`. Файл не перезаписывает существующий (`wx`): два экспорта за
 * секунду получают суффикс `-2`, `-3`…
 */
export async function exportSession(paths: PultPaths, rec: ExportRecord, opts: ScanOptions & { now?: Date } = {}): Promise<{ path: string; bytes: number }> {
  const now = opts.now ?? new Date()
  const { events } = await readSessionAsync(paths.events, rec.name, { ...opts, kinds: EXPORT_KINDS, map: slimEvent })
  const md = sessionMarkdown(rec, events, now)
  const dir = join(paths.home, 'exports')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const base = exportFileName(rec.name, now).replace(/\.md$/, '')
  const buf = Buffer.from(md, 'utf8')
  for (let i = 1; i < 100; i++) {
    const file = join(dir, `${base}${i > 1 ? `-${i}` : ''}.md`)
    let fh
    try {
      fh = await open(file, 'wx', 0o600)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw e
    }
    try {
      await fh.writeFile(buf)
      await fh.chmod(0o600)
    } finally {
      await fh.close()
    }
    return { path: file, bytes: buf.length }
  }
  throw new Error(`экспорт: в ${dir} уже 99 файлов ${base}*.md`)
}
