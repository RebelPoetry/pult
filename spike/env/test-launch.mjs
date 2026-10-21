#!/usr/bin/env node
// S9d — pultd-launch self-healing tests.
// Cases: no state file · state points at a nonexistent path · state points at a
// non-executable file · state points at a FAKE OLD node (v18) · healthy state is
// reused untouched · daemon entry missing · real exec of the entry.
// Everything happens inside the leg's fakehome. Prints JSONL to stdout.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCH = join(HERE, 'service', 'pultd-launch');
// ПОЧЕМУ временная папка, а не spike/env/fakehome + spike/env/stubs: раньше проверка перезаписывала
// отслеживаемые git-ом файлы (stubs/old-node, stubs/not-exec-node) прямо в рабочем дереве. В CI
// прогон обязан оставлять `git status` пустым, поэтому всё состояние — в mkdtemp и сносится в конце.
// Отслеживаемые stubs/* остаются в репозитории как улика спайка и проверяются `sh -n`.
const TMP = mkdtempSync(join(tmpdir(), 'pult-launch-'));
const FAKEHOME = join(TMP, 'home');
const PULT_HOME = join(FAKEHOME, '.pult');
const STATE = join(PULT_HOME, 'node-path');
const STUBS = join(TMP, 'stubs');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

rmSync(PULT_HOME, { recursive: true, force: true });
mkdirSync(PULT_HOME, { recursive: true });
mkdirSync(STUBS, { recursive: true });

// fake OLD node: answers `-v` with v18.20.0 and nothing else
const OLD_NODE = join(STUBS, 'old-node');
writeFileSync(OLD_NODE, '#!/bin/sh\n[ "$1" = "-v" ] && echo v18.20.0 && exit 0\nexit 1\n');
chmodSync(OLD_NODE, 0o755);

// a file that exists but is NOT executable
const NOT_EXEC = join(STUBS, 'not-exec-node');
writeFileSync(NOT_EXEC, '#!/bin/sh\necho v24.0.0\n');
chmodSync(NOT_EXEC, 0o644);

// ПОЧЕМУ стаб логин-шелла вместо настоящего $SHELL: pultd-launch ищет node через
// `$SHELL -ilc 'command -v node'`, а на раннере CI нет ни zsh с rc-файлами, ни node в
// launchd-подобном PATH (/usr/bin:/bin:…). Стаб делает ветку «нашли через логин-шелл»
// детерминированной на любой машине и возвращает ровно тот node, которым запущена проверка.
// PULT_TEST_REAL_SHELL=1 возвращает поведение с настоящим шеллом (ручной прогон на маке).
const SHELL_STUB = join(STUBS, 'login-shell');
writeFileSync(SHELL_STUB, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(process.execPath)}\n`);
chmodSync(SHELL_STUB, 0o755);
const SHELL_FOR_RUN = process.env.PULT_TEST_REAL_SHELL === '1'
  ? (process.env.SHELL || '/bin/sh')
  : SHELL_STUB;

// a real daemon entry to exec
const ENTRY = join(PULT_HOME, 'entry.mjs');
writeFileSync(ENTRY, 'process.stdout.write(JSON.stringify({daemon:"started",node:process.version,argv:process.argv.slice(2)})+"\\n");\n');

function run(extraEnv, args = []) {
  const r = spawnSync('/bin/sh', [LAUNCH, ...args], {
    encoding: 'utf8', timeout: 30000,
    env: {
      HOME: FAKEHOME,
      SHELL: SHELL_FOR_RUN,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',          // launchd-like: node is NOT here
      PULT_HOME, PULT_ENTRY: ENTRY,
      ...extraEnv,
    },
  });
  return {
    code: r.status, signal: r.signal,
    stdout: (r.stdout || '').trim(),
    stderrLines: (r.stderr || '').trim().split('\n').filter(Boolean)
      .map((l) => l.replace(/^\S+Z /, '')),
  };
}
const state = () => (existsSync(STATE) ? readFileSync(STATE, 'utf8').trim() : null);

const cases = [];
const failures = [];
// `expect` — предикат по результату запуска. Без него проверка печатала факты и всегда выходила 0:
// в CI это означало бы зелёный прогон на сломанном лаунчере.
const record = (id, title, res, extra = {}, expect = null) => {
  const dry = (() => { try { return JSON.parse(res.stdout); } catch { return null; } })();
  const pass = expect ? !!expect({ res, dry, state: state() }) : true;
  if (!pass) failures.push(id);
  cases.push({ id, title, ...extra, pass, exitCode: res.code, stdout: res.stdout, stderr: res.stderrLines,
               stateAfter: state() });
  out({ check: 'S9d', case: id, title, ...extra, pass, exitCode: res.code, stdout: res.stdout,
        stderr: res.stderrLines, stateAfter: state() });
};
// Годный node: dry-run напечатал путь, версия >= 22, и именно он записан в файл состояния.
const healed = ({ res, dry, state: st }) => res.code === 0 && !!dry && !!dry.node
  && /^v(2[2-9]|[3-9][0-9])\./.test(dry.nodeVersion || '') && st === dry.node;

// 1. no state file at all
rmSync(STATE, { force: true });
record('S9d-1', 'no saved node path -> resolve + write state', run({ PULT_DRY_RUN: '1' }), {}, healed);

// 2. healthy saved path is reused (no re-resolution)
const healthy = state();
record('S9d-2', 'healthy saved path reused as-is', run({ PULT_DRY_RUN: '1' }), { savedBefore: healthy },
  ({ res, dry, state: st }) => res.code === 0 && dry?.node === healthy && st === healthy);

// 3. saved path does not exist
writeFileSync(STATE, '/opt/homebrew/Cellar/node/19.0.0/bin/node\n');
record('S9d-3', 'saved path missing -> self-heal', run({ PULT_DRY_RUN: '1' }),
  { savedBefore: '/opt/homebrew/Cellar/node/19.0.0/bin/node' },
  (c) => healed(c) && c.state !== '/opt/homebrew/Cellar/node/19.0.0/bin/node');

// 4. saved path exists but is not executable
writeFileSync(STATE, NOT_EXEC + '\n');
record('S9d-4', 'saved path not executable -> self-heal', run({ PULT_DRY_RUN: '1' }), { savedBefore: NOT_EXEC },
  (c) => healed(c) && c.state !== NOT_EXEC);

// 5. saved path is a real, executable, TOO OLD node
writeFileSync(STATE, OLD_NODE + '\n');
record('S9d-5', 'saved node v18.20.0 < 22 -> self-heal', run({ PULT_DRY_RUN: '1' }), { savedBefore: OLD_NODE },
  (c) => healed(c) && c.state !== OLD_NODE);

// 6. the stub would be accepted if the floor were lower — proves the check is the version, not the path
writeFileSync(STATE, OLD_NODE + '\n');
record('S9d-6', 'same stub accepted with PULT_MIN_NODE=18 (floor is what rejects it)',
  run({ PULT_DRY_RUN: '1', PULT_MIN_NODE: '18' }), { savedBefore: OLD_NODE },
  ({ res, dry }) => res.code === 0 && dry?.node === OLD_NODE && dry?.nodeVersion === 'v18.20.0');

// 7. daemon entry missing -> exit 78, no exec
rmSync(STATE, { force: true });
record('S9d-7', 'daemon entry missing -> EX_CONFIG 78', run({ PULT_ENTRY: join(PULT_HOME, 'nope.mjs') }), {},
  ({ res }) => res.code === 78 && res.stdout === '');

// 8. real exec of the entry, with args passed through
rmSync(STATE, { force: true });
record('S9d-8', 'real exec of the daemon entry', run({}, ['--spike']), {},
  ({ res, dry }) => res.code === 0 && dry?.daemon === 'started'
    && JSON.stringify(dry?.argv) === JSON.stringify(['--spike']));

// 9. no node anywhere reachable -> exit 78 (SHELL forced to a shell with a dead PATH)
writeFileSync(STATE, '/nope/node\n');
const noNode = spawnSync('/bin/sh', [LAUNCH], {
  encoding: 'utf8', timeout: 30000,
  env: { HOME: join(STUBS, 'emptyhome'), SHELL: '/bin/sh', PATH: '/nonexistent',
         PULT_HOME: join(STUBS, 'emptyhome', '.pult'), PULT_ENTRY: ENTRY,
         PULT_MIN_NODE: '99' },   // floor 99: no node on the machine can satisfy it
});
const noNodePass = noNode.status === 78;
if (!noNodePass) failures.push('S9d-9');
out({ check: 'S9d', case: 'S9d-9', title: 'no usable node -> EX_CONFIG 78', pass: noNodePass,
      exitCode: noNode.status, stdout: (noNode.stdout || '').trim(),
      stderr: (noNode.stderr || '').trim().split('\n').filter(Boolean).map((l) => l.replace(/^\S+Z /, '')) });

// posix-sh sanity: no bashisms. /bin/dash существует не везде (на маке его нет) — его отсутствие
// не провал, а `sh -n` обязан проходить всегда.
const shCheck = spawnSync('/bin/sh', ['-n', LAUNCH], { encoding: 'utf8' });
const dashCheck = spawnSync('/bin/dash', ['-n', LAUNCH], { encoding: 'utf8' });
const posixPass = shCheck.status === 0 && (dashCheck.error ? true : dashCheck.status === 0);
if (!posixPass) failures.push('S9d-posix');
out({ check: 'S9d', case: 'S9d-posix', title: 'POSIX sh syntax check', pass: posixPass,
      sh_n_exit: shCheck.status, sh_stderr: (shCheck.stderr || '').trim(),
      dash_available: !dashCheck.error, dash_n_exit: dashCheck.status ?? null });

rmSync(TMP, { recursive: true, force: true });
out({ check: 'S9d', step: 'done', cases: cases.length + 2, failed: failures.length, failedIds: failures });
process.exit(failures.length === 0 ? 0 : 1);
