#!/usr/bin/env node
// build.mjs — сборка оболочки окна: dist/main.js (ESM, main-процесс) и dist/preload.cjs
// (CommonJS одним файлом: preload в песочнице не умеет require локальных модулей).
//
//   node scripts/build.mjs           оболочка
//   node scripts/build.mjs --tests   ещё и тесты test/**/*.test.ts -> dist-test/ (юнит и e2e)
//
// Типы проверяет `npm run typecheck` (tsc --noEmit); esbuild их только стирает.
// Код протокола в бандл main НЕ входит: main грузит его из найденного пакета pult во время работы
// (`import()` по пути), поэтому здесь импортируются только типы из ../src.

import { readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TESTS = process.argv.includes('--tests')

const common = { bundle: true, platform: 'node', target: ['node22'], logLevel: 'warning', external: ['electron'] }

rmSync(join(ROOT, 'dist'), { recursive: true, force: true })
await esbuild.build({ ...common, entryPoints: [join(ROOT, 'src', 'main.ts')], outfile: join(ROOT, 'dist', 'main.js'), format: 'esm' })
await esbuild.build({ ...common, entryPoints: [join(ROOT, 'src', 'preload.ts')], outfile: join(ROOT, 'dist', 'preload.cjs'), format: 'cjs' })

if (TESTS) {
  const walk = (dir) => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.test.ts') ? [p] : []
  })
  rmSync(join(ROOT, 'dist-test'), { recursive: true, force: true })
  await esbuild.build({
    ...common,
    entryPoints: walk(join(ROOT, 'test')),
    outdir: join(ROOT, 'dist-test'),
    outbase: join(ROOT, 'test'),
    format: 'esm',
    packages: 'external',
  })
}
