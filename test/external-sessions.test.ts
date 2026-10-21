import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { codexSession, createExternalSessions } from '../dist/sessions/external.js'

const ID = 'c7ed14e2-4377-4760-840a-dbc7994eed50'
const thread = { id: ID, cwd: '/projects/app', name: 'Existing chat', updatedAt: 1_800_000_000 }
const row = (type: string, content: unknown, extra: Record<string, unknown> = {}) => ({ type, cwd: '/projects/app', message: { content }, ...extra })

async function fixture(lines: unknown[], run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pult-external-'))
  try {
    await mkdir(join(root, '-projects-app'))
    await writeFile(join(root, '-projects-app', `${ID}.jsonl`), lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n'))
    await run(root)
  } finally { await rm(root, { recursive: true, force: true }) }
}

const noCodex = async (): Promise<Record<string, unknown>> => { throw new Error('unexpected Codex request') }

describe('external sessions', () => {
  it('validates Codex metadata and timestamp without accepting relative paths', () => {
    assert.deepEqual(codexSession(thread), { id: ID, cwd: '/projects/app', title: 'Existing chat', provider: 'codex', updatedAt: new Date(thread.updatedAt * 1000).toISOString() })
    assert.equal(codexSession({ ...thread, id: '../../auth.json' }), null)
    assert.equal(codexSession({ ...thread, cwd: 'relative' }), null)
    assert.equal(codexSession({ ...thread, name: '', preview: 'Preview' })?.title, 'Preview')
  })

  it('passes Codex pagination cursor and filters invalid metadata', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const sessions = createExternalSessions({ claudeRoot: '/unused', codexRequest: async (method, params) => {
      calls.push({ method, params })
      return { data: [thread, { ...thread, id: 'bad' }], nextCursor: params['cursor'] ? null : 'page-2' }
    } })
    const first = await sessions.list('codex')
    assert.equal(first.sessions.length, 1)
    assert.equal(first.nextCursor, 'page-2')
    const second = await sessions.list('codex', first.nextCursor!)
    assert.equal(second.nextCursor, null)
    assert.deepEqual(calls[1], { method: 'thread/list', params: { limit: 50, sortKey: 'updated_at', archived: false, cursor: 'page-2' } })
  })

  it('reads newest Codex page in chronological order, excluding tools', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const sessions = createExternalSessions({ claudeRoot: '/unused', codexRequest: async (method, params) => {
      calls.push({ method, params })
      return method === 'thread/read' ? { thread } : { data: [
        { type: 'agentMessage', text: 'Answer' },
        { type: 'commandExecution', text: 'Do not display' },
        { type: 'userMessage', content: [{ type: 'input_text', text: 'Question' }, { type: 'image', text: 'Ignore' }] },
      ], nextCursor: 'older-items' }
    } })
    const result = await sessions.read('codex', ID)
    assert.deepEqual(result.messages, [{ role: 'user', text: 'Question' }, { role: 'assistant', text: 'Answer' }])
    assert.equal(result.truncated, true)
    assert.deepEqual(calls.map((c) => c.method), ['thread/read', 'thread/items/list'])
    assert.deepEqual(calls[1]?.params, { threadId: ID, limit: 200, sortDirection: 'desc' })
  })

  it('rejects path traversal before touching either provider', async () => {
    const sessions = createExternalSessions({ claudeRoot: '/unused', codexRequest: noCodex })
    for (const provider of ['claude', 'codex'] as const) {
      await assert.rejects(sessions.read(provider, '../auth.json'), /Некорректный/)
      await assert.rejects(sessions.read(provider, `${ID}/../auth.json`), /Некорректный/)
    }
  })

  it('reads Claude title/cwd and ignores malformed lines, sidechains and tool results', async () => {
    await fixture([
      '{malformed', row('user', 'First question'),
      row('assistant', [{ type: 'text', text: 'Reply' }, { type: 'tool_use', text: 'Hidden' }]),
      row('user', [{ type: 'tool_result', content: 'Hidden' }]),
      row('assistant', 'Subagent reply', { isSidechain: true, cwd: '/wrong/subagent' }),
      { type: 'custom-title', customTitle: 'My custom title' },
    ], async (root) => {
      const sessions = createExternalSessions({ claudeRoot: root, codexRequest: noCodex })
      const page = await sessions.list('claude')
      assert.equal(page.nextCursor, null)
      assert.equal(page.sessions[0]?.title, 'My custom title')
      assert.equal(page.sessions[0]?.cwd, '/projects/app')
      const result = await sessions.read('claude', ID)
      assert.deepEqual(result.messages, [{ role: 'user', text: 'First question' }, { role: 'assistant', text: 'Reply' }])
      assert.equal(result.truncated, false)
    })
  })

  it('retains last 200 Claude messages and flags truncation', async () => {
    await fixture(Array.from({ length: 205 }, (_, i) => row(i % 2 ? 'assistant' : 'user', `Message ${i}`)), async (root) => {
      const result = await createExternalSessions({ claudeRoot: root, codexRequest: noCodex }).read('claude', ID)
      assert.equal(result.messages.length, 200)
      assert.equal(result.messages[0]?.text, 'Message 5')
      assert.equal(result.messages.at(-1)?.text, 'Message 204')
      assert.equal(result.truncated, true)
    })
  })

  it('paginates Claude files and excludes subagent directory files', async () => {
    await fixture([row('user', 'First question')], async (root) => {
      const folder = join(root, '-projects-app')
      await mkdir(join(folder, 'subagents'))
      await writeFile(join(folder, 'subagents', `${ID}.jsonl`), JSON.stringify(row('user', 'Subagent')))
      for (let i = 1; i <= 50; i++) {
        const id = `01234567-89ab-cdef-0123-${String(i).padStart(12, '0')}`
        await writeFile(join(folder, `${id}.jsonl`), JSON.stringify(row('user', `Chat ${i}`)))
      }
      const sessions = createExternalSessions({ claudeRoot: root, codexRequest: noCodex })
      const first = await sessions.list('claude')
      assert.equal(first.sessions.length, 50)
      assert.equal(first.nextCursor, '50')
      const second = await sessions.list('claude', first.nextCursor!)
      assert.equal(second.sessions.length, 1)
      assert.equal(second.nextCursor, null)
      assert.equal(new Set([...first.sessions, ...second.sessions].map((s) => s.id)).size, 51)
    })
  })
})
