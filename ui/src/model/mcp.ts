// «MCP-серверы» (О3): строки диалога из ответа `mcp.list` и переключение выбора. Чистые функции.
// Только серверы пользователя из ~/.claude.json; серверы проекта (.mcp.json) — позже.

import type { McpListing } from '../../../src/mcp/servers.js'

export type { McpListing }

export interface McpRow {
  name: string
  transport: string
  detail: string
  checked: boolean
}

/** По имени; выбор — по имени: один флажок на имя. */
export function mcpRows(listing: McpListing | null, selected: readonly string[]): McpRow[] {
  if (!listing) return []
  return listing.servers
    .map((s): McpRow => ({ name: s.name, transport: s.transport, detail: s.detail, checked: selected.includes(s.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Отметить или снять имя; порядок прежних сохраняется. */
export function toggleServer(selected: readonly string[], name: string): string[] {
  return selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name]
}
