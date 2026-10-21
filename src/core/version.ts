// Версия пакета — из package.json, а не из константы в коде: две цифры, которые надо
// держать синхронными вручную, рано или поздно разъезжаются.
// Путь считается от собранного файла: dist/core/version.js -> <корень пакета>/package.json.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function read(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url))
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const VERSION: string = read()

/**
 * Самое старое окно (Pult.app, shell/package.json), с которым работает этот пакет: интерфейс окна едет в
 * пакете, а оболочка — отдельно, и пакет может потребовать от неё нового (метод моста, белый список).
 * Попадает в latest.json полем `app.minVersion` (scripts/release.mjs читает его из собранного пакета):
 * окно старше — плашка «Нужна новая версия окна» вместо «Обновить». Поднимать, только когда интерфейс без
 * новой оболочки правда не работает: 0.2.27 со старым окном живёт (без `update.*` в белом списке плашка
 * подсказывает `pult update` в терминале), поэтому здесь 0.1.13.
 */
export const WINDOW_MIN_VERSION = '0.1.13'
