// Free probe #2: initialize WITH capabilities.experimentalApi = true, dump full feature/collab lists.
import { AppServer, PROXY_ENV, jlog } from './client.mjs';
import { writeFileSync } from 'node:fs';

const LOG = new URL('./logs/probe2.jsonl', import.meta.url).pathname;
writeFileSync(LOG, '');
const srv = new AppServer({ env: PROXY_ENV, logFile: LOG });
const init = await srv.request('initialize', {
  clientInfo: { name: 'pult-spike', version: '0.0.1' },
  capabilities: { experimentalApi: true },
});
srv.notify('initialized', {});

const out = { initializeResult: init };
for (const m of ['collaborationMode/list', 'experimentalFeature/list']) {
  try { out[m] = await srv.request(m, {}, 30000); }
  catch (e) { out[m] = 'ERROR ' + e.message; }
}
const feats = out['experimentalFeature/list']?.data ?? [];
const summary = {
  check: 'probe2',
  initializeResult: init,
  collaborationModes: out['collaborationMode/list'],
  features: feats.map((f) => `${f.name}:${f.stage}:${f.enabled}`),
  collabRelatedFeatures: feats.filter((f) => /collab|agent|multi|sub/i.test(f.name)),
};
jlog(LOG, { ev: 'SUMMARY', ...summary });
console.log(JSON.stringify(summary, null, 1));
await srv.kill();
process.exit(0);
