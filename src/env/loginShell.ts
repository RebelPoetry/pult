// Захват логин-шелла. Перенесено из spike/env/capture-env.mjs (проверка S9a).
//
// ПОЧЕМУ под `env -i`: `$SHELL -ilc 'env -0'` наследует окружение вызывающего, и демон,
// запущенный из терминала (или из десктопного Claude), снял бы слепок ЧУЖОГО мусора вместо
// того, что реально ставят rc-файлы.
// ПОЧЕМУ `env -0`, а не `env`: значение переменной может содержать перевод строки.
// ПОЧЕМУ 3 с: залипший rc-файл не имеет права держать доктора.
// ПОЧЕМУ АСИНХРОННО: захват зовёт доктор, а `doctor.run` идёт в процессе демона — `spawnSync`
// здесь останавливал событийный цикл на всё время логин-шелла (под службой — 1,8 с, замер 30.09.2026).

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { execAsync } from './exec.js'

export const CAPTURE_TIMEOUT_MS = 3000
export const BASE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

/** Имена, значения которых нельзя ни писать в журнал, ни класть в кэш. */
export const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i

export interface CapturedEnv {
  ok: boolean
  shell: string
  vars: Record<string, string>
  /** PATH после чистки: без нераскрытых `~` и без дублей, порядок сохранён. */
  pathEntries: string[]
  droppedTilde: string[]
  droppedDuplicates: string[]
  ms: number
  error?: string
  capturedAt: string
}

export interface SpawnResult {
  status: number | null
  stdout: Buffer | string
  stderr: Buffer | string
  error?: Error
}

export type SpawnFn = (file: string, args: string[], timeoutMs: number) => SpawnResult | Promise<SpawnResult>

const defaultSpawn: SpawnFn = async (file, args, timeoutMs) => {
  const r = await execAsync(file, args, { timeoutMs })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ...(r.error !== undefined ? { error: new Error(r.error) } : {}) }
}

/** Разбор вывода `env -0`: пары NAME=VALUE через NUL. */
export function parseNulEnv(buf: Buffer | string): { vars: Record<string, string>; malformed: number } {
  const text = typeof buf === 'string' ? buf : buf.toString('utf8')
  const vars: Record<string, string> = {}
  let malformed = 0
  for (const rec of text.split('\0')) {
    if (rec === '') continue
    const i = rec.indexOf('=')
    if (i <= 0) { malformed++; continue }
    vars[rec.slice(0, i)] = rec.slice(i + 1)
  }
  return { vars, malformed }
}

/**
 * Нераскрытый `~` в PATH для дочернего процесса не раскрывается никогда (это делает шелл),
 * а дубли удлиняют каждый поиск бинаря. И то и другое выбрасываем, порядок не меняем.
 */
export function sanitizePathEntries(pathValue: string): {
  entries: string[]
  droppedTilde: string[]
  droppedDuplicates: string[]
} {
  const entries: string[] = []
  const droppedTilde: string[] = []
  const droppedDuplicates: string[] = []
  const seen = new Set<string>()
  for (const raw of pathValue.split(':')) {
    const e = raw.trim()
    if (!e) continue
    if (e.startsWith('~')) { droppedTilde.push(e); continue }
    if (seen.has(e)) { droppedDuplicates.push(e); continue }
    seen.add(e)
    entries.push(e)
  }
  return { entries, droppedTilde, droppedDuplicates }
}

export interface CaptureOptions {
  shell?: string
  home?: string
  user?: string
  timeoutMs?: number
  spawn?: SpawnFn
}

export async function captureLoginEnv(opts: CaptureOptions = {}): Promise<CapturedEnv> {
  const shell = opts.shell ?? process.env['SHELL'] ?? '/bin/zsh'
  const home = opts.home ?? homedir()
  const user = opts.user ?? process.env['USER'] ?? ''
  const timeoutMs = opts.timeoutMs ?? CAPTURE_TIMEOUT_MS
  const spawn = opts.spawn ?? defaultSpawn
  const t0 = Date.now()
  const capturedAt = new Date().toISOString()

  const r = await spawn('/usr/bin/env', [
    '-i', `HOME=${home}`, `USER=${user}`, `PATH=${BASE_PATH}`,
    shell, '-ilc', 'env -0',
  ], timeoutMs)

  const ms = Date.now() - t0
  if (r.error || r.status !== 0) {
    const stderr = typeof r.stderr === 'string' ? r.stderr : (r.stderr?.toString('utf8') ?? '')
    return {
      ok: false, shell, vars: {}, pathEntries: [], droppedTilde: [], droppedDuplicates: [], ms,
      error: (r.error?.message ?? stderr).slice(0, 200), capturedAt,
    }
  }

  const { vars } = parseNulEnv(r.stdout)
  const { entries, droppedTilde, droppedDuplicates } = sanitizePathEntries(vars['PATH'] ?? '')
  return { ok: true, shell, vars, pathEntries: entries, droppedTilde, droppedDuplicates, ms, capturedAt }
}

/** Кэш в PULT_HOME/env.json. Секретные ЗНАЧЕНИЯ в кэш не попадают — только имена. */
export interface EnvCacheFile {
  capturedAt: string
  shell: string
  pathEntries: string[]
  /** Имена переменных логин-шелла; значения секретных не сохраняются. */
  names: string[]
  secretNames: string[]
}

export function toCacheFile(env: CapturedEnv): EnvCacheFile {
  const names = Object.keys(env.vars).sort()
  return {
    capturedAt: env.capturedAt,
    shell: env.shell,
    pathEntries: env.pathEntries,
    names: names.filter((n) => !SECRET_NAME_RE.test(n)),
    secretNames: names.filter((n) => SECRET_NAME_RE.test(n)),
  }
}

export function writeEnvCache(file: string, env: CapturedEnv): void {
  writeFileSync(file, JSON.stringify(toCacheFile(env), null, 2) + '\n', { mode: 0o600 })
}

export function readEnvCache(file: string, maxAgeMs?: number): EnvCacheFile | null {
  try {
    const cache = JSON.parse(readFileSync(file, 'utf8')) as EnvCacheFile
    if (!Array.isArray(cache.pathEntries)) return null
    if (maxAgeMs !== undefined) {
      // Сравнение нестрогое: `maxAgeMs = 0` обязан означать «кэш не использовать», а при
      // строгом `>` свежезаписанный кэш возрастом 0 мс проходил бы проверку.
      const age = Date.now() - Date.parse(cache.capturedAt)
      if (!Number.isFinite(age) || age >= maxAgeMs) return null
    }
    return cache
  } catch {
    return null
  }
}

/** PATH из кэша, иначе свежий захват, иначе базовый. Кэш обновляется молча. */
export async function loginShellPath(cacheFile: string, opts: CaptureOptions & { maxAgeMs?: number } = {}): Promise<string[]> {
  const cached = readEnvCache(cacheFile, opts.maxAgeMs ?? 24 * 60 * 60 * 1000)
  if (cached && cached.pathEntries.length) return cached.pathEntries
  const fresh = await captureLoginEnv(opts)
  if (fresh.ok) {
    try { writeEnvCache(cacheFile, fresh) } catch { /* кэш необязателен */ }
    return fresh.pathEntries
  }
  return BASE_PATH.split(':')
}
