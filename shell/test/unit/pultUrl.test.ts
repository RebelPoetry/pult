import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  checkPultUrl, LinkGate, LinkRate, linkFromArgv, linkTarget, matchKnownPath, MAX_PATH, MAX_PROMPT, MAX_PROMPT_LINES, MAX_URL_LEN,
  parsePultUrl, SESSION_NAME_RE,
} from '../../src/pultUrl.js'

// dist-test/unit → shell → корень рабочей копии.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const enc = encodeURIComponent

describe('ссылка pult://session/<имя>', () => {
  it('годное имя — переход к сессии', () => {
    assert.deepEqual(parsePultUrl('pult://session/alpha'), { type: 'session', name: 'alpha' })
    assert.deepEqual(parsePultUrl('pult://session/a-b_9/'), { type: 'session', name: 'a-b_9' })
    // Схема и вид — без учёта регистра (так их пишут в заметках), имя — строго.
    assert.deepEqual(parsePultUrl('PULT://Session/alpha'), { type: 'session', name: 'alpha' })
    // Неизвестные параметры молча пропускаются.
    assert.deepEqual(parsePultUrl('pult://session/alpha?from=raycast'), { type: 'session', name: 'alpha' })
  })
  it('имя не по правилу демона — отказ', () => {
    for (const u of ['pult://session', 'pult://session/', 'pult://session/Alpha', 'pult://session/9x', 'pult://session/a.b',
      'pult://session/' + 'a'.repeat(33), 'pult://session/a/b', 'pult://session/../x', 'pult://session/%2E%2E', 'pult://session/a%2Fb',
      'pult://session/%61lpha', 'pult://session/al pha', 'pult://session//alpha']) {
      assert.equal(parsePultUrl(u), null, u)
    }
  })
  it('правило имени — то же, что у демона', () => {
    const src = readFileSync(path.join(REPO, 'src', 'sessions', 'registry.ts'), 'utf8')
    const m = /export const SESSION_NAME_RE = (\/.+\/)\s*$/m.exec(src)
    assert.ok(m, 'SESSION_NAME_RE не найден в src/sessions/registry.ts')
    assert.equal(SESSION_NAME_RE.toString(), m[1])
  })
})

describe('ссылка pult://new', () => {
  it('без параметров — пустой диалог', () => {
    assert.deepEqual(parsePultUrl('pult://new'), { type: 'new' })
    assert.deepEqual(parsePultUrl('pult://new/'), { type: 'new' })
    assert.deepEqual(parsePultUrl('pult://new?path=&prompt=&provider='), { type: 'new' })
  })
  it('папка, реплика и провайдер раскодированы; неизвестное пропущено', () => {
    const prompt = 'Почини тесты\nи «закоммить» — 100% & готово?'
    const u = `pult://new?path=${enc('/Users/user/Эхо Океана/')}&prompt=${enc(prompt)}&provider=codex&utm=raycast`
    assert.deepEqual(parsePultUrl(u), { type: 'new', path: '/Users/user/Эхо Океана', prompt, provider: 'codex' })
    // `+` остаётся `+` (правило форм `+` → пробел не действует): пробел — только `%20`.
    assert.deepEqual(parsePultUrl('pult://new?prompt=c++&provider=claude'), { type: 'new', prompt: 'c++', provider: 'claude' })
    assert.deepEqual(parsePultUrl('pult://new?prompt=1+1%3D2'), { type: 'new', prompt: '1+1=2' })
    assert.deepEqual(parsePultUrl('pult://new?prompt=hi%20there'), { type: 'new', prompt: 'hi there' })
    assert.deepEqual(parsePultUrl(`pult://new?path=${enc('/p/c++')}`), { type: 'new', path: '/p/c++' })
    assert.deepEqual(parsePultUrl('pult://new?path=/'), { type: 'new', path: '/' })
    assert.deepEqual(parsePultUrl('pult://new?path=/a/./b'), { type: 'new', path: '/a/./b' })
  })
  it('папка: только абсолютная, без .., без NUL и управляющих символов', () => {
    for (const p of ['relative/dir', '~/code', './x', '/a/../b', '/a/..', '../etc', '/a/b\0c', '/a\nb', '/a\tb', '/a\u007fb',
      '/' + 'a'.repeat(MAX_PATH)]) {
      const r = checkPultUrl(`pult://new?path=${enc(p)}`)
      assert.equal(r.ok, false, JSON.stringify(p))
    }
    // `..` внутри имени — не сегмент: такая папка законна.
    assert.deepEqual(parsePultUrl(`pult://new?path=${enc('/a/b..c/..d')}`), { type: 'new', path: '/a/b..c/..d' })
  })
  it('невидимые, форматирующие и управляющие символы: в папке — никакие, в реплике — только \\n и \\t', () => {
    // U+202E — разворот текста, U+200B — пробел нулевой ширины, U+FEFF — BOM, U+0085 и U+009B — C1,
    // U+2028/U+2029 — разделители строк и абзацев, U+00AD — мягкий перенос (Cf).
    for (const ch of ['\u202e', '\u200b', '\ufeff', '\u0085', '\u009b', '\u2028', '\u2029', '\u00ad', '\u2066']) {
      assert.equal(parsePultUrl(`pult://new?path=${enc(`/p/a${ch}b`)}`), null, `path U+${ch.codePointAt(0)?.toString(16)}`)
      assert.equal(parsePultUrl(`pult://new?prompt=${enc(`a${ch}b`)}`), null, `prompt U+${ch.codePointAt(0)?.toString(16)}`)
    }
    assert.equal(parsePultUrl(`pult://new?prompt=${enc('a\rb')}`), null, 'CR в реплике')
    assert.equal(parsePultUrl(`pult://new?path=${enc('/p/a\tb')}`), null, 'таб в папке')
    assert.deepEqual(parsePultUrl(`pult://new?prompt=${enc('a\n\tb')}`), { type: 'new', prompt: 'a\n\tb' })
  })
  it('реплика: до 200 строк', () => {
    const lines = (n: number): string => Array.from({ length: n }, (_, i) => `строка ${i}`).join('\n')
    assert.equal(parsePultUrl(`pult://new?prompt=${enc(lines(MAX_PROMPT_LINES))}`)?.type, 'new')
    assert.equal(parsePultUrl(`pult://new?prompt=${enc(lines(MAX_PROMPT_LINES + 1))}`), null)
    assert.equal(parsePultUrl(`pult://new?prompt=${enc('\n'.repeat(MAX_PROMPT_LINES))}`), null, 'пустые строки тоже строки')
  })
  it('битая процентная запись — отказ', () => {
    for (const u of ['pult://new?prompt=%E0%A4%A', 'pult://new?prompt=%zz', 'pult://new?pa%th=/a']) assert.equal(parsePultUrl(u), null, u)
  })
  it('реплика: до 10 000 знаков (кодовых точек), без NUL', () => {
    assert.equal(parsePultUrl(`pult://new?prompt=${enc('я'.repeat(MAX_PROMPT))}`)?.type, 'new')
    // Эмодзи — две единицы UTF-16, но один знак.
    assert.equal(parsePultUrl(`pult://new?prompt=${enc('🙂'.repeat(MAX_PROMPT))}`)?.type, 'new')
    assert.equal(parsePultUrl(`pult://new?prompt=${enc('я'.repeat(MAX_PROMPT + 1))}`), null)
    assert.equal(parsePultUrl('pult://new?prompt=a%00b'), null)
  })
  it('провайдер — только claude или codex', () => {
    for (const v of ['opencode', 'Claude', 'bash', 'claude;rm', '__proto__']) assert.equal(parsePultUrl(`pult://new?provider=${enc(v)}`), null, v)
  })
  it('повтор известного параметра — отказ: какой из двух показывать, неясно', () => {
    assert.equal(parsePultUrl('pult://new?path=/a&path=/b'), null)
    assert.equal(parsePultUrl('pult://new?prompt=a&prompt=b'), null)
    assert.equal(parsePultUrl('pult://new?provider=claude&provider=codex'), null)
  })
})

describe('чужие и злые ссылки', () => {
  it('не строка, пусто, не URL, чужая схема — отказ', () => {
    for (const u of [undefined, null, 42, {}, '', 'session/alpha', 'https://example.com', 'javascript:alert(1)', 'file:///etc/passwd',
      'pult-app://session/alpha', 'app://pult/index.html', 'pult:', 'pult://']) {
      assert.equal(parsePultUrl(u), null, String(u))
    }
  })
  it('не наш вид ссылки — отказ', () => {
    for (const u of ['pult:session/alpha', 'pult:///session/alpha', 'pult://start?name=x', 'pult://agent/alpha', 'pult://new/x?path=/a',
      'pult://sessions/alpha', ' pult://session/alpha']) {
      assert.equal(parsePultUrl(u), null, u)
    }
  })
  it('логин, пароль, порт, якорь — отказ', () => {
    for (const u of ['pult://u:p@session/alpha', 'pult://u@new', 'pult://new:80/', 'pult://session/alpha#x', 'pult://new?prompt=a#b',
      'pult://session:/alpha', 'pult://new:?path=/a', 'pult://@new', 'pult://session/alpha#']) {
      assert.equal(parsePultUrl(u), null, u)
    }
  })
  it('сырые NUL, перевод строки и таб в ссылке — отказ (new URL выбросил бы их молча)', () => {
    for (const u of ['pult://ses\nsion/alpha', 'pult://session/al\tpha', 'pult://new?prompt=a\0b', 'pult://new?path=/a\r']) {
      assert.equal(parsePultUrl(u), null, JSON.stringify(u))
    }
  })
  it('слишком длинная ссылка — отказ до разбора', () => {
    const r = checkPultUrl(`pult://new?prompt=${'a'.repeat(MAX_URL_LEN)}`)
    assert.deepEqual(r, { ok: false, reason: 'ссылка длиннее предела' })
  })
  it('причина отказа есть, а самой ссылки в ней нет', () => {
    const r = checkPultUrl(`pult://new?path=${enc('/a/../secret-token-123')}`)
    assert.equal(r.ok, false)
    assert.ok(!r.ok && !r.reason.includes('secret'))
  })
})

describe('цель окна, argv и ворота холодного старта', () => {
  it('ссылка → кадр navigate', () => {
    assert.deepEqual(linkTarget({ type: 'session', name: 'alpha' }), { sessionId: 'alpha', link: true })
    assert.deepEqual(linkTarget({ type: 'new', path: '/a', provider: 'codex' }), { newSession: { path: '/a', provider: 'codex' }, link: true })
    assert.deepEqual(linkTarget({ type: 'new' }), { newSession: {}, link: true })
  })
  it('ссылка из argv: первый аргумент со схемой pult:', () => {
    assert.equal(linkFromArgv(['/Applications/Pult.app/Contents/MacOS/Pult', '--flag', 'pult://session/a', 'pult://new']), 'pult://session/a')
    assert.equal(linkFromArgv(['electron', '/shell', 'PULT://new']), 'PULT://new')
    assert.equal(linkFromArgv(['electron', '/shell', '--use-mock-keychain']), null)
    assert.equal(linkFromArgv(['--x=pult://session/a', 'pultd']), null)
  })
  it('до open() держится последняя ссылка, после — идёт сразу; вытесненная и потерянная — в onDrop', () => {
    const got: string[] = []
    const drops: string[] = []
    const g = new LinkGate<string>((t) => got.push(t), (why) => drops.push(why))
    g.offer('a')
    g.offer('b')
    assert.deepEqual(got, [])
    assert.deepEqual(drops, ['overwritten'])
    g.open()
    assert.deepEqual(got, ['b'])
    g.offer('c')
    assert.deepEqual(got, ['b', 'c'])
    const empty: string[] = []
    new LinkGate<string>((t) => empty.push(t)).open()
    assert.deepEqual(empty, [])
    // Окно не поднялось: держимая ссылка потеряна — одна строка в лог; пустые ворота молчат.
    const lost: string[] = []
    const dead = new LinkGate<string>(() => assert.fail('доставки быть не должно'), (why) => lost.push(why))
    dead.drop()
    dead.offer('x')
    dead.drop()
    dead.drop()
    assert.deepEqual(lost, ['dropped'])
  })
  it('предел частоты: следующая ссылка раньше 1,5 с — отброшена, и отброшенная тоже сдвигает окно', () => {
    const r = new LinkRate(1500)
    assert.equal(r.allow(10_000), true)
    assert.equal(r.allow(11_000), false)
    assert.equal(r.allow(12_000), false, 'поток раз в секунду не проходит')
    assert.equal(r.allow(13_500), true)
    assert.equal(new LinkRate(0).allow(0), true)
  })
  it('папка ссылки — только знакомая: симлинки раскрыты с обеих сторон, наружу — путь демона', () => {
    // Мир: /link → /real/proj, /alias-proj → /real/proj, /real/other — чужая, /gone — нет на диске.
    const fs: Record<string, string> = { '/link': '/real/proj', '/alias-proj': '/real/proj', '/real/proj': '/real/proj', '/real/other': '/real/other' }
    const real = (p: string): string | null => fs[p] ?? null
    assert.equal(matchKnownPath('/link', ['/real/other', '/alias-proj'], real), '/alias-proj')
    assert.equal(matchKnownPath('/real/proj', ['/alias-proj'], real), '/alias-proj')
    assert.equal(matchKnownPath('/real/other', ['/alias-proj'], real), null, 'чужая папка')
    assert.equal(matchKnownPath('/gone', ['/gone'], real), null, 'папки нет на диске')
    assert.equal(matchKnownPath('/link', [], real), null)
    // Подпапка проекта — не проект: равенство, а не префикс.
    assert.equal(matchKnownPath('/real/proj/sub', ['/real/proj'], (p) => p), null)
  })
})
