// Free (no model turn) probe: which capabilities the local app-server reports.
import { AppServer, PROXY_ENV, jlog } from './client.mjs';
import { writeFileSync } from 'node:fs';

const LOG = new URL('./logs/probe.jsonl', import.meta.url).pathname;
writeFileSync(LOG, '');
const srv = new AppServer({ env: PROXY_ENV, logFile: LOG });
const init = await srv.initialize();

const out = { initializeResult: init };
for (const m of ['collaborationMode/list', 'experimentalFeature/list', 'permissionProfile/list', 'model/list']) {
  try { const r = await srv.request(m, {}, 30000); out[m] = JSON.stringify(r).slice(0, 1200); }
  catch (e) { out[m] = 'ERROR ' + e.message + ' ' + JSON.stringify(e.rpc || {}).slice(0, 300); }
}
jlog(LOG, { ev: 'SUMMARY', ...out });
console.log(JSON.stringify(out, null, 1));
await srv.kill();
process.exit(0);
