import { open, readdir, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { isAbsolute, join } from 'node:path'
import { redactString } from '../core/log.js'

export interface ExternalSession {
  id: string
  provider: 'claude' | 'codex'
  title: string
  cwd: string
  updatedAt: string
}
export interface ExternalMessage { role: 'user' | 'assistant'; text: string }
export interface ExternalConversation {
  session: ExternalSession
  messages: ExternalMessage[]
  truncated: boolean
}
export interface ExternalPage { sessions: ExternalSession[]; nextCursor: string | null }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const object = (x: unknown): Record<string, unknown> => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {}
const text = (x: unknown): string => typeof x === 'string' ? x : ''
const contentText = (x: unknown): string => typeof x === 'string' ? x : Array.isArray(x)
  ? x.filter((c) => object(c)['type'] === 'text' || object(c)['type'] === 'input_text').map((c) => text(object(c)['text'])).join('\n') : ''

export function codexSession(raw: unknown): ExternalSession | null {
  const t = object(raw)
  const id = text(t['id']), cwd = text(t['cwd'])
  if (!UUID.test(id) || !isAbsolute(cwd)) return null
  const updated = typeof t['updatedAt'] === 'number' ? t['updatedAt'] * 1000 : Date.parse(text(t['updatedAt']))
  return { id, cwd, provider: 'codex', title: redactString(text(t['name']) || text(t['preview']) || id).slice(0, 160),
    updatedAt: new Date(Number.isFinite(updated) ? updated : 0).toISOString() }
}

/** Only transcript files under the CLI's projects directory are inspected; credentials are never read. */
export function createExternalSessions(opts: {
  claudeRoot: string
  codexRequest(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>
}) {
  const claudeFiles = async (): Promise<Array<{ id: string; file: string; updated: number }>> => {
    const files: Array<{ id: string; file: string; updated: number }> = []
    let dirs
    try { dirs = await readdir(opts.claudeRoot, { withFileTypes: true }) } catch { return files }
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      const folder = join(opts.claudeRoot, d.name)
      let entries
      try { entries = await readdir(folder, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.jsonl') || !UUID.test(e.name.slice(0, -6))) continue
        const file = join(folder, e.name)
        try { files.push({ id: e.name.slice(0, -6), file, updated: (await stat(file)).mtimeMs }) } catch { /* CLI rotated it */ }
      }
    }
    return files.sort((a, b) => b.updated - a.updated)
  }
  const claudeMeta = async (f: { id: string; file: string; updated: number }): Promise<ExternalSession | null> => {
    const fd = await open(f.file, 'r')
    try {
      const size = (await fd.stat()).size
      const length = Math.min(size, 128 * 1024)
      const head = Buffer.alloc(length), tail = Buffer.alloc(length)
      await fd.read(head, 0, length, 0)
      await fd.read(tail, 0, length, Math.max(0, size - length))
      let cwd = '', title = '', custom = ''
      for (const line of (head.toString() + '\n' + tail.toString()).split('\n')) {
        let o: Record<string, unknown>
        try { o = object(JSON.parse(line)) } catch { continue }
        if (o['isSidechain'] === true) continue
        if (text(o['cwd'])) cwd = text(o['cwd'])
        if (text(o['customTitle'])) custom = text(o['customTitle'])
        if (!title && o['type'] === 'user') title = contentText(object(o['message'])['content'])
      }
      if (!isAbsolute(cwd)) return null
      return { id: f.id, provider: 'claude', cwd, title: redactString(custom || title || f.id).replace(/\s+/g, ' ').slice(0, 160),
        updatedAt: new Date(f.updated).toISOString() }
    } finally { await fd.close() }
  }
  return {
    async list(provider: 'claude' | 'codex', cursor?: string): Promise<ExternalPage> {
      if (provider === 'codex') {
        const page = await opts.codexRequest('thread/list', { limit: 50, sortKey: 'updated_at', archived: false, ...(cursor ? { cursor } : {}) })
        return { sessions: Array.isArray(page['data']) ? page['data'].flatMap((t) => { const s = codexSession(t); return s ? [s] : [] }) : [],
          nextCursor: typeof page['nextCursor'] === 'string' ? page['nextCursor'] : null }
      }
      const files = await claudeFiles()
      const offset = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0
      const sessions: ExternalSession[] = []
      let i = offset
      while (i < files.length && sessions.length < 50) {
        const f = files[i++]!
        try { const s = await claudeMeta(f); if (s) sessions.push(s) } catch { /* missing transcript */ }
      }
      return { sessions, nextCursor: i < files.length ? String(i) : null }
    },
    async read(provider: 'claude' | 'codex', id: string): Promise<ExternalConversation> {
      if (!UUID.test(id)) throw new Error('Некорректный идентификатор разговора')
      if (provider === 'codex') {
        const raw = await opts.codexRequest('thread/read', { threadId: id, includeTurns: false })
        const session = codexSession(raw['thread'])
        if (!session) throw new Error('Разговор Codex не найден')
        const page = await opts.codexRequest('thread/items/list', { threadId: id, limit: 200, sortDirection: 'desc' })
        const messages: ExternalMessage[] = []
        for (const item of Array.isArray(page['data']) ? [...page['data']].reverse() : []) {
          const entry = object(item)
          const m = object(entry['item'] ?? entry), role = m['type'] === 'userMessage' ? 'user' : m['type'] === 'agentMessage' ? 'assistant' : null
          const body = role === 'user' ? contentText(m['content']) : text(m['text'])
          if (role && body) messages.push({ role, text: redactString(body).slice(0, 100_000) })
        }
        return { session, messages, truncated: Boolean(page['nextCursor']) }
      }
      const file = (await claudeFiles()).find((f) => f.id === id)
      const session = file && await claudeMeta(file)
      if (!file || !session) throw new Error('Разговор Claude не найден')
      const messages: ExternalMessage[] = []
      let count = 0
      const lines = createInterface({ input: createReadStream(file.file), crlfDelay: Infinity })
      try {
        for await (const line of lines) {
          let o: Record<string, unknown>
          try { o = object(JSON.parse(line)) } catch { continue }
          if (o['isSidechain'] === true || (o['type'] !== 'user' && o['type'] !== 'assistant')) continue
          const body = contentText(object(o['message'])['content'])
          if (!body) continue
          count++
          messages.push({ role: o['type'] as 'user' | 'assistant', text: redactString(body).slice(0, 100_000) })
          if (messages.length > 200) messages.shift()
        }
      } finally { lines.close() }
      return { session, messages, truncated: count > messages.length }
    },
  }
}
