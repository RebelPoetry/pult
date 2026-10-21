#!/usr/bin/env node
// Фальшивый loginctl: show-user <u> -p Linger и enable-linger <u>. Начальное состояние linger —
// FAKE_LINGER (yes|no), дальше — в FAKE_SVC_STATE. FAKE_SVC_FAIL=enable-linger — отказ, как у
// пользователя без прав polkit.

import { fail, loadState, logArgv, saveState } from './fake-svc-lib.mjs'

logArgv('loginctl')
const argv = process.argv.slice(2)
const st = loadState()

switch (argv[0]) {
  case 'show-user':
    process.stdout.write(`Linger=${st.linger || 'no'}\n`)
    process.exit(0)
  case 'enable-linger':
    if (fail('enable-linger')) { process.stderr.write('Could not enable linger: Access denied\n'); process.exit(1) }
    st.linger = 'yes'
    saveState(st)
    process.exit(0)
  default:
    process.stderr.write(`fake-loginctl: глагол ${argv[0]} не поддержан\n`)
    process.exit(64)
}
