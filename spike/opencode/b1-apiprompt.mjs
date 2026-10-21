// B1-opencode, third reply path: POST /api/session/{id}/prompt (the "next" API).
// Body is {prompt:{text}, delivery?, resume?} — no model field, so the model is set
// on the session first via POST /api/session/{id}/model.
import { makeClient, readPassword, jsonl, sleep } from './client.mjs';

const PORT = Number(process.argv[2]);
const DIR = process.argv[3];
const SES = process.argv[4];
const MODEL = { providerID: 'opencode', modelID: 'muse-spark-1.3-contributor-free' };

const log = jsonl(new URL('./logs/b1-api_prompt2.jsonl', import.meta.url).pathname);
const c = makeClient({ port: PORT, password: readPassword() });

const ac = new AbortController();
let done = false;
const ssePromise = c.sse('/event', {
  query: { directory: DIR },
  signal: ac.signal,
  onEvent: (e) => {
    if (!e || e.type === 'plugin.added' || e.type === 'server.heartbeat') return;
    const sid = e.properties?.sessionID ?? e.properties?.info?.sessionID;
    if (sid && sid !== SES) return;
    log.write({ check: 'B1', mode: 'api_prompt2', ev: e.type, status: e.properties?.status, partType: e.properties?.part?.type, field: e.properties?.field });
    if (e.type === 'session.idle' && sid === SES) done = true;
  },
});
await sleep(700);

const mres = await c.post(`/api/session/${SES}/model`, { providerID: MODEL.providerID, modelID: MODEL.modelID }, { directory: DIR });
log.write({ check: 'B1', mode: 'api_prompt2', step: 'POST /api/session/{id}/model', status: mres.status, body: mres.text.slice(0, 200) });

const t0 = Date.now();
const r = await c.post(`/api/session/${SES}/prompt`, { prompt: { text: 'reply with the single word OK' }, delivery: 'queue' }, { directory: DIR });
log.write({ check: 'B1', mode: 'api_prompt2', step: 'POST /api/session/{id}/prompt', status: r.status, ms: Date.now() - t0, body: r.text.slice(0, 400) });

const deadline = Date.now() + 90000;
while (!done && Date.now() < deadline) await sleep(300);
log.write({ check: 'B1', mode: 'api_prompt2', step: 'turn-end', done, ms: Date.now() - t0 });

const msgs = await c.get(`/session/${SES}/message`, { directory: DIR });
const arr = Array.isArray(msgs.json) ? msgs.json : [];
const last = arr[arr.length - 1];
if (last) log.write({ check: 'B1', mode: 'api_prompt2', step: 'last-message', role: last.info?.role, text: (last.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join(' ').slice(0, 200), tokens: last.info?.tokens, cost: last.info?.cost });

ac.abort();
await ssePromise.catch(() => {});
log.close();
process.exit(0);
