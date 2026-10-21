// B5-codex: turn/start with `outputSchema` -> is the final agentMessage valid JSON matching it?
import { AppServer, PROXY_ENV, SPIKE, TEXT, jlog } from './client.mjs';
import { writeFileSync } from 'node:fs';

const LOG = new URL('./logs/b5.jsonl', import.meta.url).pathname;
writeFileSync(LOG, '');

const outputSchema = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['ok', 'fail'] } },
  required: ['verdict'],
  additionalProperties: false,
};

const items = [];
const srv = new AppServer({ env: PROXY_ENV, logFile: LOG, onNotification: (m) => { if (m.method === 'item/completed') items.push(m.params.item); } });
await srv.initialize();
const th = await srv.request('thread/start', { cwd: `${SPIKE}/sandbox-a`, sandbox: 'read-only', approvalPolicy: 'never' });
const threadId = th.threadId ?? th.thread?.id ?? th.id;

const done = srv.waitTurn(threadId);
await srv.request('turn/start', { threadId, input: TEXT('Everything is fine. Report the verdict.'), effort: 'low', outputSchema });
const completed = await done;

const text = items.filter((i) => i.type === 'agentMessage').map((i) => i.text).pop() ?? '';
let parsed = null, parseError = null;
try { parsed = JSON.parse(text); } catch (e) { parseError = e.message; }
const matches = !!parsed && typeof parsed === 'object' && ['ok', 'fail'].includes(parsed.verdict) && Object.keys(parsed).length === 1;

const summary = {
  check: 'B5-codex',
  turnStatus: completed.turn?.status,
  rawFinalMessage: text,
  parsed, parseError,
  matchesSchema: matches,
};
jlog(LOG, { ev: 'SUMMARY', ...summary });
console.log(JSON.stringify(summary, null, 1));
await srv.kill();
process.exit(0);
