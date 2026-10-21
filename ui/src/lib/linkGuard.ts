// Защита от ссылки `pult://`, пришедшей, пока человек печатает в другом приложении (docs/14 О3). Окно
// всплыло само — значит, следующие нажатия предназначались не ему: Enter или ⌘Enter не должны
// отправить реплику или завести сессию, буквы — попасть в поле. Поэтому после перехода по ссылке
// окно полсекунды глотает клавиши и не ставит фокус в поле ввода открытой сессии.
//
// Состояние — одно на окно (как и сам переход), функции чистые по часам: тесты передают `now`.

/** Сколько окно глотает клавиши после перехода по ссылке. */
export const LINK_KEY_GUARD_MS = 500
/** Сколько ждёт пропущенный автофокус: сессия из ссылки могла ещё не прийти в список. */
const NO_FOCUS_TTL_MS = 10_000

const state = { keysUntil: 0, noFocus: null as null | { name: string; until: number } }

/** Переход по ссылке: глотать клавиши, а поле ввода сессии `session` (если есть) не фокусировать. */
export function armLinkGuard(now: number, session?: string): void {
  state.keysUntil = now + LINK_KEY_GUARD_MS
  state.noFocus = session ? { name: session, until: now + NO_FOCUS_TTL_MS } : null
}

export function keysGuarded(now: number): boolean {
  return now < state.keysUntil
}

/**
 * Можно ли поставить фокус в поле ввода сессии `name`. Отказ — один раз: поле открытой по ссылке
 * сессии остаётся без фокуса, следующий показ той же сессии (клик, вкладка) — как обычно.
 */
export function takeAutoFocus(name: string, now: number): boolean {
  const nf = state.noFocus
  if (!nf || now >= nf.until) { state.noFocus = null; return true }
  if (nf.name !== name) return true
  state.noFocus = null
  return false
}

/** Клавиши, которые глотаются в окно защиты: всё, кроме модификаторов самих по себе и Escape. */
export function swallowsKey(key: string): boolean {
  return !['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Escape'].includes(key)
}

/** Только для тестов: вернуть состояние к началу. */
export function resetLinkGuard(): void {
  state.keysUntil = 0
  state.noFocus = null
}
