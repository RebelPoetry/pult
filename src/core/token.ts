// Токен рукопожатия. Меняется на КАЖДОМ старте демона (DELTA v0.4 §4): клиент, который
// помнит токен прошлого демона, обязан получить отказ, а не молча попасть в новую сессию.

import { timingSafeEqual } from 'node:crypto'
import { randomBytes } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'

export const TOKEN_BYTES = 32

export function rotateToken(path: string): string {
  const token = randomBytes(TOKEN_BYTES).toString('hex')
  writeFileSync(path, token, { mode: 0o600 })
  chmodSync(path, 0o600) // umask маскирует mode у writeFileSync ровно так же, как у mkdir
  return token
}

export function readToken(path: string): string | null {
  try {
    const t = readFileSync(path, 'utf8').trim()
    return t.length ? t : null
  } catch {
    return null
  }
}

/** Сравнение постоянного времени. Разная длина — сразу нет, без утечки длины через тайминг. */
export function tokenEquals(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(a, b)
}
