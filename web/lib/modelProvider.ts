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
 * An explicit prefix decides first; a prefix-LESS value falls back to the shape contract, where
 * `provider/model` is the embedded brain — its identity is stored with no prefix at all — and a bare
 * name is Claude Code. OpenCode names itself explicitly, so a slash never routes to it by accident.
 */
export function execProvider(exec: string): ProviderId {
  if (exec.startsWith('elowen|')) return 'elowen';
  for (const [prefix, provider] of PROVIDER_PREFIXES) {
    if (exec.startsWith(prefix)) return provider;
  }
  if (exec.includes('/')) return 'elowen';
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
 * a model id may itself contain slashes (`ai-coresynth-io/deepseek/deepseek-v4-pro`), so blind
 * splitting shows the wrong name. An exec with no catalog entry falls back to the raw value, which
 * keeps a removed/stale pick visible instead of rendering it empty.
 *
 * Use this inside a list that is already GROUPED BY PROVIDER (pickers, the manage modal): the group
 * header names the provider, so repeating it on every row is noise. It is also what feeds ModelIcon,
 * whose brand lookup expects a model name.
 */
export function brainModelLabel(exec: string, models: readonly BrainModelOption[] | undefined): string {
  return models?.find((m) => brainModelId(m) === exec)?.model ?? exec;
}

/**
 * The same name QUALIFIED by its provider — `<provider>/<model>`, composed from the catalog's own
 * fields, never by splitting the exec.
 *
 * Use this where a model appears on its own, with no group header to say whose it is: selection
 * summaries, the chip for a current pick. The provider is what disambiguates there — the catalog
 * carries `deepseek-v4-pro` from one provider and `deepseek/deepseek-v4-pro` from another, and the
 * bare name leaves the reader guessing. It also matches what the database now stores since the
 * `elowen:` prefix went away, so there is no translation between what you read and what gets sent.
 */
export function brainModelQualifiedLabel(
  identity: string | Pick<BrainModelOption, 'provider' | 'model'>,
  models?: readonly BrainModelOption[],
): string {
  if (typeof identity !== 'string') return identity.provider ? `${identity.provider}/${identity.model}` : identity.model;
  const found = models?.find((m) => brainModelId(m) === identity);
  return found ? `${found.provider}/${found.model}` : identity;
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

/** Compose an exec string from a chosen provider + bare model id (inverse of the parse above). Two
 *  providers own an unprefixed shape and so stay explicit here: the embedded brain writes bare
 *  `provider/model`, and claude-code writes a bare name. Everyone else — OpenCode included, which used
 *  to share the brain's slash shape — just gets its table prefix. */
export function buildExec(provider: ProviderId, model: string): string {
  const m = model.trim();
  // the brain's identity IS `<provider>/<model>`; prefixing it is exactly what this migration removed
  if (provider === 'elowen') return m;
  // claude-code: bare resolves to claude; prefix only when a slash would otherwise mean the brain
  if (provider === 'claude-code') return m.includes('/') ? `claude:${m}` : m;
  return `${PREFIX_BY_PROVIDER[provider]}${m}`;
}
