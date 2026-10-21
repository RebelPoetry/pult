import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { connView, DAEMON_DOWN, formatUptime } from '../src/lib/conn.js'

describe('connView', () => {
  it('демон на связи — зелёный, без плашки', () => {
    const v = connView({ state: 'up', daemon: { version: '0.1.0', pid: 42, startedAt: 'x' } })
    assert.equal(v.tone, 'ok')
    assert.equal(v.banner, null)
    assert.match(v.label, /0\.1\.0/)
  })

  it('демона нет — плашка со временем повтора, причина — отдельно (в подсказку)', () => {
    const v = connView({ state: 'down', reason: 'сокет не отвечает', attempt: 2, retryInMs: 1500 })
    assert.equal(v.tone, 'fail')
    assert.equal(v.label, DAEMON_DOWN)
    assert.equal(v.banner, 'Переподключаюсь через 2 с.')
    assert.equal(v.reason, 'сокет не отвечает')
  })

  it('повтора нет (демона остановили кнопкой) — ждём кнопку', () => {
    const v = connView({ state: 'down', reason: 'остановлен', attempt: 0, retryInMs: null })
    assert.match(v.banner ?? '', /кнопкой/)
  })
})

describe('formatUptime', () => {
  it('секунды, минуты, часы, дни', () => {
    assert.equal(formatUptime(5_000), '5 с')
    assert.equal(formatUptime(125_000), '2 мин')
    assert.equal(formatUptime(3 * 3600_000 + 5 * 60_000), '3 ч 5 мин')
    assert.equal(formatUptime(50 * 3600_000), '2 дн 2 ч')
    assert.equal(formatUptime(-1), '—')
  })
})
