// B5-opencode — structured output via format:{type:"json_schema",schema,retryCount}.
// Where does the result land, and what happens on a schema the model tends to violate.
import { makeClient, readPassword, jsonl, sleep } from './client.mjs';

const PORT = Number(process.argv[2]);
const DIR = process.argv[3];
const MODEL = { providerID: 'opencode', modelID: 'muse-spark-1.3-contributor-free' };

const log = jsonl(new URL('./logs/b5-structured.jsonl', import.meta.url).pathname);
const c = makeClient({ port: PORT, password: readPassword() });

const schema = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['ok'] },
    count: { type: 'integer' },
  },
  required: ['verdict', 'count'],
  additionalProperties: false,
};

const ac = new AbortController();
let sessionID = null, idle = false;
const evTypes = [];
const ssePromise = c.sse('/event', {
  query: { directory: DIR },
  signal: ac.signal,
  onEvent: (e) => {
    if (!e || e.type === 'plugin.added' || e.type === 'server.heartbeat') return;
    const sid = e.properties?.sessionID ?? e.properties?.info?.sessionID ?? e.properties?.info?.id;
    if (sid !== sessionID) return;
    evTypes.push(e.type);
    if (e.type === 'session.error') log.write({ check: 'B5', ev: 'session.error', props: JSON.stringify(e.properties).slice(0, 400) });
    if (e.type === 'message.updated' && e.properties?.info?.structured !== undefined) log.write({ check: 'B5', ev: 'message.updated', structured: e.properties.info.structured, error: e.properties.info.error });
    if (e.type === 'session.idle') idle = true;
  },
});
await sleep(700);

const ses = await c.post('/session', { title: 'spike-b5' }, { directory: DIR });
sessionID = ses.json?.id;
log.write({ check: 'B5', step: 'POST /session', sessionID });

const t0 = Date.now();
const r = await c.post(`/session/${sessionID}/prompt_async`, {
  model: MODEL,
  format: { type: 'json_schema', schema, retryCount: 1 },
  parts: [{ type: 'text', text: 'Set verdict to ok and count to 3.' }],
}, { directory: DIR });
log.write({ check: 'B5', step: 'POST prompt_async with format', status: r.status, err: r.status >= 400 ? r.text.slice(0, 300) : undefined, sentFormat: { type: 'json_schema', retryCount: 1 } });

const deadline = Date.now() + 120000;
while (!idle && Date.now() < deadline) await sleep(300);
log.write({ check: 'B5', step: 'turn-end', idle, ms: Date.now() - t0 });

const msgs = await c.get(`/session/${sessionID}/message`, { directory: DIR });
for (const m of (Array.isArray(msgs.json) ? msgs.json : [])) {
  if (m.info?.role !== 'assistant') continue;
  log.write({
    check: 'B5', step: 'assistant-message',
    infoKeys: Object.keys(m.info),
    structured: m.info.structured ?? null,
    error: m.info.error ?? null,
    text: (m.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join(' ').slice(0, 300),
  });
}
log.write({ check: 'B5', step: 'event-types', evTypes: [...new Set(evTypes)] });

ac.abort();
await ssePromise.catch(() => {});
log.close();
process.exit(0);
