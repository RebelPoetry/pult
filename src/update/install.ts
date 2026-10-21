// Установка версии из тарбола: чтение манифеста, npm в свой префикс, проверка результата.
// Перенос spike/env/update.mjs (проверка S9e) — с тем, что спайк измерил:
//   * `npm install --prefix <dir>` без `--global` кладёт пакет как в ПРОЕКТ (`<dir>/node_modules/.bin`),
//     раскладку `<dir>/bin` + `<dir>/lib/node_modules` даёт только `--global --prefix` (S9e-layout);
//   * локальный тарбол ставится без сети вовсе — даже с прокси на мёртвый порт (S9e-offline-deadproxy),
//     поэтому `--offline` ничего не ломает, а в CI гарантирует, что реестр не тронут;
//   * ставить надо в СВОЙ каталог, никогда поверх работающей версии: её файлы не меняются ни байтом
//     (S9e-norewrite), и откат — это только перестановка симлинка.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PultPaths } from '../core/paths.js'
import { buildChildEnv } from '../env/allowlist.js'
import { locateToolPath } from '../env/locate.js'
import { isVersionName } from './versions.js'

export class UpdateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UpdateError'
  }
}

export interface TarballManifest {
  name: string
  version: string
}

/**
 * Имя и версия — из `package/package.json` ВНУТРИ тарбола (`tar -xzOf`), а не из имени файла:
 * `pult-0.2.0.tgz` можно переименовать как угодно, а каталог версии обязан совпасть с тем, что
 * скажет сам пакет (иначе проверка `pult --version` после установки провалится на ровном месте).
 */
export function readTarballManifest(tgz: string, env: NodeJS.ProcessEnv = process.env): TarballManifest {
  if (!existsSync(tgz)) throw new UpdateError(`нет файла ${tgz}`)
  const r = spawnSync('tar', ['-xzOf', tgz, 'package/package.json'], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    // tar лежит в /usr/bin и на macOS, и на Linux; PATH — по белому списку плюс пол.
    env: buildChildEnv(env, { path: `${env['PATH'] ?? ''}:/usr/bin:/bin` }),
  })
  if (r.error || r.status !== 0) {
    const why = (r.stderr || r.error?.message || '').trim().split('\n')[0] ?? ''
    throw new UpdateError(`${tgz}: не тарбол npm-пакета (нет package/package.json)${why ? ` — ${why}` : ''}`)
  }
  let pkg: { name?: unknown; version?: unknown }
  try {
    pkg = JSON.parse(r.stdout) as { name?: unknown; version?: unknown }
  } catch {
    throw new UpdateError(`${tgz}: package/package.json не разбирается как JSON`)
  }
  const name = typeof pkg.name === 'string' ? pkg.name : ''
  const version = typeof pkg.version === 'string' ? pkg.version : ''
  if (name !== 'pult') throw new UpdateError(`${tgz}: это пакет «${name || '(без имени)'}», а не pult — не ставлю`)
  if (!isVersionName(version)) throw new UpdateError(`${tgz}: версия «${version}» — не semver, каталог под неё не заводится`)
  return { name, version }
}

/**
 * npm — сосед node, которым запущен этот CLI: у brew, nvm, volta и официального установщика он
 * лежит рядом, и это ТОТ npm, что совместим с этим node. Иначе — обычный поиск CLI.
 */
export function findNpm(): string {
  const sibling = join(dirname(process.execPath), 'npm')
  if (existsSync(sibling)) return sibling
  const found = locateToolPath('npm').path
  if (found) return found
  throw new UpdateError('npm не найден ни рядом с node, ни в известных местах — поставь node вместе с npm (brew install node)')
}

/**
 * Окружение npm — по белому списку (инвариант 1): `HOME=PULT_HOME`, чтобы чужой `~/.npmrc`
 * (реестр, токен, prefix) не читался и журналы npm не падали в настоящий `~/.npm`; кэш —
 * тоже под PULT_HOME. PATH начинается с каталога node: npm — js-скрипт с `#!/usr/bin/env node`.
 */
export function npmEnv(paths: PultPaths, parent: NodeJS.ProcessEnv): Record<string, string> {
  const nodeDir = dirname(process.execPath)
  return buildChildEnv({ ...parent, HOME: paths.home }, {
    path: `${nodeDir}:${parent['PATH'] ?? ''}:/usr/bin:/bin`,
    extra: {
      npm_config_cache: paths.npmCache,
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
    },
  })
}

export const NPM_TIMEOUT_MS = 180_000

export function npmInstall(paths: PultPaths, prefix: string, tgz: string, parent: NodeJS.ProcessEnv): void {
  const npm = findNpm()
  // --ignore-scripts: пакету pult install-скрипты не нужны (их нет в package.json), а без флага
  // npm исполнял preinstall/postinstall ЛЮБОГО переданного тарбола раньше verifyInstalled —
  // чужой код успевал отработать, даже когда проверка потом отвергала пакет.
  const args = ['install', '--global', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel', 'warn', tgz]
  const r = spawnSync(npm, args, { encoding: 'utf8', timeout: NPM_TIMEOUT_MS, env: npmEnv(paths, parent) })
  if (r.error || r.status !== 0) {
    const tail = `${r.stderr ?? ''}\n${r.stdout ?? ''}`.trim().split('\n').filter(Boolean).slice(-8).join('\n')
    throw new UpdateError(`npm install не удался (код ${r.status ?? r.error?.message}):\n${tail}`)
  }
}

/**
 * Проверка поставленного до переключения: бинари на месте и новый CLI сам называет ту же
 * версию. `node <cli> --version` — через node этого CLI (он заведомо >= 22), а не через
 * шебанг: PATH службы и человека бывает любым.
 */
export function verifyInstalled(prefix: string, version: string, paths: PultPaths, parent: NodeJS.ProcessEnv): void {
  const pkgRoot = join(prefix, 'lib', 'node_modules', 'pult')
  const must = [join(prefix, 'bin', 'pultd'), join(prefix, 'bin', 'pult'), join(pkgRoot, 'dist', 'daemon', 'main.js'), join(pkgRoot, 'dist', 'cli', 'main.js')]
  for (const f of must) {
    if (!existsSync(f)) throw new UpdateError(`после установки нет ${f} — пакет собран не так`)
  }
  const r = spawnSync(process.execPath, [join(pkgRoot, 'dist', 'cli', 'main.js'), '--version'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: buildChildEnv({ ...parent, HOME: paths.home }, { extra: { PULT_HOME: paths.home } }),
  })
  const said = (r.stdout ?? '').trim()
  if (r.status !== 0 || said !== version) {
    throw new UpdateError(`новый CLI отвечает на --version «${said || (r.stderr ?? '').trim().split('\n')[0] || `код ${r.status}`}», ожидалось ${version}`)
  }
}
