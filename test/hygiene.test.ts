// Гигиена самого набора тестов: правила, нарушение которых не падает ассертом, а портит
// прогон целиком — и потому ловится только здесь.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/** Исходники тестов лежат рядом со скомпилированными: dist-test/ ↔ test/. */
const TEST_SRC = fileURLToPath(new URL('../test/', import.meta.url))

/**
 * Убирает строчные и блочные комментарии: про `unref` в них написано намеренно. Переводы
 * строк сохраняются — иначе номер строки в отчёте уехал бы относительно файла.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

describe('гигиена набора', () => {
  it('ни одного unref-нутого ожидания в тестах: раннер выходит и тесты уезжают в cancelled', () => {
    // ИЗМЕРЕНО 21.09.2026. `await new Promise((res) => { const t = setTimeout(res, 800);
    // t.unref() })` в тесте адаптера уронил обе ветки CI: unref-нутый таймер не держит
    // событийный цикл, а после close() у адаптера не остаётся НИ ОДНОГО ref-нутого
    // дескриптора. Цикл пустеет, node:test выходит посреди ожидания и пишет
    // `failureType: 'cancelledByParent'`, `error: 'Promise resolution is still pending but
    // the event loop has already resolved'` — по два теста за раз, при `fail 0`.
    //
    // ПОЧЕМУ ЭТО НЕ ЛОВИЛОСЬ ЛОКАЛЬНО: поведение зависит от мажора node. На 22 (он и стоит
    // на раннере) тесты уезжают в cancelled, на 26 цикл доживает до конца ожидания, и набор
    // зелёный. Правило проверяется здесь, а не глазами на ревью, именно поэтому.
    //
    // ЧЕМ ЖДАТЬ ВМЕСТО ЭТОГО: `sleep`/`waitFor` из test/helpers.ts — их таймеры ref-нуты.
    // Правило только про исходники тестов (.ts). В src/ unref-нутые таймеры законны и нужны
    // (демон не обязан жить ради жнеца), и в test/fakes/ тоже: фальшивый CLI — ОТДЕЛЬНЫЙ
    // процесс, его страховочный таймер ничей прогон не отменяет.
    const offenders: string[] = []
    for (const name of readdirSync(TEST_SRC, { recursive: true, encoding: 'utf8' })) {
      if (!name.endsWith('.ts')) continue
      const src = stripComments(readFileSync(join(TEST_SRC, name), 'utf8'))
      src.split('\n').forEach((line, i) => {
        if (/\.unref\s*(\?\.)?\s*\(/.test(line)) offenders.push(`test/${name}:${i + 1}: ${line.trim()}`)
      })
    }
    assert.deepEqual(offenders, [], `unref-нутое ожидание в тестах:\n${offenders.join('\n')}`)
  })
})
