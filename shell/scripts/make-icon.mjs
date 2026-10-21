#!/usr/bin/env node
// make-icon.mjs — build/icon.svg → build/icon.icns (иконка Pult.app).
//
//   node scripts/make-icon.mjs
//
// Запускается руками после правки icon.svg; результат (icon.icns) лежит в репозитории, поэтому
// сборке `npm run dist:mac` ни rsvg-convert, ни iconutil не нужны. Нужны здесь: rsvg-convert
// (brew install librsvg) и iconutil (есть в macOS).

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUILD = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')
const tmp = mkdtempSync(join(tmpdir(), 'pult-icon-'))
try {
  const set = join(tmp, 'icon.iconset')
  execFileSync('mkdir', ['-p', set])
  // Набор iconutil: 16…512 в 1x и 2x.
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = size * scale
      const name = scale === 1 ? `icon_${size}x${size}.png` : `icon_${size}x${size}@2x.png`
      execFileSync('rsvg-convert', ['-w', String(px), '-h', String(px), join(BUILD, 'icon.svg'), '-o', join(set, name)])
    }
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', join(BUILD, 'icon.icns')])
  process.stdout.write(`make-icon: ${join(BUILD, 'icon.icns')}\n`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
