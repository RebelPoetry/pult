// S4 (c): the shared local daemon. `codex app-server daemon start|version|restart|stop`
// + attaching a normal stdio JSON-RPC client through `codex app-server proxy`.
import { AppServer, PROXY_ENV, SPIKE, TEXT, CODEX, jlog } from './client.mjs';
import { writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const LOG = new URL('./logs/s4c.jsonl', import.meta.url).pathname;
writeFileSync(LOG, '');
const SOCK = `${process.env.HOME}/.codex/app-server-control/app-server-control.sock`;

const sh = (args) => {
  try { return { ok: true, out: execFileSync(CODEX, args, { encoding: 'utf8', timeout: 120000 }).trim() }; }
  catch (e) { return { ok: false, out: ((e.stdout || '') + (e.stderr || '')).trim(), code: e.status }; }
};

const steps = {};
steps.socketExistedBefore = existsSync(SOCK);
steps.versionBefore = sh(['app-server', 'daemon', 'version']);
jlog(LOG, { ev: 'before', ...steps });
if (steps.versionBefore.ok) {
  console.log(JSON.stringify({ check: 'S4-codex-c', verdict: 'PRE-EXISTING DAEMON — not touching it', versionBefore: steps.versionBefore.out }, null, 1));
  process.exit(0);
}

steps.start = sh(['app-server', 'daemon', 'start']);
steps.versionAfterStart = sh(['app-server', 'daemon', 'version']);
steps.socketPathExists = existsSync(SOCK);
jlog(LOG, { ev: 'started', start: steps.start, version: steps.versionAfterStart, sock: steps.socketPathExists });

// Attach the SAME JSON-RPC client through the proxy (stdio -> control socket).
const mk = (tag) => new AppServer({ env: PROXY_ENV, logFile: LOG, args: ['app-server', 'proxy'], cmd: CODEX });

const c1 = mk('c1');
const init1 = await c1.initialize('pult-spike-proxy');
const items1 = [];
c1.onNotification = (m) => { if (m.method === 'item/completed') items1.push(m.params.item); };
const th = await c1.request('thread/start', { cwd: `${SPIKE}/sandbox-a`, sandbox: 'read-only', approvalPolicy: 'never' });
const threadId = th.threadId ?? th.thread?.id;
const d1 = c1.waitTurn(threadId);
await c1.request('turn/start', { threadId, input: TEXT('reply with the single word DAEMON'), effort: 'low' });
const done1 = await d1;
steps.turn1 = { threadId, status: done1.turn?.status, text: items1.filter((i) => i.type === 'agentMessage').map((i) => i.text) };
jlog(LOG, { ev: 'turn1', ...steps.turn1 });
await c1.kill(); // kill only the proxy client, the daemon keeps the thread

steps.restart = sh(['app-server', 'daemon', 'restart']);
steps.versionAfterRestart = sh(['app-server', 'daemon', 'version']);
jlog(LOG, { ev: 'restarted', restart: steps.restart, version: steps.versionAfterRestart });

const c2 = mk('c2');
await c2.initialize('pult-spike-proxy2');
const items2 = [];
c2.onNotification = (m) => { if (m.method === 'item/completed') items2.push(m.params.item); };
let resumeErr = null, resumed = null;
try { resumed = await c2.request('thread/resume', { threadId, cwd: `${SPIKE}/sandbox-a`, sandbox: 'read-only', approvalPolicy: 'never', excludeTurns: true }); }
catch (e) { resumeErr = e.message; }
if (resumed) {
  const d2 = c2.waitTurn(threadId);
  await c2.request('turn/start', { threadId, input: TEXT('What single word did you reply earlier? Answer with just that word.'), effort: 'low' });
  const done2 = await d2;
  steps.turn2 = { status: done2.turn?.status, text: items2.filter((i) => i.type === 'agentMessage').map((i) => i.text) };
}
steps.resumeError = resumeErr;
await c2.kill();

steps.stop = sh(['app-server', 'daemon', 'stop']);
steps.versionAfterStop = sh(['app-server', 'daemon', 'version']);
steps.socketAfterStop = existsSync(SOCK);

const summary = { check: 'S4-codex-c', socketPath: SOCK, ...steps };
jlog(LOG, { ev: 'SUMMARY', ...summary });
console.log(JSON.stringify(summary, null, 1));
process.exit(0);
