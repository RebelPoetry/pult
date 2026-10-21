// Minimal opencode HTTP/SSE client for the Pult Ф0 spike. Node ESM, zero deps.
// Auth: HTTP Basic, username defaults to "opencode" (binary: "basic auth username
// (defaults to OPENCODE_SERVER_USERNAME or 'opencode')").
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Every leg script writes its transcript into ./logs/ (gitignored run output, not in the public tree):
// create it on import, before any script opens its log.
fs.mkdirSync(path.join(HERE, 'logs'), { recursive: true });

export function readPassword() {
  return fs.readFileSync(path.join(HERE, '.pw'), 'utf8').trim();
}

export function makeClient({ port, password, username = 'opencode' }) {
  const base = `http://127.0.0.1:${port}`;
  const auth = password
    ? 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
    : null;
  const headers = (extra = {}) => {
    const h = { ...extra };
    if (auth) h.authorization = auth;
    return h;
  };

  async function req(method, p, { query, body } = {}) {
    const url = new URL(base + p);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
    const init = { method, headers: headers(body !== undefined ? { 'content-type': 'application/json' } : {}) };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(url, init);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, text, json };
  }

  const get = (p, query) => req('GET', p, { query });
  const post = (p, body, query) => req('POST', p, { body, query });

  // SSE reader: calls onEvent(parsedJson, rawDataLine) for each `data:` line.
  async function sse(p, { query, onEvent, signal }) {
    const url = new URL(base + p);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: headers({ accept: 'text/event-stream' }), signal });
    if (!res.ok) throw new Error(`SSE ${url.pathname} -> ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          let obj = null;
          try { obj = JSON.parse(raw); } catch { /* keep raw */ }
          onEvent(obj, raw);
        }
      }
    } catch (e) {
      if (e?.name !== 'AbortError') throw e;
    }
    return { status: res.status };
  }

  return { base, get, post, req, sse };
}

export function jsonl(file) {
  const fd = fs.openSync(file, 'a');
  return {
    write(obj) {
      const line = JSON.stringify({ t: new Date().toISOString(), ...obj });
      fs.writeSync(fd, line + '\n');
      console.log(line);
    },
    close() { fs.closeSync(fd); },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
