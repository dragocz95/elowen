'use client';
import { useEffect, useMemo, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { Segmented } from '../../components/ui/Segmented';
import { ModelPillsPicker } from '../../components/ui/ModelPillsPicker';
import { LoadingState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useConfig, useCategorizationSettings, useBrainModels } from '../../lib/queries';
import { useSaveCategorizationSettings, useReclassifyMemories } from '../../lib/mutations';

/** Settings → Memory categories: the workspace-level Orca AI model that classifies memories into
 *  categories. Admin-only (the Settings config group is already admin-gated). The API key is inherited
 *  from the referenced brain provider (Settings → Orca AI). */
export function CategorizationSection() {
  const { t } = useTranslation();
  const { data: config } = useConfig();
  const { data: settings } = useCategorizationSettings();
  const { data: brainModels } = useBrainModels();
  const save = useSaveCategorizationSettings();
  const reclassify = useReclassifyMemories();
  const { toast } = useToast();

  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [seeded, setSeeded] = useState(false);

  // Seed the form once from the persisted settings; edits stay local until Save.
  useEffect(() => {
    if (settings && !seeded) {
      setProviderId(settings.providerId);
      setModel(settings.model || null);
      setBaseUrl(settings.baseUrl);
      setSeeded(true);
    }
  }, [settings, seeded]);

  // Model catalog scoped to the chosen provider (or all providers when none is picked). Deduped so a
  // model offered by several providers shows once.
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
    save.mutate(
      { providerId: providerId.trim(), model: (model ?? '').trim(), baseUrl: baseUrl.trim() },
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
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-text">{t.categorization.title}</span>
        {settings.configured
          ? <Badge tone="accent">{t.categorization.configured}</Badge>
          : <Badge>{t.categorization.notConfigured}</Badge>}
      </div>
      <p className="text-xs text-text-muted">{t.categorization.intro}</p>

      <div className="flex max-w-xl flex-col gap-5">
        <Field label={t.categorization.providerLabel}>
          {providerOptions.length > 0 ? (
            <Segmented
              aria-label={t.categorization.providerLabel}
              options={providerOptions}
              value={providerId}
              onChange={setProviderId}
            />
          ) : (
            <p className="text-xs italic text-text-muted">{t.memory.embeddingProviderPlaceholder}</p>
          )}
        </Field>

        <Field label={t.categorization.modelLabel}>
          <ModelPillsPicker mode="single" catalog={catalog} value={model} onChange={setModel} />
        </Field>

        <Field label={t.categorization.baseUrlLabel} hint={t.categorization.baseUrlHint}>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" className="font-mono" />
        </Field>

        <div>
          <Button variant="accent" icon={Check} disabled={save.isPending} onClick={onSave}>{t.categorization.save}</Button>
        </div>
      </div>

      {/* Reclassify: runs the categorization model over the caller's uncategorized memories. Needs a
          configured model first. */}
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
        <span className="text-sm font-medium text-text">{t.categorization.reclassify}</span>
        <p className="text-xs text-text-muted">{t.categorization.reclassifyHint}</p>
        <Button
          variant="default"
          icon={RefreshCw}
          className="self-start"
          disabled={!settings.configured || reclassify.isPending}
          onClick={onReclassify}
        >
          {t.categorization.reclassify}
        </Button>
      </div>
    </div>
  );
}
