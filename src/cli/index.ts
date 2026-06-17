import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { OrcaClient } from './client.js';

const BASE = process.env.ORCA_URL ?? 'http://localhost:4400';

async function ensureDaemon() {
  if (process.env.ORCA_AUTOSTART === '0') return;
  try { await fetch(`${BASE}/health`); return; } catch { /* down → start */ }
  const entry = join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'index.js');
  spawn(process.execPath, [entry], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); return; } catch { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('orca daemon did not become healthy');
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  await ensureDaemon();
  const c = new OrcaClient(BASE);
  switch (cmd) {
    case 'ls': console.log(JSON.stringify(await c.tasks(), null, 2)); break;
    case 'ready': console.log(JSON.stringify(await c.ready(), null, 2)); break;
    case 'sessions': console.log(JSON.stringify(await c.sessions(), null, 2)); break;
    default: console.error('usage: orca <ls|ready|sessions>'); process.exit(1);
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
