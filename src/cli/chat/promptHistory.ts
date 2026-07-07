import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../paths.js';

/** Persisted ↑-recall prompt history for the chat TUI, keyed by project (workDir) like the todo
 *  checklist — recalling another project's prompts in this one would just be noise. The file lives
 *  beside cli-prefs.json; the in-session walk (back/forward, draft restore, edit-exits) is the
 *  editor's own history navigation, seeded from here at startup. Corrupt or missing file degrades
 *  to an empty history, never crashes the TUI. */

export const MAX_PROMPT_HISTORY = 100;

/** Session-local draft stash depth (ctrl+s) — LIFO, oldest dropped beyond this. */
export const MAX_STASH_ENTRIES = 10;

function historyFile(env: NodeJS.ProcessEnv): string {
  return join(dataDir(env), 'cli-history.json');
}

function loadAll(env: NodeJS.ProcessEnv): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(historyFile(env), 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch { return {}; }
}

function entriesFor(all: Record<string, unknown>, workDir: string): string[] {
  const raw = all[workDir];
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is string => typeof e === 'string' && e.length > 0).slice(-MAX_PROMPT_HISTORY);
}

/** This project's sent prompts, oldest → newest (feed them to `Editor.addToHistory` in order). */
export function loadPromptHistory(workDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return entriesFor(loadAll(env), workDir);
}

/** Record one sent prompt: consecutive duplicates collapse, the list caps at {@link MAX_PROMPT_HISTORY}.
 *  Best-effort — a read-only config dir must not break the TUI. */
export function appendPromptHistory(workDir: string, text: string, env: NodeJS.ProcessEnv = process.env): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  try {
    const all = loadAll(env);
    const entries = entriesFor(all, workDir);
    if (entries[entries.length - 1] === trimmed) return; // dedupe consecutive
    entries.push(trimmed);
    all[workDir] = entries.slice(-MAX_PROMPT_HISTORY);
    mkdirSync(dirname(historyFile(env)), { recursive: true });
    writeFileSync(historyFile(env), JSON.stringify(all));
  } catch { /* best-effort persistence */ }
}

/** Session-local prompt stash (opencode-style): ctrl+s with a draft parks it, ctrl+s on an empty
 *  input pops the most recent one back. LIFO, never persisted — a stash is a "let me ask something
 *  else first" pocket, not long-term storage. */
export class PromptStash {
  private entries: string[] = [];

  get size(): number { return this.entries.length; }

  push(text: string): void {
    if (!text.trim()) return;
    this.entries.push(text);
    if (this.entries.length > MAX_STASH_ENTRIES) this.entries.shift();
  }

  pop(): string | undefined {
    return this.entries.pop();
  }
}
