// B1-opencode — event stream: subscribe to /event?directory= FIRST, then send a reply.
// usage: node b1-stream.mjs <port> <mode: prompt_async|message|api_prompt> <directory>
import { makeClient, readPassword, jsonl, sleep } from './client.mjs';

const PORT = Number(process.argv[2]);
const MODE = process.argv[3] || 'prompt_async';
const DIR = process.argv[4];
const MODEL = { providerID: 'opencode', modelID: 'muse-spark-1.3-contributor-free' };

const log = jsonl(new URL(`./logs/b1-${MODE}.jsonl`, import.meta.url).pathname);
const c = makeClient({ port: PORT, password: readPassword() });

const ac = new AbortController();
const seen = [];
let sessionID = null;
let done = false;

const ssePromise = c.sse('/event', {
  query: { directory: DIR },
  signal: ac.signal,
  onEvent: (e) => {
    if (!e) return;
    const rec = { type: e.type, sid: e.properties?.sessionID ?? e.properties?.info?.sessionID ?? e.properties?.info?.id };
    seen.push(rec);
    const mine = !sessionID || rec.sid === sessionID || rec.sid === undefined;
    if (mine) {
      let extra = {};
      if (e.type === 'session.status') extra = { status: e.properties?.status };
      if (e.type === 'message.part.delta') extra = { partType: e.properties?.part?.type ?? e.properties?.type, field: e.properties?.field };
      if (e.type === 'message.part.updated') extra = { partType: e.properties?.part?.type, tool: e.properties?.part?.tool, state: e.properties?.part?.state?.status };
      if (e.type.startsWith('session.next.tool')) extra = { tool: e.properties?.tool ?? e.properties?.name };
      if (e.type === 'session.error') extra = { error: JSON.stringify(e.properties).slice(0, 400) };
      log.write({ check: 'B1', mode: MODE, ev: e.type, ...extra });
    }
    if (rec.sid === sessionID && (e.type === 'session.idle' || (e.type === 'session.status' && e.properties?.status?.type === 'idle'))) done = true;
  },
});

await sleep(700); // let SSE attach

const ses = await c.post('/session', { title: `spike-b1-${MODE}` }, { directory: DIR });
sessionID = ses.json?.id;
log.write({ check: 'B1', mode: MODE, step: 'POST /session', status: ses.status, sessionID, keys: ses.json ? Object.keys(ses.json) : null, directory: ses.json?.directory });

const parts = [{ type: 'text', text: 'reply with the single word OK' }];
let r;
const t0 = Date.now();
if (MODE === 'prompt_async') {
  r = await c.post(`/session/${sessionID}/prompt_async`, { model: MODEL, parts }, { directory: DIR });
} else if (MODE === 'message') {
  r = await c.post(`/session/${sessionID}/message`, { model: MODEL, parts }, { directory: DIR });
} else {
  r = await c.post(`/api/session/${sessionID}/prompt`, { model: MODEL, parts }, { directory: DIR });
}
log.write({ check: 'B1', mode: MODE, step: `POST ${MODE}`, status: r.status, ms: Date.now() - t0, bodyKeys: r.json ? (Array.isArray(r.json) ? 'array' : Object.keys(r.json)) : null, bodyHead: r.text.slice(0, 300) });

const deadline = Date.now() + 120000;
while (!done && Date.now() < deadline) await sleep(300);
log.write({ check: 'B1', mode: MODE, step: 'turn-end', done, msTotal: Date.now() - t0 });

// final message list: text + usage/cost fields
const msgs = await c.get(`/session/${sessionID}/message`, { directory: DIR });
const arr = Array.isArray(msgs.json) ? msgs.json : [];
for (const m of arr) {
  const info = m.info ?? m;
  log.write({
    check: 'B1', mode: MODE, step: 'message',
    role: info.role, id: info.id,
    tokens: info.tokens, cost: info.cost, modelID: info.modelID, providerID: info.providerID,
    partTypes: (m.parts ?? []).map((p) => p.type),
    text: (m.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join(' ').slice(0, 200),
    structured: info.structured ?? null,
  });
}
log.write({ check: 'B1', mode: MODE, step: 'event-type-histogram', hist: seen.reduce((a, r) => (a[r.type] = (a[r.type] || 0) + 1, a), {}) });
log.write({ check: 'B1', mode: MODE, step: 'session-id', sessionID });

ac.abort();
await ssePromise.catch(() => {});
log.close();
process.exit(0);
