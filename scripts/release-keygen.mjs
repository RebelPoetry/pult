#!/usr/bin/env node
// release-keygen.mjs — ключ подписи релизов Пульта (M8c). Запускает владелец ОДИН раз, на своей машине.
//
//   node scripts/release-keygen.mjs            # ~/.config/pult-release/ed25519.pem (или PULT_RELEASE_KEY)
//   node scripts/release-keygen.mjs --out PATH
//
// Делает пару Ed25519, кладёт ЗАКРЫТЫЙ ключ (PKCS8 PEM) в файл 0600 в каталоге 0700 и печатает ТОЛЬКО
// открытый: строку для src/update/keys.ts. Закрытый ключ на экран не выводится никогда — экран попадает
// в историю терминала, скриншоты и логи CI. Файл уже есть — отказ: перезапись молча убила бы ключ,
// которым подписаны выпущенные релизы, и все стоящие Пульты перестали бы принимать новые.
// В CI ключ не едет: подписывает релиз владелец локально (scripts/release.mjs).

import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, statSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// Отказ — одной строкой, без стека: EPERM из глубины fs человеку ничего не говорит.
class Fail extends Error {}
const die = (msg) => { throw new Fail(msg) }
process.on('uncaughtException', (e) => {
  process.stderr.write(`release-keygen: ${e instanceof Fail ? e.message : (e?.message ?? String(e)).split('\n')[0]}\n`)
  process.exit(1)
})

const args = process.argv.slice(2)
let out = (process.env.PULT_RELEASE_KEY ?? '').trim() || join(homedir(), '.config', 'pult-release', 'ed25519.pem')
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--out') { out = args[++i] ?? die('--out: нужен путь'); continue }
  if (a.startsWith('--out=')) { out = a.slice(6); continue }
  if (a === '-h' || a === '--help') { process.stdout.write('node scripts/release-keygen.mjs [--out PATH]\n'); process.exit(0) }
  die(`незнакомый аргумент «${a}»`)
}
out = resolve(out)
if (existsSync(out)) die(`${out} уже есть — не перезаписываю: им подписаны выпущенные релизы. Новый ключ — только ротацией (docs/DEV.md, M8c)`)

const dir = dirname(out)
try {
  // Свой каталог — 0700. Чужой (уже был) не переделываем молча: только отказ, если в него может писать
  // кто-то ещё — подменить ключ в таком каталоге можно и после нас.
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  } else if ((statSync(dir).mode & 0o022) !== 0) {
    die(`${dir} доступен на запись группе или всем (${(statSync(dir).mode & 0o777).toString(8)}) — ключ туда не кладу; chmod 700 ${dir} или --out в другое место`)
  }
} catch (e) {
  if (e instanceof Fail) throw e
  die(`${dir}: ${e.code ?? ''} ${e.message}`.trim())
}

const { privateKey } = generateKeyPairSync('ed25519')
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })
// 'wx' — создать или отказать: между existsSync и записью файл мог появиться (второй запуск рядом).
let fd
try { fd = openSync(out, 'wx', 0o600) } catch (e) { die(`${out}: ${e.code === 'EEXIST' ? 'уже есть — не перезаписываю' : e.message}`) }
try { writeSync(fd, pem) } finally { closeSync(fd) }
chmodSync(out, 0o600)

const raw = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x, 'base64url')
const pub = raw.toString('base64')
const keyId = createHash('sha256').update(raw).digest('hex').slice(0, 8)

process.stdout.write([
  `открытый ключ (base64): ${pub}`,
  `keyId: ${keyId}`,
  `строка для src/update/keys.ts: { id: '${keyId}', publicKey: '${pub}' },`,
  `закрытый ключ записан: ${out} (0600)`,
  `сохрани ${out.replace(homedir(), '~')} в менеджер паролей`,
  '',
].join('\n'))
