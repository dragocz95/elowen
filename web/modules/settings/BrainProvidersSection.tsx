import { useEffect, useRef, useState } from 'react';
import { BrainCircuit, Plus, Pencil, Trash2, KeyRound, Link2, Unlink, ExternalLink, Check, ChevronRight, ListChecks, EyeOff, Server, ShieldCheck, SlidersHorizontal, Settings2 } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { HelpTip } from '../../components/ui/HelpTip';
import { Toggle } from '../../components/ui/Toggle';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/shadcn/popover';
import { Segmented } from '../../components/ui/Segmented';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { ManageSelectionModal, type ManageSelectionItem } from '../../components/ui/ManageSelectionModal';
import { ActionMenu } from '../../components/ui/ActionMenu';
import { SelectionSummary } from '../../components/ui/SelectionSummary';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { LoadingState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useBrainOauthStatus, useBrainRateLimitsAll } from '../../lib/queries';
import { useAutoSaveStatus } from '../../lib/useAutoSaveStatus';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
import { OAuthUsageRail } from './OAuthUsageRail';
import { useUpdateConfig, useSaveBrainProviders, useBrainOauthDisconnect } from '../../lib/mutations';
import { elowenClient } from '../../lib/elowenClient';
import type { BrainProvider, BrainProviderCompatibility, BrainProviderType, OAuthFlowState, ElowenConfig } from '../../lib/types';
import { SettingsGroup, SettingsRow, SettingsState } from '../../components/ui/SettingsSurface';
import { DEFAULT_PROVIDER_COMPATIBILITY, ProviderCompatibilityModal, providerCompatibilityCustomCount } from './ProviderCompatibilityModal';
import { OptionalTemperatureControl } from './OptionalTemperatureControl';
import { DomainFavicon } from './providers';
import { rowAnchor } from '../../lib/rowAnchors';

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
type HostedSearchStatusResponse = Awaited<ReturnType<typeof elowenClient.brainHostedToolSearchStatus>>;
/** One hosted-search record per provider the daemon says the native search can apply to. Membership IS
 *  the capability answer — a provider absent from this map gets no switch, because the daemon would never
 *  give it a hosted route to switch off. */
type HostedSearchEntry = HostedSearchStatusResponse['providers'][number];
type HostedSearchInfo = Omit<HostedSearchEntry, 'providerId' | 'models'> & { models: Record<string, HostedSearchStatus> };
type HostedSearchMap = Record<string, HostedSearchInfo>;

const toHostedSearchMap = (response: HostedSearchStatusResponse): HostedSearchMap => Object.fromEntries(
  response.providers.map(({ providerId, models, ...rest }) => [
    providerId,
    { ...rest, models: Object.fromEntries(models.map((model) => [model.modelId, model.status])) },
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

// `temperature` is a string because the field is free text: '' means "send none", which is a distinct,
// meaningful state rather than a missing value, and 0 is a legitimate setting.
type Draft = {
  id: string; label: string; type: BrainProviderType; baseUrl: string; models: string; apiKey: string;
  api: '' | 'openai-completions' | 'openai-responses'; temperature: string;
  compatibility: BrainProviderCompatibility;
};
const emptyDraft = (): Draft => ({
  id: '', label: '', type: 'openai', baseUrl: '', models: '', apiKey: '', api: '', temperature: '',
  compatibility: DEFAULT_PROVIDER_COMPATIBILITY,
});
function draftUsesResponses(draft: Pick<Draft, 'api' | 'baseUrl'>): boolean {
  if (draft.api) return draft.api === 'openai-responses';
  try { return new URL(draft.baseUrl).hostname === 'api.openai.com'; }
  catch { return false; }
}
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
    <Modal title={t.brain.connectTitle} icon={Link2} size="md" onClose={() => onDone('cancelled')}>
      <ModalBody gap={4}>
        {flow.authUrl ? (
          <a href={flow.authUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 break-all rounded-md border border-primary/40 bg-primary/10 p-3 text-xs text-primary hover:bg-primary/20">
            <ExternalLink size={14} className="shrink-0" aria-hidden />{flow.authUrl}
          </a>
        ) : <p className="text-xs text-muted-foreground">{t.brain.connectStarting}</p>}
        {flow.userCode ? (
          <p className="text-sm text-foreground">{t.brain.connectUserCode}: <span className="font-mono text-lg font-semibold tracking-widest text-primary">{flow.userCode}</span></p>
        ) : null}
        {flow.instructions ? <p className="text-xs leading-relaxed text-muted-foreground">{flow.instructions}</p> : null}
        {flow.needsInput ? (
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (code.trim()) { void elowenClient.brainOauthInput(flow.id, code.trim()); setCode(''); } }}>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t.brain.connectCodePlaceholder} className="font-mono" />
            <Button type="submit" variant="accent" disabled={!code.trim()}>{t.brain.connectSubmitCode}</Button>
          </form>
        ) : flow.status === 'action-required' ? <p className="text-xs italic text-muted-foreground">{t.brain.connectWaiting}</p> : null}
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={() => onDone('cancelled')}>{t.common.cancel}</Button>
      </ModalFooter>
    </Modal>
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

/** The per-provider native-tool-search switch, behind the record's own settings affordance.
 *
 *  It sits among the row's actions, beside manage and disconnect — the row's control is its value (the
 *  subscription meters), and putting the gear there had hidden them. The popover carries the switch, the
 *  explanation, and what a session spawned right now would actually get — the daemon decides that last
 *  part, so "verified", "unsupported" and "off" are never re-derived here.
 *
 *  Only providers the daemon reported as hosted-search capable ever render one; everything else has no
 *  hosted route to switch off, and a dead switch would promise otherwise. */
function HostedToolSearchControl({ providerLabel, info, pending, onChange }: {
  providerLabel: string;
  info: HostedSearchInfo;
  pending: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const stateLabel = info.effective === 'off' ? t.brain.hostedSearchOff
    : info.effective === 'unsupported' ? t.brain.hostedSearchUnsupported
      : info.effective === 'unverified' ? t.brain.hostedSearchUnverified
        : t.brain.hostedSearchActive;
  const tone = info.effective === 'active' ? 'accent' : info.effective === 'unsupported' ? 'danger' : 'default';

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${t.brain.hostedSearchSettings}: ${providerLabel}`}
          title={t.brain.hostedSearchSettings}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-primary"
        >
          <Settings2 size={15} aria-hidden />
        </button>
      </PopoverTrigger>
      {/* Radix gives the content `role="dialog"`; it has no visible heading, so it names itself. */}
      <PopoverContent align="end" aria-label={t.brain.hostedSearchTitle} className="w-72">
        <div className="flex flex-col gap-3">
          {/* The switch comes FIRST in DOM order: the popover autofocuses its first tabbable, and a HelpTip
              there would open its tooltip over the panel the moment it appeared. */}
          <div className="flex items-start justify-between gap-3">
            <span className="text-sm font-medium text-foreground">{t.brain.hostedSearchTitle}</span>
            <span className="flex items-center gap-1.5">
              <Toggle
                checked={info.enabled}
                disabled={pending}
                onChange={onChange}
                label={`${t.brain.hostedSearchTitle}: ${providerLabel}`}
              />
              <HelpTip>{t.brain.hostedSearchHelp}</HelpTip>
            </span>
          </div>
          <span className="flex">
            <Badge tone={tone}>{stateLabel}</Badge>
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Add/edit dialog for one API-key provider entry (endpoint + key + models). OAuth accounts are NOT
 *  added here — they connect via the account cards above, where their model selection also lives. */
function ProviderModal({ draft: initial, existingIds, saving, onSave, onClose }: {
  draft: Draft;
  existingIds: string[];
  saving: boolean;
  onSave: (d: Draft) => void;
  onClose: () => void;
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
  const [compatibilityOpen, setCompatibilityOpen] = useState(false);
  const customCompatibilityCount = providerCompatibilityCustomCount({
    compatibility: d.compatibility,
    temperature: d.temperature,
  });
  const compatibilitySummary = customCompatibilityCount === 0
    ? t.brain.compatibility.safeDefaults
    : t.brain.compatibility.customSummary.replace('{n}', String(customCompatibilityCount));

  return (
    <>
    <Modal title={isNew ? t.brain.addProvider : t.brain.editProvider} icon={Server} size="md" onClose={saving ? () => {} : onClose}>
      <fieldset disabled={saving} className="contents">
      <ModalBody gap={4}>
        {/* The derived id and the "taken" verdict used to sit INSIDE the wrapping label, which put both
            into the input's accessible name. As the field's description and error they describe the
            control instead of renaming it. */}
        <Field
          label={t.brain.providerLabel}
          required
          description={isNew && id ? `id: ${id}` : undefined}
          error={idTaken ? t.brain.idTaken : undefined}
        >
          {(control) => <Input value={d.label} onChange={(e) => setD({ ...d, label: e.target.value })} placeholder="CoreSynth Proxy" {...control} />}
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
        {/* Anthropic falls back to its own default endpoint, so the base URL is only mandatory for the
            OpenAI-compatible type — the same condition `valid` above enforces. */}
        <Field label={t.brain.baseUrl} hint={d.type === 'openai' ? t.brain.baseUrlHintOpenai : t.brain.baseUrlHintAnthropic} required={d.type === 'openai'}>
          {(control) => <Input value={d.baseUrl} onChange={(e) => setD({ ...d, baseUrl: e.target.value })} placeholder={d.type === 'openai' ? 'https://ai.example.com/v1' : 'https://api.anthropic.com'} className="font-mono" {...control} />}
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
        {d.type === 'openai' && !draftUsesResponses(d) ? (
          <button
            type="button"
            onClick={() => setCompatibilityOpen(true)}
            className="group flex w-full items-center gap-3 rounded-lg border border-border bg-background px-3.5 py-3 text-left transition-colors hover:border-primary/40 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground transition-colors group-hover:text-primary">
              <SlidersHorizontal size={17} aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-foreground">{t.brain.compatibility.title}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{compatibilitySummary}</span>
            </span>
            <ChevronRight size={16} className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" aria-hidden />
          </button>
        ) : (
          <OptionalTemperatureControl
            value={d.temperature}
            onChange={(temperature) => setD({ ...d, temperature })}
            label={t.brain.temperature}
            hint={t.brain.temperatureHint}
            toggleLabel={t.brain.compatibility.temperatureOverride}
          />
        )}
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
                // The field's label wraps this summary, and a wrapping label names the first labelable
                // element inside it — this button. Naming it explicitly says which selection it manages
                // instead of letting it answer to the field's own label.
                manageAriaLabel={`${t.managePicker.manage}: ${t.brain.models}`}
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
              className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:border-primary"
              placeholder={'claude-opus-4-8\nollama/kimi-k2.7-code'}
            />
          )}
        </Field>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" disabled={saving} onClick={onClose}>{t.common.cancel}</Button>
        <Button
          variant="accent"
          icon={Check}
          disabled={!valid || saving}
          aria-busy={saving}
          onClick={() => onSave({ ...d, id })}
        >
          {t.common.save}
        </Button>
      </ModalFooter>
      </fieldset>
    </Modal>
    {compatibilityOpen ? (
      <ProviderCompatibilityModal
        value={{ compatibility: d.compatibility, temperature: d.temperature }}
        onClose={() => setCompatibilityOpen(false)}
        onSave={(next) => {
          setD((current) => ({ ...current, compatibility: next.compatibility, temperature: next.temperature }));
          setCompatibilityOpen(false);
        }}
      />
    ) : null}
    </>
  );
}

/** Settings → Brain: provider accounts, API endpoints, and hosted-search verification. */
export function BrainProvidersSection({ config }: { config: ElowenConfig | undefined }) {
  const oauth = useBrainOauthStatus();
  const rateLimits = useBrainRateLimitsAll();
  const save = useSaveBrainProviders();
  const disconnect = useBrainOauthDisconnect();
  const { toast } = useToast();
  const { t } = useTranslation();
  const [modal, setModal] = useState<Draft | null>(null);
  const [providerSavePending, setProviderSavePending] = useState(false);
  const [flow, setFlow] = useState<OAuthFlowState | null>(null);
  const [modelsFor, setModelsFor] = useState<BrainProviderType | null>(null);
  const updateConfig = useUpdateConfig();
  const [disconnectTarget, setDisconnectTarget] = useState<BrainProviderType | null>(null);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [hostedSearch, setHostedSearch] = useState<HostedSearchMap>({});
  const [verifyingProvider, setVerifyingProvider] = useState<string | null>(null);
  const [hostedSearchPending, setHostedSearchPending] = useState<string | null>(null);
  const hostedStatusGeneration = useRef(0);

  const refreshHostedSearchStatus = async () => {
    const generation = ++hostedStatusGeneration.current;
    const response = await elowenClient.brainHostedToolSearchStatus();
    if (hostedStatusGeneration.current === generation) setHostedSearch(toHostedSearchMap(response));
  };
  useEffect(() => {
    let cancelled = false;
    const generation = ++hostedStatusGeneration.current;
    void elowenClient.brainHostedToolSearchStatus().then((response) => {
      if (!cancelled && hostedStatusGeneration.current === generation) setHostedSearch(toHostedSearchMap(response));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [config?.brain?.providers]);

  const providers = config?.brain?.providers ?? [];
  // OAuth entries exist in config only as carriers of the account's model selection — the account
  // cards above manage them, so the add/edit grid below shows API-key providers only.
  const apiProviders = providers.filter((p) => !p.type.startsWith('oauth-'));

  // A display filter only: hidden OAuth types drop from the accounts list so a provider the operator
  // never uses stops offering "Connect". It never touches credentials, so only disconnected accounts can
  // be hidden — a hidden type that is somehow connected still shows, to never bury a working account.
  const [hiddenOauth, setHiddenOauth] = useState<string[]>(config?.brain?.hiddenOauth ?? []);
  const [hiddenOauthSeeded, setHiddenOauthSeeded] = useState(false);
  useEffect(() => {
    if (config && !hiddenOauthSeeded) {
      setHiddenOauth(config.brain?.hiddenOauth ?? []);
      setHiddenOauthSeeded(true);
    }
  }, [config, hiddenOauthSeeded]);
  // The supported OAuth account types come straight from the daemon (keys of the status map), so a
  // provider added there shows up here without a frontend change.
  const oauthTypes = Object.keys(oauth.data ?? {});
  const typeLabel = (type: string): string => t.brain.types[type as keyof typeof t.brain.types] ?? type;
  const isConnected = (type: string) => oauth.data?.[type] ?? false;
  const hiddenOauthSave = useAutoSaveStatus([hiddenOauth], async () => {
    try {
      const saved = await updateConfig.mutateAsync({ brain: { hiddenOauth } });
      const canonical = saved.brain?.hiddenOauth ?? [];
      if (canonical.join('\\u0000') !== hiddenOauth.join('\\u0000')) setHiddenOauth(canonical);
    } catch (error) { toast(t.brain.saveError, 'error'); throw error; }
  }, { ready: hiddenOauthSeeded, delay: 0 });
  const setHiddenOauthDraft = (next: string[]) => setHiddenOauth(next);
  if (!config) return null;
  const hideOauth = (type: string) => setHiddenOauthDraft([...hiddenOauth.filter((t) => t !== type), type]);
  const showOauth = (type: string) => setHiddenOauthDraft(hiddenOauth.filter((t) => t !== type));
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
    if (providerSavePending) return;
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
      ...(d.type === 'openai' ? { compatibility: d.compatibility } : {}),
      ...(d.apiKey.trim() ? { apiKey: d.apiKey.trim() } : {}),
      ...(temperature ? { temperature: parsed } : {}),
    };
    const keyless = providers.map(({ apiKeySet, ...p }) => p);
    const next = keyless.some((p) => p.id === entry.id)
      ? keyless.map((p) => (p.id === entry.id ? entry : p))
      : [...keyless, entry];
    setProviderSavePending(true);
    save.mutate(next, {
      onSuccess: () => {
        setProviderSavePending(false);
        setModal(null);
        toast(t.brain.saved);
      },
      onError: () => {
        setProviderSavePending(false);
        toast(t.brain.providerSaveError, 'error');
      },
    });
  };

  const remove = (id: string) => persist(providers.filter((p) => p.id !== id).map(({ apiKeySet, ...p }) => p));

  // The switch travels through the ordinary provider save path — it is a field on the provider row, not a
  // capability claim, so it needs no endpoint of its own (the probe-owned verification map stays read-only
  // through the config API, and no value of this field can grant a route).
  //
  // A connected OAuth account may still have no explicit entry: the same upsert the model picker performs
  // creates one under the built-in provider id, which is exactly the id the daemon reports the account's
  // hosted status under. Turning the switch back ON omits the field rather than sending `true`, because
  // absent is the only spelling of "on" the daemon stores.
  const setHostedToolSearchEnabled = (
    entryId: string, type: BrainProviderType, label: string, enabled: boolean,
  ) => {
    const keyless = providers.map(({ apiKeySet, ...p }) => p);
    const existing = keyless.find((p) => p.id === entryId);
    const { hostedToolSearchEnabled: _current, ...base } = existing ?? { id: entryId, label, type, baseUrl: '', models: [] };
    const entry = enabled ? base : { ...base, hostedToolSearchEnabled: false as const };
    const next = existing ? keyless.map((p) => (p.id === entryId ? entry : p)) : [...keyless, entry];
    setHostedSearchPending(entryId);
    save.mutate(next, {
      onSuccess: () => {
        setHostedSearchPending(null);
        // The saved config re-runs the status effect on its own, but a caller that hands back the same
        // provider list would leave the badge stating the pre-toggle answer. Ask directly; the generation
        // guard drops whichever of the two lands second.
        void refreshHostedSearchStatus();
        toast(t.brain.saved);
      },
      onError: () => {
        setHostedSearchPending(null);
        toast(t.brain.hostedSearchToggleError, 'error');
      },
    });
  };

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
      {/* OAuth accounts: one row per supported account type, connect/disconnect. Hidden types drop out
          and return via the "+" menu. */}
      <SettingsGroup
        title={t.brain.accounts}
        rowId={rowAnchor('brain.accounts')}
        density="compact"
        actions={restorableOauth.length > 0 ? (
          <ActionMenu
            align="right"
            label={t.brain.addAccount}
            triggerClassName="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-primary"
            trigger={<Plus size={15} aria-hidden />}
            items={restorableOauth.map((type) => ({ label: typeLabel(type), iconNode: <ModelIcon name={OAUTH_ICON[type] ?? type} size={15} />, onSelect: () => showOauth(type) }))}
          />
        ) : undefined}
      >
        {oauthTypes.filter((type) => !hiddenOauth.includes(type) || isConnected(type)).map((type) => {
          const connected = isConnected(type);
          const icon = OAUTH_ICON[type] ?? type;
          const entryId = OAUTH_ENTRY_ID[type] ?? type;
          const usage = connected ? rateLimits.data?.[entryId] : undefined;
          // Only reported for a CONNECTED account whose provider can carry a hosted route at all —
          // Copilot and Kimi never appear here, and neither does a disconnected Claude/ChatGPT account.
          const hostedInfo = hostedSearch[entryId];
          return (
            <SettingsRow
              key={type}
              label={typeLabel(type)}
              // The subscription's rate-limit windows ARE the record's value; the hosted-search switch is
              // an action beside the other two, not the control — it must never displace the meters.
              control={usage ? <OAuthUsageRail usage={usage} /> : undefined}
              // A connected account is a multi-value record: a connection badge, one usage meter per
              // rate-limit window, and up to three icon actions. It does not fit the one-value table a
              // phone gives a record's trailing side.
              trailingLayout="stack"
              status={(
                <span className="flex flex-wrap items-center gap-2">
                  <ModelIcon name={icon} size={15} />
                  {connected ? <Badge tone="accent">{t.brain.connected}</Badge> : <span>{t.brain.notConnected}</span>}
                  <AutoSaveStatus status={hiddenOauthSave.status} onRetry={hiddenOauthSave.retry} />
                </span>
              )}
              actions={connected ? (
                <>
                  <Button variant="ghost" icon={ListChecks} aria-label={`${t.brain.pickModels}: ${typeLabel(type)}`} onClick={() => setModelsFor(type as BrainProviderType)}>{t.brain.pickModels}</Button>
                  {hostedInfo ? (
                    <HostedToolSearchControl
                      providerLabel={typeLabel(type)}
                      info={hostedInfo}
                      pending={hostedSearchPending === entryId}
                      onChange={(enabled) => setHostedToolSearchEnabled(entryId, type as BrainProviderType, typeLabel(type), enabled)}
                    />
                  ) : null}
                  <Button variant="ghost" icon={Unlink} aria-label={`${t.brain.disconnect}: ${typeLabel(type)}`} onClick={() => setDisconnectTarget(type as BrainProviderType)} />
                </>
              ) : (
                <>
                  <Button variant="accent" icon={Link2} onClick={() => startConnect(type)}>{t.brain.connect}</Button>
                  <Button variant="ghost" icon={EyeOff} aria-label={`${t.brain.hideAccount}: ${typeLabel(type)}`} onClick={() => hideOauth(type)} />
                </>
              )}
            />
          );
        })}
      </SettingsGroup>

      {/* Provider entries the picker exposes. */}
      <SettingsGroup
        title={t.brain.providers}
        rowId={rowAnchor('brain.providers')}
        density="compact"
        actions={(
          <button
            type="button"
            onClick={() => setModal(emptyDraft())}
            aria-label={t.brain.addProvider}
            title={t.brain.addProvider}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-primary"
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
              const hostedInfo = hostedSearch[p.id];
              const modelStates = p.models.map((modelId) => hostedInfo?.models[modelId] ?? 'unverified');
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
                  // Endpoint, model count, type badge, key badge, an optional hosted-search badge and up
                  // to three buttons — the same multi-value record as an account above.
                  trailingLayout="stack"
                  iconNode={<DomainFavicon baseUrl={p.baseUrl} fallback={<BrainCircuit size={15} strokeWidth={1.75} />} />}
                  // Badges REPORT — they are not actions, and carrying them in the actions slot put six
                  // slots in a cell whose ceiling is three. The hosted-search badge is also its own verify
                  // control: it already states the answer, so a separate button beside it said the same
                  // thing twice.
                  status={(
                    <span className="flex flex-col gap-1">
                      {p.baseUrl ? <span className="truncate font-mono">{p.baseUrl}</span> : null}
                      <span>{p.models.length > 0 ? t.brain.modelCount.replace('{n}', String(p.models.length)) : t.brain.modelsAuto}</span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Badge>{t.brain.types[p.type]}</Badge>
                        {p.apiKeySet ? <Badge tone="accent"><KeyRound size={10} className="mr-1" aria-hidden />{t.brain.keySet}</Badge> : null}
                        {azure ? (
                          <button
                            type="button"
                            className="rounded-full transition-opacity hover:opacity-80 disabled:cursor-wait disabled:opacity-60"
                            aria-label={`${t.brain.hostedSearchVerify}: ${p.label}`}
                            title={t.brain.hostedSearchVerify}
                            disabled={p.models.length === 0 || verifyingProvider === p.id}
                            onClick={() => verifyHostedSearch(p)}
                          >
                            <Badge tone={hostedState === 'supported' ? 'accent' : hostedState === 'unsupported' ? 'danger' : 'default'}>
                              <ShieldCheck size={10} className="mr-1" aria-hidden />
                              {verifyingProvider === p.id ? t.brain.hostedSearchVerifying : hostedLabel}
                            </Badge>
                          </button>
                        ) : null}
                      </span>
                    </span>
                  )}
                  actions={(
                    <>
                    <Button variant="ghost" icon={Pencil} aria-label={`${t.brain.editProvider}: ${p.label}`} onClick={() => setModal({
                      id: p.id, label: p.label, type: p.type, baseUrl: p.baseUrl, models: p.models.join('\n'),
                      apiKey: '', api: p.api ?? '', temperature: p.temperature === undefined ? '' : String(p.temperature),
                      compatibility: p.compatibility ?? DEFAULT_PROVIDER_COMPATIBILITY,
                    })} />
                    {hostedInfo ? (
                      <HostedToolSearchControl
                        providerLabel={p.label}
                        info={hostedInfo}
                        pending={hostedSearchPending === p.id}
                        onChange={(enabled) => setHostedToolSearchEnabled(p.id, p.type, p.label, enabled)}
                      />
                    ) : null}
                    <Button variant="ghost" icon={Trash2} aria-label={`${t.brain.removeProvider}: ${p.label}`} onClick={() => setRemoveTarget(p.id)} />
                    </>
                  )}
                />
              );
            })}
          </>
        )}
      </SettingsGroup>

      {modal ? (
        <ProviderModal
          draft={modal}
          existingIds={providers.map((p) => p.id)}
          saving={providerSavePending}
          onSave={upsert}
          onClose={() => setModal(null)}
        />
      ) : null}
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
