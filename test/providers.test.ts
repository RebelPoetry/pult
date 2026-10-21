import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createProviderCatalog, parseCodexModels } from '../dist/env/providers.js'

it('model catalog preserves per-model efforts and filters hidden or malformed models', () => {
  assert.deepEqual(parseCodexModels([
    { model: 'fast', displayName: 'Fast', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low', isDefault: true },
    { model: 'hidden', hidden: true }, { model: 3 }, null,
  ]), [{ id: 'fast', label: 'Fast', efforts: ['low'], defaultEffort: 'low', isDefault: true }])
})

it('readiness distinguishes missing CLI, logged-out account and available app-server without returning auth output', async () => {
  const opts = { bins: { claude: 'claude', codex: 'codex' }, cwd: '/tmp', env: {}, models: async () => [] }
  const catalog = createProviderCatalog({ ...opts, run: async (bin) => bin === 'claude'
    ? { status: 1, stdout: '{"loggedIn":false,"email":"private@example.org"}', stderr: '' }
    : { status: 0, stdout: '', stderr: 'Logged in using ChatGPT' } })
  const checked = await catalog.check()
  assert.equal(checked.claude.state, 'login_required')
  assert.equal(checked.codex.state, 'ready')
  assert.equal(JSON.stringify(checked).includes('private@example.org'), false)
  const absent = await createProviderCatalog({ ...opts, run: async () => ({ status: null, stdout: '', stderr: '', error: 'spawn ENOENT' }) }).check()
  assert.equal(absent.codex.state, 'unavailable')
})

it('concurrent checks share one auth and model request and app-server failures are visible', async () => {
  let calls = 0
  const catalog = createProviderCatalog({ bins: { claude: 'claude', codex: 'codex' }, cwd: '/tmp', env: {},
    run: async (bin) => { calls++; return { status: 0, stdout: bin === 'claude' ? '{"loggedIn":true}' : 'Logged in using ChatGPT', stderr: '' } },
    models: async () => { throw new Error('secret raw transport error') } })
  const first = catalog.check()
  assert.equal(first, catalog.check())
  assert.equal((await first).codex.state, 'error')
  assert.equal(calls, 2)
})
