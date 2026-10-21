// B3-codex: the B1 server process was SIGKILLed; start a fresh app-server, thread/resume the same
// threadId and ask a question that can only be answered from the earlier context.
// Usage: node b3.mjs <threadId>
import { AppServer, PROXY_ENV, SPIKE, TEXT, jlog } from './client.mjs';
import { writeFileSync } from 'node:fs';

const threadId = process.argv[2];
if (!threadId) { console.error('need threadId'); process.exit(1); }
const LOG = new URL('./logs/b3.jsonl', import.meta.url).pathname;
writeFileSync(LOG, '');

const items = [];
const srv = new AppServer({
  env: PROXY_ENV, logFile: LOG,
  onNotification: (m) => { if (m.method === 'item/completed') items.push(m.params.item); },
});
await srv.initialize();

const res = await srv.request('thread/resume', { threadId, cwd: `${SPIKE}/sandbox-a`, sandbox: 'read-only', approvalPolicy: 'never' });
jlog(LOG, { ev: 'resume_result_keys', keys: Object.keys(res), threadKeys: Object.keys(res.thread || {}) });

const done = srv.waitTurn(threadId);
await srv.request('turn/start', { threadId, input: TEXT('What single word did you reply earlier? Answer with just that word.'), effort: 'low' });
const completed = await done;

const summary = {
  check: 'B3-codex',
  resumedThreadId: res.thread?.id ?? res.threadId ?? null,
  sameId: (res.thread?.id ?? res.threadId) === threadId,
  resumeResultKeys: Object.keys(res),
  turnStatus: completed.turn?.status,
  itemsFromNotifications: items.map((i) => i.type),
  agentText: items.filter((i) => i.type === 'agentMessage').map((i) => i.text),
  notificationMethods: srv.methodsSeen(),
};
jlog(LOG, { ev: 'SUMMARY', ...summary });
console.log(JSON.stringify(summary, null, 1));
await srv.kill();
process.exit(0);
