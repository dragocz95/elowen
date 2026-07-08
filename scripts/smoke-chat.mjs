// Headless end-to-end smoke for the chat CLI's client layer (the exact BrainClient `elowen chat` uses).
// Assumes a running daemon at ELOWEN_URL (default http://127.0.0.1:4400) with an admin/pw user and a
// configured brain provider. Drives start → send → stream → history without a TTY, so it verifies the
// SSE parsing, streaming, tool round-trip and history reload that the interactive TUI sits on top of.
//
//   ELOWEN_URL=http://127.0.0.1:44xx node scripts/smoke-chat.mjs
//
import { BrainClient } from '../dist/cli/chat/brainClient.js';

const base = process.env.ELOWEN_URL ?? 'http://127.0.0.1:4400';
const login = await fetch(`${base}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: process.env.ELOWEN_USER ?? 'admin', password: process.env.ELOWEN_PASS ?? 'pw' }),
});
const { token } = await login.json();
const auth = { authorization: `Bearer ${token}` };

const client = new BrainClient({ base, token });
await client.start();

const events = [];
const ac = new AbortController();
client.stream((e) => events.push(e), ac.signal, 400).catch(() => {});
await new Promise((r) => setTimeout(r, 300));
await client.send('Create a task titled cli-smoke in project 1, then confirm in one sentence.');

const t0 = Date.now();
while (Date.now() - t0 < 35000 && !events.some((e) => e.type === 'idle')) await new Promise((r) => setTimeout(r, 200));
ac.abort();

console.log('event types:', events.map((e) => e.type).join(','));
console.log('streamed text:', events.filter((e) => e.type === 'text').map((e) => e.delta).join('').slice(0, 160));
console.log('tools called:', events.filter((e) => e.type === 'tool').map((e) => e.name).join(','));
console.log('history length:', (await client.history()).length);
const tasks = await (await fetch(`${base}/tasks`, { headers: auth })).json();
console.log('cli-smoke task:', tasks.find((t) => t.title === 'cli-smoke')?.id ?? 'NONE');
