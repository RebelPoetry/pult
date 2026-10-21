// Предзагрузка (`node --import`): каждый spawnSync на ГЛАВНОМ потоке пишет имя команды в файл
// TRACE_SPAWNSYNC. Так тест видит синхронный запуск процесса на событийном цикле демона, в каком бы
// модуле он ни появился. Потоки (worker_threads) не пишут: там spawnSync событийному циклу не мешает.

import cp from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { isMainThread } from 'node:worker_threads'

const file = process.env.TRACE_SPAWNSYNC
if (file && isMainThread) {
  const orig = cp.spawnSync
  cp.spawnSync = function traced(command, ...rest) {
    try { appendFileSync(file, `${String(command)}\n`) } catch { /* каталог уже стёрт */ }
    return orig.call(this, command, ...rest)
  }
  syncBuiltinESMExports()
}
