// B2-codex: approval round-trip. approvalPolicy on-request + sandbox read-only,
// prompt forces a write -> server asks the client -> we answer decline (turn 1) then accept (turn 2).
// Usage: node b2.mjs decline|accept
import { AppServer, PROXY_ENV, SPIKE, TEXT, jlog } from './client.mjs';
import { writeFileSync, existsSync, rmSync } from 'node:fs';

const mode = process.argv[2] || 'decline';
const LOG = new URL(`./logs/b2-${mode}.jsonl`, import.meta.url).pathname;
writeFileSync(LOG, '');

const target = `${SPIKE}/sandbox-a/x.txt`;
if (existsSync(target)) rmSync(target);

const seen = [];
const srv = new AppServer({
  env: PROXY_ENV,
  logFile: LOG,
  onServerRequest: (msg, s) => {
    seen.push({ method: msg.method, params: msg.params });
    if (/requestApproval/.test(msg.method)) s.respond(msg.id, { decision: mode });
  },
});

await srv.initialize();
const th = await srv.request('thread/start', {
  cwd: `${SPIKE}/sandbox-a`,
  sandbox: 'read-only',
  approvalPolicy: 'on-request',
});
const threadId = th.threadId ?? th.thread?.id ?? th.id;

const done = srv.waitTurn(threadId);
await srv.request('turn/start', {
  threadId,
  input: TEXT('Run the shell command `echo hi > x.txt` in the current working directory. Nothing else, no explanation.'),
  effort: 'low',
});
const completed = await done;

const summary = {
  check: `B2-codex/${mode}`,
  threadId,
  approvalRequests: seen.map((s) => ({
    method: s.method,
    paramKeys: Object.keys(s.params || {}),
    command: s.params?.command,
    cwd: s.params?.cwd,
    availableDecisions: s.params?.availableDecisions,
    reason: s.params?.reason,
  })),
  answeredWith: mode,
  turnStatus: completed.turn?.status,
  itemTypes: (completed.turn?.items || []).map((i) => i.type),
  agentText: (completed.turn?.items || []).filter((i) => i.type === 'agentMessage').map((i) => i.text),
  cmdItems: (completed.turn?.items || []).filter((i) => i.type === 'commandExecution').map((i) => ({ status: i.status, command: i.command, exitCode: i.exitCode, aggregatedOutput: (i.aggregatedOutput || '').slice(0, 200) })),
  fileCreated: existsSync(target),
  notificationMethods: srv.methodsSeen(),
};
jlog(LOG, { ev: 'SUMMARY', ...summary });
console.log(JSON.stringify(summary, null, 1));
await srv.kill();
process.exit(0);
