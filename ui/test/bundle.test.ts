// Сборка интерфейса: CSP дословно из docs/12 §2 и в исходном index.html, и в собранном; статика
// самодостаточна (шрифты и их лицензии рядом); в бандле нет ни одного обращения в сеть.

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CSP } from '../../shell/src/contract.js'

const root = (p: string): string => fileURLToPath(new URL(`../${p}`, import.meta.url))
const cspOf = (html: string): string | undefined =>
  /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1]

describe('dist/ui', () => {
  it('CSP в ui/index.html и dist/ui/index.html — дословно docs/12 §2', () => {
    const doc = readFileSync(root('docs/12-PLAN-F2.md'), 'utf8')
    assert.ok(doc.includes(`\`${CSP}\``), 'CSP из контракта дословно стоит в docs/12')
    assert.equal(cspOf(readFileSync(root('ui/index.html'), 'utf8')), CSP)
    assert.equal(cspOf(readFileSync(root('dist/ui/index.html'), 'utf8')), CSP)
  })

  it('есть index.html, app.js, app.css и 12 woff2 с лицензиями OFL', () => {
    for (const f of ['index.html', 'app.js', 'app.css', 'fonts/LICENSES.md']) assert.ok(existsSync(root(`dist/ui/${f}`)), f)
    const fonts = readdirSync(root('dist/ui/fonts'))
    assert.equal(fonts.filter((f) => f.endsWith('.woff2')).length, 12)
    assert.equal(fonts.filter((f) => f.endsWith('-OFL.txt')).length, 3)
  })

  it('MIT вшитого в app.js: полные тексты лицензий рядом и заголовки @license в конце бандла', () => {
    for (const pkg of ['react', 'react-dom', 'scheduler']) {
      const lic = readFileSync(root(`dist/ui/${pkg}-LICENSE.txt`), 'utf8')
      assert.match(lic, /MIT License/, pkg)
      assert.match(lic, /Meta Platforms/, pkg)
    }
    assert.match(readFileSync(root('dist/ui/app.js'), 'utf8'), /@license React/)
  })

  it('каждый url() в app.css указывает на файл внутри dist/ui', () => {
    const css = readFileSync(root('dist/ui/app.css'), 'utf8')
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]!.replace(/["']/g, ''))
    assert.ok(urls.length >= 12)
    for (const u of urls) {
      assert.doesNotMatch(u, /^(https?:|\/\/|\/)/, `внешний или абсолютный url: ${u}`)
      assert.ok(existsSync(root(`dist/ui/${u}`)), `нет файла ${u}`)
    }
  })

  it('в бандле нет адресов сети и шрифтов Google', () => {
    const js = readFileSync(root('dist/ui/app.js'), 'utf8')
    const css = readFileSync(root('dist/ui/app.css'), 'utf8')
    for (const s of [js, css]) {
      assert.doesNotMatch(s, /fonts\.googleapis|fonts\.gstatic/)
    }
  })
})
