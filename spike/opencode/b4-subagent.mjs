// B4-opencode — subagent visibility: parent session -> child session in the event stream.
import { makeClient, readPassword, jsonl, sleep } from './client.mjs';

const PORT = Number(process.argv[2]);
const DIR = process.argv[3];
const MODEL = { providerID: 'opencode', modelID: 'muse-spark-1.3-contributor-free' };

const log = jsonl(new URL('./logs/b4-subagent.jsonl', import.meta.url).pathname);
const c = makeClient({ port: PORT, password: readPassword() });

const ac = new AbortController();
let parentID = null;
let idle = false;
const sidsSeen = new Map(); // sessionID -> set of event types

const ssePromise = c.sse('/event', {
  query: { directory: DIR },
  signal: ac.signal,
  onEvent: (e) => {
    if (!e || e.type === 'plugin.added' || e.type === 'server.heartbeat') return;
    const sid = e.properties?.sessionID ?? e.properties?.info?.sessionID ?? e.properties?.info?.id;
    if (sid) {
      if (!sidsSeen.has(sid)) sidsSeen.set(sid, new Set());
      sidsSeen.get(sid).add(e.type);
    }
    if (e.type === 'session.created') log.write({ check: 'B4', ev: 'session.created', sessionID: e.properties?.info?.id, parentID: e.properties?.info?.parentID ?? null });
    if (e.type === 'message.part.updated' && ['subtask', 'tool', 'agent'].includes(e.properties?.part?.type)) {
      const p = e.properties.part;
      log.write({ check: 'B4', ev: e.type, sessionID: sid, partType: p.type, tool: p.tool, state: p.state?.status, subtask: p.type === 'subtask' ? { agent: p.agent, model: p.model, description: p.description, sessionID: p.sessionID } : undefined });
    }
    if (sid === parentID && e.type === 'session.idle') idle = true;
  },
});
await sleep(700);

const ses = await c.post('/session', { title: 'spike-b4' }, { directory: DIR });
parentID = ses.json?.id;
log.write({ check: 'B4', step: 'POST /session', parentID });

const t0 = Date.now();
await c.post(`/session/${parentID}/prompt_async`, {
  model: MODEL,
  parts: [{ type: 'text', text: 'Use the general subagent (task tool) to list the files in this directory. Then say done.' }],
}, { directory: DIR });

const deadline = Date.now() + 150000;
while (!idle && Date.now() < deadline) await sleep(400);
log.write({ check: 'B4', step: 'turn-end', idle, ms: Date.now() - t0 });

const kids = await c.get(`/session/${parentID}/children`, { directory: DIR });
const kidArr = Array.isArray(kids.json) ? kids.json : [];
log.write({ check: 'B4', step: 'GET /session/{id}/children', status: kids.status, count: kidArr.length, children: kidArr.map((s) => ({ id: s.id, parentID: s.parentID, title: s.title, directory: s.directory })) });

log.write({ check: 'B4', step: 'event-sessions', parentID, sessionsInStream: [...sidsSeen.keys()], childEventsInParentStream: kidArr.map((k) => ({ child: k.id, types: [...(sidsSeen.get(k.id) || [])] })) });

const msgs = await c.get(`/session/${parentID}/message`, { directory: DIR });
for (const m of (Array.isArray(msgs.json) ? msgs.json : [])) {
  const parts = (m.parts || []).map((p) => p.type === 'subtask' ? { type: 'subtask', keys: Object.keys(p), agent: p.agent, model: p.model, sessionID: p.sessionID, description: p.description } : p.type === 'tool' ? { type: 'tool', tool: p.tool, status: p.state?.status } : p.type);
  log.write({ check: 'B4', step: 'parent-message', role: m.info?.role, parts });
}

ac.abort();
await ssePromise.catch(() => {});
log.close();
process.exit(0);
