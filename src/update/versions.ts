// Версии на диске и их учёт: `versions/<v>`, симлинк `current`, файл `update.json` (docs/08 §1, §4).
//
// ИСТОЧНИК ИСТИНЫ об активной версии — симлинк `current`, а не `update.json`: его читают лаунчер
// службы и `pult daemon install`, и его же меняет `pult daemon install --dev` в обход update.
// `update.json` помнит то, чего по диску не восстановить: previous, пометки bad, время установки
// и последнюю попытку.
//
// Имя версии попадает в путь (`versions/<v>`), поэтому принимается только строгий semver:
// тарбол с версией `../../etc` не должен распаковаться мимо PULT_HOME.

import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { PultPaths } from '../core/paths.js'
import { compareVersions } from '../core/semver.js'
import { atomicWrite } from '../service/fsutil.js'

/** semver 2.0 без ведущих нулей не требуем — нам важно одно: безопасное имя каталога. */
const VERSION_RE = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function isVersionName(v: string): boolean {
  return VERSION_RE.test(v) && !v.endsWith('.partial')
}

/** Суффикс незаконченной установки: такой каталог версией НЕ считается никогда. */
export const PARTIAL_SUFFIX = '.partial'
/**
 * Метка версии, которую отодвинули при `--reinstall`: удаляется сразу после подмены. `~` в semver
 * запрещён, поэтому метку не спутать с пререлизом вроде `1.0.0-rc.old-1`.
 */
export const OLD_MARK = '~old-'

/** Сравнение semver живёт в core/semver.ts: им же пользуется окно (ui/), а там нет node:fs. */
export { compareVersions }

export interface PackageInfo {
  /** Корень пакета (там package.json, dist/, service/). */
  root: string
  version: string
  layout: 'installed' | 'dev'
}

/**
 * Пакет pult внутри каталога версии. Две раскладки, как у лаунчера (docs/08 §2): установленная
 * npm (`<dir>/lib/node_modules/pult`) и рабочая копия (`<dir>` = корень пакета, `install --dev`).
 */
export function packageIn(dir: string): PackageInfo | null {
  const candidates: Array<[string, PackageInfo['layout']]> = [
    [join(dir, 'lib', 'node_modules', 'pult'), 'installed'],
    [dir, 'dev'],
  ]
  for (const [root, layout] of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string; version?: string }
      if (pkg.name === 'pult' && typeof pkg.version === 'string') return { root, version: pkg.version, layout }
    } catch { /* следующая раскладка */ }
  }
  return null
}

/**
 * Точка входа демона в каталоге версии — тот же порядок, что у лаунчера службы: установленная
 * раскладка, иначе рабочая копия. Путь идёт ЧЕРЕЗ переданный каталог (обычно `current`), а не
 * через realpath: ровно этот файл запустит и служба.
 */
export function daemonEntryIn(dir: string): string {
  const installed = join(dir, 'lib', 'node_modules', 'pult', 'dist', 'daemon', 'main.js')
  return existsSync(installed) ? installed : join(dir, 'dist', 'daemon', 'main.js')
}

/** Имя активной версии: последний компонент цели `current`; `null` — симлинка нет. */
export function currentName(paths: PultPaths): string | null {
  try {
    if (!lstatSync(paths.current).isSymbolicLink()) return null
    return basename(readlinkSync(paths.current))
  } catch {
    return null
  }
}

/** `current` есть, но указывает в пустоту (версию удалили руками, каталог переехал). */
export function currentDangling(paths: PultPaths): boolean {
  return currentName(paths) !== null && !existsSync(paths.current)
}

export interface UpdateAttempt {
  at: string
  /** `from` — установка из тарбола, `to` — переключение на стоящую версию, `channel` — из latest.json (M8c). */
  action: 'from' | 'to' | 'channel'
  version: string
  /** Что было активно до попытки. */
  was: string | null
  result: 'ok' | 'already' | 'rolled_back' | 'failed'
  message?: string
  /** Файл с выводом попытки (запуск из окна); нет — вывод был в терминале. */
  log?: string
}

export interface UpdateState {
  current: string | null
  previous: string | null
  bad: string[]
  /** Время установки каждой версии — по нему «ещё одна последняя» при уборке. */
  installed: Record<string, string>
  last: UpdateAttempt | null
  /**
   * Указатель своего node (runtime/active) ДО идущего обновления — пишется вместе с отметкой «проба
   * идёт» и снимается её итогом. Перепроверка прерванной пробы берёт его отсюда: с диска к этому
   * моменту читается уже указатель новой версии, и откат «вернул» бы его же. null — указателя не было.
   */
  runtimeBefore?: string | null
}

const emptyState = (): UpdateState => ({ current: null, previous: null, bad: [], installed: {}, last: null })

/** Отметка в update.json, которую switchAndProbe пишет ДО переключения `current` и снимает итогом пробы. */
export const PROBE_PENDING = 'проба идёт (прервана?)'

/**
 * `current` указывает на версию, чья проба не дошла до конца: `pult update`, убитый между
 * переключением `current` и итогом пробы (Ctrl-C, закрытый терминал, OOM), оставляет ровно эту
 * отметку. Версия ни разу не подтвердила, что работает, — считать её «стоящей» нельзя.
 */
export function probeInterrupted(st: UpdateState, current: string | null): boolean {
  return current !== null && st.current === current && st.last !== null && st.last.result === 'failed'
    && st.last.version === current && st.last.message === PROBE_PENDING
}

/**
 * Битый или чужой `update.json` не должен ломать обновление: худшее, что теряется, —
 * previous и пометки bad, а их человек увидит в `--list` пустыми и поймёт.
 */
export function readState(paths: PultPaths): UpdateState {
  let raw: unknown
  try { raw = JSON.parse(readFileSync(paths.updateState, 'utf8')) } catch { return emptyState() }
  if (!raw || typeof raw !== 'object') return emptyState()
  const o = raw as Record<string, unknown>
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
  const installed: Record<string, string> = {}
  if (o['installed'] && typeof o['installed'] === 'object') {
    for (const [k, v] of Object.entries(o['installed'] as Record<string, unknown>)) if (typeof v === 'string') installed[k] = v
  }
  return {
    current: str(o['current']),
    previous: str(o['previous']),
    bad: Array.isArray(o['bad']) ? (o['bad'] as unknown[]).filter((b): b is string => typeof b === 'string') : [],
    installed,
    last: o['last'] && typeof o['last'] === 'object' ? (o['last'] as UpdateAttempt) : null,
    ...('runtimeBefore' in o && (o['runtimeBefore'] === null || typeof o['runtimeBefore'] === 'string')
      ? { runtimeBefore: o['runtimeBefore'] as string | null }
      : {}),
  }
}

export function writeState(paths: PultPaths, st: UpdateState): void {
  // tmp + fsync + rename: `update.json`, прочитанный пополам, превратил бы previous в null
  // ровно в тот момент, когда он нужен для отката.
  atomicWrite(paths.updateState, JSON.stringify(st, null, 2) + '\n', 0o600)
}

export interface VersionEntry {
  name: string
  dir: string
  /** Каталог — симлинк на рабочую копию (`install --dev`). */
  dev: boolean
  /** Куда указывает dev-симлинк. */
  target?: string
  /** Пакет внутри найден и версия прочитана. */
  valid: boolean
  version: string | null
}

export interface DiskVersions {
  versions: VersionEntry[]
  /** `<v>.partial` и `<v>~old-*` — следы прерванных установок. */
  leftovers: string[]
}

export function scanVersions(paths: PultPaths): DiskVersions {
  const versions: VersionEntry[] = []
  const leftovers: string[] = []
  let names: string[] = []
  try { names = readdirSync(paths.versions) } catch { return { versions, leftovers } }
  for (const name of names) {
    const dir = join(paths.versions, name)
    if (name.endsWith(PARTIAL_SUFFIX) || name.includes(OLD_MARK)) { leftovers.push(name); continue }
    let dev = false
    let target: string | undefined
    try {
      const st = lstatSync(dir)
      if (st.isSymbolicLink()) { dev = true; target = resolve(paths.versions, readlinkSync(dir)) }
      else if (!st.isDirectory()) continue
    } catch { continue }
    const pkg = packageIn(dir)
    versions.push({ name, dir, dev, ...(target !== undefined ? { target } : {}), valid: pkg !== null, version: pkg?.version ?? null })
  }
  versions.sort((a, b) => compareVersions(b.name.replace(/-dev$/, ''), a.name.replace(/-dev$/, '')) || (a.name < b.name ? -1 : 1))
  return { versions, leftovers }
}

/** Удалить каталог версии. Dev-симлинк снимается как ссылка: рабочую копию НЕ трогаем никогда. */
export function removeVersionDir(dir: string): void {
  try {
    if (lstatSync(dir).isSymbolicLink()) { unlinkSync(dir); return }
  } catch { return }
  rmSync(dir, { recursive: true, force: true })
}

/**
 * Следы прерванных установок: `.partial` (установка убита посреди npm) и `~old-*` (убита посреди
 * `--reinstall`). Зовётся ТОЛЬКО под `run/update.lock` — без него можно снести каталог, в который
 * соседний `pult update` пишет прямо сейчас.
 */
export function cleanLeftovers(paths: PultPaths): string[] {
  const { leftovers } = scanVersions(paths)
  for (const name of leftovers) removeVersionDir(join(paths.versions, name))
  return leftovers
}

export function installedAt(paths: PultPaths, st: UpdateState, name: string): number {
  const t = st.installed[name]
  if (t) {
    const ms = Date.parse(t)
    if (Number.isFinite(ms)) return ms
  }
  try { return statSync(join(paths.versions, name)).mtimeMs } catch { return 0 }
}

export const KEEP_EXTRA = 1

/**
 * Хранение после УДАЧНОГО обновления (docs/08 §4): остаются current, previous и ещё одна
 * последняя по времени установки; bad удаляются первыми, то есть запасное место достаётся
 * исправной версии, а bad — только если исправных кандидатов нет. current и previous не
 * удаляются никогда, даже помеченные bad. Dev-симлинки в счёт не идут и не удаляются: это
 * рабочая копия человека, а не установленная версия.
 */
export function pruneVersions(paths: PultPaths, st: UpdateState): string[] {
  const keep = new Set([currentName(paths), st.previous].filter((v): v is string => !!v))
  const candidates = scanVersions(paths).versions.filter((v) => !v.dev && !keep.has(v.name))
  const bad = new Set(st.bad)
  candidates.sort((a, b) => {
    const ba = bad.has(a.name) ? 1 : 0
    const bb = bad.has(b.name) ? 1 : 0
    if (ba !== bb) return ba - bb
    return installedAt(paths, st, b.name) - installedAt(paths, st, a.name)
  })
  const removed: string[] = []
  for (const v of candidates.slice(KEEP_EXTRA)) {
    removeVersionDir(v.dir)
    removed.push(v.name)
    delete st.installed[v.name]
  }
  st.bad = st.bad.filter((b) => !removed.includes(b))
  return removed
}
