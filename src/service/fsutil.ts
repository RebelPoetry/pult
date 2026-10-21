// Атомарные записи для службы и версий. Всё, что читает launchd/systemd или лаунчер в момент
// записи, обязано видеть либо старый файл целиком, либо новый целиком: полупустой plist launchd
// молча не грузит, а лаунчер, прочитавший половину node-path, уйдёт искать node заново.

import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, symlinkSync, unlinkSync, writeSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'

/** tmp рядом с целью + fsync + rename. Режим ставится явным chmod: у open он маскируется umask. */
export function atomicWrite(file: string, content: string | Buffer, mode: number): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  const fd = openSync(tmp, 'w', mode)
  try {
    writeSync(fd, typeof content === 'string' ? Buffer.from(content, 'utf8') : content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    chmodSync(tmp, mode)
    renameSync(tmp, file)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* уже нет */ }
    throw e
  }
}

/**
 * Переключение симлинка ТОЛЬКО через symlink(tmp) + rename(tmp, link) (docs/08 §1): rename
 * атомарно подменяет старую ссылку, и нет мгновения, когда `current` не существует. Цель, которая
 * существует и НЕ симлинк, не трогаем: это чья-то настоящая папка.
 */
export function atomicSymlink(target: string, link: string): void {
  try {
    const st = lstatSync(link)
    if (!st.isSymbolicLink()) throw new Error(`${link} существует и не симлинк — не трогаю`)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  mkdirSync(dirname(link), { recursive: true })
  const tmp = `${link}.tmp-${process.pid}-${Date.now()}`
  symlinkSync(target, tmp)
  try {
    renameSync(tmp, link)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* уже нет */ }
    throw e
  }
}
