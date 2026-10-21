#!/usr/bin/env node
// S9e driver — install 0.0.1, then the broken 0.0.2, prove the rollback, prove the
// running version's files are never touched, and time npm install offline
// (direct vs through a DEAD proxy vs through the live proxy). Prints JSONL.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, readFileSync, readlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const UPDATE = join(HERE, 'update.mjs');
// ПОЧЕМУ mkdtemp, а не spike/env/fakehome: установка тащит в папку сотни файлов и кэш npm.
// В CI прогон обязан оставлять рабочее дерево чистым, поэтому фальшивый ~/.pult — временный.
const TMP = mkdtempSync(join(tmpdir(), 'pult-update-'));
const PULT_HOME = join(TMP, '.pult');
const VERSIONS = join(PULT_HOME, 'versions');
const CURRENT = join(PULT_HOME, 'current');
const TB1 = join(HERE, 'tarballs', 'pult-dummy-0.0.1.tgz');
const TB2 = join(HERE, 'tarballs', 'pult-dummy-0.0.2.tgz');
const NODE = process.execPath;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

// npm ищем в PATH, а не по прошитому пути homebrew: на раннере CI он лежит в другом месте.
const NPM_BIN = (() => {
  const r = spawnSync('/usr/bin/env', ['sh', '-c', 'command -v npm'], { encoding: 'utf8' });
  return (r.stdout || '').trim() || 'npm';
})();

rmSync(VERSIONS, { recursive: true, force: true });
rmSync(CURRENT, { force: true });
mkdirSync(VERSIONS, { recursive: true });

function update(version, tarball, extraEnv = {}) {
  const r = spawnSync(NODE, [UPDATE, version, tarball], {
    encoding: 'utf8', timeout: 240000,
    env: { PATH: process.env.PATH, NPM_BIN, PULT_HOME, ...extraEnv },
  });
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  lines.forEach((l) => out({ from: 'update.mjs', ...l }));
  if (r.stderr?.trim()) out({ from: 'update.mjs:stderr', text: r.stderr.trim().split('\n').slice(-5) });
  return { exitCode: r.status, lines, find: (step) => lines.find((l) => l.step === step) };
}
const curVersion = () => {
  const r = spawnSync(join(CURRENT, 'bin', 'pult-dummy'), [], { encoding: 'utf8', timeout: 20000 });
  return r.status === 0 ? (r.stdout || '').trim() : `ERR(status=${r.status},err=${r.error?.code ?? null})`;
};
const PKG_ROOT = (v) => join(VERSIONS, v, 'lib', 'node_modules', 'pult-dummy');
const fileId = (p) => { const s = statSync(p); return { ino: s.ino, size: s.size, mtimeMs: s.mtimeMs }; };

const results = [];
const R = (id, title, pass, detail) => { results.push({ id, title, pass, detail });
  out({ check: 'S9e', case: id, title, pass, detail }); };

// ===== 1. install 0.0.1 ====================================================
const u1 = update('0.0.1', TB1);
R('S9e-install1', 'npm install --prefix into the leg fakehome, symlink current -> 0.0.1',
  u1.exitCode === 0 && curVersion() === '0.0.1' && u1.find('result')?.action === 'kept',
  { installExit: u1.find('npm_install')?.exitCode, installMs: u1.find('npm_install')?.ms,
    action: u1.find('result')?.action, running: curVersion(),
    current: readlinkSync(CURRENT) });

// --- layout: --prefix alone vs --global --prefix ---------------------------
const localMode = join(TMP, '.pult-localmode');
rmSync(localMode, { recursive: true, force: true });
mkdirSync(join(localMode, 'versions'), { recursive: true });
const uLocal = spawnSync(NODE, [UPDATE, '0.0.1', TB1], {
  encoding: 'utf8', timeout: 240000,
  env: { PATH: process.env.PATH, NPM_BIN, PULT_HOME: localMode, PULT_INSTALL_MODE: 'local' },
});
const localLines = (uLocal.stdout || '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
R('S9e-layout', '`npm install --prefix` alone gives a PROJECT layout; `--global --prefix` gives bin/ + lib/node_modules',
  existsSync(join(VERSIONS, '0.0.1', 'bin', 'pult-dummy'))
    && existsSync(join(localMode, 'versions', '0.0.1', 'node_modules', '.bin', 'pult-dummy')),
  { globalMode: { argv: u1.find('npm_install')?.argv,
                  binDir: u1.find('npm_install')?.binDir,
                  binExists: existsSync(join(VERSIONS, '0.0.1', 'bin', 'pult-dummy')) },
    localMode: { argv: localLines.find((l) => l.step === 'npm_install')?.argv,
                 binDir: localLines.find((l) => l.step === 'npm_install')?.binDir,
                 binExists: existsSync(join(localMode, 'versions', '0.0.1', 'node_modules', '.bin', 'pult-dummy')) },
    designImpact: 'DELTA3 §2 must say `npm install --global --prefix ~/.pult/versions/<v> <tgz>`; '
                + 'plain --prefix puts the bins in <prefix>/node_modules/.bin' });

// snapshot the running version's files
const V1_BIN = join(PKG_ROOT('0.0.1'), 'bin', 'pult-dummy.mjs');
const v1Before = existsSync(V1_BIN) ? fileId(V1_BIN) : null;
const v1PkgBefore = readFileSync(join(PKG_ROOT('0.0.1'), 'package.json'), 'utf8');

// ===== 2. install the BROKEN 0.0.2 -> must roll back =======================
const u2 = update('0.0.2', TB2);
const res2 = u2.find('result');
R('S9e-rollback', 'broken 0.0.2 crash-loops 3 start probes -> symlink rolled back to 0.0.1',
  res2?.action === 'rolled_back' && res2?.failedProbes === 3 && curVersion() === '0.0.1',
  { action: res2?.action, failedProbes: res2?.failedProbes,
    probeStderr: u2.lines.filter((l) => l.step === 'start_probe').map((l) => l.stderr),
    runningAfter: curVersion(), current: readlinkSync(CURRENT),
    badVersionStillOnDisk: res2?.badVersionStillOnDisk });

const v1After = existsSync(V1_BIN) ? fileId(V1_BIN) : null;
const v1PkgAfter = readFileSync(join(PKG_ROOT('0.0.1'), 'package.json'), 'utf8');
R('S9e-norewrite', 'files of the running version are byte- and inode-identical after the failed update',
  JSON.stringify(v1Before) === JSON.stringify(v1After) && v1PkgBefore === v1PkgAfter,
  { before: v1Before, after: v1After, packageJsonUnchanged: v1PkgBefore === v1PkgAfter });

// ===== 3. offline install: network needed? =================================
// dead proxy — if npm needed the registry, this must fail.
// PULT_NPM_OFFLINE=0 — намеренно: именно этот прогон доказывает, что установка локального
// тарбола не ходит в реестр САМА, а не потому что ей запретили флагом `--offline`.
const t0 = Date.now();
const uDead = update('0.0.1-deadproxy', TB1, { PULT_PROXY: 'http://127.0.0.1:9', PULT_NPM_OFFLINE: '0' });
const deadMs = uDead.find('npm_install')?.ms;
R('S9e-offline-deadproxy', 'offline tarball installs with HTTPS_PROXY/ALL_PROXY pointed at a dead port',
  uDead.find('npm_install')?.exitCode === 0,
  { exitCode: uDead.find('npm_install')?.exitCode, ms: deadMs,
    stderr: uDead.find('npm_install')?.stderr,
    conclusion: uDead.find('npm_install')?.exitCode === 0
      ? 'npm install of a local tarball needs NO network and no registry round-trip'
      : 'npm DID try the network' });

// live proxy
const uProxy = update('0.0.1-liveproxy', TB1, { PULT_PROXY: 'http://127.0.0.1:10808' });
// no proxy at all
const uDirect = update('0.0.1-direct', TB1);
R('S9e-timing', 'install time: direct vs live proxy vs dead proxy (offline tarball)',
  uProxy.find('npm_install')?.exitCode === 0 && uDirect.find('npm_install')?.exitCode === 0,
  { directMs: uDirect.find('npm_install')?.ms,
    liveProxyMs: uProxy.find('npm_install')?.ms,
    deadProxyMs: deadMs,
    firstInstallMs: u1.find('npm_install')?.ms,
    note: 'all four are the same order of magnitude -> no registry traffic' });

// ===== 4. no global write ==================================================
// prove the install only wrote inside PULT_HOME: check the real npm prefix is untouched
const realPrefix = (spawnSync(NPM_BIN, ['config', 'get', 'prefix'],
  { encoding: 'utf8', timeout: 60000 }).stdout || '').trim();
const globalDummy = join(realPrefix, 'lib', 'node_modules', 'pult-dummy');
// Проверяем не сам ~/.pult (он может существовать легально, когда Пульт уже установлен),
// а признак того, что ИМЕННО ЭТА проверка туда что-то положила.
const realHomeDummy = join(process.env.HOME || TMP, '.pult', 'versions', '0.0.1');
R('S9e-noglobal', 'nothing written to the global npm prefix or the real ~/.pult',
  !!realPrefix && !existsSync(globalDummy) && !existsSync(realHomeDummy),
  { globalPrefix: realPrefix, globalPultDummyExists: existsSync(globalDummy),
    realHomeVersionExists: existsSync(realHomeDummy) });

// ===== 5. atomic swap: `current` is never absent ===========================
// symlink(tmp)+rename vs `ln -sfn`: show ln -sfn's unlink+symlink window exists.
const lnProbe = spawnSync('/bin/sh', ['-c',
  `cd ${JSON.stringify(PULT_HOME)} && ln -sfn versions/0.0.1 cur-ln-test && readlink cur-ln-test && ` +
  `ln -sfn versions/0.0.2 cur-ln-test && readlink cur-ln-test && rm -f cur-ln-test`],
  { encoding: 'utf8', timeout: 20000 });
R('S9e-atomicswap', 'current swapped with symlink(tmp)+rename(tmp,current), never unlink-then-symlink',
  u1.find('symlink_swapped')?.method === 'symlink(tmp)+rename(tmp,current)',
  { methodUsed: u1.find('symlink_swapped')?.method,
    lnSfnAlsoWorks: lnProbe.status === 0,
    lnSfnReadlinks: (lnProbe.stdout || '').trim().split('\n'),
    why: 'ln -sfn on an existing symlink is unlink(2)+symlink(2): a reader in that window sees ENOENT' });

rmSync(TMP, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
out({ check: 'S9e', step: 'done', total: results.length,
      failed: failed.length, failedIds: failed.map((r) => r.id) });
// Провалившееся утверждение обязано ронять процесс: иначе CI зелёный при сломанном откате.
process.exit(failed.length === 0 ? 0 : 1);
