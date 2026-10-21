import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isNotifyKind, NOTIFY_SOUNDS, notificationSound } from '../../src/notifySound.js'

describe('звук уведомления по виду (О2)', () => {
  it('вопрос, готово, ошибка — свои звуки; вопрос не тот же, что «готово»', () => {
    assert.deepEqual(notificationSound('ask', true), { sound: 'Glass', silent: false })
    assert.deepEqual(notificationSound('done', true), { sound: 'Pop', silent: false })
    assert.deepEqual(notificationSound('error', true), { sound: 'Basso', silent: false })
    assert.equal(new Set(Object.values(NOTIFY_SOUNDS)).size, 3)
  })
  it('звук выключен — тихо при любом виде; вид неизвестен — звук системы', () => {
    for (const k of ['ask', 'done', 'error', null, 'x']) assert.deepEqual(notificationSound(k, false), { silent: true })
    for (const k of [null, undefined, 'boom', 42]) assert.deepEqual(notificationSound(k, true), {})
    assert.deepEqual(notificationSound('ask', undefined), { sound: 'Glass', silent: false }, 'старое окно без флага — со звуком')
    assert.equal(isNotifyKind('ask'), true)
    assert.equal(isNotifyKind('stalled'), false)
  })
})
