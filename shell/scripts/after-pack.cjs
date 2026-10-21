// after-pack.cjs — хук electron-builder для Pult.app (docs/12 §2 и §4, О3).
//
// 1. Fuses Electron (@electron/fuses) — выключают то, чем чужой код мог бы превратить наше
//    подписанное приложение в произвольный node:
//      RunAsNode off                              ELECTRON_RUN_AS_NODE=1 Pult → голый node
//      EnableNodeOptionsEnvironmentVariable off   NODE_OPTIONS=--require …
//      EnableNodeCliInspectArguments off          --inspect / --inspect-brk
//      EnableEmbeddedAsarIntegrityValidation on   подменённый app.asar не грузится (хэш в Info.plist)
//      OnlyLoadAppFromAsar on                     рядом положенная папка app/ не подхватывается
//      GrantFileProtocolExtraPrivileges off       file:// окну не нужен (интерфейс — app://pult)
//    ГРАНИЦА: целостность проверяется только у app.asar (main.js и preload.cjs). Код протокола,
//    который main импортирует из пакета pult (~/.pult/current/…), и весь интерфейс доверены на
//    уровне записи пользователя — как и сам демон, который из того же каталога работает.
// 2. Лишнее из пакета Electron: демо-приложение default_app.asar (и его запись в
//    ElectronAsarIntegrity), ATS NSAllowsArbitraryLoads — окно в сеть не ходит вовсе.
// 3. Подпись ad-hoc с hardened runtime (`--options runtime`) и правами build/entitlements.mac.plist:
//    fuses правят бинарь фреймворка, прежняя подпись после этого недействительна, а неподписанный
//    arm64-бинарь macOS не запустит. Без runtime dyld исполнял бы DYLD_INSERT_LIBRARIES — чужой
//    нативный код в main до первой строки JS, мимо всех fuses (замерено: dylib грузилась).
//    Сертификата разработчика нет (mac.identity: null) — это приложение для себя, не для раздачи.
//
// Хук — CommonJS: electron-builder грузит его через require; @electron/fuses — ESM, отсюда import().

const { execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const plist = path.join(app, 'Contents', 'Info.plist')
  const buddy = (cmd) => execFileSync('/usr/libexec/PlistBuddy', ['-c', cmd, plist], { stdio: 'pipe' })
  fs.rmSync(path.join(app, 'Contents', 'Resources', 'default_app.asar'), { force: true })
  try { buddy('Delete :ElectronAsarIntegrity:Resources/default_app.asar') } catch { /* записи нет */ }
  buddy('Set :NSAppTransportSecurity:NSAllowsArbitraryLoads false')
  const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses')
  await flipFuses(app, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  })
  const entitlements = path.join(__dirname, '..', 'build', 'entitlements.mac.plist')
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--options', 'runtime', '--entitlements', entitlements, app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  process.stdout.write(`after-pack: fuses, чистка пакета и ad-hoc подпись с hardened runtime — ${app}\n`)
}
