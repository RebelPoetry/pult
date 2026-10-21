// Один экземпляр демона. Основа перенесена из spike/env/sock-server.mjs (проверка S9f).
//
// ТРИ ВЕЩИ, КОТОРЫХ НЕ БЫЛО В СПАЙКЕ И КОТОРЫЕ КУПЛЕНЫ РЕВЬЮ В1:
//   1. ПУБЛИКАЦИЯ АТОМАРНА. `open(O_CREAT|O_EXCL)` + отдельный `write` — это ДВА шага, и
//      сосед, заставший файл между ними, читает пустоту, считает lock битым, сносит его и
//      берёт «свой». Поэтому содержимое пишется во временный файл, а на место lock попадает
//      одним `link()`: он либо удался целиком, либо не удался вовсе.
//   2. ЖИВОСТЬ pid — НЕ ДОКАЗАТЕЛЬСТВО. После жёсткого падения номер переиспользуется, и
//      `kill(pid,0)` радостно подтверждает «жив» про launchd, init или чужой демон — pultd
//      после этого не стартует НИКОГДА, пока человек не сотрёт файл руками. Поэтому вместе с
//      pid хранится ВРЕМЯ СТАРТА держателя (`ps -o lstart=`): у переиспользованного номера оно
//      другое. Спросить не вышло — считаем держателя живым (осторожная сторона).
//   3. СНИМАЕМ ТОЛЬКО СВОЁ. `release()` сверяет содержимое перед удалением, снятие протухшего
//      lock перечитывает файл прямо перед `unlink`, а после публикации мы ещё раз читаем
//      файл: если там не мы — гонку мы проиграли и стартовать не имеем права.

import { spawnSync } from 'node:child_process'
import { closeSync, linkSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'

export interface LockHandle {
  readonly path: string
  release(): void
}

export type LockResult =
  | { ok: true; lock: LockHandle }
  | { ok: false; holderPid: number | null; holderCmd: string | null }

export interface LockRecord {
  pid: number
  /** Наше время взятия lock — для человека в журнале. */
  startedAt: string
  /** Время старта процесса по `ps`. Сравнивается при проверке живости. */
  started: string
  /** Команда держателя — только для сообщения об отказе, в сравнении не участвует. */
  cmd: string
}

export interface LockDeps {
  pid?: number
  /** Время старта процесса, как его видит `ps`. */
  processStart?: (pid: number) => string | null
  processCommand?: (pid: number) => string | null
  alive?: (pid: number) => boolean
}

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM = процесс есть, но чужой. Это «жив».
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Одно поле `ps` про процесс. Формат `-p N -o поле=` одинаков на macOS и Linux. */
function psField(pid: number, field: string): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    // PATH задаём явно: у демона под launchd его может не быть вовсе, а `ps` лежит в /bin
    // на macOS и в /bin или /usr/bin на Linux.
    const r = spawnSync('ps', ['-p', String(pid), '-o', `${field}=`], {
      encoding: 'utf8', timeout: 3000, env: { PATH: '/usr/bin:/bin' },
    })
    if (r.status !== 0) return null
    const line = (r.stdout ?? '').split('\n')[0]?.trim() ?? ''
    return line.length ? line : null
  } catch {
    return null
  }
}

export const processStart = (pid: number): string | null => psField(pid, 'lstart')
export const processCommand = (pid: number): string | null => psField(pid, 'command')

/**
 * Старый формат lock — голый pid. Такой файл мог оставить pultd прошлой версии, поэтому
 * читаем и его, но времени старта в нём нет: держателя придётся судить по имени процесса.
 */
export function parseLockRecord(raw: string): LockRecord | null {
  const text = raw.trim()
  if (!text) return null
  if (text.startsWith('{')) {
    try {
      const o = JSON.parse(text) as Partial<LockRecord>
      if (typeof o.pid !== 'number' || !Number.isInteger(o.pid) || o.pid <= 0) return null
      return {
        pid: o.pid,
        startedAt: String(o.startedAt ?? ''),
        started: typeof o.started === 'string' ? o.started : '',
        cmd: typeof o.cmd === 'string' ? o.cmd : '',
      }
    } catch {
      return null
    }
  }
  const pid = Number.parseInt(text, 10)
  return Number.isInteger(pid) && pid > 0 ? { pid, startedAt: '', started: '', cmd: '' } : null
}

/** Похоже ли на наш демон — нужно только для файла старого формата, где времени старта нет. */
const LOOKS_LIKE_PULTD = /pultd|pult[/\\]dist|daemon[/\\]main\.js/

function readRaw(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

interface Probes {
  alive: (pid: number) => boolean
  start: (pid: number) => string | null
  command: (pid: number) => string | null
}

function holderIsAlive(rec: LockRecord, p: Probes): boolean {
  if (!p.alive(rec.pid)) return false
  if (rec.started) {
    const now = p.start(rec.pid)
    if (now === null) return true
    return now === rec.started
  }
  const cmd = p.command(rec.pid)
  if (cmd === null) return true
  return LOOKS_LIKE_PULTD.test(cmd)
}

function publish(path: string, record: LockRecord): boolean {
  const tmp = `${path}.${record.pid}.tmp`
  try { unlinkSync(tmp) } catch { /* его и не было */ }
  let fd: number
  try {
    fd = openSync(tmp, 'wx', 0o600)
  } catch {
    return false
  }
  try {
    writeSync(fd, JSON.stringify(record))
  } finally {
    closeSync(fd)
  }
  let linked = false
  try {
    linkSync(tmp, path)
    linked = true
  } catch { /* место занято живым или протухшим соседом */ }
  try { unlinkSync(tmp) } catch { /* ладно */ }
  return linked
}

function probesOf(deps: LockDeps): Probes {
  return {
    alive: deps.alive ?? isAlive,
    start: deps.processStart ?? processStart,
    command: deps.processCommand ?? processCommand,
  }
}

function readRecord(path: string): LockRecord | null {
  const raw = readRaw(path)
  return raw === null ? null : parseLockRecord(raw)
}

// ДВА РАЗНЫХ ВОПРОСА К ДЕРЖАТЕЛЮ LOCK — и два разных ответа на «`ps` не ответил».
//
// КАК ЛОМАЛОСЬ (`codex review` дельты В4, 28.09.2026): одна функция отвечала на оба вопроса.
// Для lock без времени старта (старый формат или `acquireLock` не смог прочитать `lstart`) она
// брала осторожный вердикт `holderIsAlive`: pid жив, а `ps` упал или не ответил за 3 с — «держит».
// По этому вердикту `pult daemon stop` слал SIGTERM. Номер протухшего lock мог достаться чужому
// процессу — и stop гасил процесс, который ему не принадлежит, ровно тогда, когда `ps` сбоил.
//
// Теперь: «кто-то, возможно, держит lock» (отказ брать lock, ожидание в stop) — осторожно, неясность
// считается «держит»; «это точно наш pultd» (кому слать сигнал) — только по положительному
// доказательству, неясность считается «не наш».

/**
 * (а) Возможный живой держатель lock или `null` — тот же осторожный вердикт, что у `acquireLock`:
 * если `ps` не ответил, держатель считается живым. Нужен `pult daemon stop`, чтобы ждать демона,
 * который уже взял lock, но ещё не слушает сокет (A1 ревью В4), и чтобы не назвать lock свободным,
 * пока pultd на нём стартовать не сможет. Кому слать сигнал, эта функция НЕ решает — см. (б).
 */
export function liveLockHolder(path: string, deps: LockDeps = {}): LockRecord | null {
  const rec = readRecord(path)
  return rec && holderIsAlive(rec, probesOf(deps)) ? rec : null
}

/**
 * (б) Держатель lock, про которого ДОКАЗАНО, что это наш pultd, или `null`. Только ему
 * `pult daemon stop` шлёт SIGTERM. Доказательство — одно из двух:
 *   * в lock записано время старта, `ps` отдал то же самое, и команда похожа на pultd;
 *   * времени старта нет — `ps` отдал команду, и она похожа на pultd (записанной в lock команде
 *     без времени старта не верим: pid мог смениться хозяином).
 * `ps` не ответил — доказательства нет, сигнала нет.
 */
export function confirmedLockHolder(path: string, deps: LockDeps = {}): LockRecord | null {
  const rec = readRecord(path)
  if (!rec) return null
  const probes = probesOf(deps)
  if (!probes.alive(rec.pid)) return null
  if (rec.started) {
    if (probes.start(rec.pid) !== rec.started) return null
    return LOOKS_LIKE_PULTD.test(rec.cmd || probes.command(rec.pid) || '') ? rec : null
  }
  const cmd = probes.command(rec.pid)
  return cmd !== null && LOOKS_LIKE_PULTD.test(cmd) ? rec : null
}

/**
 * Берёт lock или сообщает, кто его держит. Две попытки: первая может наткнуться на
 * протухший lock, который мы снимаем, вторая — уже на свой собственный успех.
 */
export function acquireLock(path: string, deps: LockDeps = {}): LockResult {
  const pid = deps.pid ?? process.pid
  const probes = probesOf(deps)
  const record: LockRecord = {
    pid,
    startedAt: new Date().toISOString(),
    started: probes.start(pid) ?? '',
    cmd: [process.execPath, process.argv[1] ?? ''].filter(Boolean).join(' '),
  }
  const mine = JSON.stringify(record)

  for (let attempt = 0; attempt < 2; attempt++) {
    if (publish(path, record)) {
      // Проверка ПОСЛЕ публикации: сосед, снимавший протухший lock, мог снести уже наш.
      if (readRaw(path) === mine) {
        return {
          ok: true,
          lock: {
            path,
            release: (): void => {
              // Снимаем ТОЛЬКО свой lock: чужой мы у него не отнимаем даже на выходе.
              if (readRaw(path) !== mine) return
              try { unlinkSync(path) } catch { /* уже снят */ }
            },
          },
        }
      }
      continue
    }

    const raw = readRaw(path)
    const held = raw === null ? null : parseLockRecord(raw)
    if (held && holderIsAlive(held, probes)) {
      return { ok: false, holderPid: held.pid, holderCmd: held.cmd || probes.command(held.pid) }
    }
    // Держатель мёртв (или файл битый). Перечитываем ПРЯМО ПЕРЕД снятием: между первым
    // чтением и этой строкой lock мог смениться на живой.
    if (raw !== null && readRaw(path) === raw) {
      try { unlinkSync(path) } catch { /* кто-то снял раньше */ }
    }
  }

  const raw = readRaw(path)
  const held = raw === null ? null : parseLockRecord(raw)
  return { ok: false, holderPid: held?.pid ?? null, holderCmd: held?.cmd ?? null }
}
