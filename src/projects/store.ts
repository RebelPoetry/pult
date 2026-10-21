// Проекты — папки, из которых заводятся сессии (окно: дерево «проект → его сессии», как в нативных
// Claude Code и Codex). Список хранит демон в `PULT_HOME/projects.json`, чтобы его видели и окно,
// и CLI, и он пережил переустановку оболочки. Сессии к проектам не привязаны полем: окно само
// раскладывает их по папкам (ui/src/model/projects.ts). Убрать проект из списка — только из
// списка: папка на диске не трогается никогда. M8d: убрать можно и папку С сессиями — тогда её сессии
// уходят в архив (`project.remove {sessions}` в src/daemon/server.ts), и группа пропадает сама; «скрытых»
// папок здесь не хранится — новая сессия в папке возвращает её в дерево.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export interface Project {
  /**
   * Абсолютный путь папки — он же ключ. Симлинки НЕ раскрываются: папки сессий хранятся так, как
   * их выбрали, и окно сравнивает пути строками. Раскрой мы `/var` → `/private/var` (macOS),
   * сессия из той же папки не встала бы в свой проект.
   */
  path: string
  addedAt: string
}

export class ProjectError extends Error {
  constructor(readonly code: 'invalid_params' | 'not_found', message: string) { super(message) }
}

/** Сколько проектов держим — список для человека, а не индекс диска. */
export const MAX_PROJECTS = 200

export function parseProjects(raw: unknown): Project[] {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { projects?: unknown }).projects)
    ? (raw as { projects: unknown[] }).projects : []
  const seen = new Set<string>()
  const out: Project[] = []
  for (const x of list) {
    if (!x || typeof x !== 'object') continue
    const o = x as Record<string, unknown>
    if (typeof o['path'] !== 'string' || !isAbsolute(o['path']) || o['path'].includes('\0') || seen.has(o['path'])) continue
    seen.add(o['path'])
    out.push({ path: o['path'], addedAt: typeof o['addedAt'] === 'string' ? o['addedAt'] : new Date(0).toISOString() })
  }
  return out.slice(0, MAX_PROJECTS)
}

function writeAtomic(file: string, list: Project[]): void {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `.projects.${process.pid}.${Date.now()}.tmp`)
  const fd = openSync(tmp, 'w', 0o600)
  try {
    const buf = Buffer.from(JSON.stringify({ version: 1, projects: list }, null, 2) + '\n', 'utf8')
    let off = 0
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try { renameSync(tmp, file) } catch (e) { try { unlinkSync(tmp) } catch { /* уже нет */ } throw e }
}

export interface ProjectStore {
  list(): Project[]
  add(path: string): Project
  remove(path: string): boolean
}

export function createProjectStore(file: string, now: () => Date = () => new Date()): ProjectStore {
  let list: Project[]
  try { list = parseProjects(JSON.parse(readFileSync(file, 'utf8'))) } catch { list = [] }
  return {
    list: () => list.map((p) => ({ ...p })),
    add(path) {
      if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new ProjectError('invalid_params', 'project.add: нужен абсолютный путь папки')
      const real = resolve(path)
      let isDir: boolean
      try { isDir = statSync(real).isDirectory() } catch { throw new ProjectError('not_found', `папки нет: ${path}`) }
      if (!isDir) throw new ProjectError('invalid_params', `это не папка: ${path}`)
      const have = list.find((p) => p.path === real)
      if (have) return { ...have }
      if (list.length >= MAX_PROJECTS) throw new ProjectError('invalid_params', `проектов уже ${MAX_PROJECTS} — убери лишние`)
      const p: Project = { path: real, addedAt: now().toISOString() }
      const next = [...list, p]
      writeAtomic(file, next)
      list = next
      return { ...p }
    },
    remove(path) {
      // Как `add`: путь нормализуется (ревью M8d) — `/srv/a/` и `/srv/a` один проект.
      const real = typeof path === 'string' && isAbsolute(path) ? resolve(path) : path
      const next = list.filter((p) => p.path !== real)
      if (next.length === list.length) return false
      writeAtomic(file, next)
      list = next
      return true
    },
  }
}
