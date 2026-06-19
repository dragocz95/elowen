// Copy the locally-installed Monaco editor assets into public/ so the app serves them itself
// instead of pulling from a third-party CDN (offline-capable, no phone-home). Idempotent.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'node_modules', 'monaco-editor', 'min', 'vs');
const dest = join(here, '..', 'public', 'monaco', 'vs');

if (!existsSync(src)) {
  console.error('[copy-monaco] monaco-editor not installed — skipping');
  process.exit(0);
}
rmSync(dest, { recursive: true, force: true });
mkdirSync(dirname(dest), { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-monaco] copied ${src} → ${dest}`);
