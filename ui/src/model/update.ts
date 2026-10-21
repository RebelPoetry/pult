// Плашка обновления (M8c): что сказать человеку по `daemon.status.update` и версии окна. Чистые функции.
//
// ВЕРСИЯ ОКНА: оболочка её мостом не отдаёт, но Electron кладёт имя и версию приложения в user agent:
// «… Pult/0.1.14 Chrome/… Electron/…» (в рабочей копии — имя пакета, «pult-shell/0.1.14»). Так плашка
// работает и в окне 0.1.13, которому не нужна новая оболочка ради одной строки.
//
// Плашка тихая: одна строка над окном, без всплывающих окон и звука. «Обновить» не доступно, когда пакету
// нужно окно новее этого: новый пакет со старым окном мог бы не открыться — тогда только ссылка на релиз
// (окно сменяется руками до 0.3.1).

import { compareVersions } from '../../../src/core/semver.js'
import type { UpdateStatus } from '../../../src/core/rpc.js'

const UA_RE = /(?:^|\s)(?:Pult|pult-shell)\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=\s|$)/

/** Версия окна из user agent Electron; не нашли — null (тогда про окно молчим). */
export function windowVersionFromUA(ua: string | undefined | null): string | null {
  return UA_RE.exec(ua ?? '')?.[1] ?? null
}

export interface UpdateBannerView {
  /** data-testid и тон плашки. */
  kind: 'available' | 'window' | 'waiting' | 'applying' | 'failed' | 'rolledback'
  text: string
  /** Страница релиза — «Что нового». */
  notes: string | null
  /** Кнопка: «Обновить» (`apply`), «Сейчас» (`force`), «Повторить» (`retry`) или никакой. */
  action: { label: string; force: boolean } | null
  /** Ключ «скрыть крестиком»: версия (до следующей) или `failure:<время>` (до следующей неудачи); null — не скрывается. */
  dismissKey: string | null
}

const turnsText = (n: number): string => {
  const mod10 = n % 10
  const mod100 = n % 100
  const word = mod10 === 1 && mod100 !== 11 ? 'идёт' : 'идут'
  return `${n} ${word}`
}

/**
 * Что показать. `dismissed` — что человек скрыл крестиком (версия или `failure:<время>`): «Доступна …» и
 * «не встало» про это больше не всплывают, но ожидание, установка и провал запуска видны всегда — их
 * человек запустил сам.
 */
export function updateBanner(u: UpdateStatus | undefined | null, windowVersion: string | null, dismissed: readonly string[] = []): UpdateBannerView | null {
  if (!u) return null
  const latest = u.latest
  const notes = latest?.notes ?? null
  switch (u.apply.state) {
    case 'waiting':
      return {
        kind: 'waiting',
        text: `Обновлю до ${u.apply.to} после окончания ходов (${turnsText(u.apply.turns)})`,
        notes, action: { label: 'Сейчас', force: true }, dismissKey: null,
      }
    case 'applying':
      return {
        kind: 'applying',
        text: `Обновляю до ${u.apply.to}… Демон перезапустится, окно переподключится само; новые реплики — после перезапуска`,
        notes: null, action: null, dismissKey: null,
      }
    case 'failed':
      return {
        kind: 'failed',
        text: `Обновление не удалось: ${u.apply.error}`,
        notes, action: u.available ? { label: 'Повторить', force: false } : null, dismissKey: null,
      }
    case 'idle':
      break
  }
  // Проба не прошла и откат — после него это уже другой демон, и только update.json помнит, что было.
  const f = u.failure ?? null
  // Старая неудача не заслоняет НОВУЮ версию: вышла версия новее не вставшей — показываем её.
  const newerThanFailure = f !== null && u.available && latest !== null && compareVersions(latest.version, f.to) > 0
  if (f && !newerThanFailure && !dismissed.includes(`failure:${f.at}`)) {
    const details = f.log ? `подробности: ${f.log}` : 'подробности были в терминале'
    return {
      kind: 'rolledback',
      text: f.back !== null
        ? `Обновление до ${f.to} не встало, вернул ${f.back} · ${details}`
        : `Обновление до ${f.to} не встало: ${f.message} · ${details}`,
      notes: null, action: null, dismissKey: `failure:${f.at}`,
    }
  }
  if (!u.available || !latest || dismissed.includes(latest.version)) return null
  const min = latest.app?.minVersion ?? null
  if (min !== null && windowVersion !== null && compareVersions(windowVersion, min) < 0) {
    return {
      kind: 'window',
      text: `Доступна ${latest.version} · Нужна новая версия окна (стоит ${windowVersion}, нужна ${min} или новее) — скачай её на странице релиза`,
      notes, action: null, dismissKey: latest.version,
    }
  }
  return {
    kind: 'available',
    text: `Доступна ${latest.version}`,
    notes, action: { label: 'Обновить', force: false }, dismissKey: latest.version,
  }
}

/** Скрытые ключи — небольшой список: новый ключ в конец, старые вытесняются (версий и неудач немного). */
export const DISMISSED_MAX = 20
export function addDismissed(list: readonly string[], key: string): string[] {
  return [...list.filter((k) => k !== key), key].slice(-DISMISSED_MAX)
}

/** Отказ `update.apply` со старой оболочкой: метода нет в её белом списке — подсказка, как обновиться иначе. */
export function applyErrorText(code: string | null, message: string): string {
  if (code === 'method_not_allowed') return 'Это окно не умеет запускать обновление (оболочка старше 0.1.14) — в терминале: pult update'
  return `Обновление не запустилось: ${message}`
}
