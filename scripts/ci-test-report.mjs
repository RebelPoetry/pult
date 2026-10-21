// ci-test-report.mjs — выжимка провалов из вывода `node --test`.
//
//   node scripts/ci-test-report.mjs <файл-с-выводом>
//
// ЗАЧЕМ. При провале `npm test` ci-check печатал `tail -n 60` — слепой хвост, в который
// попадают последние ОК-тесты и итоговые счётчики, но ни одной строки `not ok`. Диагноз
// «# fail 1» или «# cancelled 2» без единого имени теста не читается вообще: на CI это стоило
// целого прогона вслепую. Здесь мы вытаскиваем каждый непрошедший тест с его диагностикой.
//
// ДВА ФОРМАТА НА ВХОДЕ. Репортёр по умолчанию у `node --test` менялся между мажорами: node 22
// без TTY печатает TAP, node 24+ — `spec` (ИЗМЕРЕНО 21.09.2026: node 22.21 → `TAP version 13`,
// node 26.9 → `▶ набор`). CI сидит на 22, разработчик — на том, что стоит у него. Поэтому
// разбираем оба; если на входе ни тот ни другой (процесс умер раньше вывода), выходим с
// кодом 1, и ci-check честно откатывается на хвост.
//
// ЧТО СЧИТАЕТСЯ ПРОВАЛОМ. Любая строка `not ok`. Отменённый тест (`cancelled`) — это тоже
// `not ok`, только с `failureType: 'cancelledByParent'` и `error: 'Promise resolution is still
// pending but the event loop has already resolved'`: событийный цикл опустел, раннер вышел, а
// тест не доиграл. Отличать отмену от падения — работа читателя отчёта, поэтому `failureType`
// печатается всегда.

import { readFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) {
  process.stderr.write('ci-test-report: нужен путь к файлу с выводом node --test\n')
  process.exit(2)
}

const lines = readFileSync(file, 'utf8').split('\n')

/** Поля диагностики, которые объясняют провал. Остальное (duration_ms, type) — шум. */
const KEEP = /^(failureType|error|code|name|expected|actual|operator|location|exitCode|signal):/
/** Длинные значения режем: отчёт должен помещаться в лог, а не заменять его. */
const cut = (s, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s)

const out = []
const summary = []
let failures = 0

for (const line of lines) {
  // Счётчики: `# tests 206` у TAP, `ℹ tests 206` у spec.
  const s = /^[#ℹ] ((?:tests|suites|pass|fail|cancelled|skipped|todo) \d+)$/.exec(line)
  if (s) summary.push(s[1])
}

if (lines.some((l) => l.startsWith('TAP version'))) {
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)not ok (\d+) - (.*)$/.exec(lines[i])
    if (!m) continue
    const [, indent, num, title] = m
    const inner = `${indent}  `
    const detail = []
    let isSuite = false
    let j = i + 1
    if (lines[j]?.trim() !== '---') continue
    j += 1
    // YAML-блок TAP: плоские поля и блочные скаляры (`error: |-`, `stack: |-`), тело которых
    // сдвинуто ещё на два пробела. Из стека берём одну верхнюю строку — она и указывает на код.
    while (j < lines.length && lines[j].trim() !== '...') {
      const body = lines[j].startsWith(inner) ? lines[j].slice(inner.length) : lines[j].trim()
      const block = /^(error|stack): \|-?$/.exec(body)
      if (block) {
        const acc = []
        j += 1
        while (j < lines.length && lines[j].trim() !== '...' && /^\s{2}\S/.test(lines[j].slice(inner.length))) {
          if (lines[j].trim()) acc.push(lines[j].trim())
          if (block[1] === 'stack' && acc.length) break
          j += 1
        }
        if (acc.length) detail.push(`${block[1]}: ${cut(acc.join(' / '))}`)
        continue
      }
      if (body === "type: 'suite'") isSuite = true
      else if (KEEP.test(body)) detail.push(cut(body))
      j += 1
    }
    failures += 1
    out.push(`${indent}not ok ${num} - ${title.trim()}`)
    // У набора та же диагностика, что у его подтеста: имя набора нужно как контекст, его
    // повтор диагностики — нет.
    if (!isSuite) for (const d of detail) out.push(`${indent}    ${d}`)
  }
} else if (lines.some((l) => l.startsWith('✖ failing tests:'))) {
  // spec: имена и ошибки собраны в хвостовой раздел — печатаем его целиком, без кадров стека.
  const from = lines.findIndex((l) => l.startsWith('✖ failing tests:'))
  for (const l of lines.slice(from + 1)) {
    if (/^\s+at /.test(l)) continue
    if (l.startsWith('✖ ')) failures += 1
    out.push(cut(l, 300))
  }
} else {
  process.stderr.write('ci-test-report: вывод не опознан ни как TAP, ни как spec — отчёт не построен\n')
  process.exit(1)
}

process.stderr.write(`непрошедших записей: ${failures}\n${out.join('\n')}\n`)
if (summary.length) process.stderr.write(`итог: ${summary.join(' · ')}\n`)
