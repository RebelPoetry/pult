// Свой node Пульта: официальный node с nodejs.org в `PULT_HOME/runtime/node-v<версия>-<платформа>`,
// версия и sha256 — из `runtime.env` пакета. На нём работают демон (лаунчер службы и спавн) и
// заглушка разрешений; системный node остаётся запасным путём.
//
// ЗАЧЕМ (14.10.2026): демон под launchd жил с 08.10 на `/opt/homebrew/Cellar/node/26.11.0/bin/node`,
// а 12.10 `brew upgrade node` этот бинарь удалил. Процесс живёт дальше (бинарь в памяти), но
// macOS (TCC) не может проверить удалённый бинарь и не пускает его детей в ~/Desktop: каждый ход
// claude там падал за секунду с «An unknown error occurred (Unexpected)», в /tmp — проходил.
// Копия brew-овского node не спасает: он тянет библиотеки из Cellar (abseil, llhttp, …), которые
// brew тоже обновляет. Официальный node самодостаточен, и его меняет только `pult update`.
//
// Правила:
//   * тарбол сверяется с суммой из runtime.env ДО распаковки: суммы приходят в пакете Пульта,
//     а не с того же адреса, что и тарбол;
//   * распаковка — в `<имя>.partial-<pid>`, на место — rename: полуразложенный node node'ом не
//     считается, а убитая посреди установка оставляет только след, который уберёт следующая;
//   * каталог, на котором работает демон, не удаляется: уборка оставляет версии всех пакетов на
//     диске и тот node, на который смотрит указатель;
//   * в тестах (PULT_TEST=1) сеть не трогается никогда — только PULT_TEST_NODE_TARBALL.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { PultPaths } from '../core/paths.js'
import { buildChildEnv } from '../env/allowlist.js'
import { isExecutableFile, readSavedNode } from '../env/nodeBin.js'
import { atomicWrite } from '../service/fsutil.js'
import { OLD_MARK, packageIn, scanVersions } from './versions.js'

export class RuntimeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeError'
  }
}

export const PIN_FILE = 'runtime.env'
export const DEFAULT_MIRROR = 'https://nodejs.org/dist'
/** Метка недоразложенного каталога: `node-v…-<платформа>.partial-<pid>`. */
export const RUNTIME_PARTIAL = '.partial-'
/** Тарбол ~50 МБ; потолок с запасом на медленный канал. */
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
/**
 * Первый запуск свежего node: macOS проверяет бинарь (~120 МБ) перед исполнением — замер 14.10.2026:
 * `node -v` 29 с в первый раз и 0,02 с дальше. С потолком 15 с годный node объявлялся сломанным.
 */
export const FIRST_RUN_TIMEOUT_MS = 3 * 60_000

export type PlatformKey = 'darwin-arm64' | 'darwin-x64' | 'linux-x64' | 'linux-arm64'
const PLATFORM_KEYS: readonly PlatformKey[] = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']

export interface RuntimePin {
  version: string
  sha256: Partial<Record<PlatformKey, string>>
}

/** Имя платформы в именах тарболов nodejs.org; Windows и прочее — null (Пульт их не поддерживает). */
export function platformKey(platform: string = process.platform, arch: string = process.arch): PlatformKey | null {
  const key = `${platform}-${arch}`
  return (PLATFORM_KEYS as readonly string[]).includes(key) ? key as PlatformKey : null
}

export const runtimeName = (version: string, key: PlatformKey): string => `node-v${version}-${key}`

/**
 * `runtime.env`: строки KEY=VALUE, `#` — комментарий. Незнакомые ключи пропускаются (новая
 * платформа в пине не ломает старый CLI), кривые значения — ошибка: тихо поставить не тот node хуже.
 */
export function parsePin(text: string, source = PIN_FILE): RuntimePin {
  let version = ''
  const sha256: RuntimePin['sha256'] = {}
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) throw new RuntimeError(`${source}:${i + 1}: не KEY=VALUE — «${line}»`)
    const k = line.slice(0, eq)
    const v = line.slice(eq + 1)
    if (k === 'PULT_NODE_VERSION') {
      if (!/^\d+\.\d+\.\d+$/.test(v)) throw new RuntimeError(`${source}:${i + 1}: версия node «${v}» — не x.y.z`)
      version = v
      continue
    }
    const m = /^PULT_NODE_SHA256_([A-Z0-9]+)_([A-Z0-9]+)$/.exec(k)
    if (!m) continue
    const key = platformKey((m[1] ?? '').toLowerCase(), (m[2] ?? '').toLowerCase())
    if (!key) continue
    if (!/^[0-9a-f]{64}$/.test(v)) throw new RuntimeError(`${source}:${i + 1}: sha256 для ${key} — не 64 hex-символа`)
    sha256[key] = v
  }
  if (!version) throw new RuntimeError(`${source}: нет PULT_NODE_VERSION`)
  return { version, sha256 }
}

/** Пин из корня пакета; файла нет (версия старше 0.2.18) — null. */
export function readPin(pkgRoot: string): RuntimePin | null {
  const file = join(pkgRoot, PIN_FILE)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  return parsePin(text, file)
}

/** `node -v` бинаря или null. Окружение — по белому списку: чужой NODE_OPTIONS сюда не попадает. */
export function nodeVersionOf(node: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = 60_000): string | null {
  const r = spawnSync(node, ['-v'], { encoding: 'utf8', timeout: timeoutMs, env: buildChildEnv(env) })
  if (r.error || r.status !== 0) return null
  return (r.stdout ?? '').trim() || null
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Адрес зеркала: PULT_NODE_MIRROR (только https — тарбол дальше исполняется) или nodejs.org. */
export function mirrorOf(env: NodeJS.ProcessEnv): string {
  const m = (env['PULT_NODE_MIRROR'] ?? '').trim().replace(/\/+$/, '')
  if (!m) return DEFAULT_MIRROR
  if (!m.startsWith('https://')) throw new RuntimeError(`PULT_NODE_MIRROR=${m}: только https — node по нему можно подменить по дороге`)
  return m
}

/**
 * Прокси человека для curl. Белый список окружения (инвариант 1) защищает агентов от чужих
 * ANTHROPIC_* и подобного; здесь качается node, и идти он обязан тем путём, который человек задал.
 */
export function proxyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']) {
    const v = env[k]
    if (v) out[k] = v
  }
  return out
}

function fetchTarball(url: string, dest: string, env: NodeJS.ProcessEnv): void {
  // И окружение вызова, и своё: тест, передавший `env: {}`, всё равно не уходит в сеть.
  if (env['PULT_TEST'] === '1' || process.env['PULT_TEST'] === '1') {
    const fake = env['PULT_TEST_NODE_TARBALL']
    if (!fake) throw new RuntimeError('PULT_TEST=1: сеть в тестах не трогается — нужен PULT_TEST_NODE_TARBALL')
    copyFileSync(fake, dest)
    return
  }
  // `--proto '=https'` — как в install.sh: ни адрес, ни редирект не уводят на http. `-q` первым:
  // ~/.curlrc человека (прокси без https, --insecure) сюда не подмешивается.
  const r = spawnSync('curl', ['-q', '--proto', '=https', '--tlsv1.2', '-fsSL', '--retry', '2', '--connect-timeout', '20', '-o', dest, url], {
    encoding: 'utf8',
    timeout: DOWNLOAD_TIMEOUT_MS,
    env: buildChildEnv(env, { path: `${env['PATH'] ?? ''}:/usr/bin:/bin`, extra: proxyEnv(env) }),
  })
  if (r.error || r.status !== 0) {
    const why = (r.stderr || r.error?.message || `код ${r.status}`).trim().split('\n')[0] ?? ''
    throw new RuntimeError(`не скачался ${url}: ${why}`)
  }
}

function extract(tgz: string, into: string, env: NodeJS.ProcessEnv): void {
  const r = spawnSync('tar', ['-xzf', tgz, '-C', into], {
    encoding: 'utf8',
    timeout: 5 * 60_000,
    env: buildChildEnv(env, { path: `${env['PATH'] ?? ''}:/usr/bin:/bin` }),
  })
  if (r.error || r.status !== 0) {
    const why = (r.stderr || r.error?.message || `код ${r.status}`).trim().split('\n')[0] ?? ''
    throw new RuntimeError(`${tgz} не распаковался: ${why}`)
  }
}

function prepareRuntimeDir(paths: PultPaths): void {
  mkdirSync(paths.runtime, { recursive: true, mode: 0o700 })
  chmodSync(paths.runtime, 0o700)
}

/** Указатель `runtime/active` как есть (даже на мёртвый путь) — чтобы откат вернул его точно. */
export const readActivePointer = (paths: PultPaths): string | null => readSavedNode(paths.runtimeActive)

export function writeActivePointer(paths: PultPaths, node: string | null): void {
  if (node === null) {
    try { unlinkSync(paths.runtimeActive) } catch { /* уже нет */ }
    return
  }
  prepareRuntimeDir(paths)
  atomicWrite(paths.runtimeActive, `${node}\n`, 0o600)
}

export interface EnsureOptions {
  env?: NodeJS.ProcessEnv
  platform?: string
  arch?: string
  /** Локальный тарбол node вместо скачивания. Сумма сверяется всё равно. */
  from?: string
  progress?: (s: string) => void
}

export interface EnsureResult {
  node: string
  name: string
  version: string
  /** false — этот node уже лежал на диске, только указатель переставлен. */
  fetched: boolean
}

/**
 * Свой node версии из пина: уже лежит — только указатель; иначе тарбол (зеркало или `from`) →
 * сумма → распаковка в .partial → проверка `node -v` → rename → указатель. Любой провал —
 * RuntimeError, а указатель и разложенные версии остаются как были.
 *
 * Уже лежащий node НЕ запускается для проверки: каталог с его именем появляется только rename-ом
 * после проверки версии, а запуск ради неё мог занять полминуты (первый запуск на macOS) и по
 * таймауту отправить на переустановку каталог, из которого прямо сейчас работает демон.
 */
export function ensureRuntime(paths: PultPaths, pin: RuntimePin, opts: EnsureOptions = {}): EnsureResult {
  const env = opts.env ?? process.env
  const plat = opts.platform ?? process.platform
  const arch = opts.arch ?? process.arch
  const key = platformKey(plat, arch)
  if (!key) throw new RuntimeError(`своего node под ${plat}-${arch} нет — демон работает на системном node`)
  const sha = pin.sha256[key]
  if (!sha) throw new RuntimeError(`в ${PIN_FILE} нет суммы для ${key} — свой node не ставлю`)
  const name = runtimeName(pin.version, key)
  const dir = join(paths.runtime, name)
  const node = join(dir, 'bin', 'node')
  const want = `v${pin.version}`
  prepareRuntimeDir(paths)

  if (isExecutableFile(node)) {
    writeActivePointer(paths, node)
    return { node, name, version: pin.version, fetched: false }
  }

  const work = join(paths.runtime, `${name}${RUNTIME_PARTIAL}${process.pid}`)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { mode: 0o700 })
  try {
    let tgz: string
    let source: string
    if (opts.from) {
      tgz = resolve(opts.from)
      source = tgz
      if (!existsSync(tgz)) throw new RuntimeError(`нет файла ${tgz}`)
    } else {
      source = `${mirrorOf(env)}/v${pin.version}/${name}.tar.gz`
      tgz = join(work, `${name}.tar.gz`)
      opts.progress?.(`скачиваю ${source}`)
      fetchTarball(source, tgz, env)
    }
    const got = sha256File(tgz)
    if (got !== sha) throw new RuntimeError(`${source}: sha256 ${got} не совпадает с ${PIN_FILE} (${sha}) — тарбол битый или подменён, не ставлю`)
    const x = join(work, 'x')
    mkdirSync(x)
    extract(tgz, x, env)
    const extracted = join(x, name)
    const xnode = join(extracted, 'bin', 'node')
    opts.progress?.('проверяю node: первый запуск свежего бинаря macOS проверяет до минуты')
    const said = isExecutableFile(xnode) ? nodeVersionOf(xnode, env, FIRST_RUN_TIMEOUT_MS) : null
    if (said !== want) throw new RuntimeError(`в ${source} нет ${name}/bin/node ${want} (ответил: ${said ?? 'ничего'})`)
    // Заголовки C (include/, ~64 МБ из ~200) нужны только сборке нативных модулей, а у Пульта их
    // ноль; share/ — man-страницы. bin/ и lib/ (npm рядом с node — его ищет findNpm) остаются.
    for (const extra of ['include', 'share']) rmSync(join(extracted, extra), { recursive: true, force: true })
    if (existsSync(dir)) {
      // Каталог есть, а исполняемого node в нём нет (разобран руками и т.п.) — значит, и демон на
      // нём не живёт. rename не заменяет непустой каталог: отодвигаем и удаляем после подмены.
      const old = `${dir}${OLD_MARK}${process.pid}`
      renameSync(dir, old)
      renameSync(extracted, dir)
      rmSync(old, { recursive: true, force: true })
    } else {
      renameSync(extracted, dir)
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  writeActivePointer(paths, node)
  return { node, name, version: pin.version, fetched: true }
}

/** Имя каталога своего node, на который смотрит указатель, или null (системный / чужой путь). */
function activeName(paths: PultPaths): string | null {
  const p = readActivePointer(paths)
  if (!p) return null
  const rel = relative(paths.runtime, p)
  if (!rel || rel.startsWith('..') || rel.startsWith(sep)) return null
  return rel.split(sep)[0] ?? null
}

/** Свои node, которые нужны пакетам на диске (current, previous, запасные), — их уборка не трогает. */
export function pinnedRuntimes(paths: PultPaths, platform: string = process.platform, arch: string = process.arch): Set<string> {
  const keep = new Set<string>()
  const key = platformKey(platform, arch)
  if (!key) return keep
  for (const v of scanVersions(paths).versions) {
    const pkg = packageIn(v.dir)
    if (!pkg) continue
    try {
      const pin = readPin(pkg.root)
      if (pin) keep.add(runtimeName(pin.version, key))
    } catch { /* кривой пин чужой версии — её node просто не держим */ }
  }
  return keep
}

/**
 * Уборка `runtime/`: всё `node-v*`, чего нет в `keep` и на что не смотрит указатель, — включая
 * следы прерванных установок. Вызывать под run/update.lock: чужая распаковка в этот миг невозможна.
 */
export function pruneRuntimes(paths: PultPaths, keep: Set<string>): string[] {
  let names: string[]
  try { names = readdirSync(paths.runtime) } catch { return [] }
  const active = activeName(paths)
  const removed: string[] = []
  for (const n of names) {
    if (!n.startsWith('node-v') || keep.has(n) || n === active) continue
    rmSync(join(paths.runtime, n), { recursive: true, force: true })
    removed.push(n)
  }
  return removed
}

export interface RuntimeReport {
  platform: string
  key: PlatformKey | null
  /** Версия из пина пакета, которым смотрят; null — пина нет. */
  pinned: string | null
  /** Указатель как есть и его `node -v` (null — не отвечает). */
  active: string | null
  activeVersion: string | null
  installed: string[]
}

export function runtimeReport(paths: PultPaths, pin: RuntimePin | null, env: NodeJS.ProcessEnv = process.env): RuntimeReport {
  const active = readActivePointer(paths)
  let installed: string[] = []
  try { installed = readdirSync(paths.runtime).filter((n) => n.startsWith('node-v') && !n.includes(RUNTIME_PARTIAL) && !n.includes(OLD_MARK)).sort() } catch { /* каталога нет */ }
  return {
    platform: `${process.platform}-${process.arch}`,
    key: platformKey(),
    pinned: pin?.version ?? null,
    active,
    activeVersion: active && isExecutableFile(active) ? nodeVersionOf(active, env) : null,
    installed,
  }
}
