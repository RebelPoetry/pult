// Minimal JSON-RPC client for `codex app-server` over stdio (newline-delimited JSON).
// Zero deps. The `jsonrpc` field may be omitted on the wire in both directions.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync, mkdirSync } from 'node:fs';

// Every leg script writes its transcript into ./logs/ (gitignored run output, not in the public tree):
// create it on import, before any script opens its log.
mkdirSync(new URL('./logs/', import.meta.url), { recursive: true });

export const CODEX = process.env.CODEX_BIN || `${process.env.HOME}/.local/bin/codex`;
export const SPIKE = '/Users/you/src/pult/spike';

// The owner's known-good proxy profile.
export const PROXY_ENV = { ALL_PROXY: 'socks5h://127.0.0.1:10808' };

export function jlog(file, obj) {
  appendFileSync(file, JSON.stringify({ t: Date.now(), ...obj }) + '\n');
}

export class AppServer {
  // opts: { args, env, logFile, cwd, cmd }
  constructor(opts = {}) {
    this.logFile = opts.logFile;
    this.nextId = 1;
    this.pending = new Map();
    this.notes = [];              // every notification seen
    this.noteMethods = new Map(); // method -> count
    this.serverRequests = [];
    this.onServerRequest = opts.onServerRequest || null;
    this.onNotification = opts.onNotification || null;
    this.stderr = [];

    const cmd = opts.cmd || CODEX;
    const args = opts.args || ['app-server', '-c', 'model_reasoning_effort="low"'];
    this.proc = spawn(cmd, args, {
      cwd: opts.cwd || SPIKE,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pid = this.proc.pid;
    this.exited = null;
    this.proc.on('exit', (code, sig) => { this.exited = { code, sig }; this.log({ ev: 'proc_exit', code, sig }); });

    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { this.log({ ev: 'unparsed_stdout', line: line.slice(0, 400) }); return; }
      this.handle(msg);
    });
    createInterface({ input: this.proc.stderr }).on('line', (line) => {
      this.stderr.push(line);
      this.log({ ev: 'stderr', line: line.slice(0, 500) });
    });
  }

  log(o) { if (this.logFile) jlog(this.logFile, o); }

  handle(msg) {
    if (msg.id !== undefined && msg.method !== undefined) {
      // server -> client request
      this.serverRequests.push(msg);
      this.log({ ev: 'server_request', method: msg.method, id: msg.id, params: msg.params });
      if (this.onServerRequest) this.onServerRequest(msg, this);
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      this.log({ ev: 'response', id: msg.id, error: msg.error, hasResult: msg.result !== undefined });
      if (p) { this.pending.delete(msg.id); msg.error ? p.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error })) : p.resolve(msg.result); }
      return;
    }
    if (msg.method) {
      this.notes.push(msg);
      this.noteMethods.set(msg.method, (this.noteMethods.get(msg.method) || 0) + 1);
      this.log({ ev: 'notification', method: msg.method, params: msg.params });
      if (this.onNotification) this.onNotification(msg, this);
    }
  }

  send(obj) {
    this.log({ ev: 'send', ...obj });
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, timeoutMs = 180000) {
    const id = this.nextId++;
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout ${method}`)); }
      }, timeoutMs).unref?.();
    });
    this.send({ jsonrpc: '2.0', id, method, params });
    return p;
  }

  respond(id, result) { this.send({ jsonrpc: '2.0', id, result }); }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }

  async initialize(name = 'pult-spike') {
    const r = await this.request('initialize', { clientInfo: { name, title: 'Pult Ф0 spike', version: '0.0.1' } });
    this.notify('initialized', {});
    return r;
  }

  // Resolve when `turn/completed` for threadId arrives.
  // NOTE: uses a waiter SET, not onNotification chaining — chaining broke two concurrent waits
  // (the first to resolve restored `prev` and wiped the second waiter -> "Error: turn timeout").
  waitTurn(threadId, timeoutMs = 240000) {
    if (!this.turnWaiters) {
      this.turnWaiters = new Set();
      const user = this.onNotification;
      this.onNotification = (msg, srv) => {
        if (user) user(msg, srv);
        if (msg.method === 'turn/completed') {
          for (const w of [...this.turnWaiters]) {
            if (!w.threadId || w.threadId === msg.params?.threadId) { this.turnWaiters.delete(w); clearTimeout(w.to); w.resolve(msg.params); }
          }
        }
      };
    }
    return new Promise((resolve, reject) => {
      const w = { threadId, resolve };
      w.to = setTimeout(() => { this.turnWaiters.delete(w); reject(new Error('turn timeout')); }, timeoutMs);
      this.turnWaiters.add(w);
    });
  }

  async kill() {
    if (this.exited) return this.exited;
    this.proc.kill('SIGKILL');
    return new Promise((r) => this.proc.on('exit', (c, s) => r({ code: c, sig: s })));
  }

  methodsSeen() { return [...this.noteMethods.entries()].map(([m, n]) => `${m} x${n}`).sort(); }
}

export const TEXT = (s) => [{ type: 'text', text: s }];
