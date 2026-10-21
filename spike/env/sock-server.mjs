#!/usr/bin/env node
// S9f — daemon stub: unix socket + NDJSON + token handshake + single-instance lock.
// Env: PULT_RUN (run dir). Prints JSONL lifecycle lines to stdout.
//
// Properties proven here:
//   run dir 0700 · token file 0600 · hello{token} handshake · wrong token rejected
//   · stale socket cleaned on restart · single instance via lock file + pid liveness

import net from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync,
  chmodSync, statSync, openSync, closeSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';

const RUN = process.env.PULT_RUN;
if (!RUN) { console.error('PULT_RUN required'); process.exit(2); }
const SOCK = join(RUN, 'pultd.sock');
const TOKEN_FILE = join(RUN, 'token');
const LOCK = join(RUN, 'pultd.lock');
const HANDSHAKE_TIMEOUT_MS = 2000;

const out = (o) => process.stdout.write(JSON.stringify({ pid: process.pid, ...o }) + '\n');
const mode = (p) => (statSync(p).mode & 0o777).toString(8).padStart(3, '0');

// ---- run dir, 0700 --------------------------------------------------------
mkdirSync(RUN, { recursive: true, mode: 0o700 });
chmodSync(RUN, 0o700);   // mkdirSync mode is masked by umask; chmod is the guarantee
out({ ev: 'rundir', path: RUN, mode: mode(RUN) });

// ---- single-instance lock with pid liveness -------------------------------
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }   // EPERM = exists, owned by someone else
}

function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK, 'wx', 0o600);   // wx = fail if it exists — atomic
      writeSync(fd, String(process.pid));
      closeSync(fd);
      out({ ev: 'lock_acquired', path: LOCK, attempt });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const holder = parseInt(readFileSync(LOCK, 'utf8').trim(), 10);
      if (alive(holder)) {
        out({ ev: 'lock_held', holderPid: holder, alive: true });
        return false;
      }
      out({ ev: 'lock_stale', holderPid: holder, alive: false, action: 'unlink+retry' });
      try { unlinkSync(LOCK); } catch { /* raced */ }
    }
  }
  return false;
}

if (!acquireLock()) {
  out({ ev: 'exit', reason: 'another instance is alive', code: 3 });
  process.exit(3);
}

// ---- stale socket cleanup -------------------------------------------------
// The lock is ours, so any socket file left on disk is from a dead process.
if (existsSync(SOCK)) {
  let st = null; try { st = statSync(SOCK); } catch { /* noop */ }
  unlinkSync(SOCK);
  out({ ev: 'stale_socket_removed', path: SOCK, wasSocket: st ? st.isSocket() : null });
}

// ---- token, 0600 ----------------------------------------------------------
const TOKEN = randomBytes(32).toString('hex');
writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 });
chmodSync(TOKEN_FILE, 0o600);
out({ ev: 'token_written', path: TOKEN_FILE, mode: mode(TOKEN_FILE), bytes: TOKEN.length });

// ---- server ---------------------------------------------------------------
let connSeq = 0;
const server = net.createServer((sock) => {
  const id = ++connSeq;
  let authed = false;
  let buf = '';
  const send = (o) => sock.write(JSON.stringify(o) + '\n');

  const timer = setTimeout(() => {
    if (!authed) {
      out({ ev: 'handshake_timeout', conn: id });
      send({ type: 'error', code: 'handshake_timeout' });
      sock.destroy();
    }
  }, HANDSHAKE_TIMEOUT_MS);

  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { send({ type: 'error', code: 'bad_json' }); sock.destroy(); return; }

      if (!authed) {
        if (msg.type !== 'hello') {
          out({ ev: 'rejected', conn: id, reason: 'handshake_required', got: msg.type });
          send({ type: 'error', code: 'handshake_required' });
          sock.destroy(); return;
        }
        const given = typeof msg.token === 'string' ? msg.token : '';
        // constant-length compare; never log the token itself
        const ok = given.length === TOKEN.length
          && given.split('').reduce((a, c, i) => a | (c.charCodeAt(0) ^ TOKEN.charCodeAt(i)), 0) === 0;
        if (!ok) {
          out({ ev: 'rejected', conn: id, reason: 'bad_token', givenLen: given.length });
          send({ type: 'error', code: 'bad_token' });
          sock.destroy(); return;
        }
        authed = true; clearTimeout(timer);
        out({ ev: 'authed', conn: id });
        send({ type: 'hello_ok', protocol: 1 });
        continue;
      }

      if (msg.type === 'ping') { send({ type: 'pong', n: msg.n }); continue; }
      if (msg.type === 'shutdown') {
        send({ type: 'bye' });
        out({ ev: 'shutdown_requested', conn: id });
        setTimeout(() => shutdown(0), 30);
        continue;
      }
      send({ type: 'error', code: 'unknown_type', got: msg.type });
    }
  });
  sock.on('error', () => { /* client vanished */ });
  sock.on('close', () => clearTimeout(timer));
});

function shutdown(code) {
  try { server.close(); } catch { /* noop */ }
  for (const p of [SOCK, LOCK, TOKEN_FILE]) { try { unlinkSync(p); } catch { /* noop */ } }
  out({ ev: 'stopped', code });
  process.exit(code);
}
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

server.listen(SOCK, () => {
  chmodSync(SOCK, 0o600);
  out({ ev: 'listening', path: SOCK, mode: mode(SOCK) });
});
