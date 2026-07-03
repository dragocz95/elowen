'use client';
import { useEffect, useMemo, useState } from 'react';
import { Check, FlaskConical, RefreshCw } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { Segmented } from '../../components/ui/Segmented';
import { ModelPillsPicker } from '../../components/ui/ModelPillsPicker';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { LoadingState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useConfig, useEmbeddingSettings, useBrainModels } from '../../lib/queries';
import { useSaveEmbeddingSettings, useReindexMemories } from '../../lib/mutations';
import { orcaClient, OrcaApiError } from '../../lib/orcaClient';

/** Settings → Memory embedding: the workspace-level provider that turns memories into vectors for
 *  semantic recall. Admin-only (the Settings config group is already admin-gated). The API key is not
 *  entered here — it's inherited from the referenced brain provider (Settings → Brain). */
export function EmbeddingSection() {
  const { t } = useTranslation();
  const { data: config } = useConfig();
  const { data: settings } = useEmbeddingSettings();
  const { data: brainModels } = useBrainModels();
  const save = useSaveEmbeddingSettings();
  const reindex = useReindexMemories();
  const { toast } = useToast();

  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [dimensions, setDimensions] = useState('');
  const [seeded, setSeeded] = useState(false);
  const [testing, setTesting] = useState(false);
  const [reindexOpen, setReindexOpen] = useState(false);

  // Seed the form once from the persisted settings; edits stay local until Save.
  useEffect(() => {
    if (settings && !seeded) {
      setProviderId(settings.providerId);
      setModel(settings.model);
      setBaseUrl(settings.baseUrl);
      setDimensions(settings.dimensions != null ? String(settings.dimensions) : '');
      setSeeded(true);
    }
  }, [settings, seeded]);

  // Model catalog scoped to the chosen provider (or all providers when none is picked). Deduped so a
  // model offered by several providers shows once. Embedding model ids often aren't in the brain
  // catalog — the custom Input below covers those.
  const catalog = useMemo(() => {
    const opts = (brainModels ?? []).filter((m) => !providerId || m.provider === providerId);
    return Array.from(new Set(opts.map((m) => m.model)));
  }, [brainModels, providerId]);

  if (!config || !settings) return <LoadingState />;

  const providers = config.brain?.providers ?? [];
  // Pick over the configured brain providers; surface a stale saved id as its own option so it stays
  // selectable even if that provider was later removed.
  const providerOptions = providers.map((p) => ({ value: p.id, label: p.label }));
  if (providerId && !providers.some((p) => p.id === providerId)) providerOptions.unshift({ value: providerId, label: providerId });

  const onSave = () => {
    const dim = dimensions.trim();
    save.mutate(
      { providerId: providerId.trim(), model: model.trim(), baseUrl: baseUrl.trim(), dimensions: dim ? Number(dim) : null },
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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-text">{t.memory.embeddingHeading}</span>
        {settings.configured
          ? <Badge tone="accent">{t.memory.embeddingConfigured}</Badge>
          : <Badge>{t.memory.embeddingUnconfigured}</Badge>}
      </div>
      <p className="text-xs text-text-muted">{t.memory.embeddingIntro}</p>

      <div className="flex max-w-xl flex-col gap-5">
        <Field label={t.memory.embeddingProvider} hint={t.memory.embeddingProviderHint}>
          {providerOptions.length > 0 ? (
            <Segmented
              aria-label={t.memory.embeddingProvider}
              options={providerOptions}
              value={providerId}
              onChange={setProviderId}
            />
          ) : (
            <p className="text-xs italic text-text-muted">{t.memory.embeddingProviderPlaceholder}</p>
          )}
        </Field>

        <Field label={t.memory.embeddingModel}>
          <ModelPillsPicker mode="single" catalog={catalog} value={model || null} onChange={(v) => setModel(v ?? '')} />
        </Field>

        <Field label={t.memory.embeddingModelCustom} hint={t.memory.embeddingModelCustomHint}>
          <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={t.memory.embeddingModelPlaceholder} className="font-mono" />
        </Field>

        <Field label={t.memory.embeddingBaseUrl} hint={t.memory.embeddingBaseUrlHint}>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" className="font-mono" />
        </Field>

        <Field label={t.memory.embeddingDimensions} hint={t.memory.embeddingDimensionsHint}>
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
          <Button variant="accent" icon={Check} disabled={save.isPending} onClick={onSave}>{t.memory.embeddingSave}</Button>
          <Button variant="default" icon={FlaskConical} disabled={testing} onClick={onTest}>{testing ? t.memory.embeddingTesting : t.memory.embeddingTest}</Button>
        </div>
      </div>

      {/* Reindex: re-embeds memories still missing a vector. Needs a configured provider first. */}
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
        <span className="text-sm font-medium text-text">{t.memory.reindex}</span>
        <p className="text-xs text-text-muted">{t.memory.reindexConfirmBody}</p>
        {settings.configured ? null : <p className="text-xs italic text-text-muted">{t.memory.reindexUnconfigured}</p>}
        <Button
          variant="default"
          icon={RefreshCw}
          className="self-start"
          disabled={!settings.configured || reindex.isPending}
          onClick={() => setReindexOpen(true)}
        >
          {t.memory.reindex}
        </Button>
      </div>

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
