#!/usr/bin/env node
// S5-claude — "dead port": does `claude` honour HTTPS_PROXY?
// No model turn is attempted beyond what the login gate allows.
// Every run uses a MINIMAL env: this machine's shell exports ANTHROPIC_BASE_URL
// and CLAUDE_CODE_* (see capture-env.log.jsonl), which would poison the probe.
// Prints JSONL to stdout.

import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const CLAUDE = '/opt/homebrew/bin/claude';
const DEAD = 'http://127.0.0.1:9';         // discard port, nothing listens
const LIVE = 'http://127.0.0.1:10808';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

function run(label, args, proxy, timeout = 60000) {
  const env = { HOME: homedir(), PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
                TERM: 'dumb', CI: '1' };
  if (proxy) { env.HTTPS_PROXY = proxy; env.HTTP_PROXY = proxy; env.NO_PROXY = 'localhost,127.0.0.1,::1'; }
  const t0 = Date.now();
  const r = spawnSync(CLAUDE, args, { encoding: 'utf8', timeout, env, cwd: '/tmp', input: '' });
  const text = ((r.stdout || '') + (r.stderr || '')).trim();
  out({ check: 'S5-claude', label, argv: ['claude', ...args], proxy: proxy ?? null,
        exitCode: r.status, signal: r.signal, ms: Date.now() - t0,
        spawnError: r.error ? String(r.error.code || r.error.message) : null,
        output: text.split('\n').slice(0, 6) });
  return { code: r.status, text };
}

// 0. baseline: the binary itself runs without login
run('version_no_proxy', ['--version'], null);
run('help_no_proxy', ['--help'], null);

// 1. the documented machine-readable login check
run('auth_status_json_no_proxy', ['auth', 'status', '--json'], null);
run('auth_status_json_dead_proxy', ['auth', 'status', '--json'], DEAD);

// 2. every other network-ish path
for (const args of [['doctor'], ['update', '--help'], ['mcp', 'list'], ['agents', '--json']]) {
  run(`${args.join('_')}_no_proxy`, args, null, 30000);
  run(`${args.join('_')}_dead_proxy`, args, DEAD, 30000);
}

// 3. the only real network path: a print turn. Not logged in -> it must stop at the
//    gate WITHOUT spending quota. If the gate came AFTER the proxy dial we would
//    see a connection error instead of "Not logged in".
run('print_turn_dead_proxy', ['-p', 'reply with the single word OK'], DEAD, 60000);
run('print_turn_live_proxy', ['-p', 'reply with the single word OK'], LIVE, 60000);

// 4. control: something that definitely dials the dead port, to show the port IS dead
const curl = spawnSync('/usr/bin/curl', ['-sS', '--max-time', '5', '-x', DEAD, 'https://api.anthropic.com/'],
  { encoding: 'utf8', timeout: 20000 });
out({ check: 'S5-claude', label: 'control_curl_dead_port', exitCode: curl.status,
      output: ((curl.stdout || '') + (curl.stderr || '')).trim().split('\n').slice(0, 3) });
const curlLive = spawnSync('/usr/bin/curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}',
  '--max-time', '10', '-x', LIVE, 'https://api.anthropic.com/'], { encoding: 'utf8', timeout: 25000 });
out({ check: 'S5-claude', label: 'control_curl_live_proxy', exitCode: curlLive.status,
      httpCode: (curlLive.stdout || '').trim(), stderr: (curlLive.stderr || '').trim().slice(0, 200) });

out({ check: 'S5-claude', step: 'done' });
