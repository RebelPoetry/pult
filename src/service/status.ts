// Состояние службы для `pult daemon status`, `pult doctor` и `ensureDaemon`.
//
// «Установлена» — это не просто «файл есть»: файл службы один на пользователя (метка/юнит), а
// PULT_HOME бывает много (тесты, второй дом, приёмка лида). Служба считается НАШЕЙ, только если
// PULT_HOME в её файле совпадает с нашим; чужую CLI не запускает, не перезаписывает и не снимает.

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { PultPaths } from '../core/paths.js'
import { isExecutableFile } from '../env/nodeBin.js'
import type { ServiceContext } from './context.js'
import { serviceContext } from './context.js'
import type { ManagerState } from './manager.js'
import { formatLastExit, queryState } from './manager.js'
import { LAUNCHD_PROCESS_TYPE, plistProcessType, serviceHomeOf, serviceLauncherOf } from './render.js'

export interface ServiceReport {
  platform: string
  name: string
  file: string | null
  /** Файл службы существует. */
  installed: boolean
  /** PULT_HOME в файле службы; `null` — файла нет или ключ не найден. */
  fileHome: string | null
  /** Файл службы обслуживает НАШ PULT_HOME. */
  ours: boolean
  /** Лаунчер, на который указывает файл службы. */
  launcher: string | null
  /** Чем файл службы отстал от шаблона этой версии (см. ServiceFileInfo.stale); `null` — не отстал. */
  stale: string | null
  /** Этот лаунчер существует и исполняем. */
  launcherOk: boolean
  /** Ответ менеджера служб; `null` — не спрашивали (службы нет или она чужая). */
  manager: ManagerState | null
  /** Почему состояние не выяснено (не та платформа, менеджер недоступен). */
  error?: string
}

export const isExecutable = isExecutableFile

export interface ServiceFileInfo {
  installed: boolean
  fileHome: string | null
  ours: boolean
  launcher: string | null
  /**
   * Чем файл службы отстал от того, что записал бы `pult daemon install` этой версии. Файл службы
   * `pult update` не переписывает (инвариант 8: только по явной команде), поэтому правка шаблона
   * доходит до установленной службы лишь повторным install — и человеку надо об этом сказать.
   */
  stale: string | null
}

/** Команда, которая возвращает демона под службу: пишет файл заново, грузит и проверяет ответ. */
export const REINSTALL_CMD = 'pult daemon install'

function staleReason(ctx: ServiceContext, content: string): string | null {
  if (ctx.platform !== 'darwin') return null
  const type = plistProcessType(content)
  if (type === 'Background') {
    return `ProcessType ${type}: демон и всё, что он запускает (claude, codex, git), идут с фоновым приоритетом — `
      + `в разы медленнее; нужен ${LAUNCHD_PROCESS_TYPE}`
  }
  return null
}

/**
 * Один ли это каталог. Сравнение по realpath: `/var/…` и `/private/var/…` на macOS, симлинк
 * `~/.pult` на другой диск — один дом. Иначе своя служба выглядела бы чужой, CLI поднимал бы
 * демона в обход неё, и служебный экземпляр уходил бы в петлю кода 3.
 */
export function sameDir(a: string, b: string): boolean {
  const real = (p: string): string => { try { return realpathSync(p) } catch { return resolve(p) } }
  return resolve(a) === resolve(b) || real(a) === real(b)
}

export function readServiceFile(ctx: ServiceContext): ServiceFileInfo {
  if (!ctx.file || !existsSync(ctx.file)) return { installed: false, fileHome: null, ours: false, launcher: null, stale: null }
  let content = ''
  try { content = readFileSync(ctx.file, 'utf8') } catch { /* нечитаемый — считаем чужим */ }
  const fileHome = serviceHomeOf(ctx.platform, content)
  return {
    installed: true,
    fileHome,
    ours: fileHome !== null && sameDir(fileHome, ctx.paths.home),
    launcher: serviceLauncherOf(ctx.platform, content),
    stale: staleReason(ctx, content),
  }
}

/**
 * Установлена ли служба ДЛЯ ЭТОГО PULT_HOME. Никогда не бросает: на неподдерживаемой платформе
 * и в тесте без PULT_SERVICE_DIR ответ — «нет», и CLI идёт старым путём (отсоединённый спавн).
 */
export function ownServiceContext(paths: PultPaths, env: NodeJS.ProcessEnv): ServiceContext | null {
  let ctx: ServiceContext
  try { ctx = serviceContext(paths, env) } catch { return null }
  return readServiceFile(ctx).ours ? ctx : null
}

export function serviceReport(paths: PultPaths, env: NodeJS.ProcessEnv, opts: { query?: boolean } = {}): ServiceReport {
  let ctx: ServiceContext
  try {
    ctx = serviceContext(paths, env)
  } catch (e) {
    return {
      platform: process.platform, name: '', file: null, installed: false, fileHome: null, ours: false,
      launcher: null, stale: null, launcherOk: false, manager: null, error: (e as Error).message,
    }
  }
  const f = readServiceFile(ctx)
  const report: ServiceReport = {
    platform: ctx.platform,
    name: ctx.name,
    file: ctx.file,
    ...f,
    launcherOk: f.launcher !== null && isExecutable(f.launcher),
    manager: null,
  }
  if (f.ours && opts.query !== false) {
    try {
      report.manager = queryState(ctx)
      if (report.manager.error) report.error = report.manager.error
    } catch (e) {
      report.error = (e as Error).message
    }
  }
  return report
}

/** Одна строка для `pult daemon status`. */
export function formatServiceLine(r: ServiceReport): string {
  if (r.error && !r.installed) return `служба: состояние неизвестно — ${r.error}`
  if (!r.installed) return 'служба: не установлена (демон поднимается по требованию; поставить — pult daemon install)'
  if (!r.ours) {
    return `служба: ${r.file} обслуживает другой PULT_HOME (${r.fileHome ?? 'не указан'}) — к этому дому не относится`
  }
  const parts = [`служба: установлена (${r.file})`]
  parts.push(r.launcherOk ? `лаунчер ${r.launcher}` : `лаунчер НЕ НАЙДЕН: ${r.launcher ?? 'не указан'} — pult daemon install`)
  const m = r.manager
  if (!m) {
    parts.push(`менеджер служб: ${r.error ?? 'не спрашивали'}`)
  } else if (!m.loaded) {
    parts.push(m.error ? `менеджер служб: ${m.error}` : `не загружена (загрузить: ${REINSTALL_CMD})`)
  } else {
    parts.push('загружена')
    parts.push(m.pid !== null ? `pid ${m.pid}` : `не запущена${m.state ? ` (${m.state})` : ''}`)
    parts.push(`последний выход: ${formatLastExit(m)}`)
  }
  return parts.join(' · ')
}

/**
 * Демон поднят В ОБХОД установленной службы (менеджер служб отказал, и CLI запустил демона сам).
 * Работать это не мешает, но человек должен узнать об этом сразу и одной командой вернуть службу,
 * а не найти через неделю в `pult daemon status` строку «не загружена». КАК ЛОМАЛОСЬ (30.09.2026):
 * `pult update` после «Bootstrap failed: 5» печатал «pult обновлён» и оставлял службу снятой;
 * `pult daemon start` после этого тоже шёл в обход — вылечил только ручной `launchctl bootstrap`.
 */
export function bypassNotice(ctx: ServiceContext): string[] {
  let loaded: boolean | null = null
  try {
    const m = queryState(ctx)
    loaded = m.error ? null : m.loaded
  } catch { /* менеджер служб не ответил — скажем без подробностей */ }
  const direct = 'демон поднят напрямую (режим on-demand)'
  const what = loaded === false
    ? `служба ${ctx.name} осталась НЕ ЗАГРУЖЕННОЙ: ${direct}, менеджер служб его не держит и после падения не поднимет`
    : `${direct}, в обход службы ${ctx.name}${loaded === true ? ': служба загружена, но lock держит не её процесс' : ''}`
  return [
    `ВНИМАНИЕ: ${what}.`,
    `  вернуть службу: ${REINSTALL_CMD}   # остановит этого демона, загрузит службу и проверит, что демон отвечает из-под неё`,
  ]
}
