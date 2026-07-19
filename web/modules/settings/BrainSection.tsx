'use client';
import { useEffect, useRef, useState } from 'react';
import { BrainCircuit, Plus, Pencil, Trash2, KeyRound, Link2, Unlink, ExternalLink, Check, ListChecks, SlidersHorizontal, Gauge, EyeOff } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { Segmented } from '../../components/ui/Segmented';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { ManageSelectionModal, type ManageSelectionItem } from '../../components/ui/ManageSelectionModal';
import { ActionMenu } from '../../components/ui/ActionMenu';
import { SelectionSummary } from '../../components/ui/SelectionSummary';
import { Modal, ModalBody } from '../../components/ui/Modal';
import { BrainLimitsModal, BRAIN_LIMIT_DEFAULTS } from './BrainLimitsModal';
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
import type { BrainProvider, BrainProviderType, OAuthFlowState, BrainLimits } from '../../lib/types';
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

// `temperature` is a string because the field is free text: '' means "send none", which is a distinct,
// meaningful state rather than a missing value, and 0 is a legitimate setting.
type Draft = { id: string; label: string; type: BrainProviderType; baseUrl: string; models: string; apiKey: string; api: '' | 'openai-completions' | 'openai-responses'; temperature: string };
const emptyDraft = (): Draft => ({ id: '', label: '', type: 'openai', baseUrl: '', models: '', apiKey: '', api: '', temperature: '' });
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
  const [disconnectTarget, setDisconnectTarget] = useState<BrainProviderType | null>(null);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

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

  // Max agent steps per run (the turn is aborted past this) — a validated 1..200 integer.
  const [maxSteps, setMaxSteps] = useState('');
  const [stepsSeeded, setStepsSeeded] = useState(false);
  useEffect(() => {
    if (config && !stepsSeeded) { setMaxSteps(String(config.brain?.maxSteps ?? 20)); setStepsSeeded(true); }
  }, [config, stepsSeeded]);
  const parsedSteps = Number(maxSteps);
  const { status: stepsStatus, retry: retrySteps } = useAutoSaveStatus([maxSteps], async () => {
    const n = Number(maxSteps);
    try { await updateConfig.mutateAsync({ brain: { maxSteps: Math.min(200, Math.max(1, Math.floor(n))) } }); }
    catch (error) { toast(t.brain.saveError, 'error'); throw error; }
  }, { ready: stepsSeeded && Number.isFinite(parsedSteps) && parsedSteps >= 1 });

  // Operator-tunable brain limits (one draft record, autosaved whole). The daemon re-clamps every field,
  // so an out-of-range keystroke is corrected server-side; the inputs carry the same bounds for the UI.
  const [limits, setLimits] = useState<BrainLimits | null>(null);
  const [limitsSeeded, setLimitsSeeded] = useState(false);
  useEffect(() => {
    if (config && !limitsSeeded) { setLimits(config.brain?.limits ?? BRAIN_LIMIT_DEFAULTS); setLimitsSeeded(true); }
  }, [config, limitsSeeded]);
  const { status: limitsStatus, retry: retryLimits } = useAutoSaveStatus([limits], async () => {
    if (!limits) return;
    try { await updateConfig.mutateAsync({ brain: { limits } }); }
    catch (error) { toast(t.brain.saveError, 'error'); throw error; }
  }, { ready: limitsSeeded && !!limits });

  const saveStatus: SaveStatus = [nameStatus, stepsStatus, limitsStatus].includes('error')
    ? 'error'
    : [nameStatus, stepsStatus, limitsStatus].includes('saving')
      ? 'saving'
      : [nameStatus, stepsStatus, limitsStatus].includes('saved') ? 'saved' : 'idle';
  useEffect(() => {
    const retry = saveStatus === 'error' ? () => {
      if (nameStatus === 'error') retryName();
      if (stepsStatus === 'error') retrySteps();
      if (limitsStatus === 'error') retryLimits();
    } : undefined;
    onSaveState?.('brain', saveStatus, retry);
  }, [limitsStatus, nameStatus, onSaveState, retryLimits, retryName, retrySteps, saveStatus, stepsStatus]);

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

  return (
    <>
      {/* Identity + step ceiling on one row: the assistant's name (everywhere it speaks) and the max
          agent steps per run (Discord shows "Step N / MAX"). */}
      <SettingsGroup icon={BrainCircuit}>
        <SettingsRow label={t.brain.agentName} icon={BrainCircuit}>
          <Input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="Elowen" aria-label={t.brain.agentName} />
        </SettingsRow>
        <SettingsRow label={t.brain.maxSteps} description={t.brain.maxStepsHint} icon={Gauge}>
          <Input type="number" min={1} max={200} value={maxSteps} onChange={(e) => setMaxSteps(e.target.value)} aria-label={t.brain.maxSteps} />
        </SettingsRow>
        {limits ? (
          <SettingsRow label={t.brain.limits.title} description={t.brain.limits.hint} icon={SlidersHorizontal}>
            <button type="button" className="spatial-inline-action" onClick={() => setLimitsOpen(true)}>
              <SlidersHorizontal size={14} aria-hidden />{t.brain.limits.manage}
            </button>
          </SettingsRow>
        ) : null}
      </SettingsGroup>
      {limits && limitsOpen ? (
            <BrainLimitsModal
              limits={limits}
              onChange={(fn) => setLimits((cur) => (cur ? fn(cur) : cur))}
              onClose={() => setLimitsOpen(false)}
            />
      ) : null}

      {/* OAuth accounts: one row per supported account type, connect/disconnect. Hidden types drop out
          and return via the "+" menu. */}
      <SettingsGroup
        title={t.brain.accounts}
        density="compact"
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
            {apiProviders.map((p) => (
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
                  <Button variant="ghost" icon={Pencil} aria-label={`${t.brain.editProvider}: ${p.label}`} onClick={() => setModal({ id: p.id, label: p.label, type: p.type, baseUrl: p.baseUrl, models: p.models.join('\n'), apiKey: '', api: p.api ?? '', temperature: p.temperature === undefined ? '' : String(p.temperature) })} />
                  <Button variant="ghost" icon={Trash2} aria-label={`${t.brain.removeProvider}: ${p.label}`} onClick={() => setRemoveTarget(p.id)} />
                  </>
                )}
              />
            ))}
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
          onDone={(ok) => {
            setFlow(null);
            void oauth.refetch();
            // A fresh connect must surface the account's usage rail now, not on the next 20s poll tick.
            if (ok) void rateLimits.refetch();
            toast(ok ? t.brain.connectedToast : t.brain.connectFailed, ok ? undefined : 'error');
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
