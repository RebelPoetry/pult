// Чистые части замера В5 (scripts/measure-f1-lib.mjs). Сам замер ходит в настоящие CLI и
// запускается лидом один раз; здесь — решения, от которых зависит честность его цифр:
// страж перед шагом, «первое событие хода», какие папки ~/.claude/projects сносить, перекрёстный
// ответ и таблица отчёта. Ни сети, ни процессов модели.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const LIB_URL = new URL('../scripts/measure-f1-lib.mjs', import.meta.url).href
const SCRIPT = fileURLToPath(new URL('../scripts/measure-f1.mjs', import.meta.url))

const lib: any = await import(LIB_URL)

const check = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ok: true, loc: 'FI', reason: 'ok', ...over })

describe('замер В5: страж перед шагом', () => {
  it('известная страна вне списка-стража — идём', () => {
    assert.deepEqual(lib.guardDecision(check(), ['RU']), { go: true, why: 'выход FI' })
  })
  it('RU — стоп, даже если check.ok почему-то true', () => {
    const d = lib.guardDecision(check({ loc: 'RU' }), ['RU'])
    assert.equal(d.go, false)
    assert.match(d.why, /RU в списке-страже/)
  })
  it('страна неизвестна (null, пусто, мусор) — стоп', () => {
    for (const loc of [null, '', 'unknown', 'X', undefined]) {
      assert.equal(lib.guardDecision(check({ loc }), ['RU']).go, false, `loc=${String(loc)}`)
    }
  })
  it('страж демона отказал (прокси мёртв) — стоп, причина названа', () => {
    const d = lib.guardDecision(check({ ok: false, reason: 'proxy_dead' }), ['RU'])
    assert.deepEqual(d, { go: false, why: 'страж отказал: proxy_dead' })
  })
  it('проверки нет вовсе — стоп', () => {
    assert.equal(lib.guardDecision(null, ['RU']).go, false)
  })
  it('регистр страны и списка не важен', () => {
    assert.equal(lib.guardDecision(check({ loc: 'ru' }), ['Ru']).go, false)
  })
})

describe('замер В5: чистые расчёты', () => {
  it('p50 — медиана, пусто — null, мусор отбрасывается', () => {
    assert.equal(lib.p50([3000, 1000, 2000]), 2000)
    assert.equal(lib.p50([1000, 2000]), 1500)
    assert.equal(lib.p50([]), null)
    assert.equal(lib.p50([NaN, 5, undefined]), 5)
  })

  it('первое событие хода: только после курсора, daemon.* не в счёт, модель — отдельно', () => {
    const t0 = Date.parse('2026-09-28T10:00:00.000Z')
    const ev = (id: number, ms: number, kind: string): Record<string, unknown> => ({ id, ts: new Date(t0 + ms).toISOString(), kind })
    const events = [
      ev(5, -500, 'message.done'), // до курсора — прошлый ход
      ev(12, 900, 'status.changed'),
      ev(11, 300, 'daemon.started'),
      ev(14, 2400, 'message.done'),
      ev(13, 1800, 'tool.called'),
    ]
    assert.deepEqual(lib.firstEventTimes(events, 10, t0), { firstEventMs: 900, firstModelMs: 1800, firstKind: 'status.changed' })
    assert.deepEqual(lib.firstEventTimes([], 0, t0), { firstEventMs: null, firstModelMs: null, firstKind: null })
  })

  it('первое событие хода: событие ДО отправки реплики не в счёт, даже если его id после курсора', () => {
    // Курсор 0 (status после рестарта не ответил) — `read --since 0` вернёт и прошлый ход.
    // Раньше его время прижималось к 0 и замер «мерил» 0.00 с как ok.
    const t0 = Date.parse('2026-09-28T10:00:00.000Z')
    const ev = (id: number, ms: number, kind: string): Record<string, unknown> => ({ id, ts: new Date(t0 + ms).toISOString(), kind })
    const old = [ev(3, -9000, 'status.changed'), ev(4, -8000, 'message.done')]
    assert.deepEqual(lib.firstEventTimes(old, 0, t0), { firstEventMs: null, firstModelMs: null, firstKind: null })
    assert.deepEqual(lib.firstEventTimes([...old, ev(9, 700, 'message.delta')], 0, t0), { firstEventMs: 700, firstModelMs: 700, firstKind: 'message.delta' })
  })

  it('выигрыш тёплого процесса: справочная строка, ok при обеих целых сериях независимо от знака', () => {
    const NOTE = 'справочно: p50 --resume − p50 --warm; ≤ 0 — тёплый процесс не быстрее процесса на ход (решение лида 28.09.2026)'
    assert.deepEqual(lib.warmGain({ warmP50: 2000, coldP50: 3500, warmFail: null, coldFail: null }), { value: 1500, ok: true, note: NOTE })
    // Отрицательный выигрыш при обеих целых сериях — не провал (решение лида 28.09.2026): на
    // Claude Code 2.1.283 --resume бывает быстрее тёплого процесса, это справочный факт, не гейт.
    const slower = lib.warmGain({ warmP50: 4000, coldP50: 3000, warmFail: null, coldFail: null })
    assert.equal(slower.value, -1000)
    assert.equal(slower.ok, true, 'тёплый медленнее — но серии целые, строка справочная')
    assert.equal(slower.note, NOTE)
    const partial = lib.warmGain({ warmP50: 1000, coldP50: 3000, warmFail: 'код 1: упал', coldFail: null })
    assert.equal(partial.ok, false, 'серия оборвалась — выигрыш посчитан по огрызку')
    assert.equal(partial.note, 'код 1: упал')
    assert.equal(lib.warmGain({ warmP50: null, coldP50: 3000, warmFail: null, coldFail: 'нет' }).value, null)
    assert.equal(lib.warmGain({ warmP50: null, coldP50: 3000, warmFail: null, coldFail: null }).ok, false, 'p50 не посчитан — не ok')
  })

  it('ждём ухода демона с потолком: успел выйти — не жив; не успел — жив', async () => {
    let calls = 0
    const naps: number[] = []
    const sleep = async (ms: number): Promise<void> => { naps.push(ms) }
    // Жив первые три опроса (lock снят, процесс ещё выходит), потом ушёл.
    assert.equal(await lib.waitGone(() => ++calls <= 3, { timeoutMs: 3000, stepMs: 100, sleep }), false)
    assert.equal(calls, 4)
    const stuck = await lib.waitGone(() => true, { timeoutMs: 300, stepMs: 100, sleep, now: ((t) => () => (t += 100))(0) })
    assert.equal(stuck, true)
  })

  it('NDJSON событий: битые строки пропускаются', () => {
    assert.deepEqual(lib.parseEventLines('{"id":1}\nмусор\n\n{"id":2}\n'), [{ id: 1 }, { id: 2 }])
  })

  it('перекрёстный ответ ловится в обе стороны', () => {
    assert.equal(lib.crossTalk('MARK-A-1', 'MARK-A-1', 'MARK-B-2', 'MARK-B-2').ok, true)
    const swapped = lib.crossTalk('MARK-B-2', 'MARK-A-1', 'MARK-A-1', 'MARK-B-2')
    assert.equal(swapped.ok, false)
    assert.equal(swapped.foreign, true)
    const both = lib.crossTalk('MARK-A-1 MARK-B-2', 'MARK-A-1', 'MARK-B-2', 'MARK-B-2')
    assert.equal(both.ok, false, 'чужой маркер в ответе — провал, даже если свой тоже есть')
    assert.equal(lib.crossTalk('', 'MARK-A-1', 'MARK-B-2', 'MARK-B-2').ownA, false)
  })
})

describe('замер В5: уборка ~/.claude/projects', () => {
  const work = '/private/var/folders/xy/T/pult-mf-Ab12Cd'
  const ours = lib.claudeProjectDirName(`${work}/wa-Zz9`)

  it('имя папки разговоров — cwd, где всё кроме букв и цифр стало «-»', () => {
    assert.equal(lib.claudeProjectDirName('/Users/user/src/pult'), '-Users-user-src-pult')
    assert.equal(ours, '-private-var-folders-xy-T-pult-mf-Ab12Cd-wa-Zz9')
  })

  it('сносится только НОВАЯ папка С НАШИМ именем', () => {
    const before = ['-Users-user-src-pult', '-private-var-folders-xy-T-pult-mf-Ab12Cd-old']
    const after = [...before, ours, '-Users-user-other-project-opened-meanwhile']
    assert.deepEqual(lib.projectsToClean(before, after, ['pult-mf-Ab12Cd']), [ours])
  })

  it('короткий или пустой токен не сносит ничего (иначе «-» совпал бы со всем)', () => {
    assert.deepEqual(lib.projectsToClean([], [ours, '-a-b'], ['', '-', 'pult']), [])
  })
})

describe('замер В5: таблица отчёта', () => {
  const meta = { date: '2026-09-28 10:00 UTC', versions: { claude: '2.1.283', codex: 'codex-cli 0.158.0-alpha.2.1' }, egress: 'выход FI' }
  const rows = [
    { step: 'a', provider: 'claude', metric: 'тёплая реплика, p50 из 3', value: 2150, unit: 'ms', ok: true, note: 'цель В2: < 3 с' },
    { step: 'c', provider: 'claude+codex', metric: 'ускорение', value: 1.8765, unit: 'x', ok: true },
    { step: 'b', provider: 'codex', metric: 'разговор пережил рестарт', value: false, unit: 'bool', ok: false, note: 'a|b' },
    { step: 'b', provider: 'claude', metric: 'до первого события', value: null, unit: 'ms', ok: false },
  ]

  it('значения форматируются, провал виден, «|» в тексте не ломает таблицу', () => {
    const md = lib.renderMarkdown(rows, meta)
    assert.match(md, /^# Замеры приёмки Ф1 \(В5\)/)
    assert.match(md, /Итог: \*\*ПРОВАЛ: 2 из 4 строк\*\*/)
    assert.match(md, /\| a \| claude \| тёплая реплика, p50 из 3 \| 2\.15 с \| ok \| цель В2: < 3 с \|/)
    assert.match(md, /\| ×1\.88 \|/)
    assert.match(md, /\| нет \| \*\*ПРОВАЛ\*\* \| a\\\|b \|/)
    assert.match(md, /\| до первого события \| — \| \*\*ПРОВАЛ\*\* \|/)
    assert.match(md, /claude `2\.1\.283` · codex `codex-cli 0\.158\.0-alpha\.2\.1`/)
  })

  it('ни одной строки — ПРОВАЛ, а не «пройден: 0 из 0»; пройденные шаги названы', () => {
    assert.match(lib.renderMarkdown([], { ...meta, steps: [] }), /Итог: \*\*ПРОВАЛ: ни одной строки замера\*\*/)
    assert.match(lib.renderMarkdown(rows.slice(0, 2), { ...meta, steps: ['a'] }), /Итог: \*\*пройден \(шаги a\): 2 из 2 строк\*\*/)
    assert.equal(lib.exitCodeFor([], 0), 1)
    assert.equal(lib.exitCodeFor(rows.slice(0, 2), 0), 0)
    assert.equal(lib.exitCodeFor(rows, 0), 1)
    assert.equal(lib.exitCodeFor(rows.slice(0, 2), 4), 4, 'код стража не перетирается')
  })

  it('все строки ok — «пройден»; прерванный стражем — «ПРЕРВАН», даже без провалов', () => {
    const okRows = rows.slice(0, 2)
    assert.match(lib.renderMarkdown(okRows, meta), /Итог: \*\*пройден: 2 из 2 строк\*\*/)
    assert.match(lib.renderMarkdown(okRows, { ...meta, aborted: 'страж: b/claude: выход RU в списке-страже' }), /Итог: \*\*ПРЕРВАН: страж: b\/claude: выход RU/)
  })
})

describe('замер В5: разбор --only и прерывание', () => {
  it('--only: только a, b, c; пусто и мусор — ошибка', () => {
    assert.deepEqual(lib.parseOnly(null), { steps: ['a', 'b', 'c'] })
    assert.deepEqual(lib.parseOnly('c, a'), { steps: ['a', 'c'] })
    for (const bad of ['A', 'x', '', '--no-write', 'a,d']) {
      assert.ok('error' in lib.parseOnly(bad), `--only ${bad} принят`)
    }
  })

  it('SIGINT/SIGTERM: уборка идёт один раз, потом выход 130/143', async () => {
    const { EventEmitter } = await import('node:events')
    const proc = new EventEmitter()
    let cleaned = 0
    const exits: number[] = []
    const got: string[] = []
    const cleanup = lib.onceAsync(async () => { cleaned++ })
    lib.trapSignals(proc, { cleanup, onSignal: (s: string) => got.push(s), exit: (c: number) => exits.push(c) })
    proc.emit('SIGINT')
    await lib.waitGone(() => exits.length === 0, { timeoutMs: 1000, stepMs: 5 })
    assert.deepEqual(got, ['SIGINT'])
    assert.deepEqual(exits, [130])
    await cleanup()
    assert.equal(cleaned, 1, 'finally после сигнала не убирает второй раз')
    proc.emit('SIGTERM')
    await lib.waitGone(() => exits.length === 1, { timeoutMs: 1000, stepMs: 5 })
    assert.deepEqual(exits, [130, 143])
    assert.equal(cleaned, 1)
    assert.equal(proc.listenerCount('SIGINT'), 0, 'второй Ctrl+C — обычное убийство, без нашей ловушки')
  })
})

describe('замер В5: сам скрипт', () => {
  it('неизвестный шаг в --only — отказ кодом 2 ДО любого запуска, а не «пройден: 0 из 0»', () => {
    for (const args of [['--only', 'A'], ['--only=x'], ['--only', '--no-write']]) {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], {
        env: { ...process.env, PULT_TEST: '1' },
        encoding: 'utf8',
        timeout: 20_000,
      })
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`)
      assert.match(r.stderr, /--only принимает a,b,c/)
      assert.equal(r.stdout, '')
    }
  })

  it('под PULT_TEST=1 отказывается сразу — фальшивые CLI дали бы выдуманные цифры', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--no-write'], {
      env: { ...process.env, PULT_TEST: '1' },
      encoding: 'utf8',
      timeout: 20_000,
    })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /PULT_TEST=1 — замер идёт только на настоящих CLI/)
    assert.equal(r.stdout, '', 'ни одной строки замера')
  })
})
