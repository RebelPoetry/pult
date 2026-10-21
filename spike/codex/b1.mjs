// B1-codex: initialize -> thread/start (cwd=sandbox-a) -> turn/start tiny prompt -> stream to turn/completed.
import { AppServer, PROXY_ENV, SPIKE, TEXT, jlog } from './client.mjs';
import { writeFileSync } from 'node:fs';

const LOG = new URL('./logs/b1.jsonl', import.meta.url).pathname;
writeFileSync(LOG, '');

const srv = new AppServer({ env: PROXY_ENV, logFile: LOG });
const init = await srv.initialize();
jlog(LOG, { ev: 'initialize_result', result: init });

const th = await srv.request('thread/start', {
  cwd: `${SPIKE}/sandbox-a`,
  sandbox: 'read-only',
  approvalPolicy: 'never',
});
const threadId = th.threadId ?? th.thread?.id ?? th.id;
jlog(LOG, { ev: 'thread_start_result', threadId, keys: Object.keys(th) });

const done = srv.waitTurn(threadId);
const ts = await srv.request('turn/start', {
  threadId,
  input: TEXT('reply with the single word OK'),
  effort: 'low',
});
jlog(LOG, { ev: 'turn_start_result', result: ts });
const completed = await done;

const summary = {
  check: 'B1-codex',
  threadId,
  turnStatus: completed.turn?.status,
  turnId: completed.turn?.id,
  itemTypes: (completed.turn?.items || []).map((i) => i.type),
  agentText: (completed.turn?.items || []).filter((i) => i.type === 'agentMessage').map((i) => i.text),
  notificationMethods: srv.methodsSeen(),
  serverRequests: srv.serverRequests.map((r) => r.method),
};
jlog(LOG, { ev: 'SUMMARY', ...summary });
console.log(JSON.stringify(summary, null, 1));
await srv.kill();
process.exit(0);
