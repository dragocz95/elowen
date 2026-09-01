'use client';
import { useEffect, useMemo, useState } from 'react';
import { Boxes, FlaskConical, Hash, PenLine, Server, Tags } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { ProviderPicker } from '../../components/ui/ProviderPicker';
import { ChoiceField } from '../../components/ui/ChoiceField';
import { ModelCatalogField } from '../../components/ui/ModelCatalogField';
import { LoadingState, ErrorState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { interpolate, useTranslation } from '../../lib/i18n';
import { useBrand } from '../../lib/brand';
import { useConfig, useEmbeddingSettings, useCategorizationSettings, useBrainModels } from '../../lib/queries';
import { useSaveEmbeddingSettings, useSaveCategorizationSettings } from '../../lib/mutations';
import { useAutoSaveStatus, type SaveStatus } from '../../lib/useAutoSaveStatus';
import { elowenClient, ElowenApiError } from '../../lib/elowenClient';
import type { BrainModelOption } from '../../lib/types';
import { SettingsGroup, SettingsRow } from '../../components/ui/SettingsSurface';

/** Deduped model ids from the brain catalog, scoped to the chosen provider (or all when none picked).
 *  The catalog only ever holds real API/chat/embedding models from configured brain providers — CLI
 *  worker execs never appear here — so embedding/categorization can't accidentally point at a worker. */
function useProviderCatalog(brainModels: BrainModelOption[] | undefined, providerId: string): string[] {
  return useMemo(() => {
    const opts = (brainModels ?? []).filter((m) => !providerId || m.provider === providerId);
    return Array.from(new Set(opts.map((m) => m.model)));
  }, [brainModels, providerId]);
}

/** Settings → Memory: the two workspace-level models that power memory — the embedding model (memories
 *  → vectors for semantic recall) and the categorization model (sorts memories into categories). Both
 *  inherit their API key + endpoint from the referenced brain provider (Settings → Elowen AI); there is
 *  no separate base URL. Admin-only (the Settings config group is already admin-gated). */
export function MemorySection({ onSaveState }: { onSaveState?: (section: string, status: SaveStatus, retry?: () => void) => void }) {
  const { t } = useTranslation();
  const { agentName } = useBrand();
  const { data: config } = useConfig();
  const { data: embedding, isError: embeddingIsError, refetch: refetchEmbedding } = useEmbeddingSettings();
  const { data: categorization, isError: categorizationIsError, refetch: refetchCategorization } = useCategorizationSettings();
  const { data: brainModels } = useBrainModels();
  const saveEmbedding = useSaveEmbeddingSettings();
  const saveCategorization = useSaveCategorizationSettings();
  const { toast } = useToast();

  // Embedding form state
  const [embProvider, setEmbProvider] = useState('');
  const [embModel, setEmbModel] = useState('');
  const [dimensions, setDimensions] = useState('');
  const [testing, setTesting] = useState(false);

  // Categorization form state
  const [catProvider, setCatProvider] = useState('');
  const [catModel, setCatModel] = useState<string | null>(null);

  const [seeded, setSeeded] = useState(false);

  // Seed both forms once from the persisted settings; edits auto-persist shortly after.
  useEffect(() => {
    if (embedding && categorization && !seeded) {
      setEmbProvider(embedding.providerId);
      setEmbModel(embedding.model);
      setDimensions(embedding.dimensions != null ? String(embedding.dimensions) : '');
      setCatProvider(categorization.providerId);
      setCatModel(categorization.model || null);
      setSeeded(true);
    }
  }, [embedding, categorization, seeded]);

  // OAuth accounts (Claude/ChatGPT) expose no embeddings endpoint, so they can never be an embedding
  // model — drop them from the embedding catalog. Categorization is a chat completion, so it keeps all.
  const embeddingModels = useMemo(() => (brainModels ?? []).filter((m) => m.source !== 'oauth'), [brainModels]);
  const embCatalog = useProviderCatalog(embeddingModels, embProvider);
  const catCatalog = useProviderCatalog(brainModels, catProvider);

  // baseUrl is intentionally omitted from the UI — the referenced provider already carries the API
  // endpoint. We send '' so any previously stored override is cleared and the provider endpoint wins.
  const onSaveEmbedding = async () => {
    const dim = dimensions.trim();
    try { await saveEmbedding.mutateAsync({ providerId: embProvider.trim(), model: embModel.trim(), baseUrl: '', dimensions: dim ? Number(dim) : null }); }
    catch (error) { toast(t.memory.embeddingSaveError, 'error'); throw error; }
  };

  const onSaveCategorization = async () => {
    try { await saveCategorization.mutateAsync({ providerId: catProvider.trim(), model: (catModel ?? '').trim(), baseUrl: '' }); }
    catch (error) { toast(t.categorization.saveError, 'error'); throw error; }
  };

  // Auto-persist like the rest of Settings (silent on success, toast on error) — no Save buttons.
  const { status: embeddingStatus, retry: retryEmbedding } = useAutoSaveStatus([embProvider, embModel, dimensions], onSaveEmbedding, { ready: seeded });
  const { status: categorizationStatus, retry: retryCategorization } = useAutoSaveStatus([catProvider, catModel], onSaveCategorization, { ready: seeded });
  const saveStatus: SaveStatus = embeddingStatus === 'error' || categorizationStatus === 'error'
    ? 'error'
    : embeddingStatus === 'saving' || categorizationStatus === 'saving'
      ? 'saving'
      : embeddingStatus === 'saved' || categorizationStatus === 'saved' ? 'saved' : 'idle';
  useEffect(() => {
    const retry = saveStatus === 'error' ? () => {
      if (embeddingStatus === 'error') retryEmbedding();
      if (categorizationStatus === 'error') retryCategorization();
    } : undefined;
    onSaveState?.('memory', saveStatus, retry);
  }, [categorizationStatus, embeddingStatus, onSaveState, retryCategorization, retryEmbedding, saveStatus]);

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
  // Same reason: the embedding provider picker only offers providers that can actually embed
  // (API-key / OpenAI-compatible / relay) — OAuth accounts are excluded.
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

  // One merged orbit: badges are pod statuses, the test action joins the provider pod.
  const embBadge = embedding.configured ? <Badge tone="accent">{t.memory.embeddingConfigured}</Badge> : <Badge>{t.memory.embeddingUnconfigured}</Badge>;
  const catBadge = categorization.configured ? <Badge tone="accent">{t.categorization.configured}</Badge> : <Badge>{t.categorization.notConfigured}</Badge>;
  const testButton = (
    <Button variant="ghost" size="sm" icon={FlaskConical} disabled={testing} onClick={onTest}>
      {testing ? t.memory.embeddingTesting : t.memory.embeddingTest}
    </Button>
  );
  // A many-provider Segmented strip grows far too tall for a record's trailing cell — the pick opens a
  // picker instead.
  const rowEmbProvider = (
    <SettingsRow
      label={t.memory.embeddingProvider}
      description={t.help.embeddingProvider}
      icon={Server}
      trailingLayout="stack"
      status={embBadge}
      actions={testButton}
      control={embeddingProviders.length > 0
        ? <ChoiceField title={t.memory.embeddingProvider} options={embeddingProviders.map((p) => ({ value: p.id, label: p.label }))} value={embProvider} onChange={setEmbProvider} picker="always" />
        : <ProviderPicker providers={embeddingProviders} value={embProvider} onChange={setEmbProvider} label={t.memory.embeddingProvider} emptyText={t.memory.embeddingProviderPlaceholder} variant="line" />}
    />
  );
  const rowEmbModel = (
    <SettingsRow
      label={t.memory.embeddingModel}
      description={t.help.embeddingIntro}
      icon={Boxes}
      control={<ModelCatalogField value={embModel} onChange={setEmbModel} catalog={embCatalog} title={t.memory.embeddingModel} subtitle={t.help.embeddingIntro} />}
    />
  );
  const rowEmbCustom = (
    <SettingsRow
      label={t.memory.embeddingModelCustom}
      description={t.help.embeddingModelCustom}
      icon={PenLine}
      control={<Input aria-label={t.memory.embeddingModelCustom} value={embModel} onChange={(e) => setEmbModel(e.target.value)} placeholder={t.memory.embeddingModelPlaceholder} className="font-mono" />}
    />
  );
  const rowDimensions = (
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
  );
  const rowCatProvider = (
    <SettingsRow
      label={t.categorization.providerLabel}
      description={interpolate(t.help.categorizationProvider, { agentName })}
      icon={Server}
      trailingLayout="stack"
      status={catBadge}
      control={providers.length > 0
        ? <ChoiceField title={t.categorization.providerLabel} options={providers.map((p) => ({ value: p.id, label: p.label }))} value={catProvider} onChange={setCatProvider} picker="always" />
        : <ProviderPicker providers={providers} value={catProvider} onChange={setCatProvider} label={t.categorization.providerLabel} emptyText={t.memory.embeddingProviderPlaceholder} variant="line" />}
    />
  );
  const rowCatModel = (
    <SettingsRow
      label={t.categorization.modelLabel}
      description={t.help.categorizationIntro}
      icon={Tags}
      control={<ModelCatalogField value={catModel ?? ''} onChange={(v) => setCatModel(v || null)} catalog={catCatalog} title={t.categorization.modelLabel} subtitle={t.help.categorizationIntro} />}
    />
  );
  return (
    <div className="@container flex flex-col gap-4">
      <SettingsGroup columns={2}>
        {rowEmbProvider}{rowEmbModel}{rowEmbCustom}{rowDimensions}
        {rowCatProvider}{rowCatModel}
      </SettingsGroup>
    </div>
  );
}
