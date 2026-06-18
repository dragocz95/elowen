// Provider ↔ exec-string mapping. Mirrors the daemon's src/overseer/routing.ts so the UI
// shows and edits the SAME provider the spawn path will actually resolve.
export type ProviderId = 'claude-code' | 'opencode' | 'codex';

/** Which program runs this exec string (same heuristic as resolveExecutor). */
export function execProvider(exec: string): ProviderId {
  if (exec.startsWith('codex:')) return 'codex';
  if (exec.startsWith('opencode:')) return 'opencode';
  if (exec.startsWith('claude:')) return 'claude-code';
  if (exec.includes('/')) return 'opencode';
  return 'claude-code';
}

/** The bare model id with any provider prefix stripped (for display/edit). */
export function execModel(exec: string): string {
  if (exec.startsWith('codex:')) return exec.slice('codex:'.length);
  if (exec.startsWith('opencode:')) return exec.slice('opencode:'.length);
  if (exec.startsWith('claude:')) return exec.slice('claude:'.length);
  return exec; // slash form or bare — the model id is the whole string
}

/** Compose an exec string from a chosen provider + bare model id (inverse of the parse above). */
export function buildExec(provider: ProviderId, model: string): string {
  const m = model.trim();
  if (provider === 'codex') return `codex:${m}`;
  if (provider === 'opencode') return m.includes('/') ? m : `opencode:${m}`;
  // claude-code: bare resolves to claude; prefix only when a slash would otherwise mean opencode
  return m.includes('/') ? `claude:${m}` : m;
}
