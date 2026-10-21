// S5-codex "dead port": point every proxy env var at a closed port.
// If the turn fails with a connection error -> the env IS honoured. If it succeeds -> env IGNORED.
// Usage: node s5.mjs appserver|exec
import { AppServer, SPIKE, TEXT, CODEX, jlog } from './client.mjs';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const mode = process.argv[2] || 'appserver';
const LOG = new URL(`./logs/s5-${mode}.jsonl`, import.meta.url).pathname;
writeFileSync(LOG, '');

const DEAD = {
  ALL_PROXY: 'socks5h://127.0.0.1:9',
  all_proxy: 'socks5h://127.0.0.1:9',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  https_proxy: 'http://127.0.0.1:9',
  HTTP_PROXY: 'http://127.0.0.1:9',
  http_proxy: 'http://127.0.0.1:9',
  NO_PROXY: '',
  no_proxy: '',
};

if (mode === 'exec') {
  let out = '', ok = false, code = 0;
  try {
    out = execFileSync(CODEX, ['exec', '--json', '-c', 'model_reasoning_effort="low"', '-s', 'read-only', '-C', `${SPIKE}/sandbox-a`, 'reply with the single word OK'],
      { encoding: 'utf8', timeout: 180000, env: { ...process.env, ...DEAD } });
    ok = true;
  } catch (e) { out = (e.stdout || '') + (e.stderr || ''); code = e.status; }
  const lines = out.split('\n').filter(Boolean);
  const errLines = lines.filter((l) => /error|Error|proxy|refused|connect/i.test(l));
  const summary = {
    check: 'S5-codex-exec', deadEnv: DEAD, processExitCode: code, processSucceeded: ok,
    lineCount: lines.length,
    firstErrorLine: errLines[0]?.slice(0, 500) ?? null,
    lastLine: lines[lines.length - 1]?.slice(0, 500) ?? null,
    proxyHonoured: !ok || /refused|proxy|connect/i.test(out),
  };
  jlog(LOG, { ev: 'RAW', out: out.slice(0, 4000) });
  jlog(LOG, { ev: 'SUMMARY', ...summary });
  console.log(JSON.stringify(summary, null, 1));
  process.exit(0);
}

const srv = new AppServer({ env: DEAD, logFile: LOG });
await srv.initialize();
const th = await srv.request('thread/start', { cwd: `${SPIKE}/sandbox-a`, sandbox: 'read-only', approvalPolicy: 'never' });
const threadId = th.threadId ?? th.thread?.id;
const errors = [];
srv.onNotification = (m) => { if (m.method === 'error') errors.push(m.params); };
const done = srv.waitTurn(threadId, 120000);
let turnStartErr = null, completed = null;
try {
  await srv.request('turn/start', { threadId, input: TEXT('reply with the single word OK'), effort: 'low' }, 120000);
  completed = await done;
} catch (e) { turnStartErr = e.message; }

const text = (completed?.turn?.items || []).filter((i) => i.type === 'agentMessage').map((i) => i.text);
const summary = {
  check: 'S5-codex-appserver', deadEnv: DEAD,
  turnStatus: completed?.turn?.status ?? null,
  turnError: completed?.turn?.error ?? null,
  errorNotifications: errors.slice(0, 3),
  agentText: text,
  clientError: turnStartErr,
  stderrTail: srv.stderr.slice(-5),
  proxyHonoured: completed?.turn?.status !== 'completed',
};
jlog(LOG, { ev: 'SUMMARY', ...summary });
console.log(JSON.stringify(summary, null, 1));
await srv.kill();
process.exit(0);
