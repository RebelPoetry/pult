// lsregister.mjs — уборка за check-app.mjs --launch в базе LaunchServices.
//
// ЗАЧЕМ. Запущенный бандл macOS регистрирует в LaunchServices сам, и запись переживает удаление
// папки. С 0.1.13 Pult.app объявляет схему pult:// — каждая временная копия
// (`…/T/pa-*/tampered/Pult.app`) и проверенная сборка из out/ становились лишними претендентами
// на ссылки pult:// рядом с поставленным приложением. Поэтому в конце прогона (и при провале тоже)
// check-app снимает с учёта всё, что сам запускал или создавал, — ДО удаления временных папок:
// `lsregister -u` по исчезнувшему пути уже ничего не найдёт.
//
// ЧЕГО НЕ ТРОГАЕМ. Приложение в /Applications или ~/Applications — это поставленный Пульт
// человека: снять его с учёта значит отобрать у него pult://. Такой путь в список не попадает,
// даже если check-app запускали на нём.

import { execFileSync } from 'node:child_process'
import path from 'node:path'

export const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

/** Лежит ли бандл в папке поставленных приложений (системной или своей). */
export function isInstalledApp(app, home) {
  const p = path.resolve(app)
  const roots = ['/Applications', ...(home ? [path.join(home, 'Applications')] : [])]
  return roots.some((r) => p === r || p.startsWith(r + path.sep))
}

/**
 * Какие бандлы снять с учёта: проверенный (если его запускали) и все созданные копии;
 * без поставленных приложений, без дублей, порядок сохранён.
 */
export function appsToUnregister({ app, launched, created = [], home }) {
  const out = []
  for (const p of [...(launched ? [app] : []), ...created]) {
    if (!p) continue
    const abs = path.resolve(p)
    if (isInstalledApp(abs, home) || out.includes(abs)) continue
    out.push(abs)
  }
  return out
}

/** `lsregister -u` на каждый путь; ошибки не роняют уборку — только попадают в итог. */
export function unregisterApps(paths, exec = execFileSync) {
  return paths.map((p) => {
    try {
      exec(LSREGISTER, ['-u', p], { stdio: 'ignore', timeout: 15_000 })
      return { path: p, ok: true }
    } catch (e) {
      return { path: p, ok: false, error: String(e?.message ?? e).split('\n')[0] }
    }
  })
}
