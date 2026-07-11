'use client';
import { useEffect, useMemo, useState } from 'react';
import { FlaskConical, RefreshCw } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Input } from '../../components/ui/Input';
import { ProviderPicker } from '../../components/ui/ProviderPicker';
import { ModelCatalogField } from '../../components/ui/ModelCatalogField';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { SpatialGroup, SpatialRow } from '../../components/ui/SpatialPrimitives';
import { LoadingState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useConfig, useEmbeddingSettings, useCategorizationSettings, useBrainModels } from '../../lib/queries';
import { useSaveEmbeddingSettings, useReindexMemories, useSaveCategorizationSettings, useReclassifyMemories } from '../../lib/mutations';
import { useAutoSaveStatus, type SaveStatus } from '../../lib/useAutoSaveStatus';
import { elowenClient, ElowenApiError } from '../../lib/elowenClient';
import type { BrainModelOption } from '../../lib/types';

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
  const { data: config } = useConfig();
  const { data: embedding } = useEmbeddingSettings();
  const { data: categorization } = useCategorizationSettings();
  const { data: brainModels } = useBrainModels();
  const saveEmbedding = useSaveEmbeddingSettings();
  const reindex = useReindexMemories();
  const saveCategorization = useSaveCategorizationSettings();
  const reclassify = useReclassifyMemories();
  const { toast } = useToast();

  // Embedding form state
  const [embProvider, setEmbProvider] = useState('');
  const [embModel, setEmbModel] = useState('');
  const [dimensions, setDimensions] = useState('');
  const [testing, setTesting] = useState(false);
  const [reindexOpen, setReindexOpen] = useState(false);

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

  const onReindex = () => {
    setReindexOpen(false);
    reindex.mutate(undefined, {
      onSuccess: (r) => toast(t.memory.reindexDone.replace('{n}', String(r.embedded))),
      onError: () => toast(t.memory.reindexError, 'error'),
    });
  };

  const onReclassify = () => {
    reclassify.mutate(undefined, {
      onSuccess: (r) => toast(t.categorization.reclassifyDone.replace('{scanned}', String(r.scanned)).replace('{classified}', String(r.classified))),
      onError: () => toast(t.categorization.saveError, 'error'),
    });
  };

  return (
    <div className="@container flex flex-col gap-4">
      <SpatialGroup title={t.memory.embeddingHeading} description={t.help.embeddingIntro} icon={FlaskConical}>
        <div className="flex flex-wrap items-center justify-between gap-3 py-3">
          {embedding.configured ? <Badge tone="accent">{t.memory.embeddingConfigured}</Badge> : <Badge>{t.memory.embeddingUnconfigured}</Badge>}
          <button type="button" className="spatial-inline-action" disabled={testing} onClick={onTest}>
            <FlaskConical size={14} aria-hidden />{testing ? t.memory.embeddingTesting : t.memory.embeddingTest}
          </button>
        </div>
        <SpatialRow title={t.memory.embeddingProvider} description={t.help.embeddingProvider}>
          <ProviderPicker providers={embeddingProviders} value={embProvider} onChange={setEmbProvider} label={t.memory.embeddingProvider} emptyText={t.memory.embeddingProviderPlaceholder} variant="line" />
        </SpatialRow>

        <SpatialRow title={t.memory.embeddingModel} description={t.help.embeddingIntro}>
          <ModelCatalogField value={embModel} onChange={setEmbModel} catalog={embCatalog} title={t.memory.embeddingModel} subtitle={t.help.embeddingIntro} variant="line" />
        </SpatialRow>

        <SpatialRow title={t.memory.embeddingModelCustom} description={t.help.embeddingModelCustom}>
          <Input value={embModel} onChange={(e) => setEmbModel(e.target.value)} placeholder={t.memory.embeddingModelPlaceholder} className="font-mono" variant="line" />
        </SpatialRow>

        <SpatialRow title={t.memory.embeddingDimensions} description={t.help.embeddingDimensions}>
          <Input
            type="number"
            inputMode="numeric"
            value={dimensions}
            onChange={(e) => setDimensions(e.target.value)}
            placeholder="1536"
            className="max-w-40 font-mono"
            variant="line"
          />
        </SpatialRow>

        <SpatialRow title={t.memory.reindex} description={embedding.configured ? t.memory.reindexConfirmBody : t.memory.reindexUnconfigured} icon={RefreshCw}>
          <button
            type="button"
            className="spatial-inline-action"
            disabled={!embedding.configured || reindex.isPending}
            onClick={() => setReindexOpen(true)}
          >
            <RefreshCw size={14} aria-hidden />{t.memory.reindex}
          </button>
        </SpatialRow>
      </SpatialGroup>

      <SpatialGroup title={t.categorization.title} description={t.help.categorizationIntro} icon={RefreshCw}>
        <div className="flex items-center py-3">
          {categorization.configured ? <Badge tone="accent">{t.categorization.configured}</Badge> : <Badge>{t.categorization.notConfigured}</Badge>}
        </div>

        <SpatialRow title={t.categorization.providerLabel}>
          <ProviderPicker providers={providers} value={catProvider} onChange={setCatProvider} label={t.categorization.providerLabel} emptyText={t.memory.embeddingProviderPlaceholder} variant="line" />
        </SpatialRow>

        <SpatialRow title={t.categorization.modelLabel} description={t.help.categorizationIntro}>
          <ModelCatalogField value={catModel ?? ''} onChange={(v) => setCatModel(v || null)} catalog={catCatalog} title={t.categorization.modelLabel} subtitle={t.help.categorizationIntro} variant="line" />
        </SpatialRow>

        <SpatialRow title={t.categorization.reclassify} description={t.categorization.reclassifyHint} icon={RefreshCw}>
          <button
            type="button"
            className="spatial-inline-action"
            disabled={!categorization.configured || reclassify.isPending}
            onClick={onReclassify}
          >
            <RefreshCw size={14} aria-hidden />{t.categorization.reclassify}
          </button>
        </SpatialRow>
      </SpatialGroup>

      <ConfirmDialog
        open={reindexOpen}
        title={t.memory.reindexConfirmTitle}
        description={t.memory.reindexConfirmBody}
        confirmLabel={t.memory.reindexConfirm}
        onConfirm={onReindex}
        onClose={() => setReindexOpen(false)}
      />
    </div>
  );
}
