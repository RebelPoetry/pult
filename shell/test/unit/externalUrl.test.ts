import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { externalUrl, MAX_URL_LEN } from '../../src/externalUrl.js'

describe('ссылка из окна во внешний браузер', () => {
  it('http, https и mailto проходят, адрес нормализован', () => {
    assert.equal(externalUrl('https://example.com'), 'https://example.com/')
    assert.equal(externalUrl('http://example.com/a?b=1#c'), 'http://example.com/a?b=1#c')
    assert.equal(externalUrl('  https://пример.рф/путь '), 'https://xn--e1afmkfd.xn--p1ai/%D0%BF%D1%83%D1%82%D1%8C')
    assert.equal(externalUrl('mailto:a@example.net'), 'mailto:a@example.net')
  })
  it('опасные и чужие схемы — отказ', () => {
    for (const u of ['javascript:alert(1)', 'JavaScript:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>x</b>', 'smb://host/share',
      'vscode://file/x', 'pult-app://app/index.html', 'ftp://x.y/z', 'about:blank']) {
      assert.equal(externalUrl(u), null, u)
    }
  })
  it('не адрес, относительный путь, не строка — отказ', () => {
    for (const u of ['', 'src/main.ts', '/etc/passwd', '//example.com', 'example.com', 'https://', 'http:', 'mailto:', 42, null, undefined, {}]) {
      assert.equal(externalUrl(u), null, String(u))
    }
  })
  it('логин-пароль в адресе, NUL и слишком длинный адрес — отказ', () => {
    assert.equal(externalUrl('https://bank.example.com@evil.example.org/'), null)
    assert.equal(externalUrl('https://u:p@example.com/'), null)
    assert.equal(externalUrl('https://example.com/\0x'), null)
    assert.equal(externalUrl(`https://example.com/${'a'.repeat(MAX_URL_LEN)}`), null)
    assert.ok(externalUrl(`https://example.com/${'a'.repeat(MAX_URL_LEN - 30)}`))
  })
})
