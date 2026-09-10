import * as p from '../../ui/prompts.js';
import { apiJson } from '../http.js';
import { guard, type StepResult, type WizardCtx } from '../types.js';

/** The context-window fill percentage auto-compaction triggers at — the store's own default
 *  (CLI_DEFAULTS.autoCompactAt), used directly so onboarding stays one confirm instead of a form. */
const DEFAULT_AUTO_COMPACT_AT = 80;

/** The system's IANA timezone (e.g. `Europe/Prague`), or '' when the runtime can't resolve one. */
function detectTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
}

/** Reject anything the runtime can't resolve as an IANA zone. A typo saved here would be silent: the
 *  daemon falls back to the server's zone, so every scheduled job would fire at the wrong hour with no
 *  error to trace it back to. Blank is valid and means "use the server's zone". */
function validTimezone(v: string | undefined): string | undefined {
  const tz = (v ?? '').trim();
  if (!tz) return undefined;
  try { new Intl.DateTimeFormat(undefined, { timeZone: tz }); return undefined; } catch { return 'Enter a valid IANA timezone, e.g. Europe/Prague'; }
}

/** Assistant preferences — a few settings a fresh user would otherwise have to discover on their own,
 *  each offered as "accept a sane value" rather than an open question. Persists only what the user changes
 *  from the default, across three endpoints: the timezone (operator config, PUT /config), reasoning
 *  visibility (terminal settings) and auto-compaction (CLI settings). Every save is best-effort — a failed
 *  one warns and moves on, never blocking completion. */
export async function runPreferencesStep(ctx: WizardCtx): Promise<StepResult> {
  p.note('A few quick preferences for your assistant. Press enter to accept each suggested value.', 'Preferences');
  const summary: string[] = [];

  // ── Timezone — highest-value: it sets the clock Elowen answers "what time is it?" with AND the zone
  //    every scheduled job runs on. On a UTC VPS this is the difference between "daily 07:30" firing at
  //    07:30 locally vs. 07:30 UTC, so the user must see and confirm it.
  const detected = detectTimezone();
  const tz = (guard(await p.text({
    message: 'Your timezone (IANA name). It sets the time Elowen reports and the clock scheduled jobs run on — so "daily 07:30" fires at 07:30 where you are, not in the server\'s zone.',
    initialValue: detected,
    placeholder: 'e.g. Europe/Prague',
    validate: validTimezone,
  }))).trim();
  if (tz) {
    // The per-plugin config route rather than a raw PUT /config: it read-merges the stored values,
    // validates the key against the plugin's manifest schema, and hot-reloads so the zone applies to the
    // running daemon. Writing plugins.config directly would replace runtime-context's config wholesale.
    const r = await apiJson(ctx, 'PATCH', '/plugins/runtime-context/config', { values: { timezone: tz } });
    if (r.ok) summary.push(tz);
    else p.log.warn(`Couldn't save the timezone (${r.status}) — set it later in Settings.`);
  } else {
    summary.push('server timezone');
  }

  // ── Reasoning visibility — whether the model's Thought rows show in the CLI transcript. Default is on,
  //    so only persist a deliberate "hide".
  const showThoughts = guard(await p.confirm({
    message: 'Show the model\'s reasoning (Thought steps) in the CLI chat transcript?',
    initialValue: true,
  }));
  if (!showThoughts) {
    const r = await apiJson(ctx, 'PATCH', '/auth/me/terminal-settings', { showThoughtsCli: false });
    if (r.ok) summary.push('reasoning hidden');
    else p.log.warn(`Couldn't save the reasoning setting (${r.status}).`);
  }

  // ── Auto-compaction — summarize a long conversation before it overflows the context window. Off by
  //    default, which is exactly the trap a fresh user hits first (a context-limit error they can't read),
  //    so offer to turn it on. The default threshold keeps it to one confirm.
  const autoCompact = guard(await p.confirm({
    message: 'Auto-summarize a long conversation before it hits the context limit (instead of erroring out)?',
    initialValue: true,
  }));
  if (autoCompact) {
    const r = await apiJson(ctx, 'PATCH', '/auth/me/cli-settings', { autoCompact: true, autoCompactAt: DEFAULT_AUTO_COMPACT_AT });
    if (r.ok) summary.push('auto-compact on');
    else p.log.warn(`Couldn't save the auto-compaction setting (${r.status}).`);
  }

  ctx.answers.preferences = { status: 'done', summary: summary.join(' · ') || 'defaults' };
  return { status: 'done' };
}
