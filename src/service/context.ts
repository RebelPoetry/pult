// Контекст службы: платформа, имя, где лежит файл службы и какими бинарями ею управлять.
// Единственное место, где читаются швы для тестов (docs/08 §2) — так правило «в бою швы
// игнорируются» проверяется чтением одного файла.
//
// ШВЫ (только при PULT_TEST=1, в бою игнорируются, как PULT_TEST_NET в В3):
//   PULT_SERVICE_PLATFORM  darwin|linux — какую службу рисовать и чем грузить;
//   PULT_LAUNCHCTL / PULT_SYSTEMCTL / PULT_LOGINCTL — путь к фальшивому бинарю;
//   PULT_SERVICE_DIR — куда класть файл службы.
// PULT_SERVICE_NAME разрешён и в бою: второй PULT_HOME и приёмка лида не должны задевать
// будущую настоящую службу.
//
// ЗАПРЕТ В ТЕСТАХ: при PULT_TEST=1 без фальшивого бинаря настоящий launchctl/systemctl НЕ
// вызывается никогда — бинарь `null`, и любой вызов менеджера служб падает с внятной ошибкой.
// Без PULT_SERVICE_DIR файла службы в тесте просто нет (`file: null`): иначе любой тест с
// PULT_TEST=1 смотрел бы в настоящий ~/Library/LaunchAgents, а install писал бы туда.

import { homedir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import type { PultPaths } from '../core/paths.js'

export type ServicePlatform = 'darwin' | 'linux'

export const DEFAULT_LABEL = 'dev.pult.daemon'
export const DEFAULT_UNIT = 'pultd.service'

/** Боевые пути бинарей — абсолютные, не из PATH: PATH службы и CLI бывает любым. */
export const SYSTEM_BINS = {
  launchctl: '/bin/launchctl',
  systemctl: '/usr/bin/systemctl',
  loginctl: '/usr/bin/loginctl',
} as const

export interface ServiceContext {
  platform: ServicePlatform
  /** Метка launchd (`dev.pult.daemon`) или имя юнита systemd (`pultd.service`). */
  name: string
  /** Каталог файла службы; `null` — в тесте без PULT_SERVICE_DIR. */
  dir: string | null
  /** Полный путь к plist/юниту; `null` — см. `dir`. */
  file: string | null
  /** Бинари менеджера служб; `null` — в тесте без фальшивки (вызов запрещён). */
  launchctl: string | null
  systemctl: string | null
  loginctl: string | null
  uid: number
  user: string
  /** Домашний каталог пользователя (для PATH службы и WorkingDirectory). */
  home: string
  paths: PultPaths
  test: boolean
  /** Окружение, с которым запускаются бинари менеджера служб (то же, что получил CLI). */
  env: NodeJS.ProcessEnv
}

export class ServiceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ServiceError'
  }
}

/** Имя службы идёт в путь файла и в аргументы launchctl — только безопасные символы. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function platformOf(env: NodeJS.ProcessEnv): ServicePlatform {
  const test = env['PULT_TEST'] === '1'
  const forced = test ? env['PULT_SERVICE_PLATFORM'] : undefined
  const p = forced && forced.trim() ? forced.trim() : process.platform
  if (p === 'darwin' || p === 'linux') return p
  throw new ServiceError(`служба на платформе «${p}» не поддерживается: есть только macOS (launchd) и Linux (systemd --user)`)
}

export function serviceName(platform: ServicePlatform, env: NodeJS.ProcessEnv): string {
  const raw = (env['PULT_SERVICE_NAME'] ?? '').trim()
  if (!raw) return platform === 'darwin' ? DEFAULT_LABEL : DEFAULT_UNIT
  if (!NAME_RE.test(raw)) {
    throw new ServiceError(`PULT_SERVICE_NAME «${raw}»: допустимы только латиница, цифры, точка, _ и -`)
  }
  if (platform === 'linux') return raw.endsWith('.service') ? raw : `${raw}.service`
  return raw
}

function defaultDir(platform: ServicePlatform, home: string, env: NodeJS.ProcessEnv): string {
  if (platform === 'darwin') return join(home, 'Library', 'LaunchAgents')
  // systemd --user ищет пользовательские юниты в $XDG_CONFIG_HOME/systemd/user.
  const xdg = (env['XDG_CONFIG_HOME'] ?? '').trim()
  return join(xdg ? resolve(xdg) : join(home, '.config'), 'systemd', 'user')
}

export function serviceContext(paths: PultPaths, env: NodeJS.ProcessEnv = process.env): ServiceContext {
  const test = env['PULT_TEST'] === '1'
  const platform = platformOf(env)
  const name = serviceName(platform, env)
  // HOME из переданного окружения, а не только из process.env: тесты гоняют install в своём
  // процессе с временным HOME, и PATH службы/WorkingDirectory не должны указывать в настоящий дом.
  const home = (env['HOME'] ?? '').trim() || homedir()
  const seam = (key: string): string | undefined => {
    if (!test) return undefined
    const v = (env[key] ?? '').trim()
    return v ? resolve(v) : undefined
  }
  const dir = test ? (seam('PULT_SERVICE_DIR') ?? null) : defaultDir(platform, home, env)
  const fileName = platform === 'darwin' ? `${name}.plist` : name
  const bin = (key: string, real: string): string | null => (test ? (seam(key) ?? null) : real)
  let user = env['USER'] ?? ''
  try { user = userInfo().username } catch { /* остаётся USER */ }
  return {
    platform,
    name,
    dir,
    file: dir ? join(dir, fileName) : null,
    launchctl: bin('PULT_LAUNCHCTL', SYSTEM_BINS.launchctl),
    systemctl: bin('PULT_SYSTEMCTL', SYSTEM_BINS.systemctl),
    loginctl: bin('PULT_LOGINCTL', SYSTEM_BINS.loginctl),
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    user,
    home,
    paths,
    test,
    env,
  }
}

/** `gui/<uid>` — домен пользовательских агентов launchd. */
export const guiDomain = (ctx: ServiceContext): string => `gui/${ctx.uid}`
/** `gui/<uid>/<label>` — цель для bootout/kickstart/print. */
export const guiTarget = (ctx: ServiceContext): string => `gui/${ctx.uid}/${ctx.name}`
