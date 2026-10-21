// S8c — stopping a turn. One long turn, then /api/session/{id}/interrupt first,
// then /session/{id}/abort, so both endpoints are compared inside one model turn.
import { makeClient, readPassword, jsonl, sleep } from './client.mjs';

const PORT = Number(process.argv[2]);
const DIR = process.argv[3];
const MODEL = { providerID: 'opencode', modelID: 'muse-spark-1.3-contributor-free' };

const log = jsonl(new URL('./logs/s8c-abort.jsonl', import.meta.url).pathname);
const c = makeClient({ port: PORT, password: readPassword() });

const ac = new AbortController();
let sessionID = null;
let idle = false;
let deltas = 0;

const ssePromise = c.sse('/event', {
  query: { directory: DIR },
  signal: ac.signal,
  onEvent: (e) => {
    if (!e || e.type === 'plugin.added' || e.type === 'server.heartbeat') return;
    const sid = e.properties?.sessionID ?? e.properties?.info?.sessionID ?? e.properties?.info?.id;
    if (sid && sessionID && sid !== sessionID) return;
    if (e.type === 'message.part.delta') { deltas++; return; }
    if (['session.status', 'session.idle', 'session.error'].includes(e.type) || e.type.startsWith('session.next')) {
      log.write({ check: 'S8c', ev: e.type, status: e.properties?.status, deltasSoFar: deltas, err: e.type === 'session.error' ? JSON.stringify(e.properties).slice(0, 300) : undefined });
    }
    if (sid === sessionID && e.type === 'session.idle') idle = true;
  },
});
await sleep(700);

const ses = await c.post('/session', { title: 'spike-s8c-abort' }, { directory: DIR });
sessionID = ses.json?.id;
log.write({ check: 'S8c', step: 'POST /session', status: ses.status, sessionID });

const t0 = Date.now();
await c.post(`/session/${sessionID}/prompt_async`, { model: MODEL, parts: [{ type: 'text', text: 'count slowly to 200, one number per line' }] }, { directory: DIR });
log.write({ check: 'S8c', step: 'prompt sent' });

await sleep(6000);
const d1 = deltas;
const it = await c.post(`/api/session/${sessionID}/interrupt`, {}, { directory: DIR });
log.write({ check: 'S8c', step: 'POST /api/session/{id}/interrupt', status: it.status, resp: it.text.slice(0, 200), deltasAtCall: d1 });

await sleep(4000);
const d2 = deltas;
log.write({ check: 'S8c', step: 'after interrupt', deltasGrew: d2 - d1, idle });

const ab = await c.post(`/session/${sessionID}/abort`, undefined, { directory: DIR });
log.write({ check: 'S8c', step: 'POST /session/{id}/abort', status: ab.status, resp: ab.text.slice(0, 200), deltasAtCall: d2 });

await sleep(5000);
const d3 = deltas;
log.write({ check: 'S8c', step: 'after abort', deltasGrew: d3 - d2, idle, msTotal: Date.now() - t0 });

const st = await c.get('/session/status', { directory: DIR });
log.write({ check: 'S8c', step: 'GET /session/status', status: st.status, mine: (st.json || []).filter?.((x) => x.sessionID === sessionID) ?? st.text.slice(0, 200) });

const msgs = await c.get(`/session/${sessionID}/message`, { directory: DIR });
const last = (Array.isArray(msgs.json) ? msgs.json : []).slice(-1)[0];
if (last) log.write({ check: 'S8c', step: 'last-message', role: last.info?.role, error: JSON.stringify(last.info?.error || null).slice(0, 300), textLen: (last.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('').length, tokens: last.info?.tokens });

ac.abort();
await ssePromise.catch(() => {});
log.close();
process.exit(0);
