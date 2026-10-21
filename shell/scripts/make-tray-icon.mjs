#!/usr/bin/env node
// make-tray-icon.mjs — значок Пульта в строке меню macOS: build/trayTemplate.png (16×16) и
// build/trayTemplate@2x.png (32×32).
//
//   node scripts/make-tray-icon.mjs
//
// Значок — шаблонное изображение macOS: только чёрный цвет и прозрачность, имя кончается на
// `Template`. Цвет система подставляет сама (светлая и тёмная строка меню, подсветка при клике).
// Рисунок взят из build/icon.svg: три фейдера пульта, ручки на тех же высотах — левая внизу,
// средняя вверху, правая посередине; рамки нет, на 16 px она съела бы фейдеры. Дорожка вокруг
// ручки прервана на 1 pt — ручка читается отдельно от дорожки.
//
// Запускается руками после правки рисунка; результат лежит в репозитории (как icon.icns), сборке
// он не нужен. Зависимостей нет: фигуры растеризуются здесь же с суперсэмплингом, PNG кодируется
// node:zlib. Вывод детерминирован — повторный запуск даёт те же байты.

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const BUILD = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')

// Рисунок в пунктах холста 16×16. Целые координаты попадают на границы пикселей и в 1x, и в 2x;
// шаг дорожек 5 pt — ручки соседних фейдеров не заходят друг на друга.
const TRACK_TOP = 1
const TRACK_BOTTOM = 15
const TRACK_W = 1
const KNOB_W = 5
const KNOB_H = 3
const GAP = 1
/** Фейдер: x — левый край дорожки, knob — верх ручки (высоты как в icon.svg). */
const FADERS = [
  { x: 2, knob: 9 },
  { x: 7, knob: 4 },
  { x: 12, knob: 8 },
]

/** Скруглённый прямоугольник: точка внутри? */
function inRoundRect(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false
  const cx = Math.min(Math.max(px, x0 + r), x1 - r)
  const cy = Math.min(Math.max(py, y0 + r), y1 - r)
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r
}

/** Покрыта ли точка (в пунктах) рисунком. */
function covered(px, py) {
  for (const f of FADERS) {
    const kx0 = f.x + TRACK_W / 2 - KNOB_W / 2
    if (inRoundRect(px, py, kx0, f.knob, kx0 + KNOB_W, f.knob + KNOB_H, 1)) return true
    const inGap = py > f.knob - GAP && py < f.knob + KNOB_H + GAP
    if (!inGap && inRoundRect(px, py, f.x, TRACK_TOP, f.x + TRACK_W, TRACK_BOTTOM, TRACK_W / 2)) return true
  }
  return false
}

/** RGBA холста size×size: чёрный, альфа — доля покрытия пикселя (8×8 отсчётов). */
function render(size) {
  const scale = size / 16
  const ss = 8
  const px = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          if (covered((x + (sx + 0.5) / ss) / scale, (y + (sy + 0.5) / ss) / scale)) hit++
        }
      }
      px[(y * size + x) * 4 + 3] = Math.round((hit / (ss * ss)) * 255)
    }
  }
  return px
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** PNG RGBA 8 бит, фильтр строк 0 — его и ждёт юнит-тест значка. */
function png(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // глубина
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

for (const [size, name] of [[16, 'trayTemplate.png'], [32, 'trayTemplate@2x.png']]) {
  const file = join(BUILD, name)
  writeFileSync(file, png(size, render(size)))
  process.stdout.write(`make-tray-icon: ${file}\n`)
}
