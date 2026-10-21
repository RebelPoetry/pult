// B2-opencode — permission round trip.
// Session-level ruleset forces asking; the host replies "reject" on the first run
// and "once" on the second. usage: node b2-permissions.mjs <port> <dir> <reject|once> [replyPath]
import { makeClient, readPassword, jsonl, sleep } from './client.mjs';

const PORT = Number(process.argv[2]);
const DIR = process.argv[3];
const REPLY = process.argv[4] || 'reject';
const REPLY_PATH = process.argv[5] || 'api'; // 'api' | 'global'
const MODEL = { providerID: 'opencode', modelID: 'muse-spark-1.3-contributor-free' };

const log = jsonl(new URL(`./logs/b2-permissions-${REPLY}.jsonl`, import.meta.url).pathname);
const c = makeClient({ port: PORT, password: readPassword() });

const ac = new AbortController();
let sessionID = null;
let done = false;
let replied = false;

const ssePromise = c.sse('/event', {
  query: { directory: DIR },
  signal: ac.signal,
  onEvent: async (e) => {
    if (!e || e.type === 'plugin.added' || e.type === 'server.heartbeat') return;
    const sid = e.properties?.sessionID ?? e.properties?.info?.sessionID ?? e.properties?.info?.id;
    if (sid && sessionID && sid !== sessionID) return;
    if (/permission/.test(e.type)) {
      log.write({ check: 'B2', reply: REPLY, ev: e.type, props: e.properties });
    } else if (['session.idle', 'session.status', 'session.error'].includes(e.type) || e.type.startsWith('session.next')) {
      log.write({ check: 'B2', reply: REPLY, ev: e.type, status: e.properties?.status, err: e.type === 'session.error' ? JSON.stringify(e.properties).slice(0, 300) : undefined });
    } else if (e.type === 'message.part.updated' && e.properties?.part?.type === 'tool') {
      log.write({ check: 'B2', reply: REPLY, ev: e.type, tool: e.properties.part.tool, state: e.properties.part.state?.status, input: JSON.stringify(e.properties.part.state?.input || {}).slice(0, 160) });
    }
    if ((e.type === 'permission.v2.asked' || e.type === 'permission.asked') && !replied) {
      replied = true;
      const requestID = e.properties?.id;
      const body = { reply: REPLY };
      const p = REPLY_PATH === 'api'
        ? `/api/session/${sessionID}/permission/${requestID}/reply`
        : `/permission/${requestID}/reply`;
      const r = await c.post(p, body, REPLY_PATH === 'api' ? undefined : { directory: DIR });
      log.write({ check: 'B2', reply: REPLY, step: 'POST ' + p.replace(sessionID, '{sessionID}').replace(requestID, '{requestID}'), body, status: r.status, resp: r.text.slice(0, 200) });
    }
    if (sid === sessionID && e.type === 'session.idle') done = true;
  },
});
await sleep(700);

const ruleset = [
  { permission: 'bash', pattern: '**', action: 'ask' },
  { permission: 'edit', pattern: '**', action: 'ask' },
];
const ses = await c.post('/session', { title: `spike-b2-${REPLY}`, permission: ruleset }, { directory: DIR });
sessionID = ses.json?.id;
log.write({ check: 'B2', reply: REPLY, step: 'POST /session (permission ruleset)', status: ses.status, sessionID, sent: ruleset, err: ses.status >= 400 ? ses.text.slice(0, 300) : undefined });
if (!sessionID) { log.close(); process.exit(1); }

const t0 = Date.now();
const r = await c.post(`/session/${sessionID}/prompt_async`, {
  model: MODEL,
  parts: [{ type: 'text', text: 'Run the shell command `echo hi` with the bash tool. Nothing else.' }],
}, { directory: DIR });
log.write({ check: 'B2', reply: REPLY, step: 'POST prompt_async', status: r.status });

const deadline = Date.now() + 120000;
while (!done && Date.now() < deadline) await sleep(300);
log.write({ check: 'B2', reply: REPLY, step: 'turn-end', done, sawPermission: replied, ms: Date.now() - t0 });

const msgs = await c.get(`/session/${sessionID}/message`, { directory: DIR });
for (const m of (Array.isArray(msgs.json) ? msgs.json : [])) {
  const tools = (m.parts || []).filter((p) => p.type === 'tool').map((p) => ({ tool: p.tool, status: p.state?.status, error: (p.state?.error || '').slice(0, 200), output: (p.state?.output || '').slice(0, 120) }));
  log.write({ check: 'B2', reply: REPLY, step: 'message', role: m.info?.role, tools, text: (m.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join(' ').slice(0, 250) });
}

ac.abort();
await ssePromise.catch(() => {});
log.close();
process.exit(0);
