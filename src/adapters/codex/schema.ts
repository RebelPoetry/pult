// Контроль дрейфа протокола: sha256 набора JSON-схем `codex app-server`.
//
// ЗАЧЕМ. У app-server 167 клиентских методов, 83 уведомления и 11 запросов к клиенту (схема
// `--experimental`, 0.158.0-alpha.2.1), и растёт он вместе с ChatGPT.app — бинарь `~/.local/bin/codex` подменяется при каждом обновлении
// приложения (DELTA v0.4 §2). Молчаливая смена формы сообщения выглядела бы как «ход иногда
// без текста», и искали бы мы её долго. Дешёвая страховка: у самого CLI есть
// `codex app-server generate-json-schema --out <dir>` — 310 файлов за 58 мс (ИЗМЕРЕНО
// 21.09.2026), их слепок и сверяется.
//
// ЧТО ДЕЛАЕТСЯ ПРИ РАСХОЖДЕНИИ: ПРЕДУПРЕЖДЕНИЕ в `pult doctor` и строка в журнале. Не отказ
// работать: протокол обратно совместим чаще, чем нет, и превращать обновление ChatGPT.app в
// неработающего агента — хуже, чем показать жёлтую плашку.
//
// ПОЧЕМУ ВСЁ ЗДЕСЬ АСИНХРОННОЕ (правка по ревью В3). Первая версия звала `spawnSync`, и это
// замораживало ВЕСЬ демон: у Пульта один процесс на все сессии всех провайдеров, а
// `spawnSync` держит событийный цикл на всё время запуска. Взломщик померил: 50-миллисекундный
// пульс вставал на 1614–1679 мс при генерации схемы длиной 1500 мс — то есть на это время
// замирали и чужие ходы, и сокет демона. Теперь запуск асинхронный, с жёстким добиванием по
// таймауту, и его результата НИКТО не ждёт на горячем пути хода.
//
// ГДЕ ПИШЕТСЯ ВРЕМЕННЫЙ КАТАЛОГ: под `PULT_HOME/run`, а не в `os.tmpdir()`. Инвариант 8 —
// «никаких записей вне PULT_HOME, рабочей папки сессии и указанного worktree», и это был
// единственный в `src/` вызов `tmpdir()`. Каталог сносится в `finally` при любом исходе,
// включая добитый по таймауту процесс.
//
// КАК СЧИТАЕТСЯ СЛЕПОК (эта функция — источник истины, а не `shasum` из спайка): все файлы
// каталога рекурсивно, пути относительные с прямыми слэшами, отсортированы; на каждый —
// `sha256` содержимого; итог — `sha256` от строк `"<хэш>  <путь>\n"`. Порядок и разделитель
// закреплены здесь, потому что от них зависит записанное значение.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { buildChildEnv } from '../../env/allowlist.js'
import { redactString } from '../../core/log.js'

/**
 * Слепок, снятый 19.10.2026 на `codex-cli 0.163.0-alpha.10.2`. Прежние: 14.10.2026 на 0.162.0-alpha.17.2
 * (`f99193701ebcaa0d1eb31eec888706051523888aef510b815fe25f29d23d7d92`, 317 файлов), 28.09.2026 на
 * 0.158.0-alpha.2.1 (`da52a92a5dff90a80801f3469cf59f2fc55930ed99554cc3f0f167da788484d1`, 314 файлов)
 * и 21.09.2026 на 0.155.0-alpha.9.2 (`116bdc390b1bbc4d9ec82f5423ac70600089d3ab710932719cc578e889e0d2bb`, 310).
 * Сводные файлы версий лежат в `spike/codex/schema/<версия>/`; что поменялось для адаптера —
 * `node scripts/diff-codex-schema.mjs <старая> <новая>` и DELTA v0.4 §2а.
 * Итог сверки 0.155 → 0.158: одно необязательное поле `InitializeCapabilities.explicitGatewayOauth`,
 * которое мы не шлём, — адаптер не менялся. Итог 0.158 → 0.162 (8 определений в замыкании адаптера):
 * `Turn.error` теперь бывает и у ПРЕРВАННОГО хода — адаптер дописывает причину сервера к «прерван»;
 * `MessagePhase` += `partial_answer` (фазу адаптер только передаёт), `CodexErrorInfo` += `flexUnavailable`
 * (не лимит — обычный провал с текстом сервера), `PlanType` += `promax`, необязательные
 * `rootTurnId`/`parentTurnId`, которых мы не шлём, `ResponseItem` += `additional_tools` (не читаем).
 * Итог 0.162 → 0.163 (только добавления, адаптер не менялся): методы `thread/readState/update`,
 * `thread/items/read` (experimental) и уведомление `thread/readState/changed` — не зовём и не слушаем;
 * в замыкании адаптера — необязательные `model`/`reasoningEffort` у `subAgentActivity` (не читаем),
 * `TurnToolOutput.retain` (не шлём), в experimental ещё `encrypted_content`/`status` у `ResponseItem`
 * и `annotations`/`logprobs` у `output_text` (не читаем). Схема запросов разрешений не поменялась.
 */
export const CODEX_SCHEMA_SHA256 = '495ecc09e89c6fa08112a6e4b283826a953e7a6a16d082e9ee425f1346d8f0af'
export const CODEX_SCHEMA_FILES = 318
export const CODEX_SCHEMA_CLI_VERSION = '0.163.0-alpha.10.2'
/** Когда снят слепок: попадает в строку доктора, чтобы «совпала» не читалось как «свежая». */
export const CODEX_SCHEMA_TAKEN = '19.10.2026'
/** Дольше этого генерация схемы не имеет права идти: процесс добивается SIGKILL. */
export const SCHEMA_TIMEOUT_MS = 30_000

export interface SchemaRunResult {
  status: number | null
  stdout: string
  stderr: string
}

/** Асинхронный запуск: синхронного здесь больше нет и быть не должно (см. шапку). */
export type SchemaRun = (file: string, args: string[], timeoutMs: number) => Promise<SchemaRunResult>

export interface SchemaDigest {
  sha256: string
  files: number
}

export function hashSchemaDir(dir: string): SchemaDigest {
  const found: string[] = []
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.isFile()) found.push(p)
    }
  }
  walk(dir)
  const rel = found.map((f) => relative(dir, f).split(sep).join('/')).sort()
  const bundle = createHash('sha256')
  for (const r of rel) {
    const body = readFileSync(join(dir, r.split('/').join(sep)))
    bundle.update(`${createHash('sha256').update(body).digest('hex')}  ${r}\n`)
  }
  return { sha256: bundle.digest('hex'), files: rel.length }
}

export type SchemaStatus = 'ok' | 'drift' | 'unavailable'

export interface CodexSchemaCheck {
  status: SchemaStatus
  expected: string
  actual: string | null
  files: number | null
  /** Готовая строка для `pult doctor` и журнала. */
  detail: string
}

export interface SchemaCheckDeps {
  /** Путь к бинарю `codex`. `null` — CLI не найден. */
  bin: string | null
  /**
   * Куда класть временный каталог схемы. ОБЯЗАТЕЛЕН и всегда внутри PULT_HOME (инвариант 8):
   * необязательным его делать нельзя — забытый параметр вернул бы запись в `os.tmpdir()`.
   */
  workDir: string
  run?: SchemaRun
  timeoutMs?: number
  /**
   * ШОВ ДЛЯ ТЕСТА, в бою не задаётся: таймер добивания взводится не в момент `spawn`, а когда
   * этот промис разрешится (отказ — тоже взвод). Без него тест «зависший codex» гонял таймер
   * против запуска скрипта-заглушки: на загруженной машине SIGKILL прилетал раньше, чем `sh`
   * успевал выполнить первую строку, и тест падал «скрипт так и не запустился». Сам таймер,
   * SIGKILL и отчёт «добита по таймауту» — тот же боевой код; работает только с запуском по
   * умолчанию (подменённому `run` шов не передаётся).
   */
  armAfter?: Promise<unknown>
}

/** Запуск с жёстким добиванием: зависший `codex` не держит ни демон, ни доктора. */
const spawnWithDeadline = (file: string, args: string[], timeoutMs: number, armAfter?: Promise<unknown>): Promise<SchemaRunResult> => new Promise<SchemaRunResult>((resolve) => {
  let child
  try {
    child = spawn(file, args, { env: buildChildEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    resolve({ status: null, stdout: '', stderr: String((e as Error).message) })
    return
  }
  let stdout = ''
  let stderr = ''
  let settled = false
  let killer: ReturnType<typeof setTimeout> | undefined
  const done = (r: SchemaRunResult): void => { if (!settled) { settled = true; clearTimeout(killer); resolve(r) } }
  const arm = (): void => {
    if (settled) return
    killer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* уже ушёл */ }
      done({ status: null, stdout, stderr: `${stderr}\nгенерация схемы добита по таймауту ${timeoutMs} мс` })
    }, timeoutMs)
    killer.unref?.()
  }
  if (armAfter) armAfter.then(arm, arm)
  else arm()
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (d: string) => { stdout += d })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (d: string) => { stderr += d })
  child.on('error', (e) => { done({ status: null, stdout, stderr: String(e.message) }) })
  child.on('close', (code) => { done({ status: code, stdout, stderr }) })
})

export async function checkCodexSchema(deps: SchemaCheckDeps): Promise<CodexSchemaCheck> {
  const expected = CODEX_SCHEMA_SHA256
  if (!deps.bin) {
    return { status: 'unavailable', expected, actual: null, files: null, detail: 'CLI codex не найден — схему не у кого спросить' }
  }
  const run: SchemaRun = deps.run ?? ((file, args, timeoutMs) => spawnWithDeadline(file, args, timeoutMs, deps.armAfter))
  mkdirSync(deps.workDir, { recursive: true, mode: 0o700 })
  const dir = mkdtempSync(join(deps.workDir, 'codex-schema-'))
  try { chmodSync(dir, 0o700) } catch { /* права проверит доктор */ }
  try {
    const r = await run(deps.bin, ['app-server', 'generate-json-schema', '--out', dir], deps.timeoutMs ?? SCHEMA_TIMEOUT_MS)
    if (r.status !== 0) {
      const tail = redactString((r.stderr || r.stdout || '').trim().split('\n')[0] ?? '')
      return {
        status: 'unavailable',
        expected,
        actual: null,
        files: null,
        detail: `generate-json-schema вышел с кодом ${r.status}${tail ? `: ${tail}` : ''}`,
      }
    }
    const digest = hashSchemaDir(dir)
    // Пустой каталог — это не «схема изменилась», а «схему не получили»: так выглядит и
    // подменённый в тесте запуск, и CLI, который отчитался успехом, ничего не записав.
    if (digest.files === 0) {
      return { status: 'unavailable', expected, actual: null, files: 0, detail: 'generate-json-schema не записал ни одного файла' }
    }
    if (digest.sha256 === expected) {
      return {
        status: 'ok',
        expected,
        actual: digest.sha256,
        files: digest.files,
        detail: `схема совпала со снятой ${CODEX_SCHEMA_TAKEN} (${digest.files} файлов, codex ${CODEX_SCHEMA_CLI_VERSION})`,
      }
    }
    return {
      status: 'drift',
      expected,
      actual: digest.sha256,
      files: digest.files,
      detail: `схема протокола РАЗОШЛАСЬ: ${digest.sha256.slice(0, 16)}… против ${expected.slice(0, 16)}… `
        + `(${digest.files} файлов против ${CODEX_SCHEMA_FILES}). Работать это не мешает, но форма сообщений могла измениться`,
    }
  } catch (e) {
    return { status: 'unavailable', expected, actual: null, files: null, detail: `схему не прочитать: ${redactString((e as Error).message)}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
