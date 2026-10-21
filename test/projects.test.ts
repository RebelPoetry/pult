// Проекты — список папок у демона (окно раскладывает по ним сессии). Хранилище и RPC.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { connectClient } from '../dist/cli/client.js'
import { createProjectStore, MAX_PROJECTS, parseProjects } from '../dist/projects/store.js'
import { startTestDaemon, tempHome } from './helpers.js'

describe('проекты: хранилище', () => {
  it('добавить: путь как выбран (симлинк НЕ раскрыт), нормализован; повтор — тот же проект; файл переживает перезапуск', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-proj-')))
    try {
      const repo = join(dir, 'repo'); mkdirSync(repo)
      const link = join(dir, 'link'); symlinkSync(repo, link)
      const file = join(dir, 'projects.json')
      const s = createProjectStore(file, () => new Date('2026-10-07T10:00:00Z'))
      assert.deepEqual(s.add(link), { path: link, addedAt: '2026-10-07T10:00:00.000Z' })
      assert.equal(s.add(`${repo}/`).path, repo)
      assert.equal(s.add(`${repo}/./`).path, repo)
      assert.equal(s.list().length, 2)
      assert.deepEqual(createProjectStore(file).list().map((p) => p.path), [link, repo])
      assert.equal(s.remove(link), true)
      assert.equal(s.remove(repo), true)
      assert.equal(s.remove(repo), false)
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).projects, [])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('отказ: относительный путь, файл вместо папки, нет папки', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-proj-')))
    try {
      const f = join(dir, 'a.txt'); writeFileSync(f, 'x')
      const s = createProjectStore(join(dir, 'projects.json'))
      assert.throws(() => s.add('rel/path'), /абсолютный путь/)
      assert.throws(() => s.add(f), /не папка/)
      assert.throws(() => s.add(join(dir, 'нет')), /папки нет/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('битый файл и мусор в нём не роняют демона: берётся то, что годно', () => {
    assert.deepEqual(parseProjects({ projects: [{ path: '/srv/a' }, { path: 'rel' }, { path: '/srv/a' }, 7, { path: '/srv/b', addedAt: 'x' }] }).map((p) => p.path), ['/srv/a', '/srv/b'])
    assert.deepEqual(parseProjects(null), [])
    assert.equal(parseProjects({ projects: Array.from({ length: MAX_PROJECTS + 5 }, (_, i) => ({ path: `/srv/${i}` })) }).length, MAX_PROJECTS)
  })
})

describe('проекты: RPC демона', () => {
  it('project.add → project.list → project.remove; ошибки — коды not_found / invalid_params', async () => {
    const home = tempHome()
    const d = await startTestDaemon(home)
    const repo = join(home.paths.home, 'repo'); mkdirSync(repo)
    const c = await connectClient(home.paths)
    try {
      const added = await c.request('project.add', { path: repo }) as { path: string }
      assert.equal(added.path, repo)
      assert.deepEqual((await c.request('project.list') as { projects: Array<{ path: string }> }).projects.map((p) => p.path), [repo])
      await assert.rejects(c.request('project.add', { path: join(repo, 'нет') }), (e: { code?: string }) => e.code === 'not_found')
      await assert.rejects(c.request('project.add', { path: 'rel' }), (e: { code?: string }) => e.code === 'invalid_params')
      assert.deepEqual(await c.request('project.remove', { path: repo }), { removed: true })
      assert.deepEqual((await c.request('project.list') as { projects: unknown[] }).projects, [])
    } finally { c.close(); await d.stop('конец теста'); home.remove() }
  })
})
