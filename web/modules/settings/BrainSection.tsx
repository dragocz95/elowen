'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { BrainCircuit, Plus, Pencil, Trash2, KeyRound, Link2, Unlink, ExternalLink, Check, ListChecks, SlidersHorizontal, Gauge, EyeOff, ShieldCheck, Boxes } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Slider } from '../../components/ui/Slider';
import { Field } from '../../components/ui/Field';
import { Segmented } from '../../components/ui/Segmented';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { ManageSelectionModal, type ManageSelectionItem } from '../../components/ui/ManageSelectionModal';
import { ActionMenu } from '../../components/ui/ActionMenu';
import { SelectionSummary } from '../../components/ui/SelectionSummary';
import { Modal, ModalBody } from '../../components/ui/Modal';
import { BrainLimitsModal, BRAIN_LIMIT_DEFAULTS } from './BrainLimitsModal';
import { RuntimeLimitsModal, RUNTIME_LIMIT_DEFAULTS } from './RuntimeLimitsModal';
import { ToolDeferralModal } from './ToolDeferralModal';
import { MemoryRetentionModal, DEFAULT_MEMORY_RETENTION } from './MemoryRetentionModal';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { LoadingState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useConfig, useBrainOauthStatus, useBrainRateLimitsAll } from '../../lib/queries';
import { OAuthUsageRail } from './OAuthUsageRail';
import { useUpdateConfig } from '../../lib/mutations';
import { useAutoSaveStatus, type SaveStatus } from '../../lib/useAutoSaveStatus';
import { useSaveBrainProviders, useBrainOauthDisconnect } from '../../lib/mutations';
import { elowenClient } from '../../lib/elowenClient';
import type { BrainProvider, BrainProviderType, OAuthFlowState, BrainLimits, RuntimeConfig, RuntimeLimits, MemoryRetentionConfig } from '../../lib/types';
import { SettingsGroup, SettingsRow, SettingsState } from './SettingsSurface';

// UI-only icon slug per OAuth type. The daemon exposes the SUPPORTED type set (the keys of
// /brain/oauth/status), never icons — so the enumeration is derived from that runtime data (a newly
// added daemon provider is not silently dropped), while the icon stays a client-side map. Unknown or
// newly-added types fall back to ModelIcon's generic glyph via their raw type string.
const OAUTH_ICON: Record<string, string> = {
  'oauth-anthropic': 'claude',
  'oauth-openai-codex': 'gpt',
  'oauth-github-copilot': 'copilot',
  'oauth-kimi': 'kimi',
};
const API_TYPES: BrainProviderType[] = ['openai', 'anthropic'];

type HostedSearchStatus = 'supported' | 'unsupported' | 'unverified';
type HostedSearchStatusMap = Record<string, Record<string, HostedSearchStatus>>;
type HostedSearchStatusResponse = Awaited<ReturnType<typeof elowenClient.brainHostedToolSearchStatus>>;

const toHostedSearchStatusMap = (response: HostedSearchStatusResponse): HostedSearchStatusMap => Object.fromEntries(
  response.providers.map((provider) => [
    provider.providerId,
    Object.fromEntries(provider.models.map((model) => [model.modelId, model.status])),
  ]),
);

function isAzureResponsesProvider(provider: BrainProvider): boolean {
  if (provider.type !== 'openai' || provider.api !== 'openai-responses') return false;
  try {
    const url = new URL(provider.baseUrl);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    return url.protocol === 'https:'
      && url.hostname !== 'openai.azure.com'
      && url.hostname.endsWith('.openai.azure.com')
      && path === '/openai/v1';
  } catch {
    return false;
  }
}

/** The importance levels the retention block carries a half-life for (mirrors the daemon's clamp keys). */
const RETENTION_IMPORTANCE_KEYS = [1, 2, 3, 4, 5] as const;

// `temperature` is a string because the field is free text: '' means "send none", which is a distinct,
// meaningful state rather than a missing value, and 0 is a legitimate setting.
type Draft = { id: string; label: string; type: BrainProviderType; baseUrl: string; models: string; apiKey: string; api: '' | 'openai-completions' | 'openai-responses'; temperature: string };
const emptyDraft = (): Draft => ({ id: '', label: '', type: 'openai', baseUrl: '', models: '', apiKey: '', api: '', temperature: '' });
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

/** How a connect dialog ended. Cancelling is a deliberate user action, not a failure, so it stays
 *  distinct from the flow reporting an error — otherwise closing the dialog raises an error toast. */
type OAuthConnectResult = 'success' | 'error' | 'cancelled';

/** Connect dialog: shows the provider's auth URL (+ device code), collects the pasted code when the
 *  flow asks for one, and polls the flow until it settles. */
function OAuthConnectDialog({ flow: initial, onDone }: { flow: OAuthFlowState; onDone: (result: OAuthConnectResult) => void }) {
  const { t } = useTranslation();
  const [flow, setFlow] = useState(initial);
  const [code, setCode] = useState('');
  const titleId = useId();
  // The dialog owns the poll; `onDone` is only how it reports the outcome. Reading it through a ref keeps
  // it out of the effect's dependencies, because the parent re-renders on its own (a 20s rate-limit
  // refetch) and a fresh inline callback would otherwise retire the poll — dropping the answer in flight
  // and restarting the interval every time.
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    // A poll already in flight resolves after the dialog is torn down. Clearing the timer does not
    // reach it, so that late answer used to settle a flow the user had already cancelled — reporting
    // the account as connected. The generation flag drops any answer from a retired effect run.
    // The next poll is scheduled only once the previous one answered: on a fixed interval a slow poll
    // is still in flight when the next fires, and its late answer would push the dialog back to a
    // state the flow has already left.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () => {
      void elowenClient.brainOauthFlow(flow.id).then((f) => {
        if (cancelled) return;
        setFlow(f);
        if (f.status === 'success' || f.status === 'error') {
          cancelled = true;
          doneRef.current(f.status);
          return;
        }
        timer = setTimeout(poll, 1500);
      }).catch(() => { if (!cancelled) timer = setTimeout(poll, 1500); });
    };
    timer = setTimeout(poll, 1500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [flow.id]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-border bg-surface p-5">
        <span id={titleId} className="flex items-center gap-2 text-sm font-semibold text-text"><Link2 size={15} aria-hidden />{t.brain.connectTitle}</span>
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
          <Button variant="ghost" onClick={() => onDone('cancelled')}>{t.common.cancel}</Button>
        </div>
      </div>
    </div>
  );
}

/** Picker rows = the live model list PLUS any still-selected model that has dropped out of it (a provider
 *  that removed a model from its catalog / API). Without the second group a stale selection can never be
 *  un-checked here — it stays active and keeps showing in the Models section with no way to turn it off. The
 *  orphans go under an "unavailable" header so the user sees why they're there and that un-checking clears them. */
export function modelPickerItems(available: string[], selected: string[], unavailableLabel: string): ManageSelectionItem[] {
  const orphans = selected.filter((m) => !available.includes(m));
  return [
    ...available.map((m) => ({ id: m, label: m, group: '', icon: <ModelIcon name={m} size={14} /> })),
    ...orphans.map((m) => ({ id: m, label: m, group: 'unavailable', groupLabel: unavailableLabel, icon: <ModelIcon name={m} size={14} /> })),
  ];
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
  const items = modelPickerItems(catalog, initial, t.brain.modelsUnavailable);
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
  const titleId = useId();
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
    // Clearing the debounce timer does not reach a probe that already left: a slow answer for the
    // previous endpoint can land after the current one and show a catalog belonging to a URL the
    // operator has since edited away. The generation flag drops any answer from a retired effect run.
    let cancelled = false;
    const timer = setTimeout(() => {
      void elowenClient.brainProviderProbe({ baseUrl: d.baseUrl.trim(), ...(d.apiKey.trim() ? { apiKey: d.apiKey.trim() } : {}), ...(isNew ? {} : { id: d.id }) })
        .then((r) => { if (!cancelled) setProbed(r.models.length > 0 ? r.models : null); })
        .catch(() => { if (!cancelled) setProbed(null); });
    }, 600);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [d.type, d.baseUrl, d.apiKey, d.id, isNew]);
  const selectedModels = d.models.split('\n').map((m) => m.trim()).filter(Boolean);
  const [modelsOpen, setModelsOpen] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="flex w-full max-w-lg flex-col gap-4 rounded-lg border border-border bg-surface p-5">
        <span id={titleId} className="text-sm font-semibold text-text">{isNew ? t.brain.addProvider : t.brain.editProvider}</span>
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
        <Field label={t.brain.temperature} hint={t.brain.temperatureHint}>
          <Input
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={d.temperature}
            onChange={(e) => setD({ ...d, temperature: e.target.value })}
            placeholder={t.brain.temperaturePlaceholder}
          />
        </Field>
        <Field label={t.brain.models} hint={Array.isArray(probed) ? t.brain.modelsHintPicker : d.type === 'openai' ? t.brain.modelsHintAuto : t.brain.modelsHint}>
          {probed === 'loading' ? (
            <LoadingState />
          ) : Array.isArray(probed) ? (
            <>
              <SelectionSummary
                countText={selectedModels.length === 0 ? t.brain.modelsAuto : t.managePicker.modelsSelected.replace('{n}', String(selectedModels.length))}
                samples={selectedModels.slice(0, 3).map((m) => ({ label: m, icon: <ModelIcon name={m} size={13} /> }))}
                moreCount={Math.max(0, selectedModels.length - 3)}
                onManage={() => setModelsOpen(true)}
                manageLabel={t.managePicker.manage}
              />
              <ManageSelectionModal
                title={t.brain.models}
                open={modelsOpen}
                onClose={() => setModelsOpen(false)}
                items={modelPickerItems(probed, selectedModels, t.brain.modelsUnavailable)}
                selected={new Set(selectedModels)}
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
export function BrainSection({ onSaveState }: { onSaveState?: (section: string, status: SaveStatus, retry?: () => void) => void }) {
  const { data: config } = useConfig();
  const oauth = useBrainOauthStatus();
  const rateLimits = useBrainRateLimitsAll();
  const save = useSaveBrainProviders();
  const disconnect = useBrainOauthDisconnect();
  const { toast } = useToast();
  const { t } = useTranslation();
  const [modal, setModal] = useState<Draft | null>(null);
  const [flow, setFlow] = useState<OAuthFlowState | null>(null);
  const [modelsFor, setModelsFor] = useState<BrainProviderType | null>(null);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [toolLoadingOpen, setToolLoadingOpen] = useState(false);
  const [retentionOpen, setRetentionOpen] = useState(false);
  const [disconnectTarget, setDisconnectTarget] = useState<BrainProviderType | null>(null);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [hostedSearchStatus, setHostedSearchStatus] = useState<HostedSearchStatusMap>({});
  const [verifyingProvider, setVerifyingProvider] = useState<string | null>(null);
  const hostedStatusGeneration = useRef(0);

  const refreshHostedSearchStatus = async () => {
    const generation = ++hostedStatusGeneration.current;
    const response = await elowenClient.brainHostedToolSearchStatus();
    if (hostedStatusGeneration.current === generation) setHostedSearchStatus(toHostedSearchStatusMap(response));
  };
  useEffect(() => {
    let cancelled = false;
    const generation = ++hostedStatusGeneration.current;
    void elowenClient.brainHostedToolSearchStatus().then((response) => {
      if (!cancelled && hostedStatusGeneration.current === generation) setHostedSearchStatus(toHostedSearchStatusMap(response));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [config?.brain?.providers]);

  // The assistant's display identity ("Elowen" by default) — feeds the persona everywhere it speaks.
  const updateConfig = useUpdateConfig();
  const [agentName, setAgentName] = useState('');
  const [nameSeeded, setNameSeeded] = useState(false);
  useEffect(() => {
    if (config && !nameSeeded) { setAgentName(config.brain?.agentName ?? 'Elowen'); setNameSeeded(true); }
  }, [config, nameSeeded]);
  const { status: nameStatus, retry: retryName } = useAutoSaveStatus([agentName], async () => {
    try { await updateConfig.mutateAsync({ brain: { agentName: agentName.trim() } }); }
    catch (error) { toast(t.brain.saveError, 'error'); throw error; }
  }, { ready: nameSeeded && !!agentName.trim() });

  // Max agent steps per run (the turn is aborted past this) — a validated 1..1000 integer. The slider
  // moves in coarse 100-steps; the daemon still accepts any 1..1000 value (API, older configs).
  const [maxSteps, setMaxSteps] = useState('');
  const [stepsSeeded, setStepsSeeded] = useState(false);
  useEffect(() => {
    if (config && !stepsSeeded) { setMaxSteps(String(config.brain?.maxSteps ?? 200)); setStepsSeeded(true); }
  }, [config, stepsSeeded]);
  const parsedSteps = Number(maxSteps);
  const { status: stepsStatus, retry: retrySteps } = useAutoSaveStatus([maxSteps], async () => {
    const n = Number(maxSteps);
    try { await updateConfig.mutateAsync({ brain: { maxSteps: Math.min(1000, Math.max(1, Math.floor(n))) } }); }
    catch (error) { toast(t.brain.saveError, 'error'); throw error; }
  }, { ready: stepsSeeded && Number.isFinite(parsedSteps) && parsedSteps >= 1 });

  // Operator-tunable brain limits (one draft record, autosaved whole). The daemon re-clamps every field,
  // so an out-of-range keystroke is corrected server-side; the inputs carry the same bounds for the UI.
  const [limits, setLimits] = useState<BrainLimits | null>(null);
  const [limitsSeeded, setLimitsSeeded] = useState(false);
  // Fields the daemon sent back lowered, i.e. clamped. The save response IS the effective config, so a
  // clamp is compared against exactly what was sent; the editor then says so per row instead of leaving
  // the operator believing a refused value took effect. A field that saves unchanged drops out again.
  const [appliedLimits, setAppliedLimits] = useState<Partial<BrainLimits>>({});
  useEffect(() => {
    if (config && !limitsSeeded) { setLimits(config.brain?.limits ?? BRAIN_LIMIT_DEFAULTS); setLimitsSeeded(true); }
  }, [config, limitsSeeded]);
  const { status: limitsStatus, retry: retryLimits } = useAutoSaveStatus([limits], async () => {
    if (!limits) return;
    try {
      const saved = await updateConfig.mutateAsync({ brain: { limits } });
      const effective = saved.brain?.limits;
      const clamped: Partial<BrainLimits> = {};
      for (const key of Object.keys(limits) as (keyof BrainLimits)[]) {
        const value = effective?.[key];
        if (value !== undefined && value !== limits[key]) clamped[key] = value;
      }
      setAppliedLimits(clamped);
    }
    catch (error) { toast(t.brain.saveError, 'error'); throw error; }
  }, { ready: limitsSeeded && !!limits });

  // The runtime knobs (the sibling group of the limits above) follow the same draft → autosave → report
  // what the daemon actually applied cycle; only the numeric half can be clamped, so only it is compared.
  const [runtime, setRuntime] = useState<RuntimeConfig | null>(null);
  const [runtimeSeeded, setRuntimeSeeded] = useState(false);
  const [appliedRuntime, setAppliedRuntime] = useState<Partial<RuntimeLimits>>({});
  const [appliedRetention, setAppliedRetention] = useState<Partial<MemoryRetentionConfig>>({});
  useEffect(() => {
    if (config && !runtimeSeeded) {
      setRuntime({
        limits: config.runtime?.limits ?? RUNTIME_LIMIT_DEFAULTS,
        toolDeferralEnabled: config.runtime?.toolDeferralEnabled ?? true,
        toolDeferralOverrides: config.runtime?.toolDeferralOverrides ?? { sources: {}, tools: {} },
        hostedToolSearch: config.runtime?.hostedToolSearch ?? {},
        // A daemon predating the feature serves the runtime block without the retention group — seed the
        // defaults so the editor always has the full block to edit (mirrors `brain.limits ?? defaults`).
        memoryRetention: config.runtime?.memoryRetention ?? DEFAULT_MEMORY_RETENTION,
        // Same reasoning for the sub-agent runner: an older daemon omits both fields, and its behaviour
        // IS the off/auto pair, so seeding them keeps the editor honest about what that daemon is doing.
        subagentRunnerEnabled: config.runtime?.subagentRunnerEnabled ?? false,
        subagentRunnerPoolMax: config.runtime?.subagentRunnerPoolMax ?? null,
        // Same again: a daemon predating provider-side compaction omits the field, and its behaviour is
        // the off state, so seeding `false` describes it correctly.
        remoteCompactionEnabled: config.runtime?.remoteCompactionEnabled ?? false,
      });
      setRuntimeSeeded(true);
    }
  }, [config, runtimeSeeded]);
  const { status: runtimeStatus, retry: retryRuntime } = useAutoSaveStatus([runtime], async () => {
    if (!runtime) return;
    try {
      // Tool loading owns its own explicit save. Omitting only those fields prevents this debounced editor
      // from replaying a stale tool-loading draft while preserving the runtime and retention controls it owns.
      const { toolDeferralEnabled: _toolDeferralEnabled, toolDeferralOverrides: _toolDeferralOverrides, hostedToolSearch: _hostedToolSearch, ...runtimePatch } = runtime;
      const { toolDeferThreshold: _toolDeferThreshold, ...limits } = runtimePatch.limits;
      const saved = await updateConfig.mutateAsync({ runtime: { ...runtimePatch, limits } });
      const effective = saved.runtime?.limits;
      const clamped: Partial<RuntimeLimits> = {};
      for (const key of Object.keys(runtime.limits) as (keyof RuntimeLimits)[]) {
        const value = effective?.[key];
        if (value !== undefined && value !== runtime.limits[key]) clamped[key] = value;
      }
      setAppliedRuntime(clamped);
      // The retention group clamps the same way (the daemon's RETENTION_BOUNDS) — report what actually
      // took effect per field, including each half-life level.
      const effectiveRetention = saved.runtime?.memoryRetention;
      const sentRetention = runtime.memoryRetention;
      const clampedRetention: Partial<MemoryRetentionConfig> = {};
      if (effectiveRetention && sentRetention) {
        if (effectiveRetention.enabled !== sentRetention.enabled) clampedRetention.enabled = effectiveRetention.enabled;
        if (effectiveRetention.graceDays !== sentRetention.graceDays) clampedRetention.graceDays = effectiveRetention.graceDays;
        if (effectiveRetention.vitalityFloor !== sentRetention.vitalityFloor) clampedRetention.vitalityFloor = effectiveRetention.vitalityFloor;
        const clampedHalfLives: Record<number, number> = {};
        for (const level of RETENTION_IMPORTANCE_KEYS) {
          const got = effectiveRetention.halfLifeByImportance[level];
          if (got !== undefined && got !== sentRetention.halfLifeByImportance[level]) clampedHalfLives[level] = got;
        }
        if (Object.keys(clampedHalfLives).length > 0) clampedRetention.halfLifeByImportance = clampedHalfLives;
      }
      setAppliedRetention(clampedRetention);
    }
    catch (error) { toast(t.brain.saveError, 'error'); throw error; }
  }, { ready: runtimeSeeded && !!runtime });

  const saveStatus: SaveStatus = [nameStatus, stepsStatus, limitsStatus, runtimeStatus].includes('error')
    ? 'error'
    : [nameStatus, stepsStatus, limitsStatus, runtimeStatus].includes('saving')
      ? 'saving'
      : [nameStatus, stepsStatus, limitsStatus, runtimeStatus].includes('saved') ? 'saved' : 'idle';
  useEffect(() => {
    const retry = saveStatus === 'error' ? () => {
      if (nameStatus === 'error') retryName();
      if (stepsStatus === 'error') retrySteps();
      if (limitsStatus === 'error') retryLimits();
      if (runtimeStatus === 'error') retryRuntime();
    } : undefined;
    onSaveState?.('brain', saveStatus, retry);
  }, [limitsStatus, nameStatus, onSaveState, retryLimits, retryName, retryRuntime, retrySteps, runtimeStatus, saveStatus, stepsStatus]);

  if (!config) return <LoadingState />;
  const providers = config.brain?.providers ?? [];
  // OAuth entries exist in config only as carriers of the account's model selection — the account
  // cards above manage them, so the add/edit grid below shows API-key providers only.
  const apiProviders = providers.filter((p) => !p.type.startsWith('oauth-'));

  // A display filter only: hidden OAuth types drop from the accounts list so a provider the operator
  // never uses stops offering "Connect". It never touches credentials, so only disconnected accounts can
  // be hidden — a hidden type that is somehow connected still shows, to never bury a working account.
  const hiddenOauth = config.brain?.hiddenOauth ?? [];
  // The supported OAuth account types come straight from the daemon (keys of the status map), so a
  // provider added there shows up here without a frontend change.
  const oauthTypes = Object.keys(oauth.data ?? {});
  const typeLabel = (type: string): string => t.brain.types[type as keyof typeof t.brain.types] ?? type;
  const isConnected = (type: string) => oauth.data?.[type] ?? false;
  const setHiddenOauth = (next: string[]) => {
    void (async () => {
      try { await updateConfig.mutateAsync({ brain: { hiddenOauth: next } }); }
      catch { toast(t.brain.saveError, 'error'); }
    })();
  };
  const hideOauth = (type: string) => setHiddenOauth([...hiddenOauth.filter((t) => t !== type), type]);
  const showOauth = (type: string) => setHiddenOauth(hiddenOauth.filter((t) => t !== type));
  const restorableOauth = oauthTypes.filter((type) => hiddenOauth.includes(type) && !isConnected(type));

  // A connected account's model selection lives on its explicit provider entry (id = the builtin
  // provider name, so `elowen:<id>/<model>` execs stay stable whether the entry is synthetic or saved).
  const OAUTH_ENTRY_ID: Record<string, string> = { 'oauth-anthropic': 'anthropic', 'oauth-openai-codex': 'openai-codex', 'oauth-github-copilot': 'github-copilot', 'oauth-kimi': 'kimi-coding' };
  const oauthEntryOf = (type: BrainProviderType) => providers.find((p) => p.type === type);

  const persist = (next: (Omit<BrainProvider, 'apiKeySet'> & { apiKey?: string })[]) =>
    save.mutate(next, {
      onSuccess: () => toast(t.brain.saved),
      onError: () => toast(t.brain.saveError, 'error'),
    });

  const upsert = (d: Draft) => {
    // Blank means "send no temperature", which is a real setting, not a missing one — so '' is omitted
    // rather than coerced to 0. Anything else must clear the same 0..2 bar the daemon enforces: without
    // this the value is POSTed, silently dropped server-side, and the operator is told it saved.
    const temperature = d.temperature.trim();
    const parsed = Number(temperature);
    if (temperature && !(Number.isFinite(parsed) && parsed >= 0 && parsed <= 2)) {
      toast(t.brain.temperatureInvalid, 'error');
      return; // modal stays open on the offending value
    }
    const entry = {
      id: d.id, label: d.label.trim(), type: d.type, baseUrl: d.baseUrl.trim(),
      models: d.models.split('\n').map((m) => m.trim()).filter(Boolean),
      ...(d.type === 'openai' && d.api ? { api: d.api } : {}),
      ...(d.apiKey.trim() ? { apiKey: d.apiKey.trim() } : {}),
      ...(temperature ? { temperature: parsed } : {}),
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

  const verifyHostedSearch = (provider: BrainProvider) => void (async () => {
    setVerifyingProvider(provider.id);
    try {
      const results = [];
      for (const modelId of provider.models) {
        results.push(await elowenClient.brainHostedToolSearchProbe({ providerId: provider.id, modelId }));
      }
      await refreshHostedSearchStatus();
      if (results.length > 0 && results.every((result) => result.status === 'supported')) toast(t.brain.hostedSearchVerified);
      else toast(t.brain.hostedSearchVerifyFailed, 'error');
    } catch {
      toast(t.brain.hostedSearchVerifyFailed, 'error');
    } finally {
      setVerifyingProvider(null);
    }
  })();

  return (
    <>
      {/* Identity + step ceiling on one row: the assistant's name (everywhere it speaks) and the max
          agent steps per run (Discord shows "Step N / MAX"). */}
      <SettingsGroup icon={BrainCircuit}>
        <SettingsRow label={t.brain.agentName} icon={BrainCircuit}>
          <Input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="Elowen" aria-label={t.brain.agentName} />
        </SettingsRow>
        <SettingsRow label={t.brain.maxSteps} description={t.brain.maxStepsHint} icon={Gauge}>
          <div className="flex items-center gap-3">
            <Slider
              min={100} max={1000} step={100}
              value={Math.min(1000, Math.max(100, Number.isFinite(parsedSteps) && parsedSteps > 0 ? parsedSteps : 200))}
              onChange={(n) => setMaxSteps(String(n))}
              aria-label={t.brain.maxSteps}
              className="w-40"
            />
            <span className="w-10 text-right tabular-nums text-sm text-muted">{Number.isFinite(parsedSteps) && parsedSteps > 0 ? parsedSteps : 200}</span>
          </div>
        </SettingsRow>
        {limits ? (
          <SettingsRow label={t.brain.limits.title} description={t.brain.limits.hint} icon={SlidersHorizontal}>
            {/* data-selection-manage: in a pod the button hides and the orb becomes the trigger. */}
            <button type="button" data-selection-manage className="spatial-inline-action" onClick={() => setLimitsOpen(true)}>
              <SlidersHorizontal size={14} aria-hidden />{t.brain.limits.manage}
            </button>
          </SettingsRow>
        ) : null}
        {runtime ? (
          <SettingsRow label={t.brain.runtime.title} description={t.brain.runtime.hint} icon={Gauge}>
            <button type="button" data-selection-manage className="spatial-inline-action" onClick={() => setRuntimeOpen(true)}>
              <Gauge size={14} aria-hidden />{t.brain.runtime.manage}
            </button>
          </SettingsRow>
        ) : null}
        {runtime ? (
          <SettingsRow label={t.brain.toolLoading.title} description={t.brain.toolLoading.hint} icon={Boxes}>
            <button type="button" data-selection-manage className="spatial-inline-action" onClick={() => setToolLoadingOpen(true)}>
              <Boxes size={14} aria-hidden />{t.brain.toolLoading.manage}
            </button>
          </SettingsRow>
        ) : null}
        {runtime ? (
          <SettingsRow label={t.brain.retention.title} description={t.brain.retention.hint} icon={ShieldCheck}>
            <button type="button" data-selection-manage className="spatial-inline-action" onClick={() => setRetentionOpen(true)}>
              <ShieldCheck size={14} aria-hidden />{t.brain.retention.manage}
            </button>
          </SettingsRow>
        ) : null}
      </SettingsGroup>
      {limits && limitsOpen ? (
            <BrainLimitsModal
              limits={limits}
              applied={appliedLimits}
              onChange={(fn) => setLimits((cur) => (cur ? fn(cur) : cur))}
              onClose={() => setLimitsOpen(false)}
              presentation="drawer"
            />
      ) : null}
      {runtime && runtimeOpen ? (
            <RuntimeLimitsModal
              runtime={runtime}
              applied={appliedRuntime}
              onChange={(fn) => setRuntime((cur) => (cur ? fn(cur) : cur))}
              onClose={() => setRuntimeOpen(false)}
              presentation="drawer"
            />
      ) : null}
      {runtime && toolLoadingOpen ? (
            <ToolDeferralModal
              runtime={runtime}
              onSave={(patch) => updateConfig.mutateAsync(patch)}
              onSaved={(next) => setRuntime((current) => current ? {
                ...current,
                toolDeferralEnabled: next.toolDeferralEnabled,
                toolDeferralOverrides: next.toolDeferralOverrides,
                limits: { ...current.limits, toolDeferThreshold: next.limits.toolDeferThreshold },
              } : current)}
              onClose={() => setToolLoadingOpen(false)}
              presentation="drawer"
            />
      ) : null}
      {runtime && retentionOpen ? (
            <MemoryRetentionModal
              runtime={runtime}
              applied={appliedRetention}
              onChange={(fn) => setRuntime((cur) => (cur ? fn(cur) : cur))}
              onClose={() => setRetentionOpen(false)}
              presentation="drawer"
            />
      ) : null}

      {/* OAuth accounts: one row per supported account type, connect/disconnect. Hidden types drop out
          and return via the "+" menu. */}
      <SettingsGroup
        title={t.brain.accounts}
        density="compact"
        variant="classic"
        actions={restorableOauth.length > 0 ? (
          <ActionMenu
            align="right"
            label={t.brain.addAccount}
            triggerClassName="flex h-6 w-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-accent"
            trigger={<Plus size={15} aria-hidden />}
            items={restorableOauth.map((type) => ({ label: typeLabel(type), iconNode: <ModelIcon name={OAUTH_ICON[type] ?? type} size={15} />, onSelect: () => showOauth(type) }))}
          />
        ) : undefined}
      >
        {oauthTypes.filter((type) => !hiddenOauth.includes(type) || isConnected(type)).map((type) => {
          const connected = isConnected(type);
          const icon = OAUTH_ICON[type] ?? type;
          const usage = connected ? rateLimits.data?.[OAUTH_ENTRY_ID[type]] : undefined;
          return (
            <SettingsRow
              key={type}
              label={typeLabel(type)}
              status={(
                <span className="flex items-center gap-2">
                  <ModelIcon name={icon} size={15} />
                  {connected ? <Badge tone="accent">{t.brain.connected}</Badge> : <span>{t.brain.notConnected}</span>}
                </span>
              )}
              actions={connected ? (
                <>
                  <Button variant="ghost" icon={ListChecks} aria-label={`${t.brain.pickModels}: ${typeLabel(type)}`} onClick={() => setModelsFor(type as BrainProviderType)}>{t.brain.pickModels}</Button>
                  <Button variant="ghost" icon={Unlink} aria-label={`${t.brain.disconnect}: ${typeLabel(type)}`} onClick={() => setDisconnectTarget(type as BrainProviderType)} />
                </>
              ) : (
                <>
                  <Button variant="accent" icon={Link2} onClick={() => startConnect(type)}>{t.brain.connect}</Button>
                  <Button variant="ghost" icon={EyeOff} aria-label={`${t.brain.hideAccount}: ${typeLabel(type)}`} onClick={() => hideOauth(type)} />
                </>
              )}
            >
              {usage ? <OAuthUsageRail usage={usage} /> : null}
            </SettingsRow>
          );
        })}
      </SettingsGroup>

      {/* Provider entries the picker exposes. */}
      <SettingsGroup
        title={t.brain.providers}
        density="compact"
        variant="classic"
        actions={(
          <button
            type="button"
            onClick={() => setModal(emptyDraft())}
            aria-label={t.brain.addProvider}
            title={t.brain.addProvider}
            className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-accent"
          >
            <Plus size={15} aria-hidden />
          </button>
        )}
      >
        {apiProviders.length === 0 ? (
          <SettingsState>{t.brain.noProviders}</SettingsState>
        ) : (
          <>
            {apiProviders.map((p) => {
              const azure = isAzureResponsesProvider(p);
              const modelStates = p.models.map((modelId) => hostedSearchStatus[p.id]?.[modelId] ?? 'unverified');
              const hostedState: HostedSearchStatus = modelStates.length > 0 && modelStates.every((status) => status === 'supported')
                ? 'supported'
                : modelStates.some((status) => status === 'unsupported') ? 'unsupported' : 'unverified';
              const hostedLabel = hostedState === 'supported' ? t.brain.hostedSearchVerified
                : hostedState === 'unsupported' ? t.brain.hostedSearchUnsupported
                  : t.brain.hostedSearchUnverified;
              return (
                <SettingsRow
                  key={p.id}
                  label={p.label}
                  icon={BrainCircuit}
                  status={(
                    <span className="flex flex-col gap-1">
                      {p.baseUrl ? <span className="truncate font-mono">{p.baseUrl}</span> : null}
                      <span>{p.models.length > 0 ? t.brain.modelCount.replace('{n}', String(p.models.length)) : t.brain.modelsAuto}</span>
                    </span>
                  )}
                  actions={(
                    <>
                    <Badge>{t.brain.types[p.type]}</Badge>
                    {p.apiKeySet ? <Badge tone="accent"><KeyRound size={10} className="mr-1" aria-hidden />{t.brain.keySet}</Badge> : null}
                    {azure ? <Badge tone={hostedState === 'supported' ? 'accent' : hostedState === 'unsupported' ? 'danger' : 'default'}>{hostedLabel}</Badge> : null}
                    {azure ? (
                      <Button
                        variant="ghost"
                        icon={ShieldCheck}
                        disabled={p.models.length === 0 || verifyingProvider === p.id}
                        onClick={() => verifyHostedSearch(p)}
                      >
                        {verifyingProvider === p.id ? t.brain.hostedSearchVerifying : t.brain.hostedSearchVerify}
                      </Button>
                    ) : null}
                    <Button variant="ghost" icon={Pencil} aria-label={`${t.brain.editProvider}: ${p.label}`} onClick={() => setModal({ id: p.id, label: p.label, type: p.type, baseUrl: p.baseUrl, models: p.models.join('\n'), apiKey: '', api: p.api ?? '', temperature: p.temperature === undefined ? '' : String(p.temperature) })} />
                    <Button variant="ghost" icon={Trash2} aria-label={`${t.brain.removeProvider}: ${p.label}`} onClick={() => setRemoveTarget(p.id)} />
                    </>
                  )}
                />
              );
            })}
          </>
        )}
      </SettingsGroup>

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
          onDone={(result) => {
            setFlow(null);
            void oauth.refetch();
            // A fresh connect must surface the account's usage rail now, not on the next 20s poll tick.
            if (result === 'success') void rateLimits.refetch();
            // Cancelling is what the operator asked for, so it gets no toast at all — only a flow that
            // actually settled reports an outcome.
            if (result === 'success') toast(t.brain.connectedToast);
            else if (result === 'error') toast(t.brain.connectFailed, 'error');
          }}
        />
      ) : null}
      <ConfirmDialog
        open={disconnectTarget !== null}
        title={t.brain.disconnect}
        description={disconnectTarget ? t.brain.disconnectConfirm.replace('{provider}', t.brain.types[disconnectTarget]) : undefined}
        confirmLabel={t.brain.disconnect}
        onConfirm={() => {
          const target = disconnectTarget;
          setDisconnectTarget(null);
          if (target) disconnect.mutate(target, { onSuccess: () => toast(t.brain.disconnected) });
        }}
        onClose={() => setDisconnectTarget(null)}
      />
      <ConfirmDialog
        open={removeTarget !== null}
        title={t.brain.removeProvider}
        description={removeTarget ? t.brain.removeProviderConfirm.replace('{provider}', providers.find((provider) => provider.id === removeTarget)?.label ?? removeTarget) : undefined}
        confirmLabel={t.brain.removeProvider}
        onConfirm={() => { if (removeTarget) remove(removeTarget); setRemoveTarget(null); }}
        onClose={() => setRemoveTarget(null)}
      />
    </>
  );
}
