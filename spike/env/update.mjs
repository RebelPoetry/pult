#!/usr/bin/env node
// S9e — install a version into <PULT_HOME>/versions/<v>, swap the `current`
// symlink atomically, probe the new daemon 3 times, roll back on a crash loop.
//
// Usage: node update.mjs <version> <tarball>
// Env:   PULT_HOME (required), NPM_BIN (default: `npm` из PATH),
//        PULT_PROXY (set HTTPS_PROXY/HTTP_PROXY/ALL_PROXY for the npm call),
//        PULT_NPM_OFFLINE=0 убирает `--offline` (нужно тому единственному прогону, который
//        доказывает, что установка локального тарбола и БЕЗ этого флага не ходит в сеть)
// Prints JSONL to stdout.

import { spawnSync } from 'node:child_process';
import {
  mkdirSync, symlinkSync, renameSync, readlinkSync, existsSync, rmSync,
  statSync, lstatSync, readdirSync,
} from 'node:fs';
import { join, basename } from 'node:path';

const PULT_HOME = process.env.PULT_HOME;
if (!PULT_HOME) { console.error('PULT_HOME required'); process.exit(2); }
// Путь к npm не прошит: на маке это /opt/homebrew/bin/npm, на раннере CI — совсем другое место.
const NPM = process.env.NPM_BIN || 'npm';
const VERSIONS = join(PULT_HOME, 'versions');
const CURRENT = join(PULT_HOME, 'current');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

const [version, tarball] = process.argv.slice(2);
if (!version || !tarball) { console.error('usage: update.mjs <version> <tarball>'); process.exit(2); }

// MEASURED (test-update.log.jsonl): `npm install --prefix <dir> <tgz>` treats <dir>
// as a PROJECT root -> <dir>/node_modules/<pkg> and <dir>/node_modules/.bin/<bin>.
// Only `npm install --global --prefix <dir>` produces the <dir>/bin +
// <dir>/lib/node_modules layout DELTA3 §2 assumes. PULT_INSTALL_MODE picks one.
const MODE = process.env.PULT_INSTALL_MODE || 'global';   // 'global' | 'local'
const prefixFor = (v) => join(VERSIONS, v);
const binFor = (v) => (MODE === 'global'
  ? join(prefixFor(v), 'bin')
  : join(prefixFor(v), 'node_modules', '.bin'));
const pkgRootFor = (v) => (MODE === 'global'
  ? join(prefixFor(v), 'lib', 'node_modules', 'pult-dummy')
  : join(prefixFor(v), 'node_modules', 'pult-dummy'));
const entryFor = (v) => join(binFor(v), 'pultd-dummy');
const cliFor = (v) => join(binFor(v), 'pult-dummy');

// ---- 1. install into its OWN prefix (never over the running version) -------
mkdirSync(prefixFor(version), { recursive: true });
const npmEnv = {
  HOME: PULT_HOME,
  // PATH наследуем: npm — это js-скрипт с `#!/usr/bin/env node`, и без node в PATH он не стартует.
  // Прошитый homebrew-PATH работал только на машине владельца.
  PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  npm_config_cache: join(PULT_HOME, 'npm-cache'),
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
};
if (process.env.PULT_PROXY) {
  npmEnv.HTTPS_PROXY = process.env.PULT_PROXY;
  npmEnv.HTTP_PROXY = process.env.PULT_PROXY;
  npmEnv.ALL_PROXY = process.env.PULT_PROXY;
  npmEnv.NO_PROXY = 'localhost,127.0.0.1,::1';
}
const t0 = Date.now();
// `--offline` — гарантия для CI: ни одного обращения к реестру, даже если у раннера есть сеть.
const OFFLINE = process.env.PULT_NPM_OFFLINE !== '0';
const installArgs = ['install', ...(MODE === 'global' ? ['--global'] : []),
  '--prefix', prefixFor(version), '--no-save', '--no-audit', '--no-fund',
  ...(OFFLINE ? ['--offline'] : []),
  '--loglevel', 'warn', tarball];
const inst = spawnSync(NPM, installArgs,
  { encoding: 'utf8', timeout: 180000, env: npmEnv });
const installMs = Date.now() - t0;
out({ check: 'S9e', step: 'npm_install', version, mode: MODE, argv: installArgs,
      tarball: basename(tarball), binDir: binFor(version), pkgRoot: pkgRootFor(version),
      prefix: prefixFor(version), exitCode: inst.status, ms: installMs,
      proxy: process.env.PULT_PROXY || null,
      stdout: (inst.stdout || '').trim().split('\n').slice(-3),
      stderr: (inst.stderr || '').trim().split('\n').slice(-5).filter(Boolean) });
if (inst.status !== 0) { out({ check: 'S9e', step: 'abort', reason: 'install failed' }); process.exit(1); }

// ---- 2. remember what `current` pointed at --------------------------------
const previous = existsSync(CURRENT) || (() => { try { lstatSync(CURRENT); return true; } catch { return false; } })()
  ? readlinkSync(CURRENT) : null;
out({ check: 'S9e', step: 'previous_current', target: previous });

// ---- 3. ATOMIC symlink swap -----------------------------------------------
// `ln -sfn` on an existing symlink is unlink()+symlink(): there is a window with
// no `current` at all. symlink(tmp) + rename(tmp, current) replaces in one step.
function swapTo(v) {
  const tmp = `${CURRENT}.tmp.${process.pid}.${Date.now()}`;
  symlinkSync(prefixFor(v), tmp);
  renameSync(tmp, CURRENT);          // atomic replace, POSIX rename(2)
  return readlinkSync(CURRENT);
}
const swapped = swapTo(version);
out({ check: 'S9e', step: 'symlink_swapped', method: 'symlink(tmp)+rename(tmp,current)',
      current: swapped, resolvedVersion: runVersion() });

function runVersion() {
  // deliberately goes through the `current` symlink, not the version dir:
  // this is what a caller on $PATH would execute
  const p = MODE === 'global'
    ? join(CURRENT, 'bin', 'pult-dummy')
    : join(CURRENT, 'node_modules', '.bin', 'pult-dummy');
  const r = spawnSync(p, [], { encoding: 'utf8', timeout: 20000 });
  return r.status === 0 ? (r.stdout || '').trim() : `ERR(status=${r.status},err=${r.error?.code ?? null})`;
}

// ---- 4. start probe x3, roll back on a crash loop -------------------------
const probes = [];
for (let i = 1; i <= 3; i++) {
  const p = spawnSync(entryFor(version), [], { encoding: 'utf8', timeout: 20000 });
  probes.push({ attempt: i, exitCode: p.status,
                stdout: (p.stdout || '').trim(), stderr: (p.stderr || '').trim() });
  out({ check: 'S9e', step: 'start_probe', version, attempt: i, exitCode: p.status,
        stdout: (p.stdout || '').trim(), stderr: (p.stderr || '').trim() });
  if (p.status === 0) break;
}
const healthy = probes.some((p) => p.exitCode === 0);

if (healthy) {
  out({ check: 'S9e', step: 'result', action: 'kept', version, current: readlinkSync(CURRENT),
        runningVersion: runVersion(), failedProbes: probes.filter((p) => p.exitCode !== 0).length });
} else if (previous) {
  const back = swapTo(basename(previous));
  out({ check: 'S9e', step: 'result', action: 'rolled_back',
        badVersion: version, failedProbes: probes.length,
        current: back, runningVersion: runVersion(),
        badVersionStillOnDisk: existsSync(prefixFor(version)),
        note: 'the bad version is left on disk; only the symlink moved' });
} else {
  out({ check: 'S9e', step: 'result', action: 'no_rollback_possible', version,
        reason: 'no previous current symlink' });
}

out({ check: 'S9e', step: 'versions_on_disk', dirs: readdirSync(VERSIONS).sort(),
      currentTarget: readlinkSync(CURRENT) });
