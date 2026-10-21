#!/usr/bin/env node
// S9c — validate the launchd plist and the systemd --user unit.
// plist: `plutil -lint` + key/type assertions read back with `plutil -convert json`.
// unit:  no systemd on macOS, so: INI parse, section/key whitelist, %h specifier check,
//        `systemd-analyze verify` attempted and reported as unavailable.
// DOES NOT bootstrap/load anything.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLIST = join(HERE, 'service', 'dev.pult.daemon.plist');
const UNIT = join(HERE, 'service', 'pultd.service');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

// ---------- plist ----------
const lint = spawnSync('/usr/bin/plutil', ['-lint', PLIST], { encoding: 'utf8' });
out({ check: 'S9c', step: 'plutil_lint', file: PLIST, exitCode: lint.status,
      stdout: (lint.stdout || '').trim(), stderr: (lint.stderr || '').trim() });

const asJson = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', PLIST], { encoding: 'utf8' });
let plist = null;
try { plist = JSON.parse(asJson.stdout); } catch { /* noop */ }
out({ check: 'S9c', step: 'plutil_convert_json', exitCode: asJson.status,
      stderr: (asJson.stderr || '').trim(), parsed: plist !== null });

const plistAsserts = [];
const A = (name, pass, got) => plistAsserts.push({ name, pass, got });
if (plist) {
  A('Label == dev.pult.daemon', plist.Label === 'dev.pult.daemon', plist.Label);
  A('ProgramArguments[0] is the launcher, not node',
    Array.isArray(plist.ProgramArguments) && /pultd-launch$/.test(plist.ProgramArguments[0] || ''),
    plist.ProgramArguments);
  A('ProgramArguments[0] exists and is executable',
    existsSync(plist.ProgramArguments?.[0] || ''), plist.ProgramArguments?.[0]);
  A('RunAtLoad === true', plist.RunAtLoad === true, plist.RunAtLoad);
  A('KeepAlive.SuccessfulExit === false',
    plist.KeepAlive && plist.KeepAlive.SuccessfulExit === false, plist.KeepAlive);
  A('StandardOutPath set', typeof plist.StandardOutPath === 'string', plist.StandardOutPath);
  A('StandardErrorPath set', typeof plist.StandardErrorPath === 'string', plist.StandardErrorPath);
  A('log dir is under the leg folder',
    (plist.StandardOutPath || '').startsWith(HERE), plist.StandardOutPath);
  A('EnvironmentVariables.PATH set',
    typeof plist.EnvironmentVariables?.PATH === 'string', plist.EnvironmentVariables?.PATH);
  A('PATH includes /opt/homebrew/bin (locator bootstrap)',
    (plist.EnvironmentVariables?.PATH || '').split(':').includes('/opt/homebrew/bin'),
    plist.EnvironmentVariables?.PATH);
  A('all paths are absolute (launchd rejects relative)',
    [plist.ProgramArguments?.[0], plist.StandardOutPath, plist.StandardErrorPath, plist.WorkingDirectory]
      .every((p) => typeof p === 'string' && p.startsWith('/')), null);
  A('no tilde anywhere (launchd does NOT expand ~)',
    !JSON.stringify(plist).includes('~'), null);
}
out({ check: 'S9c', step: 'plist_asserts', total: plistAsserts.length,
      failed: plistAsserts.filter((a) => !a.pass).length, asserts: plistAsserts });

// ---------- systemd unit ----------
const analyze = spawnSync('systemd-analyze', ['verify', UNIT], { encoding: 'utf8' });
out({ check: 'S9c', step: 'systemd_analyze_verify', available: !analyze.error,
      error: analyze.error ? String(analyze.error.code || analyze.error.message) : null,
      note: 'macOS has no systemd — this validator cannot run here; verdict for the unit is partial' });

const text = readFileSync(UNIT, 'utf8');
const KNOWN = {
  Unit: ['Description', 'Documentation', 'After', 'Before', 'Requires', 'Wants',
         'StartLimitIntervalSec', 'StartLimitBurst', 'ConditionPathExists'],
  Service: ['Type', 'ExecStart', 'ExecStop', 'ExecReload', 'Restart', 'RestartSec',
            'StandardOutput', 'StandardError', 'Environment', 'EnvironmentFile',
            'WorkingDirectory', 'KillMode', 'TimeoutStopSec', 'SyslogIdentifier'],
  Install: ['WantedBy', 'RequiredBy', 'Alias'],
};
let section = null;
const parsed = {};
const problems = [];
text.split('\n').forEach((line, i) => {
  const s = line.trim();
  if (!s || s.startsWith('#') || s.startsWith(';')) return;
  const sec = s.match(/^\[(.+)\]$/);
  if (sec) {
    section = sec[1];
    if (!(section in KNOWN)) problems.push({ line: i + 1, problem: `unknown section [${section}]` });
    parsed[section] = parsed[section] || [];
    return;
  }
  const kv = s.match(/^([A-Za-z][A-Za-z0-9]*)=(.*)$/);
  if (!kv) { problems.push({ line: i + 1, problem: `not a KEY=VALUE line: ${s}` }); return; }
  if (!section) { problems.push({ line: i + 1, problem: 'key outside any section' }); return; }
  const [, k, v] = kv;
  parsed[section].push([k, v]);
  if (KNOWN[section] && !KNOWN[section].includes(k)) {
    problems.push({ line: i + 1, problem: `key ${k} is not valid in [${section}]` });
  }
});
const get = (sec, key) => (parsed[sec] || []).filter(([k]) => k === key).map(([, v]) => v);
const unitAsserts = [];
const U = (name, pass, got) => unitAsserts.push({ name, pass, got });
U('sections are exactly [Unit] [Service] [Install]',
  JSON.stringify(Object.keys(parsed)) === JSON.stringify(['Unit', 'Service', 'Install']), Object.keys(parsed));
U('Restart=on-failure', get('Service', 'Restart')[0] === 'on-failure', get('Service', 'Restart'));
U('StandardOutput uses append:', /^append:/.test(get('Service', 'StandardOutput')[0] || ''),
  get('Service', 'StandardOutput'));
U('StandardError uses append:', /^append:/.test(get('Service', 'StandardError')[0] || ''),
  get('Service', 'StandardError'));
U('ExecStart is absolute or %h-rooted', /^(\/|%h\/)/.test(get('Service', 'ExecStart')[0] || ''),
  get('Service', 'ExecStart'));
U('ExecStart points at pultd-launch, not node', /pultd-launch$/.test(get('Service', 'ExecStart')[0] || ''),
  get('Service', 'ExecStart'));
U('StartLimit* live in [Unit], not [Service]',
  get('Unit', 'StartLimitBurst').length === 1 && get('Service', 'StartLimitBurst').length === 0, null);
U('no literal ~ (systemd does not expand it; %h is the specifier)', !text.replace(/^\s*#.*$/gm, '').includes('~'), null);
U('WantedBy=default.target (user unit, not multi-user.target)',
  get('Install', 'WantedBy')[0] === 'default.target', get('Install', 'WantedBy'));
U('linger is documented in the file', /enable-linger/.test(text), null);
out({ check: 'S9c', step: 'unit_syntax', parseProblems: problems,
      asserts: unitAsserts, failed: unitAsserts.filter((a) => !a.pass).length });

const failed = plistAsserts.filter((a) => !a.pass).length + unitAsserts.filter((a) => !a.pass).length;
out({ check: 'S9c', step: 'done', plutilLintExit: lint.status, totalFailedAsserts: failed,
      systemdVerified: false });
