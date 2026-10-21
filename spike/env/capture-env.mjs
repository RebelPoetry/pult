#!/usr/bin/env node
// S9a — login-shell env capture.
// Runs `$SHELL -ilc 'env -0'` with a 3s timeout, parses NUL-separated pairs,
// reports NAMES ONLY for anything secret-looking, PATH entries, *_PROXY vars,
// and diffs against a GUI-like minimal env (what a launchd child would see).
// Prints JSONL to stdout.

import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const SECRET_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

function classify(name) {
  return SECRET_RE.test(name) ? 'redacted-name-only' : 'plain';
}

function captureLoginShell(shell, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(shell, ['-ilc', 'env -0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    const errChunks = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => errChunks.push(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String(e.message), ms: Date.now() - t0 });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        timedOut,
        code,
        signal,
        ms: Date.now() - t0,
        raw: Buffer.concat(chunks),
        stderrBytes: Buffer.concat(errChunks).length,
      });
    });
  });
}

function parseNul(buf) {
  const env = {};
  let malformed = 0;
  for (const rec of buf.toString('utf8').split('\0')) {
    if (rec === '') continue;
    const i = rec.indexOf('=');
    if (i <= 0) { malformed++; continue; }
    env[rec.slice(0, i)] = rec.slice(i + 1);
  }
  return { env, malformed };
}

const shell = process.env.SHELL || '/bin/zsh';

// --- 1. login shell capture ------------------------------------------------
const runs = [];
for (let i = 0; i < 3; i++) runs.push(await captureLoginShell(shell, 3000));
const r = runs[0];
out({ check: 'S9a', step: 'login_shell_spawn', shell, argv: ['-ilc', 'env -0'],
      ok: r.ok, code: r.code, signal: r.signal, timedOut: !!r.timedOut,
      ms_runs: runs.map((x) => x.ms), stderrBytes: r.stderrBytes });

if (!r.ok) {
  out({ check: 'S9a', step: 'fatal', reason: 'login shell capture failed' });
  process.exit(1);
}

const { env: loginEnv, malformed } = parseNul(r.raw);
const loginNames = Object.keys(loginEnv).sort();
out({ check: 'S9a', step: 'parse', varCount: loginNames.length, malformedRecords: malformed,
      rawBytes: r.raw.length,
      names: loginNames.map((n) => (classify(n) === 'plain' ? n : n + ' [value-redacted]')) });

// PATH entries
const loginPath = (loginEnv.PATH || '').split(':').filter(Boolean);
out({ check: 'S9a', step: 'login_PATH', count: loginPath.length, entries: loginPath });

// proxy vars — names + values (proxy URLs are not secrets here; they are localhost)
const proxyNames = loginNames.filter((n) => /_PROXY$/i.test(n) || /^(https?_proxy|all_proxy|no_proxy)$/i.test(n));
out({ check: 'S9a', step: 'login_proxy_vars', count: proxyNames.length,
      vars: Object.fromEntries(proxyNames.map((n) => [n, loginEnv[n]])) });

// --- 2. GUI-like minimal env (what launchd gives a child) ------------------
// launchd agents get a very small env: PATH=/usr/bin:/bin:/usr/sbin:/sbin, HOME, USER... .
const minimal = spawnSync('/usr/bin/env', [
  '-i', `HOME=${homedir()}`, '/opt/homebrew/bin/node', '-e',
  'process.stdout.write(JSON.stringify(process.env))',
], { encoding: 'utf8', timeout: 10000 });
let minEnv = {};
try { minEnv = JSON.parse(minimal.stdout || '{}'); } catch { /* noop */ }
out({ check: 'S9a', step: 'minimal_env', code: minimal.status,
      names: Object.keys(minEnv).sort(),
      PATH: minEnv.PATH ?? null,
      note: 'env -i + node: node itself injects PWD; PATH is absent entirely' });

// launchd's real default PATH for a gui/ agent without EnvironmentVariables:
const LAUNCHD_DEFAULT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
out({ check: 'S9a', step: 'launchd_default_PATH_assumption', value: LAUNCHD_DEFAULT_PATH,
      note: 'not measured here (would need a loaded job); used only to compute what is missing' });

const missingPathEntries = loginPath.filter((p) => !LAUNCHD_DEFAULT_PATH.split(':').includes(p));
const missingVarNames = loginNames.filter((n) => !(n in minEnv));
out({ check: 'S9a', step: 'gap',
      pathEntriesMissingInGui: missingPathEntries,
      varsMissingInGuiCount: missingVarNames.length,
      varsMissingInGui: missingVarNames.map((n) => (classify(n) === 'plain' ? n : n + ' [value-redacted]')),
      proxyVarsMissingInGui: proxyNames.filter((n) => !(n in minEnv)) });

// --- 3. zsh functions are NOT captured by `env -0`, by design --------------
const fnProbe = spawnSync(shell, ['-ilc', 'typeset -f codex >/dev/null 2>&1 && echo FUNC_EXISTS || echo FUNC_ABSENT'],
  { encoding: 'utf8', timeout: 5000 });
const fnInEnv = spawnSync(shell, ['-ilc', "env -0 | tr '\\0' '\\n' | grep -c '^codex' || true"],
  { encoding: 'utf8', timeout: 5000 });
out({ check: 'S9a', step: 'zsh_function_not_in_env',
      typeset_f_codex: (fnProbe.stdout || '').trim(),
      env0_lines_starting_with_codex: (fnInEnv.stdout || '').trim(),
      note: 'shell FUNCTIONS live in the shell, never in the environment block; `env -0` cannot carry them. '
          + 'A daemon must call the codex BINARY by absolute path and set proxy vars itself.' });

// --- 4. login shell with a CLEAN parent env -------------------------------
// `$SHELL -ilc 'env -0'` inherits the caller's environment. A daemon started from
// a terminal would snapshot that terminal's junk. Re-run with `env -i` so only
// what the rc files + launchd-style base actually set survives.
const t1 = Date.now();
const clean = spawnSync('/usr/bin/env', [
  '-i', `HOME=${homedir()}`, `USER=${process.env.USER ?? ''}`, 'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
  shell, '-ilc', 'env -0',
], { encoding: 'buffer', timeout: 10000 });
const cleanMs = Date.now() - t1;
const { env: cleanEnv } = parseNul(clean.stdout ?? Buffer.alloc(0));
const cleanNames = Object.keys(cleanEnv).sort();
const cleanPath = (cleanEnv.PATH || '').split(':').filter(Boolean);
const cleanProxy = cleanNames.filter((n) => /_PROXY$/i.test(n) || /^(https?_proxy|all_proxy|no_proxy)$/i.test(n));
out({ check: 'S9a', step: 'clean_parent_login_shell', code: clean.status, ms: cleanMs,
      varCount: cleanNames.length,
      names: cleanNames.map((n) => (classify(n) === 'plain' ? n : n + ' [value-redacted]')),
      PATH_entries: cleanPath,
      proxyVars: Object.fromEntries(cleanProxy.map((n) => [n, cleanEnv[n]])),
      note: 'this is what a launchd-started daemon would actually get from the login shell' });

out({ check: 'S9a', step: 'done',
      medianMs: runs.map((x) => x.ms).sort((a, b) => a - b)[1],
      cleanParentMs: cleanMs });
