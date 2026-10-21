#!/usr/bin/env node
// S9b — CLI locator.
// Finds claude, codex, opencode, git, gh, node, npm from a MINIMAL env,
// using the candidate paths from DELTA §6 / DELTA3 §6, then reports versions.
// Prints JSONL to stdout.

import { spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

// Minimal env: exactly what launchd hands a gui/ agent with no EnvironmentVariables.
const MINIMAL_ENV = { HOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', USER: process.env.USER ?? '' };

const expand = (p) => (p.startsWith('~/') ? join(HOME, p.slice(2)) : p);

function isExec(p) {
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch { return false; }
}

// --- PATH from login shell (cached by the daemon as ~/.pult/env.json) -------
function loginShellPath() {
  const shell = process.env.SHELL || '/bin/zsh';
  const r = spawnSync('/usr/bin/env', ['-i', `HOME=${HOME}`, `USER=${MINIMAL_ENV.USER}`,
    'PATH=/usr/bin:/bin:/usr/sbin:/sbin', shell, '-ilc', 'printf %s "$PATH"'],
    { encoding: 'utf8', timeout: 3000 });
  if (r.status !== 0) return { ok: false, entries: [], err: (r.stderr || '').slice(0, 200) };
  return { ok: true, entries: (r.stdout || '').split(':').filter(Boolean) };
}

function npmPrefix() {
  // must be resolved with a node/npm we can actually reach
  for (const npm of ['/opt/homebrew/bin/npm', '/usr/local/bin/npm']) {
    if (!isExec(npm)) continue;
    const r = spawnSync(npm, ['config', 'get', 'prefix'],
      { encoding: 'utf8', timeout: 15000, env: { ...MINIMAL_ENV, PATH: '/opt/homebrew/bin:' + MINIMAL_ENV.PATH } });
    if (r.status === 0) return (r.stdout || '').trim();
  }
  return null;
}

const shellPath = loginShellPath();
out({ check: 'S9b', step: 'login_shell_PATH', ok: shellPath.ok, count: shellPath.entries.length,
      unexpandedTildeEntries: shellPath.entries.filter((e) => e.startsWith('~')) });

const prefix = npmPrefix();
out({ check: 'S9b', step: 'npm_prefix', value: prefix });

// --- candidate paths, DELTA §6 / DELTA3 §6 ---------------------------------
const CANDIDATES = {
  claude: [
    '~/.claude/local/claude',
    prefix ? join(prefix, 'bin', 'claude') : null,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '~/.local/bin/claude',
  ],
  codex: [
    '~/.local/bin/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    prefix ? join(prefix, 'bin', 'codex') : null,
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ],
  opencode: [
    '/opt/homebrew/bin/opencode',
    '~/.local/bin/opencode',
    '~/.opencode/bin/opencode',
    prefix ? join(prefix, 'bin', 'opencode') : null,
    '/usr/local/bin/opencode',
  ],
  git: ['/opt/homebrew/bin/git', '/usr/bin/git', '/usr/local/bin/git'],
  gh: ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '~/.local/bin/gh'],
  node: ['/opt/homebrew/bin/node', '/usr/local/bin/node', '~/.volta/bin/node', '~/.nvm/versions/node', '/usr/bin/node'],
  npm: ['/opt/homebrew/bin/npm', '/usr/local/bin/npm', '~/.volta/bin/npm', '/usr/bin/npm'],
};

const VERSION_ARGV = {
  claude: ['--version'], codex: ['--version'], opencode: ['--version'],
  git: ['--version'], gh: ['--version'], node: ['-v'], npm: ['-v'],
};

// PATH search, as `which` would do, but restricted to the given entry list
function searchPath(name, entries) {
  const hits = [];
  for (const e of entries) {
    if (e.startsWith('~')) continue; // literal tilde in PATH never resolves for a child process
    const p = join(e, name);
    if (isExec(p)) hits.push(p);
  }
  return hits;
}

const results = {};
for (const [name, cands] of Object.entries(CANDIDATES)) {
  const tried = [];
  let found = null;
  for (const raw of cands) {
    if (!raw) continue;
    const p = expand(raw);
    const ok = isExec(p);
    tried.push({ path: p, exec: ok });
    if (ok && !found) found = p;
  }
  // fall back to the captured login-shell PATH
  const pathHits = shellPath.ok ? searchPath(name, shellPath.entries) : [];
  if (!found && pathHits.length) found = pathHits[0];

  // minimal-env `which` — proves the GUI child would NOT find it
  const whichMinimal = spawnSync('/usr/bin/which', [name], { encoding: 'utf8', env: MINIMAL_ENV, timeout: 5000 });

  let version = null, versionCode = null, real = null;
  if (found) {
    try { real = realpathSync(found); } catch { real = null; }
    const r = spawnSync(found, VERSION_ARGV[name], {
      encoding: 'utf8', timeout: 30000,
      env: { ...MINIMAL_ENV, PATH: '/opt/homebrew/bin:' + MINIMAL_ENV.PATH },
    });
    versionCode = r.status;
    version = ((r.stdout || '') + (r.stderr || '')).trim().split('\n')[0] || null;
  }

  results[name] = { found, real, version, versionCode };
  out({ check: 'S9b', step: 'locate', name, found, realpath: real,
        version, versionExitCode: versionCode,
        candidatesTried: tried,
        loginShellPathHits: pathHits,
        foundInMinimalEnvPATH: whichMinimal.status === 0 ? (whichMinimal.stdout || '').trim() : null });
}

const missingInGui = Object.entries(results).filter(([n]) => {
  const w = spawnSync('/usr/bin/which', [n], { encoding: 'utf8', env: MINIMAL_ENV, timeout: 5000 });
  return w.status !== 0;
}).map(([n]) => n);

out({ check: 'S9b', step: 'summary',
      allFound: Object.entries(results).filter(([, v]) => v.found).map(([k]) => k),
      notFound: Object.entries(results).filter(([, v]) => !v.found).map(([k]) => k),
      notOnMinimalEnvPATH: missingInGui });
