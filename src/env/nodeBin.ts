// Путь к node для процессов, которые запускает не сам демон: заглушку разрешений `pult mcp-ask`
// поднимает `claude` по файлу --mcp-config, демона — лаунчер службы по node-path.
//
// ЗАЧЕМ: `process.execPath` — настоящий путь до бинаря, у Homebrew это
// `/opt/homebrew/Cellar/node/26.10.0_2/bin/node`. `brew upgrade node` удаляет этот каталог, а демон,
// запущенный до обновления, живёт дальше (бинарь уже в памяти) и пишет в --mcp-config мёртвый путь:
// `claude` не может поднять заглушку и падает с «MCP tool mcp__pult__ask … not found. Available MCP
// tools: none» (08.10.2026, node 26.10.0_2 → 26.11.0). Отсюда два правила: писать путь, который
// переживает обновление, и проверять его на каждом запуске, а не один раз на сессию.

import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, sep } from 'node:path'
import type { DaemonNode } from '../core/rpc.js'

export type IsExecutable = (p: string) => boolean

export function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** `<префикс>/Cellar/<формула>/<версия>/bin/node` — формула бывает и `node@22`. */
const BREW_CELLAR_NODE = /^(.+)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/

/**
 * Путь, который переживает `brew upgrade`: `<префикс>/Cellar/<формула>/<версия>/bin/node` →
 * `<префикс>/opt/<формула>/bin/node` — ссылку `opt` Homebrew сам переводит на новую версию.
 * Не Homebrew или ссылки `opt` нет — путь как есть.
 */
export function stableNodePath(execPath: string, isExec: IsExecutable = isExecutableFile): string {
  const m = BREW_CELLAR_NODE.exec(execPath)
  if (!m) return execPath
  const opt = `${m[1]}/opt/${m[2]}/bin/node`
  return isExec(opt) ? opt : execPath
}

/** Первая строка `PULT_HOME/node-path`; файла нет или он пуст — null. */
export function readSavedNode(nodePathFile: string): string | null {
  try {
    return (readFileSync(nodePathFile, 'utf8').split('\n')[0] ?? '').trim() || null
  } catch {
    return null
  }
}

/**
 * Живой node на момент вызова: устойчивый путь своего node → свой node как есть →
 * `PULT_HOME/node-path` (его чинит лаунчер службы на каждом старте). Ни один не исполняемый — null.
 */
export function resolveChildNode(
  execPath: string,
  saved: string | null,
  isExec: IsExecutable = isExecutableFile,
): string | null {
  const candidates = [stableNodePath(execPath, isExec), execPath]
  if (saved) candidates.push(stableNodePath(saved, isExec), saved)
  return candidates.find((p) => isExec(p)) ?? null
}

/**
 * Свой node Пульта (src/update/runtime.ts) по указателю `PULT_HOME/runtime/active`: путь, если он
 * исполняемый и собран под ЭТУ машину (`.../node-v<версия>-<платформа>-<arch>/bin/node`), иначе null.
 * Платформа сверяется по имени каталога, а не запуском: PULT_HOME, перенесённый с Intel-мака на
 * Apple Silicon без Rosetta, дал бы «Bad CPU type», а запуск ради проверки на macOS бывает долгим.
 * Указатель пишет `pult update` / `pult runtime install`.
 */
export function readActiveRuntime(
  activeFile: string,
  isExec: IsExecutable = isExecutableFile,
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  const p = readSavedNode(activeFile)
  if (!p || !isExec(p)) return null
  return basename(dirname(dirname(p))).endsWith(`-${platform}-${arch}`) ? p : null
}

/**
 * Чем поднимать демона в обход службы: своим node Пульта, а если его нет — `fallback` (node
 * вызывающего; у окна — найденный им node). Свой node главнее и явно переданного пути: окно
 * держит путь неделями, и он может указывать на системный node, который снесёт brew, или на свой,
 * уже убранный обновлением. Лаунчер службы выбирает в том же порядке (service/pultd-launch, шаг 2).
 */
export function daemonNode(activeFile: string, fallback: string = process.execPath, isExec: IsExecutable = isExecutableFile): string {
  return readActiveRuntime(activeFile, isExec) ?? fallback
}

export interface FileId { dev: number; ino: number }

/** Устройство и inode файла или null (файла нет). */
export function fileId(p: string): FileId | null {
  try {
    const st = statSync(p)
    return { dev: st.dev, ino: st.ino }
  } catch {
    return null
  }
}

/**
 * Node живого процесса для `daemon.status`: тот ли бинарь лежит по его пути, что при старте, и
 * свой ли он (под `PULT_HOME/runtime`). Сверка по inode, а не по наличию пути: установщик с
 * nodejs.org и apt кладут новую версию по ТОМУ ЖЕ пути — путь есть, а бинарь процесса удалён.
 * execPath у node — настоящий путь, поэтому сверяемся и с realpath каталога (/tmp → /private/tmp).
 */
export function daemonNodeInfo(
  runtimeDir: string,
  execPath: string = process.execPath,
  version: string = process.version,
  startedAs: FileId | null = null,
): DaemonNode {
  const roots = [runtimeDir]
  try { roots.push(realpathSync(runtimeDir)) } catch { /* каталога нет — своего node нет */ }
  const now = fileId(execPath)
  return {
    path: execPath,
    version,
    alive: now !== null && (startedAs === null || (now.dev === startedAs.dev && now.ino === startedAs.ino)),
    own: roots.some((r) => execPath.startsWith(r + sep)),
  }
}
