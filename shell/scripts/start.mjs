#!/usr/bin/env node
// start.mjs — окно в режиме разработки: интерфейс и код протокола берутся из рабочей копии
// (PULT_UI_ROOT = корень пакета pult), а не из установленного ~/.pult/current.
// Пересборка интерфейса на лету — `npm run ui:watch` в корне; окно перезагружается ⌘R.

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHELL = join(dirname(fileURLToPath(import.meta.url)), '..')
const electron = createRequire(import.meta.url)('electron')
const env = { ...process.env, PULT_UI_ROOT: process.env.PULT_UI_ROOT ?? join(SHELL, '..') }
if (!env.PULT_NODE) env.PULT_NODE = process.execPath
const child = spawn(electron, [SHELL], { stdio: 'inherit', env })
const forward = (sig) => process.on(sig, () => child.kill(sig))
forward('SIGINT')
forward('SIGTERM')
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
