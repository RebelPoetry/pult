// Контекстное окно сессии: сколько токенов разговор занимает в окне модели прямо сейчас.
//
// ИСТОЧНИК — событие `context.updated` `{used, window, model}`, которое пишут переводчики
// провайдеров (claude: `usage` ответа верхнего уровня + `modelUsage[…].contextWindow` из
// `result`; codex: `thread/tokenUsage/updated` своего треда). Здесь — ЧИСТЫЕ функции разбора
// и слияния: их зовут и менеджер демона (`agent.list`, реестр), и окно (свёртка журнала), и
// обоим нужен один и тот же ответ на одни и те же события.
//
// ПОЧЕМУ `window` может быть `null`. У Claude размер окна приходит только в `result`, то есть
// в КОНЦЕ хода, а первая реплика модели — раньше. В режиме `turn` каждый ход — новый процесс
// и новый переводчик, и до своего `result` он окна не знает. Поэтому неизвестное окно
// наследуется от прошлого значения той же модели (`mergeContext`): так его заполняет менеджер
// перед записью в журнал, и так же — окно, если в журнале всё-таки окажется `null`.

/** Данные события `context.updated`. */
export interface ContextData {
  /** Токенов в контексте сейчас (подсказка последнего обращения к модели). */
  used: number
  /** Размер окна модели; `null` — ещё не известен. */
  window: number | null
  model: string | null
}

/** Последнее известное состояние окна сессии: `agent.list`, реестр, окно Пульта. */
export interface SessionContext extends ContextData {
  /** ISO-время события, из которого это значение. */
  at: string
}

const posInt = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null

const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

/** Разбор `data` события `context.updated`. Чужому журналу не верим: кривое — `null`. */
export function parseContextData(data: unknown): ContextData | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const o = data as Record<string, unknown>
  const used = posInt(o['used'])
  if (used === null) return null
  const window = posInt(o['window'])
  return { used, window: window !== null && window > 0 ? window : null, model: nonEmpty(o['model']) }
}

/** Разбор поля `context` записи реестра (файл могли править руками). */
export function parseSessionContext(x: unknown): SessionContext | null {
  const d = parseContextData(x)
  if (!d) return null
  const at = nonEmpty((x as Record<string, unknown>)['at'])
  return at ? { ...d, at } : null
}

/** Одна ли это модель для наследования окна: неизвестная модель не спорит ни с какой. */
function sameModel(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b
}

/**
 * Новое значение поверх прошлого: неизвестные окно и модель берутся из прошлого значения, если
 * модель та же. Сменилась модель — прошлое окно к ней не относится, остаётся `null`.
 */
export function mergeContext(prev: SessionContext | null | undefined, next: ContextData, at: string): SessionContext {
  const inherit = prev != null && sameModel(prev.model, next.model)
  return {
    used: next.used,
    window: next.window ?? (inherit ? prev.window : null),
    model: next.model ?? (inherit ? prev.model : null),
    at,
  }
}

/** Доля занятого окна 0…1 (может быть > 1, если окно меньше подсказки); окна нет — `null`. */
export function contextShare(c: ContextData | null | undefined): number | null {
  if (!c || c.window === null || c.window <= 0) return null
  return c.used / c.window
}
