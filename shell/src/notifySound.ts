// Звук системного уведомления по виду (О2, docs/14 «Правила уведомлений»; звук настраивается, как у
// Conductor и OpenCode). Вопрос — громче и заметнее всего: без человека сессия стоит. «Готово» — тихий
// щелчок. Ошибка — глухой «Basso», его не спутать ни с чем. Имена — системные звуки macOS
// (/System/Library/Sounds), их понимает `new Notification({ sound })`. Звук выключен (`notify.sound: false`
// в config.json демона) — уведомление тихое (`silent`). Вид неизвестен (старое окно) — как раньше, звук
// системы по умолчанию.

import type { NotifyKind } from './contract.js'

export const NOTIFY_SOUNDS: Readonly<Record<NotifyKind, string>> = {
  ask: 'Glass',
  done: 'Pop',
  error: 'Basso',
}

export function isNotifyKind(x: unknown): x is NotifyKind {
  return x === 'ask' || x === 'done' || x === 'error'
}

/** Параметры звука для `new Notification(...)`: имя звука, тишина или ничего (звук системы). */
export function notificationSound(kind: unknown, sound: unknown): { sound?: string; silent?: boolean } {
  if (sound === false) return { silent: true }
  if (!isNotifyKind(kind)) return {}
  return { sound: NOTIFY_SOUNDS[kind], silent: false }
}
