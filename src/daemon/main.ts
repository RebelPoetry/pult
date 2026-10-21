#!/usr/bin/env node
// `pultd` — точка входа демона. Нарочно крошечная: СНАЧАЛА обработчики SIGTERM/SIGINT, и только
// потом `await import()` настоящего демона (run.ts) со всем графом импортов.
//
// КАК ЛОМАЛОСЬ (B1 повторной приёмки В4, 23.09.2026, настоящий launchd): обработчики ставил сам
// main() демона, а статические импорты вычисляются ДО него. SIGTERM, пришедший, пока node грузил
// граф модулей, убивал процесс сигналом; для launchd (`KeepAlive {SuccessfulExit: false}`) это
// «неуспешный выход», и служба, которую `pult daemon stop` просил остановить, поднималась снова:
// в `pult daemon status` — «последний выход: сигнал 15 (Terminated)».
//
// Здесь только ворота: сигнал до готовности демона запоминается (`pending`), run.ts исполняет его,
// как только может (до старта — сразу выход с кодом 0, посреди старта — остановка после него).
// Статических импортов в этом файле нет и быть не должно (тест проверяет): `import type` стирается.

import type { SignalGate } from './run.js'

const gate: SignalGate = { pending: null, handler: null }
const onSignal = (signal: string): void => {
  if (gate.handler) gate.handler(signal)
  else if (gate.pending === null) gate.pending = signal
}
process.on('SIGTERM', () => onSignal('SIGTERM'))
process.on('SIGINT', () => onSignal('SIGINT'))

const { runDaemon } = await import('./run.js')
await runDaemon(gate)
