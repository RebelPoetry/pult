// Сравнение версий semver. Чистый модуль без node:* — его берут и демон (src/update), и окно (ui/):
// «Доступна 1.0.3» и «нужна новая версия окна» окно решает тем же сравнением, что и `pult update`.

/** Строгая стабильная версия `x.y.z` — без пререлиза и метаданных. Только такие ходят каналом обновлений. */
export const STABLE_VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/

export function isStableVersion(v: string): boolean {
  return STABLE_VERSION_RE.test(v)
}

/**
 * Сравнение semver для сортировки списка: числа по-числовому, версия без пререлиза старше
 * пререлиза той же тройки. Метаданные сборки (`+…`) в порядке не участвуют — как в semver.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { nums: number[]; pre: string | null } => {
    const core = v.split('+')[0] ?? v
    const dash = core.indexOf('-')
    const main = dash >= 0 ? core.slice(0, dash) : core
    return { nums: main.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: dash >= 0 ? core.slice(dash + 1) : null }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d !== 0) return d
  }
  if (x.pre === null && y.pre !== null) return 1
  if (x.pre !== null && y.pre === null) return -1
  if (x.pre !== null && y.pre !== null) {
    const pa = x.pre.split('.')
    const pb = y.pre.split('.')
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const sa = pa[i]
      const sb = pb[i]
      if (sa === undefined) return -1
      if (sb === undefined) return 1
      const na = /^\d+$/.test(sa) ? Number(sa) : null
      const nb = /^\d+$/.test(sb) ? Number(sb) : null
      if (na !== null && nb !== null && na !== nb) return na - nb
      if (na !== null && nb === null) return -1
      if (na === null && nb !== null) return 1
      if (sa !== sb) return sa < sb ? -1 : 1
    }
  }
  return a === b ? 0 : a < b ? -1 : 1
}
