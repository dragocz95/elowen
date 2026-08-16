// Provider ↔ exec-string mapping. Mirrors the daemon's src/overseer/routing.ts so the UI
// shows and edits the SAME provider the spawn path will actually resolve.
import type { BrainModelOption } from './types';

export type ProviderId = 'claude-code' | 'opencode' | 'codex' | 'kilo' | 'pi' | 'omp' | 'elowen';

/** Short auth-source chip for a brain model (mirrors the `source` the daemon derives from how the model is
 *  reachable). The ONE source for every model picker so the chip set never drifts between them. */
export const SOURCE_BADGE: Record<BrainModelOption['source'], string> = {
  oauth: 'OAuth',
  'api-key': 'API',
  relay: 'Relay',
};

/** Explicit `<prefix>:<model>` spec prefixes, in match order, mapped to their provider. Mirrors the
 *  daemon's PROGRAM_PREFIXES (src/shared/execs.ts) so the UI parses execs the same way spawn does. */
const PROVIDER_PREFIXES: readonly [string, ProviderId][] = [
  ['elowen:', 'elowen'],
  ['codex:', 'codex'],
  ['opencode:', 'opencode'],
  ['claude:', 'claude-code'],
  ['kilo:', 'kilo'],
  ['pi:', 'pi'],
  ['omp:', 'omp'],
];

/**
 * Which program runs this exec string — the same decision the daemon's `execSpecProgram` makes.
 * An explicit prefix decides; only a prefix-LESS value falls back to the CLI shape contract
 * (`provider/model` is OpenCode, a bare name is Claude Code). A slash must NEVER be read as the
 * embedded brain: `elowen` is reached through its prefix (or, on the wire, through the model's own
 * `program` field) and nothing else — otherwise every OpenCode exec would file under Elowen AI.
 */
export function execProvider(exec: string): ProviderId {
  if (exec.startsWith('elowen|')) return 'elowen';
  for (const [prefix, provider] of PROVIDER_PREFIXES) {
    if (exec.startsWith(prefix)) return provider;
  }
  if (exec.includes('/')) return 'opencode';
  return 'claude-code';
}

/**
 * The IDENTITY of a brain model in a picker or an allow-list: its composite spec, which carries the
 * program AND the provider AND the model — and which is also the value the daemon stores, so a pick
 * round-trips. Deliberately NOT the visible label: two providers can offer the same model name, and
 * keying rows by that name collapses them into one ambiguous row (and makes a saved value unmatchable).
 */
export function brainModelId(m: Pick<BrainModelOption, 'exec'>): string {
  return m.exec;
}

/**
 * The clean model name to DISPLAY for an exec — taken from the catalog, never by splitting the string:
 * a model id may itself contain slashes (`elowen:relay/ollama/kimi-k2.7-code`), so blind splitting
 * shows the wrong name. An exec with no catalog entry falls back to the raw value, which keeps a
 * removed/stale pick visible instead of rendering it empty.
 */
export function brainModelLabel(exec: string, models: readonly BrainModelOption[] | undefined): string {
  return models?.find((m) => brainModelId(m) === exec)?.model ?? exec;
}

/** The bare model id with any provider prefix stripped (for display/edit). */
export function execModel(exec: string): string {
  if (exec.startsWith('elowen|')) {
    const parts = exec.split('|');
    if (parts.length === 3) try { return decodeURIComponent(parts[2] ?? ''); } catch { return exec; }
  }
  for (const [prefix] of PROVIDER_PREFIXES) {
    if (exec.startsWith(prefix)) return exec.slice(prefix.length);
  }
  return exec; // slash form or bare — the model id is the whole string
}

/** Prefix for the providers whose exec format is "just prepend the prefix" — derived from the parse table
 *  above so a new PROVIDER_PREFIXES entry works through buildExec without a matching branch here. */
const PREFIX_BY_PROVIDER: Record<string, string> = Object.fromEntries(
  PROVIDER_PREFIXES.map(([prefix, provider]) => [provider, prefix]),
);

/** Compose an exec string from a chosen provider + bare model id (inverse of the parse above). opencode
 *  and claude-code are the only two whose format genuinely differs (bare unless a slash would otherwise
 *  mean the other program), so they stay explicit; every other provider just gets its table prefix. */
export function buildExec(provider: ProviderId, model: string): string {
  const m = model.trim();
  if (provider === 'opencode') return m.includes('/') ? m : `opencode:${m}`;
  // claude-code: bare resolves to claude; prefix only when a slash would otherwise mean opencode
  if (provider === 'claude-code') return m.includes('/') ? `claude:${m}` : m;
  return `${PREFIX_BY_PROVIDER[provider]}${m}`;
}
