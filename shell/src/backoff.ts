// Пауза между попытками переподключиться к демону: растёт вдвое от `minMs` до `maxMs`.
// Без дрожания: клиент у демона один (это окно), толпы, которую надо разводить, нет.

export interface Backoff {
  minMs: number
  maxMs: number
}

export const DEFAULT_BACKOFF: Backoff = { minMs: 250, maxMs: 5000 }

/** Пауза перед попыткой номер `attempt` (1, 2, …). */
export function backoffDelay(attempt: number, b: Backoff = DEFAULT_BACKOFF): number {
  const n = Math.max(1, Math.floor(attempt))
  return Math.min(b.maxMs, b.minMs * 2 ** Math.min(n - 1, 30))
}

/**
 * Разбор `PULT_SHELL_BACKOFF=min,max` (мс). Действует только при PULT_TEST=1: e2e растягивает
 * паузу, чтобы гарантированно проверить доигрывание с курсора, а не живой поток.
 */
export function parseBackoff(raw: string | undefined, testMode: boolean): Backoff {
  if (!testMode || !raw) return DEFAULT_BACKOFF
  const [a, b] = raw.split(',').map((s) => Number(s.trim()))
  if (!Number.isFinite(a) || !Number.isFinite(b) || a! <= 0 || b! < a!) return DEFAULT_BACKOFF
  return { minMs: a!, maxMs: b! }
}
