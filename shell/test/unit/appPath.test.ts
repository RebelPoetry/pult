import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { appHeaders, mimeOf, resolveAppPath } from '../../src/appPath.js'
import { CSP } from '../../src/contract.js'

const ROOT = '/pkg/dist/ui'

describe('resolveAppPath', () => {
  it('корень и файлы внутри dist/ui', () => {
    assert.equal(resolveAppPath(ROOT, 'app://pult/'), '/pkg/dist/ui/index.html')
    assert.equal(resolveAppPath(ROOT, 'app://pult/index.html'), '/pkg/dist/ui/index.html')
    assert.equal(resolveAppPath(ROOT, 'app://pult/fonts/onest-latin-wght-normal.woff2'), '/pkg/dist/ui/fonts/onest-latin-wght-normal.woff2')
    assert.equal(resolveAppPath(ROOT, 'app://pult/app.js?v=1#x'), '/pkg/dist/ui/app.js')
  })

  it('точки-сегменты парсер URL схлопывает сам: результат остаётся внутри корня', () => {
    // `%2e%2e` — это `..` для WHATWG URL: путь схлопнется до /package.json ВНУТРИ dist/ui (там его нет — 404).
    assert.equal(resolveAppPath(ROOT, 'app://pult/%2e%2e/%2e%2e/package.json'), '/pkg/dist/ui/package.json')
    assert.equal(resolveAppPath(ROOT, 'app://pult/../../../etc/passwd'), '/pkg/dist/ui/etc/passwd')
    assert.equal(resolveAppPath(ROOT, 'app://pult/%2F%2Fetc%2Fpasswd'), '/pkg/dist/ui/etc/passwd')
  })

  it('выход за корень после декодирования — отказ в любом написании', () => {
    for (const u of [
      'app://pult/..%2f..%2fpackage.json',
      'app://pult/fonts/%2e%2e%2f%2e%2e%2fcli%2fmain.js',
      'app://pult/a%5c..%5c..%5cx',
      'app://pult/x%00.js',
      'app://pult/%E0%A4%A',
    ]) assert.equal(resolveAppPath(ROOT, u), null, u)
  })

  it('чужая схема или хост — отказ', () => {
    for (const u of ['file:///etc/passwd', 'app://evil/index.html', 'https://pult/index.html', 'не адрес']) {
      assert.equal(resolveAppPath(ROOT, u), null, u)
    }
  })
})

describe('mimeOf', () => {
  it('известные типы и отказ на прочие', () => {
    assert.equal(mimeOf('/a/index.html'), 'text/html; charset=utf-8')
    assert.equal(mimeOf('/a/app.js'), 'text/javascript; charset=utf-8')
    assert.equal(mimeOf('/a/x.woff2'), 'font/woff2')
    assert.equal(mimeOf('/a/x.node'), null)
    assert.equal(mimeOf('/a/Makefile'), null)
  })
})

describe('заголовки ответа app://', () => {
  it('CSP на КАЖДОМ ответе, а не только на html: svg/json, открытый во фрейме, иначе шёл бы без политики', () => {
    for (const f of ['index.html', 'app.js', 'app.css', 'x.svg', 'x.json', 'fonts/a.woff2']) {
      const h = appHeaders(mimeOf(f)!)
      assert.equal(h['content-security-policy'], CSP, f)
      assert.equal(h['x-content-type-options'], 'nosniff', f)
    }
  })
})
