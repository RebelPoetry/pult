// S4 (a)+(b): two threads on ONE app-server with different cwd / sandbox / effort,
// two turns started concurrently -> independent? parallel? (wall clock vs sum of durationMs)
import { AppServer, PROXY_ENV, SPIKE, TEXT, jlog } from './client.mjs';
import { writeFileSync } from 'node:fs';

const LOG = new URL('./logs/s4ab.jsonl', import.meta.url).pathname;
writeFileSync(LOG, '');

const byThread = new Map();
const srv = new AppServer({
  env: PROXY_ENV, logFile: LOG,
  onNotification: (m) => {
    const tid = m.params?.threadId;
    if (!tid) return;
    if (!byThread.has(tid)) byThread.set(tid, { items: [], turns: [] });
    if (m.method === 'item/completed') byThread.get(tid).items.push(m.params.item);
    if (m.method === 'turn/completed') byThread.get(tid).turns.push(m.params.turn);
  },
});
await srv.request('initialize', { clientInfo: { name: 'pult-spike', version: '0.0.1' }, capabilities: { experimentalApi: true } });
srv.notify('initialized', {});

const a = await srv.request('thread/start', { cwd: `${SPIKE}/sandbox-a`, sandbox: 'read-only', approvalPolicy: 'never' });
const b = await srv.request('thread/start', { cwd: `${SPIKE}/sandbox-b`, sandbox: 'workspace-write', approvalPolicy: 'never' });
const ida = a.threadId ?? a.thread?.id, idb = b.threadId ?? b.thread?.id;
jlog(LOG, { ev: 'threads', ida, idb, aCwd: a.cwd, bCwd: b.cwd, aSandbox: a.sandbox, bSandbox: b.sandbox, aEffort: a.reasoningEffort, bEffort: b.reasoningEffort });

const prompt = 'Run the shell command `pwd` and reply with exactly its output, nothing else.';
const t0 = Date.now();
const dA = srv.waitTurn(ida), dB = srv.waitTurn(idb);
await srv.request('turn/start', { threadId: ida, input: TEXT(prompt), effort: 'low' });
await srv.request('turn/start', { threadId: idb, input: TEXT(prompt), effort: 'low' });
const tStarted = Date.now();
const [ca, cb] = await Promise.all([dA, dB]);
const wall = Date.now() - t0;

const txt = (id) => (byThread.get(id)?.items || []).filter((i) => i.type === 'agentMessage').map((i) => i.text).join(' | ');
const summary = {
  check: 'S4-codex-ab',
  threadA: { id: ida, cwd: a.cwd, sandbox: a.sandbox, effort: a.reasoningEffort, answer: txt(ida), durationMs: ca.turn?.durationMs, status: ca.turn?.status },
  threadB: { id: idb, cwd: b.cwd, sandbox: b.sandbox, effort: b.reasoningEffort, answer: txt(idb), durationMs: cb.turn?.durationMs, status: cb.turn?.status },
  independentCwd: txt(ida).includes('sandbox-a') && txt(idb).includes('sandbox-b'),
  wallClockMs: wall,
  startOverheadMs: tStarted - t0,
  sumOfTurnDurationsMs: (ca.turn?.durationMs || 0) + (cb.turn?.durationMs || 0),
  parallel: wall < (ca.turn?.durationMs || 0) + (cb.turn?.durationMs || 0),
};
jlog(LOG, { ev: 'SUMMARY', ...summary });
console.log(JSON.stringify(summary, null, 1));
await srv.kill();
process.exit(0);
