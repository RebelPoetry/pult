// B6-codex / S2: account/rateLimits/read shape + account/read (planType + auth mode ONLY, never email).
// No model turn is spent here: the `account/rateLimits/updated` notification during a turn is evidenced by logs/b1.jsonl.
import { AppServer, PROXY_ENV, jlog } from './client.mjs';
import { writeFileSync } from 'node:fs';

const LOG = new URL('./logs/b6.jsonl', import.meta.url).pathname;
writeFileSync(LOG, '');

const srv = new AppServer({ env: PROXY_ENV, logFile: LOG });
await srv.initialize();

const rl = await srv.request('account/rateLimits/read', {});
const acc = await srv.request('account/read', {});

// Redact: keep only structural info from account/read.
const redact = (o, path = '') => {
  if (o === null || typeof o !== 'object') return typeof o;
  if (Array.isArray(o)) return o.length ? [redact(o[0])] : [];
  const out = {};
  for (const k of Object.keys(o)) out[k] = /email|token|id$|account/i.test(k) ? '<redacted:' + typeof o[k] + '>' : redact(o[k], path + '.' + k);
  return out;
};

const scrub = (o) => JSON.parse(JSON.stringify(o, (k, v) => (/accountId|^id$|email|token/i.test(k) ? '<redacted>' : v)));

const a = acc?.account ?? acc ?? {};
const summary = {
  check: 'B6-codex/S2',
  rateLimitsRaw: scrub(rl),
  rateLimitsTopKeys: Object.keys(rl),
  snapshotKeys: Object.keys(rl.rateLimits ?? rl),
  primaryKeys: Object.keys((rl.rateLimits ?? rl).primary ?? {}),
  secondaryKeys: Object.keys((rl.rateLimits ?? rl).secondary ?? {}),
  rateLimitReachedTypePresent: 'rateLimitReachedType' in (rl.rateLimits ?? rl),
  rateLimitReachedTypeValue: (rl.rateLimits ?? rl).rateLimitReachedType,
  planType: (rl.rateLimits ?? rl).planType ?? a.planType ?? null,
  accountReadKeys: Object.keys(acc ?? {}),
  accountObjectKeys: Object.keys(a),
  accountPlanType: a.planType ?? null,
  accountAuthMode: a.authMode ?? a.mode ?? a.authMethod ?? a.method ?? a.type ?? null,
  accountReadShape: redact(acc),
};
jlog(LOG, { ev: 'SUMMARY', ...summary });
console.log(JSON.stringify(summary, null, 1));
await srv.kill();
process.exit(0);
