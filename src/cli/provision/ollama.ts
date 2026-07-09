import { spawn } from 'node:child_process';
import type { Runner } from '../install/runner.js';
import { must, step } from './exec.js';

/** Provision a self-hosted local Ollama runtime for the "Self-hosted (local Ollama)" wizard choice:
 *  install the binary (official script), make sure the server is reachable, and pull a model. Built on
 *  the shared `must`/`step` provisioning primitives so it drives the same executors as `elowen install`.
 *  All operations target the daemon-local host (Ollama serves `127.0.0.1:11434`). */

const OLLAMA_HOST = 'http://127.0.0.1:11434';

/** Absolute path of the `ollama` binary, or null when it isn't installed. */
export function hasOllama(r: Runner): Promise<string | null> {
  return r.which('ollama');
}

/** Whether the Ollama server answers on its native API (`/api/tags`). Uses fetch (no shell) with a short
 *  timeout so a down server fails fast rather than hanging the wizard. */
export async function ollamaUp(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch { return false; }
}

/** Install Ollama via the official script. The script sets up (and starts) the systemd `ollama` service
 *  on Linux; it self-elevates with sudo when not run as root. Idempotent — a no-op if already installed.
 *  Recent installer builds ship a zstd-compressed archive and abort with a "requires zstd for extraction"
 *  error when the tool is missing (bare containers/minimal images), so ensure it first on apt hosts. */
export async function installOllama(r: Runner): Promise<void> {
  await must(r, 'bash', ['-lc',
    'command -v zstd >/dev/null 2>&1 || { '
    + 'SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"; '
    + 'command -v apt-get >/dev/null 2>&1 && $SUDO apt-get update -qq && $SUDO apt-get install -y -qq zstd; }; '
    + 'curl -fsSL https://ollama.com/install.sh | sh']);
}

const pollUp = async (tries: number): Promise<boolean> => {
  for (let i = 0; i < tries; i++) {
    if (await ollamaUp()) return true;
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
};

/** Make sure the Ollama server is reachable. Prefer the systemd service (what the install script sets up
 *  on a normal host); on a box without systemd (or where the unit isn't installed) fall back to spawning
 *  `ollama serve` detached ourselves. Throws when it never comes up so the caller can surface a clear
 *  error instead of a later opaque probe failure. */
export async function ensureOllamaRunning(r: Runner): Promise<void> {
  if (await ollamaUp()) return;
  await r.exec('systemctl', ['start', 'ollama']).catch(() => undefined);
  if (await pollUp(6)) return;
  // No systemd / unit absent — start the server ourselves, detached so it outlives this process.
  try { spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' }).unref(); } catch { /* fall through to the poll/throw */ }
  if (await pollUp(20)) return;
  throw new Error(`Ollama server did not come up at ${OLLAMA_HOST}`);
}

/** Models already pulled locally, via the native `/api/tags` endpoint. Empty on any error. */
export async function listLocalModels(): Promise<string[]> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return [];
    const body = (await res.json()) as { models?: { name?: string }[] };
    return (body.models ?? []).map((m) => m.name ?? '').filter(Boolean);
  } catch { return []; }
}

/** Pull a model (`ollama pull <model>`). No-op when it is already present locally. */
export async function pullModel(r: Runner, model: string): Promise<void> {
  const local = await listLocalModels();
  if (local.includes(model)) return;
  await must(r, 'ollama', ['pull', model]);
}

/** Full flow: install (if missing) → ensure running → pull the model, each as a labelled step. Returns
 *  the models present locally afterwards so the caller can confirm/select. */
export async function provisionOllama(r: Runner, model: string): Promise<string[]> {
  if (!(await hasOllama(r))) await step('Installing Ollama', () => installOllama(r));
  await step('Starting Ollama', () => ensureOllamaRunning(r));
  await step(`Downloading ${model}`, () => pullModel(r, model));
  return listLocalModels();
}

/** A small curated shortlist of capable, widely-used open models to offer for download. Users can also
 *  type any other Ollama model tag. */
export const SUGGESTED_OLLAMA_MODELS = [
  'llama3.2',
  'qwen2.5-coder',
  'deepseek-r1',
  'gemma2',
  'phi4',
  'mistral',
];
