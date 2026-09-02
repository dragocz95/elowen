'use client';
import { useEffect, useMemo, useState } from 'react';
import { Boxes, Brain, FlaskConical, Hash, LayoutDashboard, PenLine, Server, Sparkles, Tags, UserCog } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '../../components/ui/Badge';
import { Button, buttonClassName } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { BrainModelField } from '../../components/ui/BrainModelField';
import { ProviderPicker } from '../../components/ui/ProviderPicker';
import { ChoiceField } from '../../components/ui/ChoiceField';
import { ModelCatalogField } from '../../components/ui/ModelCatalogField';
import { LoadingState, ErrorState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { interpolate, useTranslation } from '../../lib/i18n';
import { useBrand } from '../../lib/brand';
import { useConfig, useEmbeddingSettings, useCategorizationSettings, useBrainModels, useMyCliSettings } from '../../lib/queries';
import { useSaveEmbeddingSettings, useSaveCategorizationSettings, useUpdateConfig } from '../../lib/mutations';
import { useAutoSaveStatus, type SaveStatus } from '../../lib/useAutoSaveStatus';
import { combineSaveFeedback } from '../../lib/saveFeedback';
import { elowenClient, ElowenApiError } from '../../lib/elowenClient';
import type { BrainModelOption } from '../../lib/types';
import { resolveDigestRoute, roleKey, splitRoleKey } from '../../lib/modelRoles';
import { SettingsGroup, SettingsRow } from '../../components/ui/SettingsSurface';

/** Deduped model ids from the brain catalog, scoped to the chosen provider (or all when none picked).
 *  The catalog only ever holds real API/chat/embedding models from configured brain providers — CLI
 *  worker execs never appear here — so embedding can't accidentally point at a worker. */
function useProviderCatalog(brainModels: BrainModelOption[] | undefined, providerId: string): string[] {
  return useMemo(() => {
    const opts = (brainModels ?? []).filter((m) => !providerId || m.provider === providerId);
    return Array.from(new Set(opts.map((m) => m.model)));
  }, [brainModels, providerId]);
}

/** Settings → Models → **Model roles**: every instance-level answer to "which model does what", in the
 *  order someone actually asks it. The chat default the runtime resolves (read-only, because it is
 *  DERIVED from provider order rather than stored), the utility model that titles conversations and
 *  distils memories, the daily digest that inherits it, and the embedding route that cannot inherit
 *  anything because it speaks to a different endpoint.
 *
 *  Three independent autosave lifecycles ride here — `PUT /memory/embedding`, `PUT /memory/categorization`
 *  and `PUT /config` for the dashboard digest. They keep separate controllers on purpose: one shared
 *  controller would replay a stale sibling's draft on every save. The section folds them into ONE
 *  reported state, which the deck then folds again with the catalog's own saves.
 *
 *  Admin-only, like the whole Settings deck. */
export function ModelRolesSection({ onSaveState, onOpenSection }: {
  onSaveState?: (section: string, status: SaveStatus, retry?: () => void) => void;
  /** Switch the settings deck to another core section (the in-page cross-links). */
  onOpenSection?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { agentName } = useBrand();
  const { data: config } = useConfig();
  const { data: embedding, isError: embeddingIsError, refetch: refetchEmbedding } = useEmbeddingSettings();
  const { data: categorization, isError: categorizationIsError, refetch: refetchCategorization } = useCategorizationSettings();
  const { data: brainModels } = useBrainModels();
  const cli = useMyCliSettings();
  const saveEmbedding = useSaveEmbeddingSettings();
  const saveCategorization = useSaveCategorizationSettings();
  const updateConfig = useUpdateConfig();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Embedding form state
  const [embProvider, setEmbProvider] = useState('');
  const [embModel, setEmbModel] = useState('');
  const [dimensions, setDimensions] = useState('');
  const [testing, setTesting] = useState(false);

  // Utility (categorization) route, as ONE provider+model pair.
  const [utilityKey, setUtilityKey] = useState('');
  // Daily digest route, same encoding. Empty = inherit the utility model, which is already the runtime rule.
  const [digestKey, setDigestKey] = useState('');

  const [seeded, setSeeded] = useState(false);
  const [digestSeeded, setDigestSeeded] = useState(false);

  // Seed the memory-owned forms once from the persisted settings; edits auto-persist shortly after.
  useEffect(() => {
    if (embedding && categorization && !seeded) {
      setEmbProvider(embedding.providerId);
      setEmbModel(embedding.model);
      setDimensions(embedding.dimensions != null ? String(embedding.dimensions) : '');
      setUtilityKey(roleKey(categorization.providerId, categorization.model));
      setSeeded(true);
    }
  }, [embedding, categorization, seeded]);
  // …and the digest once from the config block. Its own gate, so a slow /config never holds up the
  // embedding form's seed (and vice versa) and neither autosave starts against an unseeded draft.
  useEffect(() => {
    const digest = config?.dashboard?.digest;
    if (digest && !digestSeeded) {
      setDigestKey(roleKey(digest.providerId, digest.model));
      setDigestSeeded(true);
    }
  }, [config, digestSeeded]);

  // OAuth accounts (Claude/ChatGPT) expose no embeddings endpoint, so they can never be an embedding
  // model — drop them from the embedding catalog. The utility and digest roles are chat completions, so
  // both keep the whole catalog.
  const embeddingModels = useMemo(() => (brainModels ?? []).filter((m) => m.source !== 'oauth'), [brainModels]);
  const embCatalog = useProviderCatalog(embeddingModels, embProvider);
  const catalog = useMemo(() => brainModels ?? [], [brainModels]);

  // baseUrl is intentionally omitted from the UI — the referenced provider already carries the API
  // endpoint. We send '' so any previously stored override is cleared and the provider endpoint wins.
  const onSaveEmbedding = async () => {
    const dim = dimensions.trim();
    try { await saveEmbedding.mutateAsync({ providerId: embProvider.trim(), model: embModel.trim(), baseUrl: '', dimensions: dim ? Number(dim) : null }); }
    catch (error) { toast(t.memory.embeddingSaveError, 'error'); throw error; }
  };

  const onSaveUtility = async () => {
    const { providerId, model } = splitRoleKey(utilityKey);
    try { await saveCategorization.mutateAsync({ providerId, model, baseUrl: '' }); }
    catch (error) { toast(t.categorization.saveError, 'error'); throw error; }
  };

  // One picker writes BOTH halves, so a half-set pair can never be persisted as if it were explicit —
  // which is what the runtime reads as "inherit the utility route".
  const onSaveDigest = async () => {
    const { providerId, model } = splitRoleKey(digestKey);
    try {
      await updateConfig.mutateAsync({ dashboard: { digest: { providerId, model } } });
      // The recap route reads config live; refetch so the dashboard reflects the change immediately.
      void queryClient.invalidateQueries({ queryKey: ['dash-recap'] });
      void queryClient.invalidateQueries({ queryKey: ['config'] });
    } catch (error) { toast(t.settings.modelRoles.digestSaveError, 'error'); throw error; }
  };

  // Auto-persist like the rest of Settings (silent on success, toast on error) — no Save buttons.
  const { status: embeddingStatus, retry: retryEmbedding } = useAutoSaveStatus([embProvider, embModel, dimensions], onSaveEmbedding, { ready: seeded });
  const { status: utilityStatus, retry: retryUtility } = useAutoSaveStatus([utilityKey], onSaveUtility, { ready: seeded });
  const { status: digestStatus, retry: retryDigest } = useAutoSaveStatus([digestKey], onSaveDigest, { ready: digestSeeded });
  const feedback = combineSaveFeedback(
    { status: embeddingStatus, retry: retryEmbedding },
    { status: utilityStatus, retry: retryUtility },
    { status: digestStatus, retry: retryDigest },
  );
  useEffect(() => {
    onSaveState?.('models', feedback.status, feedback.retry);
  }, [feedback.retry, feedback.status, onSaveState]);

  if (embeddingIsError || categorizationIsError) {
    return (
      <ErrorState
        message={t.common.daemonUnreachable}
        onRetry={() => { if (embeddingIsError) void refetchEmbedding(); if (categorizationIsError) void refetchCategorization(); }}
      />
    );
  }
  if (!config || !embedding || !categorization) return <LoadingState />;

  const providers = config.brain?.providers ?? [];
  // Same reason as the model filter: the embedding provider picker only offers providers that can
  // actually embed (API-key / OpenAI-compatible / relay) — OAuth accounts are excluded.
  const embeddingProviders = providers.filter((p) => !p.type.startsWith('oauth-'));

  const onTest = () => {
    setTesting(true);
    void elowenClient.testEmbedding()
      .then((r) => {
        if (r.ok) toast(t.memory.embeddingTestOk.replace('{dimensions}', String(r.dimensions)));
        else toast(t.memory.embeddingTestFail.replace('{error}', r.error), 'error');
      })
      // A 400 (unconfigured) throws ElowenApiError; anything else is an unexpected transport failure.
      .catch((e) => toast(e instanceof ElowenApiError ? t.memory.embeddingUnconfiguredError : String(e), 'error'))
      .finally(() => setTesting(false));
  };

  // WHAT THE RUNTIME RESOLVES, not what the API's `serverDefault` reports. The two disagree for a
  // provider with an EMPTY manual list: `serverDefault` returns its first explicitly configured model
  // (or a constant), while the spawn path takes the provider's catalog default. The daemon already
  // computes the spawn answer and marks it `default` on the catalog, so this row reads that flag and
  // cannot state a model the next conversation would not actually start on.
  const runtimeDefault = catalog.find((m) => m.default);
  // The same helper the Recap status row reads, so the two surfaces cannot disagree about which model
  // writes the digest — and neither can disagree with the daemon, whose rule it mirrors.
  const digestRoute = resolveDigestRoute(splitRoleKey(digestKey), splitRoleKey(utilityKey));
  // The pinned row's label describes the OPTION, not the current state: it names what choosing inherit
  // would resolve to, so it must read the utility route alone and stay stable while an explicit digest
  // model is selected. Resolving it against the live pair made it go blank the moment one was picked.
  const inheritedDigest = resolveDigestRoute(undefined, splitRoleKey(utilityKey));
  const digestInheritLabel = inheritedDigest.route
    ? interpolate(t.settings.modelRoles.inherit, { model: inheritedDigest.route.model })
    : t.settings.modelRoles.inheritUnset;
  // The personal primary this administrator's own conversations start on — the one fact that makes the
  // cross-link worth a row rather than a link in a hint.
  const personalPrimary = cli.data?.model || runtimeDefault?.model || '';

  const inheritedBadge = <Badge>{t.settings.modelRoles.inherited}</Badge>;
  const embBadge = embedding.configured ? <Badge tone="accent">{t.memory.embeddingConfigured}</Badge> : <Badge>{t.memory.embeddingUnconfigured}</Badge>;
  const utilityBadge = categorization.configured ? <Badge tone="accent">{t.categorization.configured}</Badge> : <Badge>{t.categorization.notConfigured}</Badge>;
  const testButton = (
    <Button variant="ghost" size="sm" icon={FlaskConical} disabled={testing} onClick={onTest}>
      {testing ? t.memory.embeddingTesting : t.memory.embeddingTest}
    </Button>
  );

  return (
    <SettingsGroup title={t.settings.modelRoles.title} description={t.settings.modelRoles.hint} icon={Boxes}>
      {/* Read-only on purpose: this answer is DERIVED from provider order, not stored, so a picker here
          would promise a setting that does not exist. The way to change it is to reorder the providers. */}
      <SettingsRow
        label={t.settings.modelRoles.instanceDefault}
        description={t.settings.modelRoles.instanceDefaultHelp}
        icon={Brain}
        status={<span className="truncate font-mono">{runtimeDefault?.model ?? '—'}</span>}
        actions={(
          <Button variant="ghost" size="sm" icon={Server} onClick={() => onOpenSection?.('brain')}>
            {t.settings.modelRoles.providersLink}
          </Button>
        )}
      />

      <SettingsRow
        label={t.settings.modelRoles.utility}
        description={interpolate(t.settings.modelRoles.utilityHelp, { agentName })}
        icon={Tags}
        trailingLayout="stack"
        status={utilityBadge}
        control={(
          <BrainModelField
            value={utilityKey}
            onChange={setUtilityKey}
            models={catalog}
            title={t.settings.modelRoles.utility}
            subtitle={interpolate(t.settings.modelRoles.utilityHelp, { agentName })}
            defaultLabel={t.settings.modelRoles.utilityOff}
            keyOf={(m) => roleKey(m.provider, m.model)}
            manageAriaLabel={`${t.managePicker.manage}: ${t.settings.modelRoles.utility}`}
          />
        )}
      />

      <SettingsRow
        label={t.settings.modelRoles.digest}
        description={t.settings.modelRoles.digestHelp}
        icon={Sparkles}
        trailingLayout="stack"
        status={digestRoute.inherited ? inheritedBadge : undefined}
        actions={(
          <Button variant="ghost" size="sm" icon={LayoutDashboard} onClick={() => onOpenSection?.('dashboard')}>
            {t.settings.modelRoles.recapLink}
          </Button>
        )}
        control={(
          <BrainModelField
            value={digestKey}
            onChange={setDigestKey}
            models={catalog}
            title={t.settings.modelRoles.digest}
            subtitle={t.settings.modelRoles.digestHelp}
            defaultLabel={digestInheritLabel}
            keyOf={(m) => roleKey(m.provider, m.model)}
            manageAriaLabel={`${t.managePicker.manage}: ${t.settings.modelRoles.digest}`}
          />
        )}
      />

      {/* A many-provider Segmented strip grows far too tall for a record's trailing cell — the pick opens
          a picker instead, and the badge and Test action share the stacked trailing side. */}
      <SettingsRow
        label={t.memory.embeddingProvider}
        description={t.help.embeddingProvider}
        hint={t.settings.modelRoles.embeddingConstraint}
        icon={Server}
        trailingLayout="stack"
        status={embBadge}
        actions={testButton}
        control={embeddingProviders.length > 0
          ? <ChoiceField title={t.memory.embeddingProvider} options={embeddingProviders.map((p) => ({ value: p.id, label: p.label }))} value={embProvider} onChange={setEmbProvider} picker="always" />
          : <ProviderPicker providers={embeddingProviders} value={embProvider} onChange={setEmbProvider} label={t.memory.embeddingProvider} emptyText={t.memory.embeddingProviderPlaceholder} variant="line" />}
      />
      {/* The provider is picked one row above, so a flat id list is the correct vocabulary here — and the
          free-text row below writes this same field. */}
      <SettingsRow
        label={t.memory.embeddingModel}
        description={t.help.embeddingIntro}
        icon={Boxes}
        control={<ModelCatalogField value={embModel} onChange={setEmbModel} catalog={embCatalog} title={t.memory.embeddingModel} subtitle={t.help.embeddingIntro} />}
      />
      <SettingsRow
        label={t.memory.embeddingModelCustom}
        description={t.help.embeddingModelCustom}
        icon={PenLine}
        control={<Input aria-label={t.memory.embeddingModelCustom} value={embModel} onChange={(e) => setEmbModel(e.target.value)} placeholder={t.memory.embeddingModelPlaceholder} className="font-mono" />}
      />
      <SettingsRow
        label={t.memory.embeddingDimensions}
        description={t.help.embeddingDimensions}
        icon={Hash}
        control={(
          <Input
            type="number"
            inputMode="numeric"
            aria-label={t.memory.embeddingDimensions}
            value={dimensions}
            onChange={(e) => setDimensions(e.target.value)}
            placeholder="1536"
            className="font-mono"
          />
        )}
      />

      {/* The personal half of the same question, one click away. A real navigation rather than a deck
          switch: the account roles live on another route. */}
      <SettingsRow
        label={t.settings.modelRoles.personal}
        description={t.settings.modelRoles.personalHelp}
        icon={UserCog}
        status={<span className="truncate font-mono">{personalPrimary || '—'}</span>}
        actions={(
          <a href="/account?cat=cli" className={buttonClassName('ghost', 'sm')}>
            <UserCog size={14} aria-hidden />
            {t.settings.modelRoles.openAccount}
          </a>
        )}
      />
    </SettingsGroup>
  );
}
