import { brainConfigFromElowen } from '../../brain/config.js';
import { probeAzureHostedToolSearch } from '../../brain/hostedToolSearchProbe.js';
import { listBrainModels, fetchOpenAiModels } from '../../brain/models.js';
import { hostedToolSearchFingerprint, isAzureOpenAIResponsesProvider } from '../../brain/session/hostedToolSearch.js';
import { elowenExec, isExecAllowedForUser } from '../../shared/execs.js';
import { HOSTED_TOOL_SEARCH_PROTOCOL } from '../../shared/hostedToolSearchProtocol.js';
import { brainProviderIds } from '../../store/configStore.js';
import type { ElowenApp } from '../context.js';
import type { BrainRouteContext } from './brainRouteContext.js';

export function registerBrainProviderRoutes(app: ElowenApp, route: BrainRouteContext): void {
  const { d, forbidden } = route;

  // The pickable models across every configured brain provider — dedicated entries, connected OAuth
  // accounts, or the relay fallback (feeds the Account → CLI dropdown and the CLI /model picker).
  //
  // Each item carries its identity STRUCTURALLY (`program` + the `provider`/`model` it already had) so a
  // client can render the bare model name without parsing anything out of a string — a model id may
  // itself contain slashes, so splitting the spec is not a safe way to get it. `exec` is the canonical
  // spelling and the picker's identifier — since migration v13 it is also what configs, task labels and
  // per-user allow-lists actually store. `legacyExec` is the pre-v13 `elowen:` spelling, kept ONLY so a
  // client built against the older wire format still resolves a pick; nothing in this repo, the web app
  // or the plugin registry reads it, and it goes away in the migration's cleanup phase. Non-admins only
  // see models their allow-list permits — this single server-side filter covers web AND CLI.
  app.get('/brain/models', async c => {
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const cfg = brainConfigFromElowen(d.config, d.brainAuth);
    if (!cfg) return c.json([]);
    const models = (await listBrainModels(cfg)).map((m) => {
      const legacyExec = `elowen:${m.provider}/${m.model}`;
      return { ...m, program: 'elowen' as const, legacyExec, exec: elowenExec(m.provider, m.model) };
    });
    const u = d.users ? c.get('user') : undefined;
    if (!u || u.is_admin) return c.json(models);
    const globalExecs = d.config.get().allowedExecs;
    // Judged on the structured identity — the gate asks the program, not the prefix of a string.
    return c.json(models.filter((m) => isExecAllowedForUser(u, globalExecs, { program: m.program, provider: m.provider, model: m.model }, brainProviderIds(d.config))));
  });

  // Probe an OpenAI-compatible endpoint's /models for the provider add/edit dialog — so the admin
  // clicks models instead of typing them. `apiKey` may be omitted when editing (`id` resolves the
  // stored key). Admin-only: it can exercise arbitrary stored credentials.
  app.post('/brain/providers/probe', async c => {
    const u = d.users ? c.get('user') : undefined;
    if (d.users && d.users.count() > 0 && (!u || !u.is_admin)) return c.json({ error: 'forbidden' }, 403);
    const b = (await c.req.json().catch(() => ({}))) as { baseUrl?: unknown; apiKey?: unknown; id?: unknown };
    const baseUrl = typeof b.baseUrl === 'string' ? b.baseUrl.trim() : '';
    if (!baseUrl) return c.json({ error: 'baseUrl required' }, 400);
    let apiKey = typeof b.apiKey === 'string' && b.apiKey.trim() ? b.apiKey.trim() : null;
    if (!apiKey && typeof b.id === 'string') apiKey = d.config.brainProviders().find((p) => p.id === b.id)?.apiKey ?? null;
    const models = await fetchOpenAiModels({ id: 'probe', label: 'probe', type: 'openai', baseUrl, models: [], apiKey }, fetch);
    return c.json({ models });
  });

  app.get('/brain/providers/hosted-tool-search/status', c => {
    const u = d.users ? c.get('user') : undefined;
    if (d.users && d.users.count() > 0 && (!u || !u.is_admin)) return c.json({ error: 'forbidden' }, 403);
    const capabilities = d.config.get().runtime.hostedToolSearch;
    return c.json({ providers: d.config.brainProviders()
      .filter(isAzureOpenAIResponsesProvider)
      .map((provider) => ({
        providerId: provider.id,
        models: provider.models.map((modelId) => {
          const saved = capabilities[provider.id]?.[modelId];
          const current = !!saved && saved.fingerprint === hostedToolSearchFingerprint(provider, modelId)
            && saved.protocol === HOSTED_TOOL_SEARCH_PROTOCOL;
          return {
            modelId,
            status: current ? saved.status : 'unverified',
            checkedAt: current ? saved.checkedAt : null,
          };
        }),
      })) });
  });

  // Verify Azure hosted tool search end-to-end with one synthetic function and an isolated transcript.
  // Admin-only: it exercises the stored provider key. Provider errors stay structured and never expose raw
  // response bodies (which can include request metadata or echoed prompt content).
  app.post('/brain/providers/hosted-tool-search/probe', async c => {
    const u = d.users ? c.get('user') : undefined;
    if (d.users && d.users.count() > 0 && (!u || !u.is_admin)) return c.json({ error: 'forbidden' }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { providerId?: unknown; modelId?: unknown };
    const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
    const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : '';
    if (!providerId || !modelId) return c.json({ error: 'providerId and modelId required' }, 400);
    const provider = d.config.brainProviders().find((entry) => entry.id === providerId);
    if (!provider) return c.json({ error: 'provider not found' }, 404);
    if (!isAzureOpenAIResponsesProvider(provider)) return c.json({ error: 'provider is not Azure OpenAI Responses' }, 400);
    if (!provider.models.includes(modelId)) return c.json({ error: 'model not configured for provider' }, 400);

    const result = await probeAzureHostedToolSearch({ provider, modelId });
    if (result.status !== 'error') {
      d.config.setHostedToolSearchCapability(providerId, modelId, {
        status: result.status,
        fingerprint: hostedToolSearchFingerprint(provider, modelId),
        checkedAt: result.checkedAt,
        protocol: HOSTED_TOOL_SEARCH_PROTOCOL,
      });
    }
    return c.json({ providerId, modelId, ...result });
  });

  // Smoke-test the configured brain: run ONE minimal non-streaming completion to prove it actually
  // answers. Admin-only (it exercises stored provider credentials, like providers/probe). Always 200 with
  // a structured result — a provider failure is reported as { ok:false, error }, never a 500.
  app.post('/brain/test', async c => {
    const u = d.users ? c.get('user') : undefined;
    if (d.users && d.users.count() > 0 && (!u || !u.is_admin)) return c.json({ error: 'forbidden' }, 403);
    if (!d.brain) return c.json({ ok: false, error: 'brain unavailable' });
    const b = (await c.req.json().catch(() => ({}))) as { providerId?: unknown; model?: unknown };
    const sel = {
      providerId: typeof b.providerId === 'string' ? b.providerId : undefined,
      model: typeof b.model === 'string' ? b.model : undefined,
    };
    return c.json(await d.brain.smokeTest(sel));
  });
}
