'use client';
import { useEffect, useMemo, useState } from 'react';
import { Check, FlaskConical, RefreshCw } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { HelpTip } from '../../components/ui/HelpTip';
import { ProviderPicker } from '../../components/ui/ProviderPicker';
import { ModelPillsPicker } from '../../components/ui/ModelPillsPicker';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { LoadingState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useConfig, useEmbeddingSettings, useCategorizationSettings, useBrainModels } from '../../lib/queries';
import { useSaveEmbeddingSettings, useReindexMemories, useSaveCategorizationSettings, useReclassifyMemories } from '../../lib/mutations';
import { orcaClient, OrcaApiError } from '../../lib/orcaClient';
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
 *  inherit their API key + endpoint from the referenced brain provider (Settings → Orca AI); there is
 *  no separate base URL. Admin-only (the Settings config group is already admin-gated). */
export function MemorySection() {
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

  // Seed both forms once from the persisted settings; edits stay local until Save.
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

  if (!config || !embedding || !categorization) return <LoadingState />;

  const providers = config.brain?.providers ?? [];
  // Same reason: the embedding provider picker only offers providers that can actually embed
  // (API-key / OpenAI-compatible / relay) — OAuth accounts are excluded.
  const embeddingProviders = providers.filter((p) => !p.type.startsWith('oauth-'));

  // baseUrl is intentionally omitted from the UI — the referenced provider already carries the API
  // endpoint. We send '' so any previously stored override is cleared and the provider endpoint wins.
  const onSaveEmbedding = () => {
    const dim = dimensions.trim();
    saveEmbedding.mutate(
      { providerId: embProvider.trim(), model: embModel.trim(), baseUrl: '', dimensions: dim ? Number(dim) : null },
      { onSuccess: () => toast(t.memory.embeddingSaved), onError: () => toast(t.memory.embeddingSaveError, 'error') },
    );
  };

  const onTest = () => {
    setTesting(true);
    void orcaClient.testEmbedding()
      .then((r) => {
        if (r.ok) toast(t.memory.embeddingTestOk.replace('{dimensions}', String(r.dimensions)));
        else toast(t.memory.embeddingTestFail.replace('{error}', r.error), 'error');
      })
      // A 400 (unconfigured) throws OrcaApiError; anything else is an unexpected transport failure.
      .catch((e) => toast(e instanceof OrcaApiError ? t.memory.embeddingUnconfiguredError : String(e), 'error'))
      .finally(() => setTesting(false));
  };

  const onReindex = () => {
    setReindexOpen(false);
    reindex.mutate(undefined, {
      onSuccess: (r) => toast(t.memory.reindexDone.replace('{n}', String(r.embedded))),
      onError: () => toast(t.memory.reindexError, 'error'),
    });
  };

  const onSaveCategorization = () => {
    saveCategorization.mutate(
      { providerId: catProvider.trim(), model: (catModel ?? '').trim(), baseUrl: '' },
      { onSuccess: () => toast(t.categorization.saved), onError: () => toast(t.categorization.saveError, 'error') },
    );
  };

  const onReclassify = () => {
    reclassify.mutate(undefined, {
      onSuccess: (r) => toast(t.categorization.reclassifyDone.replace('{scanned}', String(r.scanned)).replace('{classified}', String(r.classified))),
      onError: () => toast(t.categorization.saveError, 'error'),
    });
  };

  return (
    <div className="@container flex flex-col gap-4">
      {/* Embedding model */}
      <section className="flex flex-col gap-5 rounded-xl border border-border bg-surface p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-text">{t.memory.embeddingHeading}</span>
          <HelpTip align="left">{t.help.embeddingIntro}</HelpTip>
          {embedding.configured
            ? <Badge tone="accent">{t.memory.embeddingConfigured}</Badge>
            : <Badge>{t.memory.embeddingUnconfigured}</Badge>}
        </div>

        <Field label={t.memory.embeddingProvider} hint={t.help.embeddingProvider}>
          <ProviderPicker providers={embeddingProviders} value={embProvider} onChange={setEmbProvider} label={t.memory.embeddingProvider} emptyText={t.memory.embeddingProviderPlaceholder} />
        </Field>

        <Field label={t.memory.embeddingModel}>
          <ModelPillsPicker mode="single" catalog={embCatalog} value={embModel || null} onChange={(v) => setEmbModel(v ?? '')} />
        </Field>

        <Field label={t.memory.embeddingModelCustom} hint={t.help.embeddingModelCustom}>
          <Input value={embModel} onChange={(e) => setEmbModel(e.target.value)} placeholder={t.memory.embeddingModelPlaceholder} className="font-mono" />
        </Field>

        <Field label={t.memory.embeddingDimensions} hint={t.help.embeddingDimensions}>
          <Input
            type="number"
            inputMode="numeric"
            value={dimensions}
            onChange={(e) => setDimensions(e.target.value)}
            placeholder="1536"
            className="max-w-40 font-mono"
          />
        </Field>

        <div className="flex flex-wrap gap-2">
          <Button variant="accent" icon={Check} disabled={saveEmbedding.isPending} onClick={onSaveEmbedding}>{t.memory.embeddingSave}</Button>
          <Button variant="default" icon={FlaskConical} disabled={testing} onClick={onTest}>{testing ? t.memory.embeddingTesting : t.memory.embeddingTest}</Button>
        </div>

        {/* Reindex: re-embeds memories still missing a vector. Needs a configured provider first. */}
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-bg p-4">
          <span className="text-sm font-medium text-text">{t.memory.reindex}</span>
          <p className="text-xs text-text-muted">{t.memory.reindexConfirmBody}</p>
          {embedding.configured ? null : <p className="text-xs italic text-text-muted">{t.memory.reindexUnconfigured}</p>}
          <Button
            variant="default"
            icon={RefreshCw}
            className="self-start"
            disabled={!embedding.configured || reindex.isPending}
            onClick={() => setReindexOpen(true)}
          >
            {t.memory.reindex}
          </Button>
        </div>
      </section>

      {/* Categorization model */}
      <section className="flex flex-col gap-5 rounded-xl border border-border bg-surface p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-text">{t.categorization.title}</span>
          <HelpTip align="left">{t.help.categorizationIntro}</HelpTip>
          {categorization.configured
            ? <Badge tone="accent">{t.categorization.configured}</Badge>
            : <Badge>{t.categorization.notConfigured}</Badge>}
        </div>

        <Field label={t.categorization.providerLabel}>
          <ProviderPicker providers={providers} value={catProvider} onChange={setCatProvider} label={t.categorization.providerLabel} emptyText={t.memory.embeddingProviderPlaceholder} />
        </Field>

        <Field label={t.categorization.modelLabel}>
          <ModelPillsPicker mode="single" catalog={catCatalog} value={catModel} onChange={setCatModel} />
        </Field>

        <div className="flex flex-wrap gap-2">
          <Button variant="accent" icon={Check} disabled={saveCategorization.isPending} onClick={onSaveCategorization}>{t.categorization.save}</Button>
        </div>

        {/* Reclassify: runs the categorization model over the caller's uncategorized memories. Needs a
            configured model first. */}
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-bg p-4">
          <span className="text-sm font-medium text-text">{t.categorization.reclassify}</span>
          <p className="text-xs text-text-muted">{t.categorization.reclassifyHint}</p>
          <Button
            variant="default"
            icon={RefreshCw}
            className="self-start"
            disabled={!categorization.configured || reclassify.isPending}
            onClick={onReclassify}
          >
            {t.categorization.reclassify}
          </Button>
        </div>
      </section>

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
