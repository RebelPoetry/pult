// B4-codex: try to make the agent delegate to a subagent; record collabAgentToolCall / subAgentActivity items.
import { AppServer, PROXY_ENV, SPIKE, TEXT, jlog } from './client.mjs';
import { writeFileSync } from 'node:fs';

const LOG = new URL('./logs/b4.jsonl', import.meta.url).pathname;
writeFileSync(LOG, '');

const items = [];
const threadsStarted = [];
const srv = new AppServer({
  env: PROXY_ENV, logFile: LOG,
  onNotification: (m) => {
    if (m.method === 'item/completed') items.push(m.params.item);
    if (m.method === 'thread/started') threadsStarted.push(m.params);
  },
});
await srv.request('initialize', { clientInfo: { name: 'pult-spike', version: '0.0.1' }, capabilities: { experimentalApi: true } });
srv.notify('initialized', {});

const th = await srv.request('thread/start', { cwd: `${SPIKE}/sandbox-a`, sandbox: 'read-only', approvalPolicy: 'never' });
const threadId = th.threadId ?? th.thread?.id ?? th.id;

const done = srv.waitTurn(threadId);
await srv.request('turn/start', {
  threadId,
  input: TEXT('Use your agent-spawning tool to delegate one trivial task to a subagent: the subagent must reply with the single word PING. Report the subagent reply. Do not do the task yourself.'),
  effort: 'low',
});
const completed = await done;

const collab = items.filter((i) => i.type === 'collabAgentToolCall');
const subAct = items.filter((i) => i.type === 'subAgentActivity');
const summary = {
  check: 'B4-codex',
  turnStatus: completed.turn?.status,
  itemTypes: items.map((i) => i.type),
  collabAgentToolCalls: collab.map((i) => ({ tool: i.tool, status: i.status, senderThreadId: i.senderThreadId, receiverThreadIds: i.receiverThreadIds, model: i.model, reasoningEffort: i.reasoningEffort, agentsStates: i.agentsStates })),
  subAgentActivity: subAct.map((i) => ({ kind: i.kind, agentPath: i.agentPath, agentThreadId: i.agentThreadId })),
  threadStartedNotifications: threadsStarted.length,
  agentText: items.filter((i) => i.type === 'agentMessage').map((i) => i.text),
  notificationMethods: srv.methodsSeen(),
};
jlog(LOG, { ev: 'SUMMARY', ...summary });
console.log(JSON.stringify(summary, null, 1));
await srv.kill();
process.exit(0);
