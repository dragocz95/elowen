import * as p from '../../ui/prompts.js';
import { apiJson } from '../http.js';
import { OPENROUTER_BASE, RECOMMENDED_EMBEDDING_MODEL } from '../constants.js';
import { guard, type StepResult, type WizardCtx } from '../types.js';
import { getBrainProviders, keepProvider } from './shared.js';

/** Step 4 — memory embeddings. Reuse the AI provider's key (recommended, when it can serve /v1/embeddings)
 *  or set up OpenRouter; fully optional. Persists via PUT /memory/embedding, then offers a validation test
 *  that never blocks completion. */
export async function runMemoryStep(ctx: WizardCtx): Promise<StepResult> {
  p.note('Memory lets Elowen recall useful facts across conversations using embeddings. Optional.', 'Memory');

  const ai = ctx.answers.ai;
  // Reuse only works when the AI provider is an openai-type endpoint WITH a key (embeddings go through
  // the OpenAI-compatible /v1/embeddings path; OAuth/Anthropic can't serve it with the reused key).
  const canReuse = ai?.status === 'done' && ai.providerType === 'openai' && ai.hasKey === true && !!ai.providerId;

  const choice = guard(await p.select({
    message: 'Memory provider',
    options: [
      ...(canReuse ? [{ value: 'reuse', label: 'Reuse your AI provider', hint: 'recommended — no extra key' }] : []),
      { value: 'openrouter', label: 'OpenRouter embeddings', hint: 'needs an OpenRouter API key' },
      { value: 'skip', label: 'Skip for now' },
      { value: 'back', label: '← Go back' },
    ],
  }));
  if (choice === 'back') return { status: 'back' };
  if (choice === 'skip') return skip(ctx);

  const providerId = choice === 'reuse' ? ai!.providerId! : await ensureOpenRouter(ctx);
  if (!providerId) return skip(ctx);

  // The recommended model, with an advanced override.
  let model = RECOMMENDED_EMBEDDING_MODEL;
  const useRecommended = guard(await p.confirm({ message: `Use the recommended embedding model (${model})?`, initialValue: true }));
  if (!useRecommended) model = (guard(await p.text({ message: 'Embedding model', initialValue: model }))).trim() || model;

  // Persist BEFORE testing — the test endpoint reads the persisted config, not the request body.
  const put = await apiJson(ctx, 'PUT', '/memory/embedding', { providerId, model, baseUrl: '' });
  if (!put.ok) { p.log.error(`Saving memory config failed (${put.status}).`); return skip(ctx); }

  const wantTest = guard(await p.confirm({ message: 'Test the embedding provider now?', initialValue: true }));
  if (wantTest) {
    const outcome = await runTest(ctx);
    if (outcome === 'edit') return runMemoryStep(ctx);
    if (outcome === 'off') return skip(ctx);
  }

  ctx.answers.memory = { status: 'done', summary: model };
  return { status: 'done' };
}

/** Reuse an existing keyed OpenRouter brain provider or create one; returns its id ('' if the user
 *  declined to enter a key). */
async function ensureOpenRouter(ctx: WizardCtx): Promise<string> {
  const providers = await getBrainProviders(ctx);
  const existing = providers.find((x) => x.type === 'openai' && x.baseUrl === OPENROUTER_BASE && x.apiKeySet);
  if (existing) return existing.id;

  const key = (guard(await p.password({ message: 'OpenRouter API key' }))).trim();
  if (!key) return '';
  const id = 'openrouter';
  const kept = providers.filter((e) => e.id !== id).map(keepProvider);
  const saved = await apiJson(ctx, 'PUT', '/config', {
    brain: { providers: [...kept, { id, label: 'OpenRouter', type: 'openai', baseUrl: OPENROUTER_BASE, models: [], apiKey: key }] },
  });
  if (!saved.ok) { p.log.error('Saving the OpenRouter provider failed.'); return ''; }
  return id;
}

/** Run the embedding self-test, looping on retry. Returns how it resolved — 'ok'/'kept' complete the
 *  step, 'edit' re-runs it, 'off' turns memory back off. Never aborts the wizard. */
async function runTest(ctx: WizardCtx): Promise<'ok' | 'kept' | 'edit' | 'off'> {
  for (;;) {
    const s = p.spinner(); s.start('Testing embeddings…');
    const r = await apiJson<{ ok?: boolean; dimensions?: number; error?: string }>(ctx, 'POST', '/memory/embedding/test');
    if (r.data?.ok) { s.stop(`Embeddings working — ${r.data.dimensions} dimensions.`); return 'ok'; }
    s.stop(`Embedding test failed: ${r.data?.error ?? `HTTP ${r.status}`}`, 'error');
    const next = guard(await p.select({
      message: 'What next?',
      options: [
        { value: 'retry', label: 'Retry test' },
        { value: 'edit', label: 'Change provider / model' },
        { value: 'keep', label: 'Keep anyway (unverified)' },
        { value: 'off', label: 'Turn memory off' },
      ],
    }));
    if (next === 'retry') continue;
    if (next === 'edit') return 'edit';
    if (next === 'keep') return 'kept';
    await apiJson(ctx, 'PUT', '/memory/embedding', { providerId: '', model: '' }); // disable
    return 'off';
  }
}

function skip(ctx: WizardCtx): StepResult {
  ctx.answers.memory = { status: 'skipped', summary: 'not configured' };
  return { status: 'skipped' };
}
