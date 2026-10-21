#!/usr/bin/env node
// ci-data.mjs — проверка данных репозитория: разбирается ли то, что лежит в git.
//
//   git ls-files '*.json'  | node scripts/ci-data.mjs json
//   git ls-files '*.jsonl' | node scripts/ci-data.mjs jsonl
//   node scripts/ci-data.mjs plist <файл>...
//
// Список файлов — на stdin (по одному в строке), режим — первым аргументом.
// Падает на ПЕРВОЙ ошибке и печатает `файл:строка: причина`. Код выхода 1.
//
// ПОЧЕМУ отдельный скрипт, а не node -e в ci-check.sh: одна длинная однострочная команда в
// кавычках не читается и не проверяется `node --check`. Здесь же — обычный файл, который CI
// сам себе и синтаксически проверяет.

import { readFileSync } from 'node:fs'

const mode = process.argv[2]
const argFiles = process.argv.slice(3)

function readStdinList() {
  let raw = ''
  try { raw = readFileSync(0, 'utf8') } catch { raw = '' }
  return raw.split('\n').map((s) => s.trim()).filter(Boolean)
}

const files = argFiles.length ? argFiles : readStdinList()
const die = (msg) => { process.stderr.write(`ci-data: ${msg}\n`); process.exit(1) }

// Файлы читаем и разбираем ПО ОДНОМУ: самый большой здесь — схема Codex на ~850 КБ, и при
// последовательном чтении пик памяти равен размеру одного файла, а не суммы.
function checkJson(path) {
  let text
  try { text = readFileSync(path, 'utf8') } catch (e) { die(`${path}: не читается — ${e.code || e.message}`) }
  try { JSON.parse(text) } catch (e) {
    // JSON.parse в Node сообщает позицию — переводим её в номер строки, чтобы человеку было куда идти.
    const m = /position (\d+)/.exec(e.message)
    const line = m ? text.slice(0, Number(m[1])).split('\n').length : '?'
    die(`${path}:${line}: не разбирается как JSON — ${e.message}`)
  }
}

/**
 * Строки, которые в этих файлах НЕ обязаны быть JSON, — поимённо и по образцу.
 *
 * Фикстуры `test/fixtures/claude/*.jsonl` — дословный stdout настоящего `claude`, а он
 * печатает туда не только события: `--resume` на несуществующий разговор отвечает голой
 * строкой `No conversation found with session ID: <uuid>` и только потом `result`
 * (ИЗМЕРЕНО 21.09.2026). Править запись, чтобы она понравилась проверке, — значит потерять
 * ровно тот факт, ради которого её и сняли.
 *
 * Разрешение УЗКОЕ: конкретный файл, конкретный образец строки. Любая другая неразбираемая
 * строка — хоть в этом файле, хоть в соседнем — по-прежнему роняет проверку.
 */
const RAW_NON_JSON = new Map([
  ['test/fixtures/claude/10-resume-no-conversation.jsonl', /^No conversation found with session ID: \S+$/],
])

function checkJsonl(path) {
  let text
  try { text = readFileSync(path, 'utf8') } catch (e) { die(`${path}: не читается — ${e.code || e.message}`) }
  const allowed = RAW_NON_JSON.get(path) ?? null
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue            // пустые строки разрешены (хвост файла, разрывы прогонов)
    try { JSON.parse(line) } catch (e) {
      if (allowed && allowed.test(line.trim())) { rawLines += 1; continue }
      die(`${path}:${i + 1}: строка JSONL не разбирается — ${String(e.message).slice(0, 160)}`)
    }
  }
  return lines.filter((l) => l.trim()).length
}

/** Сколько не-JSON строк разрешили по списку: в итог они идут отдельно, а не молча. */
let rawLines = 0

// Well-formedness XML-плиста без внешних инструментов: нужен ровно один корневой <plist>,
// сбалансированные теги и никакого мусора после закрытия. Это НЕ валидация по DTD —
// содержательные ключи проверяет section C (plutil на macOS, см. ci-check.sh).
function checkPlist(path) {
  let text
  try { text = readFileSync(path, 'utf8') } catch (e) { die(`${path}: не читается — ${e.code || e.message}`) }
  if (!/^\s*<\?xml\b/.test(text)) die(`${path}:1: нет XML-пролога <?xml …?>`)
  if (!/<plist\b/.test(text)) die(`${path}: нет корневого элемента <plist>`)
  const body = text
    .replace(/<\?[\s\S]*?\?>/g, '')       // прологи
    .replace(/<!DOCTYPE[^>]*>/g, '')      // доктайп
    .replace(/<!--[\s\S]*?-->/g, '')      // комментарии
  const stack = []
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>/g
  let m
  while ((m = tag.exec(body)) !== null) {
    const [, closing, name, attrs, selfClose] = m
    const line = body.slice(0, m.index).split('\n').length
    if (selfClose === '/' || /\/$/.test(attrs)) continue
    if (closing === '/') {
      const open = stack.pop()
      if (open !== name) die(`${path}:${line}: </${name}> закрывает ${open ? `<${open}>` : 'ничего'}`)
    } else {
      stack.push(name)
    }
  }
  if (stack.length) die(`${path}: незакрытые теги: ${stack.join(', ')}`)
}

if (!['json', 'jsonl', 'plist'].includes(mode)) die(`неизвестный режим: ${mode || '(пусто)'}`)
if (!files.length) die(`режим ${mode}: пустой список файлов`)

let lines = 0
for (const f of files) {
  if (mode === 'json') checkJson(f)
  else if (mode === 'jsonl') lines += checkJsonl(f)
  else checkPlist(f)
}

process.stdout.write(mode === 'jsonl'
  ? `   ${files.length} файлов jsonl, ${lines} строк — все разбираются`
    + `${rawLines ? ` (и ${rawLines} не-JSON строк записи CLI — разрешены поимённо)` : ''}\n`
  : `   ${files.length} файлов ${mode} — все разбираются\n`)
