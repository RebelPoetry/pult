import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { LSREGISTER, appsToUnregister, isInstalledApp, unregisterApps } from '../../scripts/lsregister.mjs'

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts')

describe('check-app: уборка в LaunchServices (lsregister -u)', () => {
  const home = '/Users/user'
  const out = '/repo/shell/out/mac-arm64/Pult.app'
  const copy = '/var/folders/xy/0000000000000000000000gn/T/pa-abc/tampered/Pult.app'

  it('снимает проверенную сборку и временную копию, в порядке запуска', () => {
    assert.deepEqual(appsToUnregister({ app: out, launched: true, created: [copy], home }), [out, copy])
  })
  it('без --launch приложение не запускалось — снимать нечего, кроме созданного', () => {
    assert.deepEqual(appsToUnregister({ app: out, launched: false, created: [], home }), [])
    assert.deepEqual(appsToUnregister({ app: out, launched: false, created: [copy], home }), [copy])
  })
  it('поставленное приложение (/Applications, ~/Applications) не снимается никогда: у него pult://', () => {
    assert.deepEqual(appsToUnregister({ app: '/Applications/Pult.app', launched: true, created: [copy], home }), [copy])
    assert.deepEqual(appsToUnregister({ app: '/Users/user/Applications/Pult.app', launched: true, home }), [])
    assert.equal(isInstalledApp('/Applications/Pult.app', home), true)
    assert.equal(isInstalledApp('/Applications-old/Pult.app', home), false)
    assert.equal(isInstalledApp('/Users/user/Applications/Pult.app', home), true)
    assert.equal(isInstalledApp(out, home), false)
  })
  it('пути абсолютные и без дублей', () => {
    const rel = appsToUnregister({ app: 'out/mac-arm64/Pult.app', launched: true, created: [path.resolve('out/mac-arm64/Pult.app')], home })
    assert.deepEqual(rel, [path.resolve('out/mac-arm64/Pult.app')])
  })
  it('unregisterApps зовёт lsregister -u по каждому пути, ошибка одного не останавливает остальные', () => {
    const calls: Array<[string, string[]]> = []
    const res = unregisterApps([out, copy], (file, args) => {
      calls.push([file, args])
      if (args[1] === out) throw new Error('boom\nstack')
      return ''
    })
    assert.deepEqual(calls, [[LSREGISTER, ['-u', out]], [LSREGISTER, ['-u', copy]]])
    assert.deepEqual(res, [{ path: out, ok: false, error: 'boom' }, { path: copy, ok: true }])
    assert.match(LSREGISTER, /LaunchServices\.framework\/Support\/lsregister$/)
  })
  it('check-app снимает с учёта в finally и ДО удаления временного дома; копию помнит до cp', () => {
    const src = readFileSync(path.join(SCRIPTS, 'check-app.mjs'), 'utf8')
    const fin = src.slice(src.lastIndexOf('} finally {'))
    const unreg = fin.indexOf('unregisterApps(appsToUnregister(')
    assert.ok(unreg > 0, 'нет уборки lsregister в finally')
    assert.ok(unreg < fin.indexOf('rmSync(home'), 'lsregister -u должен идти до rmSync(home)')
    assert.match(fin, /created: createdApps/)
    assert.ok(src.indexOf('createdApps.push(copy)') < src.indexOf("execFileSync('cp', ['-Rc', APP, copy])"))
  })
})
