// Разговор с менеджером служб: launchctl (macOS) и systemctl/loginctl (Linux).
// Всё идёт через `runTool`, которому бинарь даёт ServiceContext: в тесте это фальшивка, пишущая
// argv в лог, в бою — абсолютный системный путь. Бинарь `null` значит «в тесте фальшивку не дали» —
// тогда вызов падает, а не уходит в настоящий launchctl (docs/08 §2: в тестах НИКОГДА).

import { spawnSync } from 'node:child_process'
import { liveLockHolder } from '../core/lock.js'
import { buildChildEnv } from '../env/allowlist.js'
import type { ServiceContext } from './context.js'
import { guiDomain, guiTarget, ServiceError } from './context.js'

export interface ToolResult {
  status: number | null
  stdout: string
  stderr: string
  /** Команда целиком — для сообщений человеку. */
  cmd: string
}

const TOOL_TIMEOUT_MS = 20_000

/**
 * Окружение launchctl/systemctl/loginctl — по белому списку (инвариант 1), как у любого ребёнка
 * Пульта. Раньше им уходило окружение CLI целиком: из терминала десктопного Claude это 25
 * переменных ANTHROPIC_* и CLAUDE_*. Сверх списка — только адрес пользовательской шины: без
 * XDG_RUNTIME_DIR и DBUS_SESSION_BUS_ADDRESS `systemctl --user` не находит свой менеджер.
 * В тесте (PULT_TEST=1) проходят ещё FAKE_* и PULT_SERVICE_DIR — это настройки фальшивок.
 */
export function toolEnv(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const extra: Record<string, string> = {}
  for (const k of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
    const v = parent[k]
    if (typeof v === 'string' && v) extra[k] = v
  }
  if (parent['PULT_TEST'] === '1') {
    for (const [k, v] of Object.entries(parent)) {
      if (typeof v === 'string' && (k.startsWith('FAKE_') || k === 'PULT_SERVICE_DIR')) extra[k] = v
    }
  }
  return buildChildEnv(parent, { extra })
}

export function runTool(bin: string | null, what: string, args: string[], env?: NodeJS.ProcessEnv): ToolResult {
  if (!bin) {
    throw new ServiceError(`${what}: в тестовом режиме (PULT_TEST=1) нужен фальшивый бинарь — настоящий менеджер служб в тестах не вызывается`)
  }
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: TOOL_TIMEOUT_MS, env: toolEnv(env) })
  return {
    status: r.error ? null : r.status,
    stdout: r.stdout ?? '',
    stderr: (r.stderr ?? '') + (r.error ? `${r.error.message}\n` : ''),
    cmd: [what, ...args].join(' '),
  }
}

/** Синхронная пауза: вся работа с менеджером служб синхронна (spawnSync), промисы тут лишние. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const firstLine = (r: ToolResult): string =>
  (r.stderr.trim() || r.stdout.trim()).split('\n')[0] ?? ''

// --- разбор ответов -------------------------------------------------------------

export interface ExitSignal {
  num: number
  /** Имя в понимании менеджера (`Killed`, `Terminated`); у systemd его нет — пустая строка. */
  name: string
}

export interface ManagerState {
  /** Менеджер служб знает о службе (launchd: загружена; systemd: LoadState=loaded). */
  loaded: boolean
  /** Процесс службы сейчас жив. */
  running: boolean
  pid: number | null
  /** Код последнего выхода; `null` — служба ещё ни разу не выходила, умерла от сигнала или код неизвестен. */
  lastExitCode: number | null
  /** Сигнал, которым кончился последний процесс; `null` — вышел сам или ещё не выходил. */
  lastSignal: ExitSignal | null
  /**
   * Метка «какой по счёту запуск»: launchd — `runs`, systemd — `ExecMainPID` (pid последнего
   * главного процесса, остаётся и после его выхода). Сменилась — менеджер запускал процесс заново.
   * Нужна пробе `pult update`: понять, что процесс ЭТОЙ попытки уже вышел, не дожидаясь 10 с.
   */
  runs: number | null
  /** Сырое состояние менеджера (`running`, `spawn scheduled`, `active`, `failed`…) для человека. */
  state: string | null
  /** Ответ менеджера служб не разобран: `pult doctor` покажет это как предупреждение. */
  error?: string
}

/** «Последний выход» для человека: `код 1`, `сигнал 9 (Killed)`, `ещё не выходила`. */
export function formatLastExit(m: Pick<ManagerState, 'lastExitCode' | 'lastSignal'>): string {
  if (m.lastSignal) return `сигнал ${m.lastSignal.num}${m.lastSignal.name ? ` (${m.lastSignal.name})` : ''}`
  if (m.lastExitCode !== null) return `код ${m.lastExitCode}`
  return 'ещё не выходила'
}

export interface LaunchctlPrint {
  state: string | null
  pid: number | null
  lastExitCode: number | null
  lastSignal: ExitSignal | null
  runs: number | null
}

/**
 * Разбор `launchctl print gui/<uid>/<label>`. Формат человекочитаемый и не документирован,
 * поэтому берём только строки ВЕРХНЕГО уровня блока службы (вложенные `resource coalition = {…}`
 * несут свои `state = active`): `state`, `pid`, `runs`, `last exit code`, `last terminating signal`.
 *
 * Что показал НАСТОЯЩИЙ вывод (записан лидом 23.09.2026, test/fixtures/service/): у работающей
 * службы `last exit code = (never exited)`; после смерти от сигнала строки `last exit code` НЕТ
 * вовсе, вместо неё `last terminating signal = Killed: 9`, а `state = spawn scheduled`. Прежний
 * разбор знал только код — и `pult daemon status` после kill -9 печатал «последний код выхода —».
 */
export function parseLaunchctlPrint(text: string): LaunchctlPrint {
  const top = new Map<string, string>()
  let depth = 0
  for (const raw of text.split('\n')) {
    const l = raw.trim()
    if (l === '}' || l === '};') { depth = Math.max(0, depth - 1); continue }
    const m = /^([^=]+?) = (.*)$/.exec(l)
    if (m && m[1] !== undefined && m[2] !== undefined && depth === 1 && !top.has(m[1])) top.set(m[1], m[2].trim())
    if (l.endsWith('{')) depth++
  }
  const int = (v: string | undefined): number | null => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null)
  const codeRaw = top.get('last exit code')
  const cm = codeRaw !== undefined ? /^(-?\d+)/.exec(codeRaw) : null
  const sigRaw = top.get('last terminating signal')
  const sm = sigRaw !== undefined ? /^(.*?):\s*(\d+)\s*$/.exec(sigRaw) : null
  return {
    state: top.get('state') ?? null,
    pid: int(top.get('pid')),
    lastExitCode: cm && cm[1] !== undefined ? Number(cm[1]) : null,
    lastSignal: sm && sm[2] !== undefined ? { num: Number(sm[2]), name: (sm[1] ?? '').trim() } : null,
    runs: int(top.get('runs')),
  }
}

/** Разбор `systemctl --user show <unit> -p …`: строки `Ключ=значение`. */
export function parseSystemctlShow(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const l of text.split('\n')) {
    const i = l.indexOf('=')
    if (i > 0) out[l.slice(0, i).trim()] = l.slice(i + 1).trim()
  }
  return out
}

/**
 * «Службы нет в launchd»: так отвечают `bootout`/`print`/`kickstart` по незагруженной метке.
 * Встречаются два вида: `Boot-out failed: 3: No such process` (код 3) и
 * `Could not find service "<label>" in domain for user gui: <uid>` (код 113).
 */
export function launchdNotLoaded(r: ToolResult): boolean {
  if (r.status === 113 || r.status === 3) return true
  return /No such process|Could not find service/i.test(r.stderr + r.stdout)
}

// --- действия -------------------------------------------------------------------

const NOT_LOADED: ManagerState = { loaded: false, running: false, pid: null, lastExitCode: null, lastSignal: null, runs: null, state: null }

export function queryState(ctx: ServiceContext): ManagerState {
  if (ctx.platform === 'darwin') {
    const r = runTool(ctx.launchctl, 'launchctl', ['print', guiTarget(ctx)], ctx.env)
    if (r.status !== 0) {
      if (launchdNotLoaded(r)) return { ...NOT_LOADED }
      return { ...NOT_LOADED, error: `${r.cmd}: код ${r.status} — ${firstLine(r)}` }
    }
    const p = parseLaunchctlPrint(r.stdout)
    return { loaded: true, running: p.pid !== null, ...p }
  }
  const r = runTool(ctx.systemctl, 'systemctl', ['--user', 'show', ctx.name, '-p',
    'LoadState,ActiveState,SubState,MainPID,ExecMainPID,ExecMainCode,ExecMainStatus'], ctx.env)
  if (r.status !== 0) {
    return { ...NOT_LOADED, error: `${r.cmd}: код ${r.status} — ${firstLine(r)}` }
  }
  const kv = parseSystemctlShow(r.stdout)
  const posInt = (v: string | undefined): number | null => (/^\d+$/.test(v ?? '') && Number(v) > 0 ? Number(v) : null)
  const pid = posInt(kv['MainPID'])
  const status = /^-?\d+$/.test(kv['ExecMainStatus'] ?? '') ? Number(kv['ExecMainStatus']) : null
  // ExecMainCode — si_code из waitid: 1 CLD_EXITED (Status = код), 2 CLD_KILLED и 3 CLD_DUMPED (Status = сигнал).
  const killed = kv['ExecMainCode'] === '2' || kv['ExecMainCode'] === '3'
  const active = kv['ActiveState'] ?? null
  const sub = kv['SubState'] ?? ''
  return {
    loaded: kv['LoadState'] === 'loaded',
    running: pid !== null && (active === 'active' || active === 'activating' || active === 'reloading'),
    pid,
    // У systemd 0 — и «вышел с нулём», и «ещё не выходил»: отличить нельзя, поэтому 0 без
    // процесса показываем как 0 — это не ошибка ни в одном из двух прочтений.
    lastExitCode: killed ? null : status,
    lastSignal: killed && status !== null ? { num: status, name: '' } : null,
    runs: posInt(kv['ExecMainPID']),
    // `activating (auto-restart)` — процесс уже умер и ждёт перезапуска: без SubState это
    // читалось бы как «стартует».
    state: active === 'activating' && sub ? `${active} (${sub})` : active,
  }
}

export interface Step {
  cmd: string
  ok: boolean
  detail: string
}

const step = (r: ToolResult, ok = r.status === 0): Step => ({ cmd: r.cmd, ok, detail: ok ? '' : `код ${r.status} — ${firstLine(r)}` })

/** Команды загрузки — ровно те, что выполнит `load`: их же печатает `--print`. */
export function loadCommands(ctx: ServiceContext, file: string): string[] {
  if (ctx.platform === 'darwin') {
    return [
      `launchctl bootout ${guiTarget(ctx)}   # ошибка «не загружена» игнорируется`,
      `launchctl bootstrap ${guiDomain(ctx)} ${file}`,
    ]
  }
  return [
    'systemctl --user daemon-reload',
    `systemctl --user reset-failed ${ctx.name}   # ошибка игнорируется`,
    `systemctl --user enable --now ${ctx.name}`,
    `loginctl show-user ${ctx.user} -p Linger   # не yes → loginctl enable-linger ${ctx.user}`,
  ]
}

export interface LoadResult {
  ok: boolean
  steps: Step[]
  /** Предупреждения, которые установку не валят (linger). */
  warnings: string[]
}

/**
 * Сколько ждать, пока launchd доснимет службу после `bootout`. У службы Пульта `exit timeout = 5`
 * (значение launchd по умолчанию): столько launchd ждёт выхода процесса по SIGTERM, прежде чем
 * добить его SIGKILL. Запас — на сам SIGKILL и уборку.
 */
export const UNLOAD_WAIT_MS = 15_000
const UNLOAD_POLL_MS = 100

/**
 * Дождаться, пока службы не станет в launchd. `bootout` отвечает СРАЗУ (код 0), а служба остаётся
 * загруженной, пока её процесс не вышел: `print` её ещё видит, `bootstrap` отвечает
 * `5: Input/output error`. ЗАМЕР 30.09.2026 (настоящий launchd): демон, занятый стартом, выходил
 * через 1,3–5,1 с после `bootout` — до `exit timeout`, после которого launchd добивает его сам.
 * Прежние пять повторов `bootstrap` по 400 мс (2 с) до этого не доживали: `pult update` получал
 * «Bootstrap failed: 5», поднимал демона напрямую и оставлял службу НЕ загруженной.
 */
type Unload =
  | { state: 'gone'; ms: number }
  /** Службу уже загрузил заново кто-то другой: у неё новый процесс. */
  | { state: 'reloaded'; ms: number; pid: number }
  | { state: 'stuck'; ms: number }

/**
 * pid процесса службы по `launchctl print`: число; `null` — служба загружена, процесса нет;
 * `undefined` — служба не загружена или ответ не получен.
 */
function launchdPid(ctx: ServiceContext): number | null | undefined {
  const r = runTool(ctx.launchctl, 'launchctl', ['print', guiTarget(ctx)], ctx.env)
  return r.status === 0 ? parseLaunchctlPrint(r.stdout).pid : undefined
}

/** `prevPid` — процесс службы ДО `bootout`: другой pid после него значит, что службу загрузили заново. */
function waitUnloaded(ctx: ServiceContext, waitMs: number, prevPid: number | null | undefined): Unload {
  const t0 = Date.now()
  for (;;) {
    const r = runTool(ctx.launchctl, 'launchctl', ['print', guiTarget(ctx)], ctx.env)
    if (r.status !== 0 && launchdNotLoaded(r)) return { state: 'gone', ms: Date.now() - t0 }
    if (r.status === 0 && prevPid !== undefined) {
      const pid = parseLaunchctlPrint(r.stdout).pid
      if (pid !== null && pid !== prevPid) return { state: 'reloaded', ms: Date.now() - t0, pid }
    }
    if (Date.now() - t0 >= waitMs) return { state: 'stuck', ms: Date.now() - t0 }
    sleepSync(UNLOAD_POLL_MS)
  }
}

const isBootstrapBusy = (r: ToolResult): boolean => r.status === 5 || r.status === 37

const bootstrapOnce = (ctx: ServiceContext, file: string): ToolResult =>
  runTool(ctx.launchctl, 'launchctl', ['bootstrap', guiDomain(ctx), file], ctx.env)

/**
 * `bootstrap` с коротким повтором на `5: Input/output error` / `37: Operation already in progress`:
 * это пояс к `waitUnloaded` — между «`print` службы уже не видит» и «launchd готов принять её
 * заново» остаётся зазор в доли секунды.
 */
function bootstrap(ctx: ServiceContext, file: string): ToolResult {
  let boot = bootstrapOnce(ctx, file)
  for (let i = 0; i < 5 && isBootstrapBusy(boot); i++) {
    sleepSync(400)
    boot = bootstrapOnce(ctx, file)
  }
  return boot
}

/**
 * Пока мы снимали службу, её загрузила другая команда: `ensureDaemon` любой команды `pult` и окна
 * грузит незагруженную службу сам (см. `start`). Файл службы и `current` к этому времени уже
 * новые — их пишут ДО загрузки, — так что служба загружена ровно так, как загрузили бы мы. Это не
 * отказ менеджера служб: отвечать «не вышло» значило бы поднимать второго демона в обход.
 */
const loadedByOther = (ctx: ServiceContext, pid: number | null): Step => ({
  cmd: `launchctl print ${guiTarget(ctx)}`,
  ok: true,
  detail: `службу уже загрузила другая команда${pid !== null ? ` (pid ${pid})` : ''}`,
})

export function load(ctx: ServiceContext, file: string, opts: { unloadWaitMs?: number } = {}): LoadResult {
  const steps: Step[] = []
  const warnings: string[] = []
  if (ctx.platform === 'darwin') {
    const prevPid = launchdPid(ctx)
    // bootout перед bootstrap: повторный bootstrap загруженной службы отвечает
    // `Bootstrap failed: 5: Input/output error` (spike/env/HUMAN-STEPS.md) — install обязан быть идемпотентным.
    const out = runTool(ctx.launchctl, 'launchctl', ['bootout', guiTarget(ctx)], ctx.env)
    const wasLoaded = !launchdNotLoaded(out)
    steps.push(step(out, out.status === 0 || !wasLoaded))
    // Служба была загружена — ждём КОНЦА выгрузки, и только потом грузим заново (см. waitUnloaded).
    if (wasLoaded) {
      const w = waitUnloaded(ctx, opts.unloadWaitMs ?? UNLOAD_WAIT_MS, prevPid)
      if (w.state === 'reloaded') {
        steps.push(loadedByOther(ctx, w.pid))
        return { ok: true, steps, warnings }
      }
      if (w.state === 'stuck') {
        steps.push({
          cmd: `launchctl print ${guiTarget(ctx)}`,
          ok: false,
          detail: `служба не выгрузилась за ${Math.round(w.ms / 1000)} с после bootout — её процесс не выходит`,
        })
        return { ok: false, steps, warnings }
      }
    }
    const boot = bootstrap(ctx, file)
    if (isBootstrapBusy(boot)) {
      // «Уже загружена» после того, как `print` показал «службы нет»: успела другая команда.
      const pid = launchdPid(ctx)
      if (pid !== undefined) {
        steps.push(loadedByOther(ctx, pid))
        return { ok: true, steps, warnings }
      }
    }
    steps.push(step(boot))
    return { ok: boot.status === 0, steps, warnings }
  }
  const reload = runTool(ctx.systemctl, 'systemctl', ['--user', 'daemon-reload'], ctx.env)
  steps.push(step(reload))
  if (reload.status !== 0) return { ok: false, steps, warnings }
  // reset-failed: после петли падений systemd откажет в старте («start request repeated too
  // quickly»), пока счётчик StartLimitBurst не сброшен, — а install как раз то, что запускают
  // после починки. Юнита ещё нет в состоянии failed — команда ругнётся, это не ошибка.
  const reset = runTool(ctx.systemctl, 'systemctl', ['--user', 'reset-failed', ctx.name], ctx.env)
  steps.push(step(reset, true))
  // Работающий демон install уже остановил штатно (код 0 → on-failure не поднимает), поэтому
  // `enable --now` стартует службу по НОВОМУ юниту.
  const enable = runTool(ctx.systemctl, 'systemctl', ['--user', 'enable', '--now', ctx.name], ctx.env)
  steps.push(step(enable))
  if (enable.status !== 0) return { ok: false, steps, warnings }
  warnings.push(...ensureLinger(ctx, steps))
  return { ok: true, steps, warnings }
}

/** Команда, которую печатаем человеку, если включить linger сами не смогли. */
export const lingerFixCommand = (ctx: ServiceContext): string => `sudo loginctl enable-linger ${ctx.user}`

/**
 * Без linger systemd --user убивает все процессы пользователя на последнем выходе из сессии —
 * демон по SSH-сессии умрёт вместе с ней. Не вышло включить — установка всё равно успешна,
 * а человек получает ТОЧНУЮ команду.
 */
export function ensureLinger(ctx: ServiceContext, steps: Step[]): string[] {
  const show = runTool(ctx.loginctl, 'loginctl', ['show-user', ctx.user, '-p', 'Linger'], ctx.env)
  steps.push(step(show))
  if (show.status === 0 && parseSystemctlShow(show.stdout)['Linger'] === 'yes') return []
  const en = runTool(ctx.loginctl, 'loginctl', ['enable-linger', ctx.user], ctx.env)
  steps.push(step(en))
  if (en.status === 0) return []
  return [
    `linger не включён (${firstLine(en) || `код ${en.status}`}): без него systemd --user остановит демона, `
    + `когда закроется последняя сессия. Включи руками: ${lingerFixCommand(ctx)}`,
  ]
}

export function lingerState(ctx: ServiceContext): boolean | null {
  const show = runTool(ctx.loginctl, 'loginctl', ['show-user', ctx.user, '-p', 'Linger'], ctx.env)
  if (show.status !== 0) return null
  const v = parseSystemctlShow(show.stdout)['Linger']
  return v === 'yes' ? true : v === 'no' ? false : null
}

export function unload(ctx: ServiceContext): { ok: boolean; steps: Step[] } {
  const steps: Step[] = []
  if (ctx.platform === 'darwin') {
    const out = runTool(ctx.launchctl, 'launchctl', ['bootout', guiTarget(ctx)], ctx.env)
    const ok = out.status === 0 || launchdNotLoaded(out)
    steps.push(step(out, ok))
    return { ok, steps }
  }
  const dis = runTool(ctx.systemctl, 'systemctl', ['--user', 'disable', '--now', ctx.name], ctx.env)
  // Юнит, которого systemd не знает, — не ошибка снятия: снимать и так нечего.
  const disOk = dis.status === 0 || /not loaded|does not exist|No such file|not found/i.test(dis.stderr)
  steps.push(step(dis, disOk))
  return { ok: disOk, steps }
}

export function daemonReload(ctx: ServiceContext): Step {
  return step(runTool(ctx.systemctl, 'systemctl', ['--user', 'daemon-reload'], ctx.env))
}

/**
 * Старт уже установленной службы для `ensureDaemon`. launchd: `kickstart` БЕЗ `-k` — живой процесс
 * не трогается (с `-k` он был бы убит и поднят заново). systemd: `start` у активной службы — no-op.
 *
 * Служба УСТАНОВЛЕНА, НО НЕ ЗАГРУЖЕНА (файл есть, launchd о ней не знает: её сняли `bootout` и не
 * вернули) — `kickstart` отвечает `113: Could not find service`, и раньше на этом всё кончалось:
 * демон поднимался в обход службы, и так каждый раз, до следующего входа в систему (замер
 * 30.09.2026). Теперь такую службу грузит `bootstrap` — `RunAtLoad` в plist запускает её сам.
 * systemd этого не нужно: `start` сам читает юнит с диска.
 */
export function start(ctx: ServiceContext): Step {
  if (ctx.platform === 'darwin') {
    const kickstart = (): ToolResult => runTool(ctx.launchctl, 'launchctl', ['kickstart', guiTarget(ctx)], ctx.env)
    const kick = kickstart()
    if (kick.status === 0 || !launchdNotLoaded(kick) || !ctx.file) return step(kick)
    // Lock уже держит живой демон (поднят напрямую и ещё стартует или занят): грузить службу поверх
    // него нельзя — её процесс выйдет с кодом 3, и launchd будет поднимать его каждые 10 с, пока тот
    // демон жив, а после `pult daemon stop` поднимет демона, которого просили остановить.
    const holder = liveLockHolder(ctx.paths.lock)
    if (holder) {
      // …если только это не процесс самой службы: её в эту же секунду могла загрузить другая команда.
      const again = kickstart()
      if (again.status === 0) return step(again)
      return { cmd: kick.cmd, ok: false, detail: `служба не загружена, а lock уже держит живой демон (pid ${holder.pid}) — поверх него её не гружу` }
    }
    let boot = bootstrapOnce(ctx, ctx.file)
    if (isBootstrapBusy(boot)) {
      // «Уже загружена»: службу в эту же секунду загрузил кто-то другой (окно и CLI поднимают демона
      // разом). Тогда она наша — остаётся убедиться, что её процесс запущен. Повторы `bootstrap`
      // (2 с синхронной паузы) — только если службы всё ещё нет: значит, её выгрузка не кончилась.
      const again = kickstart()
      if (again.status === 0) return step(again)
      boot = bootstrap(ctx, ctx.file)
    }
    return {
      cmd: `launchctl bootstrap ${guiDomain(ctx)} ${ctx.file}`,
      ok: boot.status === 0,
      detail: boot.status === 0 ? '' : `служба не загружена (${firstLine(kick)}), и загрузить её не вышло: код ${boot.status} — ${firstLine(boot)}`,
    }
  }
  return step(runTool(ctx.systemctl, 'systemctl', ['--user', 'start', ctx.name], ctx.env))
}

/** Как `restart` зовётся в строках хода: launchd — перезагрузка, systemd — `restart`. */
export const restartCommand = (ctx: ServiceContext): string => (ctx.platform === 'darwin'
  ? `launchctl bootout ${guiTarget(ctx)} + bootstrap ${guiDomain(ctx)}`
  : `systemctl --user restart ${ctx.name}`)

/**
 * Перезапуск службы для `pult update` (docs/08 §4). Код новой версии служба берёт из `current`
 * через лаунчер, поэтому файл службы при обновлении не переписывается.
 *
 * launchd — ПЕРЕЗАГРУЗКА `bootout` + `bootstrap` (та же `load`, что у `daemon install`, с её
 * повтором на EIO), а не `kickstart -k`. КАК ЛОМАЛОСЬ (B2 повторной приёмки В4, 23.09.2026):
 * после падения launchd придерживает `kickstart -k` на ThrottleInterval — 10–18,6 с за вызов, и
 * откат сломанной версии шёл 65 с; замер лида на той же машине: bootout + bootstrap до ответа
 * сокета — 1,5 с. systemd — `systemctl --user restart` (у остановленного юнита это старт).
 */
export function restart(ctx: ServiceContext): Step {
  if (ctx.platform === 'darwin') {
    if (!ctx.file) return { cmd: restartCommand(ctx), ok: false, detail: 'неизвестен путь к файлу службы' }
    const r = load(ctx, ctx.file)
    const bad = r.steps.find((s) => !s.ok)
    return { cmd: restartCommand(ctx), ok: r.ok, detail: bad ? `${bad.cmd}: ${bad.detail}` : '' }
  }
  return step(runTool(ctx.systemctl, 'systemctl', ['--user', 'restart', ctx.name], ctx.env))
}

/**
 * Остановка процесса службы для `pult daemon stop`, когда сокет ещё не отвечает (демон стартует).
 * launchd: `kill SIGTERM` — демон выходит с кодом 0, и `KeepAlive {SuccessfulExit: false}` его не
 * поднимает; служба остаётся загруженной, следующая команда поднимет её через `kickstart`.
 * systemd: `stop` — синхронный, заодно отменяет запланированный `Restart=on-failure`.
 */
export function signalStop(ctx: ServiceContext): Step {
  if (ctx.platform === 'darwin') return step(runTool(ctx.launchctl, 'launchctl', ['kill', 'SIGTERM', guiTarget(ctx)], ctx.env))
  return step(runTool(ctx.systemctl, 'systemctl', ['--user', 'stop', ctx.name], ctx.env))
}
