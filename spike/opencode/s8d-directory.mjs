// S8d — is ?directory= alone enough to isolate two concurrent sessions on ONE server?
// Two sessions, two directories, both prompted at the same time, each asked to print its cwd.
import { makeClient, readPassword, jsonl, sleep } from './client.mjs';

const PORT = Number(process.argv[2]);
const DIRS = [process.argv[3], process.argv[4]];
const MODEL = { providerID: 'opencode', modelID: 'muse-spark-1.3-contributor-free' };

const log = jsonl(new URL('./logs/s8d-directory.jsonl', import.meta.url).pathname);
const c = makeClient({ port: PORT, password: readPassword() });

const state = DIRS.map((d) => ({ dir: d, sessionID: null, idle: false, seenForeign: [] }));

const ac = new AbortController();
const streams = state.map((st) =>
  c.sse('/event', {
    query: { directory: st.dir },
    signal: ac.signal,
    onEvent: (e) => {
      if (!e || e.type === 'plugin.added' || e.type === 'server.heartbeat') return;
      const sid = e.properties?.sessionID ?? e.properties?.info?.sessionID ?? e.properties?.info?.id;
      if (!sid) return;
      const mine = sid === st.sessionID;
      const other = state.find((s) => s !== st && s.sessionID === sid);
      if (other && !st.seenForeign.includes(e.type)) st.seenForeign.push(e.type);
      if (mine && (e.type === 'session.idle')) st.idle = true;
    },
  })
);
await sleep(700);

for (const st of state) {
  const ses = await c.post('/session', { title: 'spike-s8d' }, { directory: st.dir });
  st.sessionID = ses.json?.id;
  log.write({ check: 'S8d', step: 'POST /session', dir: st.dir, sessionID: st.sessionID, returnedDirectory: ses.json?.directory, projectID: ses.json?.projectID });
}

const t0 = Date.now();
await Promise.all(state.map((st) =>
  c.post(`/session/${st.sessionID}/prompt_async`, {
    model: MODEL,
    parts: [{ type: 'text', text: 'Run the bash command `pwd` and reply with only its output.' }],
  }, { directory: st.dir })
));
log.write({ check: 'S8d', step: 'both prompts sent (concurrent)' });

const deadline = Date.now() + 150000;
while (!state.every((s) => s.idle) && Date.now() < deadline) await sleep(400);
log.write({ check: 'S8d', step: 'turns-end', idle: state.map((s) => s.idle), ms: Date.now() - t0 });

for (const st of state) {
  const msgs = await c.get(`/session/${st.sessionID}/message`, { directory: st.dir });
  const arr = Array.isArray(msgs.json) ? msgs.json : [];
  const tools = arr.flatMap((m) => (m.parts || []).filter((p) => p.type === 'tool').map((p) => ({ tool: p.tool, cmd: p.state?.input?.command, out: (p.state?.output || '').slice(0, 200), status: p.state?.status })));
  log.write({ check: 'S8d', step: 'result', dir: st.dir, sessionID: st.sessionID, tools, text: arr.flatMap((m) => (m.parts || []).filter((p) => p.type === 'text').map((p) => p.text)).join(' | ').slice(0, 300) });
  log.write({ check: 'S8d', step: 'cross-talk', streamDir: st.dir, foreignSessionEventTypesSeen: st.seenForeign });
}

// does a session created for dir A answer on ?directory=B ?
const cross = await c.get(`/session/${state[0].sessionID}`, { directory: DIRS[1] });
log.write({ check: 'S8d', step: 'GET session-of-A with directory=B', status: cross.status, returnedDirectory: cross.json?.directory, body: cross.text.slice(0, 160) });

// does GET /session?directory=A list sessions of B?
const listA = await c.get('/session', { directory: DIRS[0] });
const ids = (Array.isArray(listA.json) ? listA.json : []).map((s) => s.id);
log.write({ check: 'S8d', step: 'GET /session?directory=A', count: ids.length, containsA: ids.includes(state[0].sessionID), containsB: ids.includes(state[1].sessionID) });

ac.abort();
await Promise.all(streams.map((p) => p.catch(() => {})));
log.close();
process.exit(0);
