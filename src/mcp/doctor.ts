// Пункты доктора О3: браузер агента (Playwright MCP и Chrome) и свои MCP-серверы владельца.
// Браузер — необязательная часть: пока ни одна сессия его не просит, «не поставлен» и «нет Chrome» — не
// предупреждение, а справка. Желтеет, когда браузер включён хоть у одной сессии, а работать ему нечем.

import type { DoctorItem } from '../env/doctor.js'
import type { PultPaths } from '../core/paths.js'
import type { DaemonBrowser } from '../core/rpc.js'
import type { InstallState } from './browser.js'
import { browserInstalled, browserPrefix, PLAYWRIGHT_MCP_PACKAGE, PLAYWRIGHT_MCP_VERSION } from './browser.js'
import { readServersFile } from './servers.js'

export interface BrowserDoctorInput {
  paths: PultPaths
  /** Состояние установки у демона; у CLI без демона — по диску. */
  state?: InstallState
  /** Сколько сессий с включённым браузером (null — неизвестно: демон не ответил). */
  wanted: number | null
  chrome: string | null
}

/** Состояние установки из `daemon.status.browser` (CLI спрашивает демона, если он жив). */
export function installStateOf(b: DaemonBrowser): InstallState {
  switch (b.state) {
    case 'installing': return { state: 'installing', since: 'идёт сейчас' }
    case 'installed': return { state: 'installed' }
    case 'failed': return { state: 'failed', at: '', error: b.error ?? 'причина не сообщена' }
    default: return { state: 'missing' }
  }
}

export function browserDoctorItems(i: BrowserDoctorInput): DoctorItem[] {
  const st: InstallState = i.state ?? (browserInstalled(i.paths) ? { state: 'installed' } : { state: 'missing' })
  const want = (i.wanted ?? 0) > 0
  const pkg = `${PLAYWRIGHT_MCP_PACKAGE} ${PLAYWRIGHT_MCP_VERSION}`
  const mcp: DoctorItem = st.state === 'installed'
    ? { id: 'browser.mcp', title: 'Браузер агента', status: 'ok', detail: `${pkg} стоит: ${browserPrefix(i.paths)}` }
    : st.state === 'installing'
      ? { id: 'browser.mcp', title: 'Браузер агента', status: 'ok', detail: `${pkg} ставится${st.since === 'идёт сейчас' ? '' : ` (с ${st.since})`}` }
      : st.state === 'failed'
        ? { id: 'browser.mcp', title: 'Браузер агента', status: 'warn', detail: `${pkg} не поставился: ${st.error.split('\n')[0] ?? ''}`, fix: 'pult browser install', fixCmd: 'pult browser install' }
        : want
          ? { id: 'browser.mcp', title: 'Браузер агента', status: 'warn', detail: `${pkg} не поставлен, а браузер включён у сессий: ${i.wanted}`, fix: 'pult browser install', fixCmd: 'pult browser install' }
          : { id: 'browser.mcp', title: 'Браузер агента', status: 'ok', detail: `${pkg} не поставлен — поставится сам, когда сессии включат браузер (или: pult browser install)` }
  const needChrome = want || st.state === 'installed'
  const chrome: DoctorItem = i.chrome
    ? { id: 'browser.chrome', title: 'Chrome для браузера агента', status: 'ok', detail: i.chrome }
    : {
        id: 'browser.chrome',
        title: 'Chrome для браузера агента',
        status: needChrome ? 'warn' : 'ok',
        detail: needChrome
          ? 'Google Chrome не найден — браузер агента работает на системном Chrome, своих браузеров Пульт не качает'
          : 'Google Chrome не найден (нужен только браузеру агента)',
        ...(needChrome ? { fix: 'поставь Google Chrome (https://www.google.com/chrome/) в /Applications' } : {}),
      }
  return [mcp, chrome]
}

/**
 * Свои MCP-серверы: что выбрано и читается ли `~/.claude.json`. Выбранного имени там нет — предупреждение:
 * сервер не подключается, подстановок нет (серверы проекта `.mcp.json` — позже).
 */
export async function mcpDoctorItems(userFile: string, selected: readonly string[]): Promise<DoctorItem[]> {
  const r = await readServersFile(userFile)
  if (r.warning) {
    return [{ id: 'mcp.servers', title: 'Свои MCP-серверы', status: 'warn', detail: r.warning, fix: `проверь ${userFile}: Пульт читает оттуда mcpServers (только чтение)` }]
  }
  const known = Object.keys(r.servers)
  const missing = selected.filter((n) => !Object.hasOwn(r.servers, n))
  if (missing.length) {
    return [{
      id: 'mcp.servers', title: 'Свои MCP-серверы', status: 'warn',
      detail: `выбраны, но в ~/.claude.json их нет — не подключаются: ${missing.join(', ')}`,
      fix: 'добавь их (claude mcp add --scope user …) или сними выбор: окно → doctor → «MCP-серверы…» / pult mcp select',
    }]
  }
  const detail = selected.length
    ? `подключены к сессиям Claude: ${selected.join(', ')} · в ~/.claude.json: ${known.length}`
    : `не выбраны (в ~/.claude.json: ${known.length}) — выбрать: окно → doctor → «MCP-серверы» или pult mcp select`
  return [{ id: 'mcp.servers', title: 'Свои MCP-серверы', status: 'ok', detail }]
}

/** `defaultMode: bypassPermissions` в настройках Claude — браузер для сессий Claude не включается. */
export function bypassDoctorItems(mode: string | null, wanted: number): DoctorItem[] {
  if (mode !== 'bypassPermissions') return []
  return [{
    id: 'browser.permissions', title: 'Браузер агента и режим разрешений Claude', status: wanted > 0 ? 'warn' : 'ok',
    detail: 'в ~/.claude/settings.json permissions.defaultMode = "bypassPermissions" — браузер для сессий Claude не включается (вызовы шли бы без вопроса)',
    fix: 'поменяй defaultMode (например, на "auto") в ~/.claude/settings.json',
  }]
}
