#!/usr/bin/env node
// S9f — drives sock-server.mjs and proves each property. Prints JSONL to stdout.
// Every server it starts is killed and the death is confirmed.

import net from 'node:net';
import { spawn } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, 'sock-server.mjs');
// ПОЧЕМУ mkdtemp, а не spike/env/fakehome: проверка должна оставлять рабочее дерево нетронутым
// (в CI после прогона `git status` обязан быть пустым) и не мешать параллельному прогону.
// Путь к unix-сокету на macOS ограничен 104 байтами, поэтому префикс короткий, а `run` —
// сразу под корнем временной папки.
const TMP = mkdtempSync(join(tmpdir(), 'pult-sock-'));
const RUN = join(TMP, 'run');
const SOCK = join(RUN, 'pultd.sock');
const TOKEN_FILE = join(RUN, 'token');
const LOCK = join(RUN, 'pultd.lock');
const NODE = process.execPath;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mode = (p) => (existsSync(p) ? (statSync(p).mode & 0o777).toString(8).padStart(3, '0') : null);

rmSync(RUN, { recursive: true, force: true });
mkdirSync(RUN, { recursive: true, mode: 0o700 });

// ---- server control -------------------------------------------------------
function startServer(tag) {
  const child = spawn(NODE, [SERVER], { env: { ...process.env, PULT_RUN: RUN }, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  child.stdout.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => {
    lines.push(l); out({ check: 'S9f', from: `server:${tag}`, line: JSON.parse(l) });
  }));
  child.stderr.on('data', (d) => out({ check: 'S9f', from: `server:${tag}:stderr`, text: d.toString().trim() }));
  return { child, lines, saw: (ev) => lines.some((l) => JSON.parse(l).ev === ev) };
}
async function waitFor(s, ev, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (s.saw(ev)) return true; await sleep(30); }
  return false;
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
// ПОЧЕМУ опрос, а не фиксированный sleep: на загруженном раннере (особенно на дорогой ноге
// macOS) «подождать 150 мс и проверить» — источник мигающих провалов. Ждём само условие,
// с потолком; возвращаем последнее значение, чтобы утверждение осталось честным по таймауту.
async function until(cond, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return true;
    if (Date.now() - t0 >= ms) return false;
    await sleep(20);
  }
}

// ---- NDJSON client --------------------------------------------------------
function connect() {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCK);
    const replies = [];   // all replies, in order
    const pending = [];   // replies not yet consumed by next()
    const waiters = [];
    let buf = '';
    sock.on('data', (c) => {
      buf += c.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        replies.push(msg);
        const w = waiters.shift();
        if (w) w(msg); else pending.push(msg);
      }
    });
    sock.on('error', reject);
    sock.on('connect', () => resolve({
      sock, replies,
      send: (o) => sock.write(JSON.stringify(o) + '\n'),
      raw: (s) => sock.write(s),
      // drains anything already buffered before waiting — a reply that arrived
      // while we were not looking must not be lost
      next: (ms = 3000) => new Promise((res) => {
        if (pending.length) return res(pending.shift());
        const t = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); res(null); }, ms);
        const w = (m) => { clearTimeout(t); res(m); };
        waiters.push(w);
      }),
      closed: () => new Promise((res) => sock.once('close', () => res(true))),
    }));
  });
}

const results = [];
const R = (id, title, pass, detail) => { results.push({ id, title, pass, detail });
  out({ check: 'S9f', case: id, title, pass, detail }); };

// ===== run 1 ===============================================================
const s1 = startServer('run1');
await waitFor(s1, 'listening');

R('S9f-modes', 'run dir 0700, token 0600, socket 0600',
  mode(RUN) === '700' && mode(TOKEN_FILE) === '600' && mode(SOCK) === '600',
  { runDir: mode(RUN), token: mode(TOKEN_FILE), socket: mode(SOCK) });

const token = readFileSync(TOKEN_FILE, 'utf8').trim();

// wrong token
{
  const c = await connect();
  c.send({ type: 'hello', token: 'f'.repeat(token.length) });
  const reply = await c.next();
  const closed = await Promise.race([c.closed(), sleep(1000).then(() => false)]);
  R('S9f-badtoken', 'wrong token rejected and connection closed',
    reply?.type === 'error' && reply?.code === 'bad_token' && closed === true, { reply, closed });
}

// no handshake first
{
  const c = await connect();
  c.send({ type: 'ping', n: 1 });
  const reply = await c.next();
  R('S9f-nohandshake', 'first message must be hello',
    reply?.type === 'error' && reply?.code === 'handshake_required', { reply });
  c.sock.destroy();
}

// malformed json
{
  const c = await connect();
  c.raw('{not json\n');
  const reply = await c.next();
  R('S9f-badjson', 'malformed NDJSON line rejected',
    reply?.type === 'error' && reply?.code === 'bad_json', { reply });
  c.sock.destroy();
}

// handshake timeout
{
  const c = await connect();
  const reply = await c.next(4000);
  R('S9f-timeout', 'silent client dropped after handshake timeout',
    reply?.type === 'error' && reply?.code === 'handshake_timeout', { reply });
  c.sock.destroy();
}

// good token + NDJSON framing (two messages in one write, one message split across writes)
{
  const c = await connect();
  c.send({ type: 'hello', token });
  const hello = await c.next();
  c.raw(JSON.stringify({ type: 'ping', n: 1 }) + '\n' + JSON.stringify({ type: 'ping', n: 2 }) + '\n');
  const p1 = await c.next(); const p2 = await c.next();
  const half = JSON.stringify({ type: 'ping', n: 3 }) + '\n';
  c.raw(half.slice(0, 9)); await sleep(50); c.raw(half.slice(9));
  const p3 = await c.next();
  R('S9f-handshake', 'correct token accepted; NDJSON framing survives coalescing and splitting',
    hello?.type === 'hello_ok' && p1?.n === 1 && p2?.n === 2 && p3?.n === 3,
    { hello, p1, p2, p3 });
  c.sock.destroy();
}

// single instance: second server must refuse while the first is alive
{
  const s2 = startServer('run2-duplicate');
  const code = await new Promise((r) => s2.child.on('exit', r));
  R('S9f-singleinstance', 'second instance refuses while the first is alive (lock_held, exit 3)',
    code === 3 && s2.saw('lock_held'), { exitCode: code, sawLockHeld: s2.saw('lock_held') });
}

// ---- kill run 1 HARD (SIGKILL) so the socket and lock are left behind ------
s1.child.kill('SIGKILL');
const c1code = await new Promise((r) => s1.child.on('exit', (code, sig) => r({ code, sig })));
// SIGKILL не даёт процессу прибраться, поэтому ждём не «немножко», а того, что ОС действительно
// сняла pid: только после этого утверждение «мусор остался на диске» что-то значит.
await until(() => !pidAlive(s1.child.pid));
R('S9f-hardkill-leftovers', 'SIGKILL leaves a stale socket and a stale lock on disk',
  existsSync(SOCK) && existsSync(LOCK),
  { exit: c1code, socketLeft: existsSync(SOCK), lockLeft: existsSync(LOCK),
    lockPid: existsSync(LOCK) ? readFileSync(LOCK, 'utf8').trim() : null,
    lockPidAlive: existsSync(LOCK) ? pidAlive(parseInt(readFileSync(LOCK, 'utf8'), 10)) : null });

// ===== run 2: must clean the stale socket and steal the dead lock ==========
const s3 = startServer('run3-after-kill');
const up = await waitFor(s3, 'listening');
R('S9f-stalecleanup', 'restart after SIGKILL: stale lock stolen, stale socket removed, listening again',
  up && s3.saw('lock_stale') && s3.saw('stale_socket_removed'),
  { listening: up, sawLockStale: s3.saw('lock_stale'), sawStaleSocketRemoved: s3.saw('stale_socket_removed') });

// token must be a NEW one after restart
const token2 = readFileSync(TOKEN_FILE, 'utf8').trim();
R('S9f-tokenrotates', 'token is regenerated on every start (old token no longer works)',
  token2 !== token, { rotated: token2 !== token, len: token2.length });
{
  const c = await connect();
  c.send({ type: 'hello', token });     // the OLD token
  const reply = await c.next();
  R('S9f-oldtoken', 'token from the previous run is rejected',
    reply?.code === 'bad_token', { reply });
  c.sock.destroy();
}

// lock file with a garbage / impossible pid
{
  const c = await connect();
  c.send({ type: 'hello', token: token2 });
  await c.next();
  c.send({ type: 'shutdown' });
  await c.next();
  c.sock.destroy();
}
const s3code = await new Promise((r) => s3.child.on('exit', (code) => r(code)));
R('S9f-cleanshutdown', 'clean shutdown removes socket, lock and token file',
  s3code === 0 && !existsSync(SOCK) && !existsSync(LOCK) && !existsSync(TOKEN_FILE),
  { exitCode: s3code, socket: existsSync(SOCK), lock: existsSync(LOCK), token: existsSync(TOKEN_FILE) });

// garbage pid in the lock file
writeFileSync(LOCK, '999999999\n', { mode: 0o600 });
const s4 = startServer('run4-garbage-lock');
const up4 = await waitFor(s4, 'listening');
R('S9f-garbagelock', 'lock file with a dead/impossible pid is stolen, not honoured',
  up4 && s4.saw('lock_stale'), { listening: up4, sawLockStale: s4.saw('lock_stale') });

// ---- cleanup: kill everything and confirm ---------------------------------
s4.child.kill('SIGTERM');
const s4code = await new Promise((r) => s4.child.on('exit', (code, sig) => r({ code, sig })));
// Обработчик SIGTERM сносит сокет, лок и токен уже после выхода из ожидания exit — ждём именно
// исчезновения файлов, а не фиксированные 200 мс.
await until(() => ![SOCK, LOCK, TOKEN_FILE].some(existsSync));
const leftovers = [SOCK, LOCK, TOKEN_FILE].filter(existsSync);
out({ check: 'S9f', step: 'cleanup',
      run1: { pid: s1.child.pid, alive: pidAlive(s1.child.pid) },
      run3: { pid: s3.child.pid, alive: pidAlive(s3.child.pid) },
      run4: { pid: s4.child.pid, alive: pidAlive(s4.child.pid), exit: s4code },
      leftoverFiles: leftovers });

rmSync(TMP, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
out({ check: 'S9f', step: 'done', total: results.length, failed: failed.length,
      failedIds: failed.map((r) => r.id) });
// Провалившееся утверждение обязано ронять процесс: иначе CI зелёный при сломанном демоне.
process.exit(failed.length === 0 ? 0 : 1);
