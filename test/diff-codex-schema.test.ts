// scripts/diff-codex-schema.mjs — сверка двух слепков схемы codex app-server «для адаптера».
// Скрипт ручной, но на него ссылается совет `pult doctor` при дрейфе схемы: если он молчит об
// изменении в методе, который адаптер зовёт, дрейф пропускается. Гоняем на копии настоящего
// слепка 0.155 из spike/ во временных папках; codex не запускается.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/diff-codex-schema.mjs', import.meta.url))
const SNAPSHOT = fileURLToPath(new URL('../spike/codex/schema/0.155.0-alpha.9.2/experimental/codex_app_server_protocol.schemas.json', import.meta.url))
const FILE = 'codex_app_server_protocol.schemas.json'

describe('diff-codex-schema', () => {
  it('ловит изменение ответа account/rateLimits/read, у которого params — anyOf, а не $ref', () => {
    const root = mkdtempSync(join(tmpdir(), 'pult-dcs-'))
    try {
      const text = readFileSync(SNAPSHOT, 'utf8')
      const schema = JSON.parse(text) as { definitions: { v2: Record<string, { properties: Record<string, unknown>; required?: string[] }> } }
      const resp = schema.definitions.v2['GetAccountRateLimitsResponse']
      assert.ok(resp?.properties['rateLimits'], 'в слепке 0.155 нет GetAccountRateLimitsResponse.rateLimits — тест устарел')
      // Адаптер (adapter.ts) читает `rateLimits` — поле пропало, появилось обязательное новое.
      delete resp.properties['rateLimits']
      resp.properties['zzz'] = { type: 'string' }
      resp.required = [...(resp.required ?? []), 'zzz']
      const [a, b] = ['old', 'new'].map((n) => { const d = join(root, n); mkdirSync(d); return d })
      writeFileSync(join(a!, FILE), text)
      writeFileSync(join(b!, FILE), JSON.stringify(schema))
      const r = spawnSync(process.execPath, [SCRIPT, a!, b!], { encoding: 'utf8', timeout: 60_000 })
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /v2\/GetAccountRateLimitsResponse/)
      assert.doesNotMatch(r.stdout, /изменилось: 0/)
      assert.doesNotMatch(r.stdout, /для адаптера ничего/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('метод с params без ссылки (инлайн-объект) — не «для адаптера ничего» и код выхода 1', () => {
    const root = mkdtempSync(join(tmpdir(), 'pult-dcs-'))
    try {
      const text = readFileSync(SNAPSHOT, 'utf8')
      type Variant = { properties: { method: { enum: string[] }; params?: unknown } }
      const withInline = (type: string): string => {
        const schema = JSON.parse(text) as { definitions: { ClientRequest: { oneOf: Variant[] } } }
        const v = schema.definitions.ClientRequest.oneOf.find((x) => x.properties.method.enum[0] === 'turn/interrupt')
        assert.ok(v, 'в слепке 0.155 нет turn/interrupt — тест устарел')
        // Форма params реально меняется между версиями, но ссылки нет — сверять нечего.
        v.properties.params = { type: 'object', properties: { x: { type } } }
        return JSON.stringify(schema)
      }
      const [a, b] = ['old', 'new'].map((n) => { const d = join(root, n); mkdirSync(d); return d })
      writeFileSync(join(a!, FILE), withInline('string'))
      writeFileSync(join(b!, FILE), withInline('integer'))
      const r = spawnSync(process.execPath, [SCRIPT, a!, b!], { encoding: 'utf8', timeout: 60_000 })
      assert.match(r.stdout, /форма не сверена: ClientRequest turn\/interrupt/)
      assert.doesNotMatch(r.stdout, /для адаптера ничего/)
      assert.equal(r.status, 1, r.stdout)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
