'use client';
import { useEffect, useRef, useState } from 'react';
import { BrainCircuit, Plus, Pencil, Trash2, KeyRound, Link2, Unlink, ExternalLink, Check, ListChecks, SlidersHorizontal } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { Segmented } from '../../components/ui/Segmented';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { ManageSelectionModal, type ManageSelectionItem } from '../../components/ui/ManageSelectionModal';
import { SelectionSummary } from '../../components/ui/SelectionSummary';
import { Modal, ModalBody } from '../../components/ui/Modal';
import { BrainLimitsModal, BRAIN_LIMIT_DEFAULTS } from './BrainLimitsModal';
import { LoadingState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useConfig, useBrainOauthStatus } from '../../lib/queries';
import { HelpTip } from '../../components/ui/HelpTip';
import { useUpdateConfig } from '../../lib/mutations';
import { useAutoSave } from '../../lib/useAutoSave';
import { useSaveBrainProviders, useBrainOauthDisconnect } from '../../lib/mutations';
import { elowenClient } from '../../lib/elowenClient';
import type { BrainProvider, BrainProviderType, OAuthFlowState, BrainLimits } from '../../lib/types';

const OAUTH_TYPES: { type: BrainProviderType; icon: string }[] = [
  { type: 'oauth-anthropic', icon: 'claude' },
  { type: 'oauth-openai-codex', icon: 'gpt' },
  { type: 'oauth-github-copilot', icon: 'copilot' },
];
const API_TYPES: BrainProviderType[] = ['openai', 'anthropic'];

type Draft = { id: string; label: string; type: BrainProviderType; baseUrl: string; models: string; apiKey: string; api: '' | 'openai-completions' | 'openai-responses' };
const emptyDraft = (): Draft => ({ id: '', label: '', type: 'openai', baseUrl: '', models: '', apiKey: '', api: '' });
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

/** Connect dialog: shows the provider's auth URL (+ device code), collects the pasted code when the
 *  flow asks for one, and polls the flow until it settles. */
function OAuthConnectDialog({ flow: initial, onDone }: { flow: OAuthFlowState; onDone: (ok: boolean) => void }) {
  const { t } = useTranslation();
  const [flow, setFlow] = useState(initial);
  const [code, setCode] = useState('');
  const done = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => {
      void elowenClient.brainOauthFlow(flow.id).then((f) => {
        setFlow(f);
        if ((f.status === 'success' || f.status === 'error') && !done.current) {
          done.current = true;
          clearInterval(timer);
          onDone(f.status === 'success');
        }
      }).catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [flow.id, onDone]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-border bg-surface p-5">
        <span className="flex items-center gap-2 text-sm font-semibold text-text"><Link2 size={15} aria-hidden />{t.brain.connectTitle}</span>
        {flow.authUrl ? (
          <a href={flow.authUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 break-all rounded-md border border-accent/40 bg-accent/10 p-3 text-xs text-accent hover:bg-accent/20">
            <ExternalLink size={14} className="shrink-0" aria-hidden />{flow.authUrl}
          </a>
        ) : <p className="text-xs text-text-muted">{t.brain.connectStarting}</p>}
        {flow.userCode ? (
          <p className="text-sm text-text">{t.brain.connectUserCode}: <span className="font-mono text-lg font-semibold tracking-widest text-accent">{flow.userCode}</span></p>
        ) : null}
        {flow.instructions ? <p className="text-xs text-text-muted">{flow.instructions}</p> : null}
        {flow.needsInput ? (
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (code.trim()) { void elowenClient.brainOauthInput(flow.id, code.trim()); setCode(''); } }}>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t.brain.connectCodePlaceholder} className="font-mono" />
            <Button type="submit" variant="accent" disabled={!code.trim()}>{t.brain.connectSubmitCode}</Button>
          </form>
        ) : flow.status === 'action-required' ? <p className="text-xs italic text-text-muted">{t.brain.connectWaiting}</p> : null}
        <div className="flex justify-end">
          <Button variant="ghost" onClick={() => onDone(false)}>{t.common.cancel}</Button>
        </div>
      </div>
    </div>
  );
}

/** Model picker for a connected OAuth account: loads the account's built-in catalog and hands it to the
 *  shared manage-selection modal (multi-select, each row carrying the model's brand icon). The selection
 *  is stored as an explicit provider entry's manual `models` list — empty selection = the whole catalog
 *  (today's behavior). This keeps the Models section from drowning in the account's entire catalog. */
function OAuthModelsModal({ type, initial, onSave, onClose }: {
  type: BrainProviderType; initial: string[]; onSave: (models: string[]) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<string[] | null>(null);
  useEffect(() => {
    setCatalog(null);
    void elowenClient.brainOauthCatalog(type).then((r) => setCatalog(r.models)).catch(() => setCatalog([]));
  }, [type]);

  const title = t.brain.pickModelsTitle.replace('{provider}', t.brain.types[type]);
  if (catalog === null) {
    return <Modal title={title} onClose={onClose} size="md"><ModalBody><LoadingState /></ModalBody></Modal>;
  }
  const items: ManageSelectionItem[] = catalog.map((m) => ({ id: m, label: m, group: '', icon: <ModelIcon name={m} size={14} /> }));
  return (
    <ManageSelectionModal
      title={title}
      subtitle={t.brain.pickModelsHint}
      open
      onClose={onClose}
      items={items}
      selected={new Set(initial)}
      onSave={(next) => onSave([...next])}
      emptySelectionHint={t.brain.pickModelsHint}
      countLabel={(n) => t.managePicker.modelsSelected.replace('{n}', String(n))}
    />
  );
}

/** Add/edit dialog for one API-key provider entry (endpoint + key + models). OAuth accounts are NOT
 *  added here — they connect via the account cards above, where their model selection also lives. */
function ProviderModal({ draft: initial, existingIds, onSave, onClose }: {
  draft: Draft; existingIds: string[]; onSave: (d: Draft) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [d, setD] = useState(initial);
  const isNew = !initial.id;
  const id = isNew ? slug(d.label) : d.id;
  const idTaken = isNew && existingIds.includes(id);
  const valid = d.label.trim() && id && !idTaken && (d.type === 'anthropic' || d.baseUrl.trim());

  // Live-probe the endpoint's /models as soon as it looks addressable, so the admin clicks pills
  // instead of typing model ids. Debounced; when editing, the stored key is used server-side (`id`).
  // No answer (bad URL, no /models route) → the manual textarea below stays as the fallback.
  // null = endpoint gave nothing (manual textarea fallback); 'loading' = probe in flight — show a
  // spinner instead of flashing the fallback and swapping it for pills a beat later.
  const [probed, setProbed] = useState<string[] | 'loading' | null>(d.type === 'openai' && initial.baseUrl.trim() ? 'loading' : null);
  useEffect(() => {
    if (d.type !== 'openai' || !d.baseUrl.trim()) { setProbed(null); return; }
    setProbed('loading');
    const timer = setTimeout(() => {
      void elowenClient.brainProviderProbe({ baseUrl: d.baseUrl.trim(), ...(d.apiKey.trim() ? { apiKey: d.apiKey.trim() } : {}), ...(isNew ? {} : { id: d.id }) })
        .then((r) => setProbed(r.models.length > 0 ? r.models : null))
        .catch(() => setProbed(null));
    }, 600);
    return () => clearTimeout(timer);
  }, [d.type, d.baseUrl, d.apiKey, d.id, isNew]);
  const selectedModels = d.models.split('\n').map((m) => m.trim()).filter(Boolean);
  const [modelsOpen, setModelsOpen] = useState(false);
  const probedSelected = Array.isArray(probed) ? selectedModels.filter((m) => probed.includes(m)) : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="flex w-full max-w-lg flex-col gap-4 rounded-lg border border-border bg-surface p-5">
        <span className="text-sm font-semibold text-text">{isNew ? t.brain.addProvider : t.brain.editProvider}</span>
        <Field label={t.brain.providerLabel}>
          <Input value={d.label} onChange={(e) => setD({ ...d, label: e.target.value })} placeholder="CoreSynth Proxy" />
          {isNew && id ? <p className="mt-1 font-mono text-tiny text-text-muted">id: {id}{idTaken ? ` — ${t.brain.idTaken}` : ''}</p> : null}
        </Field>
        <Field label={t.brain.providerType}>
          <Segmented
            aria-label={t.brain.providerType}
            size="sm"
            options={API_TYPES.map((v) => ({ value: v, label: t.brain.types[v] }))}
            value={d.type}
            onChange={(v) => setD({ ...d, type: v as BrainProviderType })}
          />
        </Field>
        <Field label={t.brain.baseUrl} hint={d.type === 'openai' ? t.brain.baseUrlHintOpenai : t.brain.baseUrlHintAnthropic}>
          <Input value={d.baseUrl} onChange={(e) => setD({ ...d, baseUrl: e.target.value })} placeholder={d.type === 'openai' ? 'https://ai.example.com/v1' : 'https://api.anthropic.com'} className="font-mono" />
        </Field>
        <Field label={t.brain.apiKey} hint={isNew ? undefined : t.brain.apiKeyKeepHint}>
          <Input type="password" value={d.apiKey} onChange={(e) => setD({ ...d, apiKey: e.target.value })} placeholder={isNew ? 'sk-…' : '••••••'} autoComplete="off" />
        </Field>
        {d.type === 'openai' ? (
          <Field label={t.brain.wireApi} hint={t.brain.wireApiHint}>
            <Segmented
              aria-label={t.brain.wireApi}
              size="sm"
              options={[
                { value: '', label: t.brain.wireApiAuto },
                { value: 'openai-responses', label: t.brain.wireApiResponses },
                { value: 'openai-completions', label: t.brain.wireApiCompletions },
              ]}
              value={d.api}
              onChange={(v) => setD({ ...d, api: v as Draft['api'] })}
            />
          </Field>
        ) : null}
        <Field label={t.brain.models} hint={Array.isArray(probed) ? t.brain.modelsHintPicker : d.type === 'openai' ? t.brain.modelsHintAuto : t.brain.modelsHint}>
          {probed === 'loading' ? (
            <LoadingState />
          ) : Array.isArray(probed) ? (
            <>
              <SelectionSummary
                countText={probedSelected.length === 0 ? t.brain.modelsAuto : t.managePicker.modelsSelected.replace('{n}', String(probedSelected.length))}
                samples={probedSelected.slice(0, 3).map((m) => ({ label: m, icon: <ModelIcon name={m} size={13} /> }))}
                moreCount={Math.max(0, probedSelected.length - 3)}
                onManage={() => setModelsOpen(true)}
                manageLabel={t.managePicker.manage}
              />
              <ManageSelectionModal
                title={t.brain.models}
                open={modelsOpen}
                onClose={() => setModelsOpen(false)}
                items={probed.map((m) => ({ id: m, label: m, group: '', icon: <ModelIcon name={m} size={14} /> }))}
                selected={new Set(probedSelected)}
                onSave={(next) => setD({ ...d, models: [...next].join('\n') })}
                emptySelectionHint={t.brain.modelsAuto}
                countLabel={(n) => t.managePicker.modelsSelected.replace('{n}', String(n))}
              />
            </>
          ) : (
            <textarea
              value={d.models}
              onChange={(e) => setD({ ...d, models: e.target.value })}
              rows={3}
              className="w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm text-text placeholder:text-text-muted focus:border-accent"
              placeholder={'claude-opus-4-8\nollama/kimi-k2.7-code'}
            />
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button variant="accent" icon={Check} disabled={!valid} onClick={() => onSave({ ...d, id })}>{t.common.save}</Button>
        </div>
      </div>
    </div>
  );
}

/** Settings → Brain: the model providers behind `elowen chat` (custom endpoints + OAuth accounts). */
export function BrainSection() {
  const { data: config } = useConfig();
  const oauth = useBrainOauthStatus();
  const save = useSaveBrainProviders();
  const disconnect = useBrainOauthDisconnect();
  const { toast } = useToast();
  const { t } = useTranslation();
  const [modal, setModal] = useState<Draft | null>(null);
  const [flow, setFlow] = useState<OAuthFlowState | null>(null);
  const [modelsFor, setModelsFor] = useState<BrainProviderType | null>(null);
  const [limitsOpen, setLimitsOpen] = useState(false);

  // The assistant's display identity ("Elowen" by default) — feeds the persona everywhere it speaks.
  const updateConfig = useUpdateConfig();
  const [agentName, setAgentName] = useState('');
  const [nameSeeded, setNameSeeded] = useState(false);
  useEffect(() => {
    if (config && !nameSeeded) { setAgentName(config.brain?.agentName ?? 'Elowen'); setNameSeeded(true); }
  }, [config, nameSeeded]);
  useAutoSave([agentName], () => {
    if (agentName.trim()) updateConfig.mutate({ brain: { agentName: agentName.trim() } }, { onError: () => toast(t.brain.saveError, 'error') });
  }, { ready: nameSeeded });

  // Max agent steps per run (the turn is aborted past this) — a validated 1..200 integer.
  const [maxSteps, setMaxSteps] = useState('');
  const [stepsSeeded, setStepsSeeded] = useState(false);
  useEffect(() => {
    if (config && !stepsSeeded) { setMaxSteps(String(config.brain?.maxSteps ?? 20)); setStepsSeeded(true); }
  }, [config, stepsSeeded]);
  useAutoSave([maxSteps], () => {
    const n = Number(maxSteps);
    if (Number.isFinite(n) && n >= 1) updateConfig.mutate({ brain: { maxSteps: Math.min(200, Math.max(1, Math.floor(n))) } }, { onError: () => toast(t.brain.saveError, 'error') });
  }, { ready: stepsSeeded });

  // Operator-tunable brain limits (one draft record, autosaved whole). The daemon re-clamps every field,
  // so an out-of-range keystroke is corrected server-side; the inputs carry the same bounds for the UI.
  const [limits, setLimits] = useState<BrainLimits | null>(null);
  const [limitsSeeded, setLimitsSeeded] = useState(false);
  useEffect(() => {
    if (config && !limitsSeeded) { setLimits(config.brain?.limits ?? BRAIN_LIMIT_DEFAULTS); setLimitsSeeded(true); }
  }, [config, limitsSeeded]);
  useAutoSave([limits], () => {
    if (limits) updateConfig.mutate({ brain: { limits } }, { onError: () => toast(t.brain.saveError, 'error') });
  }, { ready: limitsSeeded && !!limits });

  if (!config) return <LoadingState />;
  const providers = config.brain?.providers ?? [];
  // OAuth entries exist in config only as carriers of the account's model selection — the account
  // cards above manage them, so the add/edit grid below shows API-key providers only.
  const apiProviders = providers.filter((p) => !p.type.startsWith('oauth-'));

  // A connected account's model selection lives on its explicit provider entry (id = the builtin
  // provider name, so `elowen:<id>/<model>` execs stay stable whether the entry is synthetic or saved).
  const OAUTH_ENTRY_ID: Record<string, string> = { 'oauth-anthropic': 'anthropic', 'oauth-openai-codex': 'openai-codex', 'oauth-github-copilot': 'github-copilot' };
  const oauthEntryOf = (type: BrainProviderType) => providers.find((p) => p.type === type);

  const persist = (next: (Omit<BrainProvider, 'apiKeySet'> & { apiKey?: string })[]) =>
    save.mutate(next, {
      onSuccess: () => toast(t.brain.saved),
      onError: () => toast(t.brain.saveError, 'error'),
    });

  const upsert = (d: Draft) => {
    const entry = {
      id: d.id, label: d.label.trim(), type: d.type, baseUrl: d.baseUrl.trim(),
      models: d.models.split('\n').map((m) => m.trim()).filter(Boolean),
      ...(d.type === 'openai' && d.api ? { api: d.api } : {}),
      ...(d.apiKey.trim() ? { apiKey: d.apiKey.trim() } : {}),
    };
    const keyless = providers.map(({ apiKeySet, ...p }) => p);
    persist(keyless.some((p) => p.id === entry.id) ? keyless.map((p) => (p.id === entry.id ? entry : p)) : [...keyless, entry]);
    setModal(null);
  };

  const remove = (id: string) => persist(providers.filter((p) => p.id !== id).map(({ apiKeySet, ...p }) => p));

  const startConnect = (type: string) =>
    void elowenClient.brainOauthStart(type)
      .then((f) => setFlow(f))
      .catch(() => toast(t.brain.connectError, 'error'));

  return (
    <div className="flex flex-col gap-6">
      {/* Identity + step ceiling on one row: the assistant's name (everywhere it speaks) and the max
          agent steps per run (Discord shows "Step N / MAX"). */}
      <div className="flex max-w-md flex-wrap items-end gap-3">
        <div className="flex min-w-[12rem] max-w-xs flex-1 flex-col gap-2">
          <span className="text-sm font-medium text-text">{t.brain.agentName}</span>
          <Input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="Elowen" aria-label={t.brain.agentName} />
        </div>
        <div className="flex w-32 flex-col gap-2">
          <span className="flex items-center gap-1 whitespace-nowrap text-sm font-medium text-text">{t.brain.maxSteps}<HelpTip>{t.brain.maxStepsHint}</HelpTip></span>
          <Input type="number" min={1} max={200} value={maxSteps} onChange={(e) => setMaxSteps(e.target.value)} aria-label={t.brain.maxSteps} />
        </div>
      </div>

      {/* Limits: the brain's tunable ceilings — output size, waits, recall, goal autonomy, channel cap.
          The 8-field grid lives in a modal so it doesn't crowd the section; edits still autosave live. */}
      {limits && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-text">{t.brain.limits.title}</span>
            <span className="text-tiny text-text-muted">{t.brain.limits.hint}</span>
          </div>
          <div>
            <Button variant="default" icon={SlidersHorizontal} onClick={() => setLimitsOpen(true)}>{t.brain.limits.manage}</Button>
          </div>
          {limitsOpen ? (
            <BrainLimitsModal
              limits={limits}
              onChange={(fn) => setLimits((cur) => (cur ? fn(cur) : cur))}
              onClose={() => setLimitsOpen(false)}
            />
          ) : null}
        </div>
      )}

      {/* OAuth accounts: one row per supported account type, connect/disconnect. */}
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-text">{t.brain.accounts}</span>
        <div className="@container">
        <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-3">
          {OAUTH_TYPES.map(({ type, icon }) => {
            const connected = oauth.data?.[type] ?? false;
            return (
              <div key={type} className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border p-3 ${connected ? 'border-accent/40 bg-accent/5' : 'border-border bg-surface'}`}>
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-elevated">
                  <ModelIcon name={icon} size={22} />
                </span>
                <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                  <span className="w-full truncate text-sm font-medium text-text">{t.brain.types[type]}</span>
                  {connected ? <Badge tone="accent">{t.brain.connected}</Badge> : <span className="text-tiny text-text-muted">{t.brain.notConnected}</span>}
                </div>
                {connected ? (
                  <span className="flex shrink-0 flex-wrap justify-end gap-1">
                    <Button variant="ghost" icon={ListChecks} aria-label={`${t.brain.pickModels}: ${t.brain.types[type]}`} onClick={() => setModelsFor(type)}>{t.brain.pickModels}</Button>
                    <Button variant="ghost" icon={Unlink} aria-label={`${t.brain.disconnect}: ${t.brain.types[type]}`} onClick={() => disconnect.mutate(type, { onSuccess: () => toast(t.brain.disconnected) })} />
                  </span>
                ) : (
                  <Button variant="accent" icon={Link2} onClick={() => startConnect(type)}>{t.brain.connect}</Button>
                )}
              </div>
            );
          })}
        </div>
        </div>
      </div>

      {/* Provider entries the picker exposes. */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium text-text">{t.brain.providers}</span>
          <button
            type="button"
            onClick={() => setModal(emptyDraft())}
            aria-label={t.brain.addProvider}
            title={t.brain.addProvider}
            className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-accent"
          >
            <Plus size={15} aria-hidden />
          </button>
        </div>
        {apiProviders.length === 0 ? (
          <p className="text-xs italic text-text-muted">{t.brain.noProviders}</p>
        ) : (
          <div className="@container">
          <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2">
            {apiProviders.map((p) => (
              <div key={p.id} className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <BrainCircuit size={16} className="shrink-0 text-accent" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text">{p.label}</span>
                  <Badge>{t.brain.types[p.type]}</Badge>
                  {p.apiKeySet ? <Badge tone="accent"><KeyRound size={10} className="mr-1" aria-hidden />{t.brain.keySet}</Badge> : null}
                  <span className="ml-auto flex shrink-0 gap-1">
                    <Button variant="ghost" icon={Pencil} aria-label={`${t.brain.editProvider}: ${p.label}`} onClick={() => setModal({ id: p.id, label: p.label, type: p.type, baseUrl: p.baseUrl, models: p.models.join('\n'), apiKey: '', api: p.api ?? '' })} />
                    <Button variant="ghost" icon={Trash2} aria-label={`${t.brain.removeProvider}: ${p.label}`} onClick={() => remove(p.id)} />
                  </span>
                </div>
                {p.baseUrl ? <span className="truncate font-mono text-tiny text-text-muted">{p.baseUrl}</span> : null}
                <span className="text-tiny text-text-muted">{p.models.length > 0 ? t.brain.modelCount.replace('{n}', String(p.models.length)) : t.brain.modelsAuto}</span>
              </div>
            ))}
          </div>
          </div>
        )}
      </div>

      {modal ? <ProviderModal draft={modal} existingIds={providers.map((p) => p.id)} onSave={upsert} onClose={() => setModal(null)} /> : null}
      {modelsFor ? (
        <OAuthModelsModal
          type={modelsFor}
          initial={oauthEntryOf(modelsFor)?.models ?? []}
          onClose={() => setModelsFor(null)}
          onSave={(models) => {
            // Upsert the explicit entry carrying the selection; keep an existing entry's identity.
            const existing = oauthEntryOf(modelsFor);
            const entry = existing
              ? { ...(({ apiKeySet, ...rest }) => rest)(existing), models }
              : { id: OAUTH_ENTRY_ID[modelsFor], label: t.brain.types[modelsFor], type: modelsFor, baseUrl: '', models };
            const keyless = providers.map(({ apiKeySet, ...p }) => p);
            persist(keyless.some((p) => p.id === entry.id) ? keyless.map((p) => (p.id === entry.id ? entry : p)) : [...keyless, entry]);
            setModelsFor(null);
          }}
        />
      ) : null}
      {flow ? (
        <OAuthConnectDialog
          flow={flow}
          onDone={(ok) => {
            setFlow(null);
            void oauth.refetch();
            toast(ok ? t.brain.connectedToast : t.brain.connectFailed, ok ? undefined : 'error');
          }}
        />
      ) : null}
    </div>
  );
}
