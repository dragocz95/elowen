import * as p from '@clack/prompts';
import type { BrainProviderType } from '../../../store/configStore.js';
import type { OAuthFlowState } from '../../../brain/oauth.js';
import { PREFERRED_DEFAULT } from '../../../brain/providers.js';
import { apiJson } from '../http.js';
import { openBrowser } from '../browser.js';
import { API_KEY_PROVIDERS, OAUTH_CHOICES } from '../constants.js';
import { deriveSlug } from '../slug.js';
import { guard, WizardCancelled, type StepResult, type WizardCtx } from '../types.js';
import { getBrainProviders, keepProvider, type PublicProvider } from './shared.js';

interface ProviderEntry { id: string; label: string; type: BrainProviderType; baseUrl: string; models: string[]; apiKey?: string }

const OAUTH_POLL_MS = 1500;
const OAUTH_TIMEOUT_MS = 300_000;
const stripSignIn = (label: string) => label.replace('Sign in with ', '');

/** Step 3 — connect an AI provider. Offers reuse of an already-configured/connected provider, an OAuth
 *  sign-in (Claude / Copilot / Codex-OpenAI), an API key, a custom OpenAI-compatible endpoint, or skip. */
export async function runAiStep(ctx: WizardCtx): Promise<StepResult> {
  const providers = await getBrainProviders(ctx);
  const oauthStatus = (await apiJson<Record<string, boolean>>(ctx, 'GET', '/brain/oauth/status')).data ?? {};

  const reuse: { value: string; label: string; hint: string }[] = [];
  for (const pr of providers) if (pr.apiKeySet) reuse.push({ value: `reuse:${pr.id}`, label: `Reuse ${pr.label}`, hint: 'configured API key' });
  for (const ch of OAUTH_CHOICES) if (oauthStatus[ch.type]) reuse.push({ value: `reuse-oauth:${ch.type}`, label: `Reuse ${stripSignIn(ch.label)}`, hint: 'connected account' });

  const choice = guard(await p.select({
    message: 'Connect an AI provider',
    options: [
      ...reuse,
      ...OAUTH_CHOICES.map((c) => ({ value: c.type, label: c.label })),
      { value: 'apikey', label: 'Use an API key' },
      { value: 'custom', label: 'Custom OpenAI-compatible endpoint' },
      { value: 'skip', label: 'Connect later', hint: 'set up in the web UI' },
      { value: 'back', label: '← Go back' },
    ],
  })) as string;

  if (choice === 'back') return { status: 'back' };
  if (choice === 'skip') return skip(ctx);
  if (choice.startsWith('reuse-oauth:')) return reuseOauth(ctx, choice.slice('reuse-oauth:'.length) as BrainProviderType, providers);
  if (choice.startsWith('reuse:')) return reuseApiKey(ctx, choice.slice('reuse:'.length), providers);
  if (choice === 'apikey' || choice === 'custom') return apiKeyFlow(ctx, choice === 'custom', providers);
  return oauthFlow(ctx, choice as BrainProviderType, providers);
}

// ── reuse ────────────────────────────────────────────────────────────────────────────────────────
async function reuseApiKey(ctx: WizardCtx, id: string, providers: PublicProvider[]): Promise<StepResult> {
  const pr = providers.find((x) => x.id === id);
  if (!pr) return { status: 'back' };
  const model = pr.models[0] ?? (pr.type === 'anthropic' ? PREFERRED_DEFAULT.anthropic : '') ?? '';
  await maybeWireAutopilot(ctx, pr.type, true, pr.id, model);
  return done(ctx, pr.label, model, pr.id, pr.type, true);
}

async function reuseOauth(ctx: WizardCtx, type: BrainProviderType, providers: PublicProvider[]): Promise<StepResult> {
  const entry = providers.find((x) => x.type === type);
  if (entry) return done(ctx, entry.label, entry.models[0] ?? '', entry.id, type, false);
  return persistOauthEntry(ctx, type, providers); // connected but no config entry yet → create one
}

// ── API key / custom endpoint ──────────────────────────────────────────────────────────────────
async function apiKeyFlow(ctx: WizardCtx, custom: boolean, providers: PublicProvider[]): Promise<StepResult> {
  let type: BrainProviderType = 'openai';
  let base = API_KEY_PROVIDERS[0]!.base;
  let label = 'Custom';
  if (!custom) {
    const pick = guard(await p.select({ message: 'Provider', options: API_KEY_PROVIDERS.map((x) => ({ value: x.key, label: x.label })) })) as string;
    const preset = API_KEY_PROVIDERS.find((x) => x.key === pick)!;
    type = preset.type; base = preset.base; label = preset.label;
  } else {
    base = (guard(await p.text({ message: 'API base URL', placeholder: 'https://…/v1', validate: validUrl })) as string).trim();
  }
  const apiKey = (guard(await p.password({ message: 'API key (leave blank to add later in the web UI)' })) as string).trim();

  const model = await chooseModel(ctx, type, base, apiKey);
  if (model === null) return skip(ctx);

  const id = uniqueId(label, providers);
  const entry: ProviderEntry = { id, label, type, baseUrl: base, models: model ? [model] : [], ...(apiKey ? { apiKey } : {}) };
  const s = p.spinner(); s.start('Saving provider…');
  const ok = await saveProvider(ctx, entry, providers);
  s.stop(ok ? 'Provider saved.' : 'Saving the provider failed.');
  if (!ok) return skip(ctx);

  await maybeWireAutopilot(ctx, type, !!apiKey, id, model);
  return done(ctx, label, model, id, type, !!apiKey);
}

/** Resolve the default model: probe /models for an openai endpoint with a key (validates key + URL),
 *  otherwise ask. Returns the model, '' (none), or null (the user chose to skip AI setup). */
async function chooseModel(ctx: WizardCtx, type: BrainProviderType, base: string, apiKey: string): Promise<string | null> {
  if (type === 'anthropic') return (guard(await p.text({ message: 'Default model', initialValue: PREFERRED_DEFAULT.anthropic })) as string).trim();
  if (type === 'openai' && apiKey) {
    for (;;) {
      const s = p.spinner(); s.start('Checking the endpoint…');
      const probe = await apiJson<{ models?: string[] }>(ctx, 'POST', '/brain/providers/probe', { baseUrl: base, apiKey });
      const models = probe.data?.models ?? [];
      if (models.length) { s.stop(`Connected — ${models.length} models available.`); return pickFromList(models); }
      s.stop('Reached the endpoint but got no model list (the key may be wrong, or it has no /models).');
      const next = guard(await p.select({
        message: 'What next?',
        options: [
          { value: 'manual', label: 'Enter a model name manually' },
          { value: 'retry', label: 'Retry' },
          { value: 'skip', label: 'Skip AI setup' },
        ],
      })) as string;
      if (next === 'retry') continue;
      if (next === 'skip') return null;
      return (guard(await p.text({ message: 'Model id', placeholder: 'e.g. gpt-5.5' })) as string).trim();
    }
  }
  return (guard(await p.text({ message: 'Default model (optional)', placeholder: 'e.g. gpt-5.5' })) as string).trim();
}

async function pickFromList(models: string[]): Promise<string> {
  const opts = models.slice(0, 40).map((m) => ({ value: m, label: m }));
  const pick = guard(await p.select({ message: 'Default model', options: [...opts, { value: '__manual__', label: 'Enter another…' }] })) as string;
  return pick === '__manual__' ? (guard(await p.text({ message: 'Model id' })) as string).trim() : pick;
}

// ── OAuth (same paste-back flow the web uses) ─────────────────────────────────────────────────────
async function oauthFlow(ctx: WizardCtx, type: BrainProviderType, providers: PublicProvider[]): Promise<StepResult> {
  for (;;) {
    const outcome = await connectOAuth(ctx, type);
    if (outcome === 'success') return persistOauthEntry(ctx, type, providers);
    if (outcome === 'cancel') return { status: 'back' };
    const again = guard(await p.select({
      message: "Sign-in didn't complete.",
      options: [
        { value: 'retry', label: 'Retry' },
        { value: 'switch', label: 'Choose a different provider' },
        { value: 'skip', label: 'Skip AI setup' },
      ],
    })) as string;
    if (again === 'retry') continue;
    if (again === 'switch') return runAiStep(ctx);
    return skip(ctx);
  }
}

/** Drive one OAuth sign-in exactly like the web dialog: show the authorization URL (opening the browser
 *  best-effort), let the user authorize, then paste the redirect URL / code back. Crucially, NO spinner
 *  runs while the URL and the paste prompt are on screen — a running spinner previously obscured them and
 *  the flow looked stuck. A spinner appears only for the final "finishing" wait. */
async function connectOAuth(ctx: WizardCtx, type: BrainProviderType): Promise<'success' | 'failed' | 'cancel'> {
  const ch = OAUTH_CHOICES.find((c) => c.type === type)!;
  const start = await apiJson<{ id?: string }>(ctx, 'POST', `/brain/oauth/${type}/start`);
  if (!start.ok || !start.data?.id) { p.log.error(`Couldn't start the sign-in (${start.status}).`); return 'failed'; }
  const flowId = start.data.id;

  try {
    // 1. Wait for the provider to hand us an authorization URL (or a terminal state).
    const ready = await waitForFlow(ctx, flowId, (f) => !!f.authUrl || !!f.userCode || f.needsInput || isSettled(f));
    if (!ready) { p.log.error('Timed out starting the sign-in.'); return 'failed'; }
    if (ready.status === 'error') { p.log.error(`Sign-in failed: ${ready.error ?? 'unknown error'}`); return 'failed'; }

    // 2. Show the URL / device code (no spinner over it) and open the browser best-effort.
    if (ready.authUrl) {
      p.log.step(`Sign in to ${stripSignIn(ch.label)} — open this URL and authorize:`);
      p.log.message(ready.authUrl);
      if (openBrowser(ready.authUrl)) p.log.info('(also opened it in your browser)');
      if (ready.instructions) p.log.message(ready.instructions);
    }
    if (ready.userCode) p.note(ready.userCode, 'Enter this code in your browser');

    // 3. Paste-back: when the flow wants the redirect URL / code, ask for it (waiting until it's ready).
    let cur = ready;
    if (!cur.needsInput && !isSettled(cur)) cur = (await waitForFlow(ctx, flowId, (f) => f.needsInput || isSettled(f))) ?? cur;
    if (cur.needsInput) {
      const pasted = (guard(await p.text({ message: 'Paste the redirect URL (or code) from your browser here' })) as string).trim();
      const sub = await apiJson(ctx, 'POST', `/brain/oauth/flow/${flowId}/input`, { value: pasted });
      if (!sub.ok) p.log.warn('Submitting the code failed — the sign-in may still complete on its own.');
    }

    // 4. Wait for completion (a spinner is fine here — nothing else needs the screen).
    const s = p.spinner(); s.start('Finishing sign-in…');
    const done = await waitForFlow(ctx, flowId, isSettled, 120_000);
    if (done?.status === 'success') { s.stop('Signed in ✓'); return 'success'; }
    s.stop(`Sign-in failed: ${done?.error ?? 'timed out'}`);
    return 'failed';
  } catch (e) {
    if (e instanceof WizardCancelled) return 'cancel'; // ctrl+c at the paste prompt → go back a step
    throw e;
  }
}

const isSettled = (f: OAuthFlowState): boolean => f.status === 'success' || f.status === 'error';

/** Poll a flow until `until` holds or the timeout elapses; returns the flow snapshot, or null on timeout /
 *  a lost flow. */
async function waitForFlow(ctx: WizardCtx, flowId: string, until: (f: OAuthFlowState) => boolean, timeoutMs = OAUTH_TIMEOUT_MS): Promise<OAuthFlowState | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const f = (await apiJson<OAuthFlowState>(ctx, 'GET', `/brain/oauth/flow/${flowId}`)).data;
    if (!f) return null;
    if (until(f)) return f;
    if (Date.now() > deadline) return null;
    await sleep(OAUTH_POLL_MS);
  }
}

/** Persist a config entry for a connected OAuth account (no key — the credential lives in AuthStorage),
 *  choosing a default model from the account's catalog so the model registry resolves it. */
async function persistOauthEntry(ctx: WizardCtx, type: BrainProviderType, providers: PublicProvider[]): Promise<StepResult> {
  const ch = OAUTH_CHOICES.find((c) => c.type === type)!;
  const cat = (await apiJson<{ models?: string[] }>(ctx, 'GET', `/brain/oauth/${type}/catalog`)).data?.models ?? [];
  const preferred = PREFERRED_DEFAULT[ch.builtin];
  const model = preferred && cat.includes(preferred) ? preferred : cat[0] ?? '';
  const id = `oauth-${ch.builtin}`;
  await saveProvider(ctx, { id, label: stripSignIn(ch.label), type, baseUrl: '', models: model ? [model] : [] }, providers);
  p.log.success(`Connected ${stripSignIn(ch.label)}.`);
  return done(ctx, stripSignIn(ch.label), model, id, type, false);
}

// ── persistence + wiring ───────────────────────────────────────────────────────────────────────
/** Save `entry` into the brain provider list. The list replaces wholesale, so the OTHER entries are
 *  re-sent WITHOUT their apiKey — the config store keeps each stored key when apiKey is omitted, so no
 *  secret is echoed or lost. */
async function saveProvider(ctx: WizardCtx, entry: ProviderEntry, others: PublicProvider[]): Promise<boolean> {
  const kept = others.filter((e) => e.id !== entry.id).map(keepProvider);
  const r = await apiJson(ctx, 'PUT', '/config', { brain: { providers: [...kept, entry] } });
  return r.ok;
}

/** Point the autopilot relay at this provider — but ONLY for an openai-type provider WITH a key. The
 *  relay is OpenAI-compatible and autopilotRelay() returns null without a key, so wiring an Anthropic or
 *  OAuth provider would silently fail; for those we tell the user what the planner needs instead. */
/** The autopilot relay is OpenAI-compatible and needs a key — only an openai-type provider WITH a key
 *  can back it (autopilotRelay() returns null without a key; Anthropic/OAuth can't speak the protocol). */
export function shouldWireAutopilot(type: BrainProviderType, hasKey: boolean): boolean {
  return type === 'openai' && hasKey;
}

async function maybeWireAutopilot(ctx: WizardCtx, type: BrainProviderType, hasKey: boolean, providerId: string, model: string): Promise<void> {
  if (!shouldWireAutopilot(type, hasKey)) {
    p.log.info('Autopilot (planner/overseer) needs an agent CLI or a separate OpenAI-compatible key — set it up later in Settings.');
    return;
  }
  const r = await apiJson(ctx, 'PUT', '/config', { autopilot: { providerId, ...(model ? { model } : {}) } });
  if (r.ok) p.log.info('Autopilot will use this provider too.');
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────
function done(ctx: WizardCtx, label: string, model: string, providerId: string, providerType: BrainProviderType, hasKey: boolean): StepResult {
  const summary = `${label}${model ? ` (${model})` : ''}`;
  ctx.answers.ai = { status: 'done', summary, providerId, providerType, model, hasKey };
  return { status: 'done', summary };
}

function skip(ctx: WizardCtx): StepResult {
  ctx.answers.ai = { status: 'skipped', summary: 'not configured' };
  return { status: 'skipped', summary: 'AI not configured' };
}

function validUrl(v: string | undefined): string | undefined {
  try { new URL((v ?? '').trim()); return undefined; } catch { return 'Enter a valid URL (including https://)'; }
}

function uniqueId(label: string, providers: PublicProvider[]): string {
  const base = deriveSlug(label) || 'provider';
  const taken = new Set(providers.map((x) => x.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
