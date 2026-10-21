// S8b — live model list: which models have cost.input == 0 && cost.output == 0.
import { makeClient, readPassword, jsonl } from './client.mjs';

const PORT = Number(process.argv[2]);
const log = jsonl(new URL('./logs/s8b-providers.jsonl', import.meta.url).pathname);
const c = makeClient({ port: PORT, password: readPassword() });

const prov = await c.get('/provider');
log.write({ check: 'S8b', step: 'GET /provider', status: prov.status, topKeys: prov.json ? Object.keys(prov.json) : null });

const cfgProv = await c.get('/config/providers');
log.write({ check: 'S8b', step: 'GET /config/providers', status: cfgProv.status, topKeys: cfgProv.json ? Object.keys(cfgProv.json) : null });

function collect(payload, label) {
  const out = [];
  if (!payload) return out;
  const providers = Array.isArray(payload) ? payload
    : Array.isArray(payload.providers) ? payload.providers
    : typeof payload === 'object' ? Object.values(payload).filter((v) => v && typeof v === 'object' && v.models) : [];
  for (const p of providers) {
    const pid = p.id ?? p.providerID ?? p.name;
    const models = p.models ? (Array.isArray(p.models) ? p.models : Object.entries(p.models).map(([k, v]) => ({ id: k, ...v }))) : [];
    for (const m of models) {
      const cost = m.cost ?? {};
      out.push({ source: label, providerID: pid, modelID: m.id ?? m.modelID, name: m.name, input: cost.input, output: cost.output, free: cost.input === 0 && cost.output === 0 });
    }
  }
  return out;
}

const all = [...collect(prov.json, '/provider'), ...collect(cfgProv.json, '/config/providers')];
const free = all.filter((m) => m.free);
log.write({ check: 'S8b', step: 'counts', totalModels: all.length, freeModels: free.length });
log.write({ check: 'S8b', step: 'free-list', free: free.map((m) => `${m.providerID}/${m.modelID}`) });
log.write({ check: 'S8b', step: 'free-detail', sample: free.slice(0, 40) });

// how the "default" provider list looks (no keys printed)
if (prov.json && prov.json.default) log.write({ check: 'S8b', step: 'default-map', default: prov.json.default });
log.close();
