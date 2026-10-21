// Клавиатурная разборка очереди (О2, docs/14, как в Conductor и cmux): ⌘⌥L — следующая сессия, которая
// ждёт тебя, ⌃⌘L — отложить текущую. Чистые функции: вход — строки списка, выход — порядок и имя.
//
// ПОРЯДОК — docs/14: непрочитанные ошибки (ход упал, лимит, страж), затем разрешения и вопросы, затем
// прочее непрочитанное («готово»). Внутри класса — кто ждёт дольше, тот первый (как в Inbox): по номеру
// события внимания, без него — по последней активности. Отложенные — в конец своего класса, пока у
// сессии не случится новое событие внимания: отложили «упал в 10:02», а она упала снова — снова в очереди.
// Отложенная не гаснет сама (окно не шлёт по ней `agent.seen`), пока человек не придёт к ней сам.

import { waitClass } from '../../../src/sessions/attention.js'
import type { AgentView } from './agents.js'

/**
 * Отложенные сессии: имя → номер события внимания на момент «отложить» (0 — внимания не было).
 * Живёт только в окне: «отложить» — про порядок разбора здесь и сейчас, а не про состояние сессии.
 */
export type Snoozed = Readonly<Record<string, number>>

const attId = (a: Pick<AgentView, 'attention'>): number => a.attention?.id ?? 0

/** Отложена ли сессия сейчас: отметка совпадает с её последним событием внимания. */
export function isSnoozed(a: Pick<AgentView, 'name' | 'attention'>, snoozed: Snoozed): boolean {
  const at = snoozed[a.name]
  return at !== undefined && at === attId(a)
}

/** Отложить: запомнить, на каком событии внимания. */
export function snooze(snoozed: Snoozed, a: Pick<AgentView, 'name' | 'attention'>): Snoozed {
  return { ...snoozed, [a.name]: attId(a) }
}

/** Снять отметку: человек сам пришёл к сессии (⌘⌥L, клик, вкладка) — она больше не отложена. */
export function unsnooze(snoozed: Snoozed, name: string): Snoozed {
  if (!(name in snoozed)) return snoozed
  const out = { ...snoozed }
  delete out[name]
  return out
}

/** Выкинуть отметки, которые больше ничего не значат: сессии нет или у неё новое событие внимания. */
export function pruneSnoozed(snoozed: Snoozed, agents: readonly Pick<AgentView, 'name' | 'attention'>[]): Snoozed {
  const alive = new Map(agents.map((a) => [a.name, a]))
  const keys = Object.keys(snoozed)
  const kept = keys.filter((k) => { const a = alive.get(k); return a !== undefined && isSnoozed(a, snoozed) })
  if (kept.length === keys.length) return snoozed
  const out: Record<string, number> = {}
  for (const k of kept) out[k] = snoozed[k] as number
  return out
}

/** Очередь «ждут тебя» в порядке разбора. Сессии, которые никого не ждут, сюда не попадают. */
export function waitingQueue(agents: readonly AgentView[], snoozed: Snoozed = {}): AgentView[] {
  const rows: Array<{ a: AgentView; cls: number; late: number }> = []
  for (const a of agents) {
    // Архивные убраны с глаз: их ошибки и непрочитанное ⌘⌥L не показывает. Но ждущий запрос —
    // показывает: архивная сессия, что работает и спросила разрешения, стоит, пока ты не ответишь.
    const cls = a.archived ? (a.pending > 0 ? waitClass(false, undefined, a.pending) : null) : waitClass(a.unread === true, a.attention, a.pending)
    if (cls === null) continue
    rows.push({ a, cls, late: isSnoozed(a, snoozed) ? 1 : 0 })
  }
  return rows.sort((x, y) =>
    x.cls - y.cls
    || x.late - y.late
    || attId(x.a) - attId(y.a)
    || Date.parse(x.a.lastActivity) - Date.parse(y.a.lastActivity)
    || x.a.name.localeCompare(y.a.name)).map((r) => r.a)
}

/** ⌘⌥L: кого открыть следующим. Текущую пропускаем; никого — `null`. */
export function nextWaiting(agents: readonly AgentView[], current: string | null, snoozed: Snoozed = {}): string | null {
  return waitingQueue(agents, snoozed).find((a) => a.name !== current)?.name ?? null
}
