'use client';
import { Activity, useCallback, useState, useEffect, useRef, type ReactNode } from 'react';
import { UserCog, Mail, Cpu, Upload, ShieldCheck, User as UserIcon, KeyRound, ZoomIn, Bell, Sparkles, AtSign, Brain, MessageCircle, SquareTerminal, MessageSquareText, Send } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ElowenApiError } from '../../lib/elowenClient';
import type { PlatformLinkKey, ProfilePatch } from '../../lib/types';

/** The platform links this form edits, keyed exactly like the daemon's `CliSettings`. */
type PlatformLinks = Partial<Record<PlatformLinkKey, string>>;
/** The input shape of each link field. A `Record` over the daemon's link keys, so it is EXHAUSTIVE by
 *  type: a platform added to the identity descriptors fails this build until it has a field here. The
 *  keys are spelled out rather than imported because the descriptor module is daemon runtime code and
 *  this app takes TYPES only from `src/` — the type is what enforces the set, not the spelling. */
const PLATFORM_LINK_INPUTS: Record<PlatformLinkKey, { placeholder: string; icon: LucideIcon }> = {
  discordUserId: { placeholder: '123456789012345678', icon: AtSign },
  msteamsUserId: { placeholder: '00000000-0000-0000-0000-000000000000', icon: MessageSquareText },
  telegramUserId: { placeholder: '123456789', icon: Send },
  whatsappNumber: { placeholder: '420778433908', icon: MessageCircle },
};
/** Render and save order — the declaration order above, never a second list to keep in step. */
const PLATFORM_LINK_ORDER = Object.keys(PLATFORM_LINK_INPUTS) as PlatformLinkKey[];
import { useMe, useConfig, useMyCliSettings, useBrainModels } from '../../lib/queries';
import { useUpdateMe, useUploadAvatar, useChangePassword, useSaveMyCliSettings } from '../../lib/mutations';
import { allModels } from '../../lib/execPresets';
import { brainModelLabel, brainModelQualifiedLabel, execProvider, type ProviderId } from '../../lib/modelProvider';
import { providerMeta } from '../settings/providers';
import { Avatar } from '../../components/ui/Avatar';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { ManageSelectionModal, type ManageSelectionItem } from '../../components/ui/ManageSelectionModal';
import { SelectionSummary } from '../../components/ui/SelectionSummary';
import { BrainModelField } from '../../components/ui/BrainModelField';
import { Toggle } from '../../components/ui/Toggle';
import { Slider } from '../../components/ui/Slider';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { LoadingState, ErrorState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { usePersistentState } from '../../lib/usePersistentState';
import { useAutoSaveStatus, type SaveStatus } from '../../lib/useAutoSaveStatus';
import { combineSaveFeedback, type SaveFeedback } from '../../lib/saveFeedback';
import { useUiScale, MIN_SCALE, MAX_SCALE, DEFAULT_SCALE } from '../../lib/useUiScale';
import { isPushSupported, enablePush, disablePush } from '../../lib/pushClient';
import { ChoiceField } from '../../components/ui/ChoiceField';
import { SpatialControlDeck } from '../../components/ui/SpatialControlDeck';
import { SpatialGroup, SpatialIdentity, SpatialRow } from '../../components/ui/SpatialPrimitives';
import { ConstellationScope } from '../../components/ui/Constellation';
import { WorkspaceDetailRail } from '../../components/ui/WorkspacePrimitives';
import { MotionReveal } from '../../components/ui/Motion';
import { useEffects, type EffectsMode } from '../../lib/useEffects';
import { PersonalitySection } from './PersonalitySection';
import { CliSection } from './CliSection';
import { TerminalSection } from './TerminalSection';
import { AccountMemorySection } from './AccountMemorySection';

type AccountSection = 'profile' | 'security' | 'notifications' | 'personality' | 'cli' | 'terminal' | 'memory';

/** Mount a section only after its first visit, then let React Activity retain its local form state.
 *  This avoids eagerly starting every section's queries while making sidebar switches lossless. */
function AccountPanel({ id, active, visited, children }: {
  id: AccountSection;
  active: AccountSection;
  visited: ReadonlySet<AccountSection>;
  children: ReactNode;
}) {
  if (id !== active && !visited.has(id)) return null;
  return (
    <Activity mode={id === active ? 'visible' : 'hidden'}>
      {/* data-constellation drops the card frame so sections float on the page background. */}
      <MotionReveal data-account-panel={id} data-constellation="">{children}</MotionReveal>
    </Activity>
  );
}

/** Small provider engine logo for the worker modal's group headers/chips. */
function ProviderGroupIcon({ provider }: { provider: ProviderId }) {
  const meta = providerMeta(provider);
  if (!meta) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={meta.icon} alt="" width={14} height={14} style={{ objectFit: 'contain' }} aria-hidden />
  );
}

/** Single-select default worker exec: a compact summary chip + a manage modal grouping the pickable
 *  worker engines by provider (engine logo on each header, model brand icon on each row). A pinned row
 *  (id '') clears the personal default so new tasks fall back to the global default. */
function WorkerField({ value, onChange, execs, labelOf, summaryLabelOf, defaultLabel, title }: {
  value: string;
  onChange: (v: string) => void;
  execs: string[];
  /** Row label inside the picker, which is grouped by provider — so the provider is NOT repeated here. */
  labelOf: (exec: string) => string;
  /** Label for the summary chip, which stands alone: there the provider is what disambiguates. */
  summaryLabelOf: (exec: string) => string;
  defaultLabel: string;
  title: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const items: ManageSelectionItem[] = [
    { id: '', label: defaultLabel, group: '' },
    ...execs.map((exec) => {
      const prov = execProvider(exec);
      return { id: exec, label: labelOf(exec), group: prov, groupLabel: providerMeta(prov)?.label ?? prov, icon: <ModelIcon name={exec} size={14} /> };
    }),
  ];
  const groupIcons = Object.fromEntries(
    [...new Set(execs.map(execProvider))].map((prov) => [prov, <ProviderGroupIcon key={prov} provider={prov} />]),
  );
  return (
    <>
      <SelectionSummary
        countText=""
        samples={[value ? { label: summaryLabelOf(value), icon: <ModelIcon name={value} size={13} /> } : { label: defaultLabel }]}
        moreCount={0}
        onManage={() => setOpen(true)}
        manageLabel={t.managePicker.manage}
        manageAriaLabel={`${t.managePicker.manage}: ${title}`}
      />
      <ManageSelectionModal
        title={title}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        selected={new Set([value])}
        single
        groupIcons={groupIcons}
        onSave={(next) => onChange([...next][0] ?? '')}
      />
    </>
  );
}

export function AccountView() {
  const me = useMe();
  const { data: config } = useConfig();
  const cli = useMyCliSettings();
  const brainModels = useBrainModels();
  const updateMe = useUpdateMe();
  const saveLinks = useSaveMyCliSettings();
  const saveModel = useSaveMyCliSettings();
  const uploadAvatar = useUploadAvatar();
  const changePassword = useChangePassword();
  const { toast } = useToast();
  const { t } = useTranslation();
  const { scale, preference, setPreference } = useUiScale();
  const effects = useEffects();
  const fileRef = useRef<HTMLInputElement>(null);
  const prefPct = Math.round(preference * 100);
  const appliedPct = Math.round(scale * 100);
  const [section, setSection] = usePersistentState<AccountSection>(
    'elowen.account.section', 'profile', ['profile', 'security', 'notifications', 'personality', 'cli', 'terminal', 'memory']);
  const [visitedSections, setVisitedSections] = useState<Set<AccountSection>>(() => new Set([section]));
  const [sectionFeedback, setSectionFeedback] = useState<Partial<Record<AccountSection, SaveFeedback>>>({});
  const reportSaveState = useCallback((id: string, status: SaveStatus, retry?: () => void) => {
    if (!['profile', 'security', 'notifications', 'personality', 'cli', 'terminal', 'memory'].includes(id)) return;
    setSectionFeedback((current) => ({ ...current, [id as AccountSection]: { status, retry } }));
  }, []);
  useEffect(() => {
    setVisitedSections((current) => current.has(section) ? current : new Set(current).add(section));
  }, [section]);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [defaultExec, setDefaultExec] = useState('');
  // The user's default Elowen AI chat model, kept as `provider::model` ('' = server default). Lives in
  // cliSettings (not on the User) — seeded once, then this local state drives the picker highlight.
  const [elowenSel, setElowenSel] = useState('');
  const [elowenSeeded, setElowenSeeded] = useState(false);
  // Platform account links live in cliSettings; Teams is normally filled automatically from verified UPN.
  // Held as ONE map keyed by the daemon's platform-link keys rather than a state hook per platform, so
  // a platform added to the identity descriptors gets its field here instead of being silently missing.
  const [links, setLinks] = useState<PlatformLinks>({});
  const [linksBase, setLinksBase] = useState<PlatformLinks | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  // The password form lives in a side drawer opened via the pod's orb.
  const [passwordOpen, setPasswordOpen] = useState(false);
  // Phone push is a per-device preference (like UI scale): reflect this device's current state.
  const [pushSupported, setPushSupported] = useState(true);
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  // What /auth/me last reported for each profile field. It is both the dirty marker and the diff base:
  // a field still equal to its baseline is untouched, so it keeps following the server, while a field
  // the user has changed holds their text — a later refetch (e.g. the autosave's own invalidation) must
  // never type over an edit in progress. Tracking it per field, not per form, is what keeps a value
  // changed elsewhere (another window, another device) from being written back from this form's stale
  // copy when the user saves an unrelated field. The id resets the whole form when the identity changes.
  const [profileBase, setProfileBase] = useState<{ id: number; name: string; email: string; default_exec: string } | null>(null);
  // What this form last wrote for each field. A value the user changed no longer equals its baseline, so
  // without this it reads as an edit in progress forever — even once it has been saved and acknowledged.
  // The baseline then adopts whatever the refetch reports (another window's newer value) while the input
  // keeps the settled edit, and the next save carries it back out, silently undoing that other window.
  const profileSent = useRef<ProfilePatch>({});
  useEffect(() => {
    const user = me.data?.user;
    if (!user) return;
    const server = { id: user.id, name: user.name, email: user.email, default_exec: user.default_exec };
    if (profileBase && profileBase.id === server.id) {
      if (profileBase.name === server.name && profileBase.email === server.email && profileBase.default_exec === server.default_exec) return;
      // Follow the server whenever the field holds nothing but a settled value: its baseline, or this
      // form's own last write coming back as an echo. Anything else is the user's unsaved text.
      const sent = profileSent.current;
      setName((cur) => (cur === profileBase.name || cur.trim() === sent.name ? server.name : cur));
      setEmail((cur) => (cur === profileBase.email || cur.trim() === sent.email ? server.email : cur));
      setDefaultExec((cur) => (cur === profileBase.default_exec || cur === sent.default_exec ? server.default_exec : cur));
    } else {
      setName(server.name);
      setEmail(server.email);
      setDefaultExec(server.default_exec);
    }
    setProfileBase(server);
  }, [me.data, profileBase]);

  // Auto-persist the profile shortly after any change — no Save button. Only the changed fields go out;
  // `savable` holds the save entirely when nothing differs, so adopting a server-side change does not
  // bounce it straight back as a write.
  const profilePatch: ProfilePatch = {};
  if (profileBase) {
    if (name.trim() !== profileBase.name) profilePatch.name = name.trim();
    if (email.trim() !== profileBase.email) profilePatch.email = email.trim();
    if (defaultExec !== profileBase.default_exec) profilePatch.default_exec = defaultExec;
  }
  const profileSave = useAutoSaveStatus([name, email, defaultExec], async () => {
    try {
      await updateMe.mutateAsync(profilePatch);
      profileSent.current = { ...profileSent.current, ...profilePatch };
    } catch (error) {
      toast(t.account.saveError, 'error');
      throw error;
    }
  }, { ready: profileBase !== null, savable: Object.keys(profilePatch).length > 0 });

  // Seed the Elowen-AI default once cliSettings load; thereafter local state is the source of truth.
  useEffect(() => {
    if (cli.data && !elowenSeeded) {
      setElowenSel(cli.data.model ? `${cli.data.modelProvider ?? ''}::${cli.data.model}` : '');
      const seeded = Object.fromEntries(PLATFORM_LINK_ORDER.map((key) => [key, cli.data?.[key] ?? ''])) as PlatformLinks;
      setLinks(seeded);
      setLinksBase(seeded);
      setElowenSeeded(true);
    }
  }, [cli.data, elowenSeeded]);
  // Autosave only links changed in this form. In particular, a Teams TOFU link may appear server-side
  // while this page is open; saving an unrelated Discord field must not send the stale empty Teams value.
  const linksPatch: PlatformLinks = {};
  if (linksBase) {
    for (const key of PLATFORM_LINK_ORDER) {
      if (links[key] !== linksBase[key]) linksPatch[key] = links[key] ?? '';
    }
  }
  const linksSave = useAutoSaveStatus([links], async () => {
    try {
      await saveLinks.mutateAsync(linksPatch);
      setLinksBase((current) => current ? { ...current, ...linksPatch } : current);
    } catch (error) {
      toast(t.account.saveError, 'error');
      throw error;
    }
  }, { ready: linksBase !== null, savable: Object.keys(linksPatch).length > 0 });

  // Picking an Elowen AI model writes ONLY model+modelProvider (the cli-settings PATCH merges, so
  // CliSection's other fields are untouched) and the daemon restarts a running brain on the new model.
  // The picker hands back a `provider::model` key ('' = clear to the server default).
  const applyElowen = (key: string) => {
    const prev = elowenSel;
    setElowenSel(key);
    const sep = key.indexOf('::');
    const provider = sep > -1 ? key.slice(0, sep) : '';
    const model = sep > -1 ? key.slice(sep + 2) : '';
    saveModel.mutate(
      { model: key ? model : '', modelProvider: key ? provider : '' },
      // Revert the optimistic highlight if the server rejects the pick, so it can't drift from state.
      { onError: () => { setElowenSel(prev); toast(t.account.saveError, 'error'); } },
    );
  };

  useEffect(() => {
    const supported = isPushSupported();
    setPushSupported(supported);
    if (!supported) return;
    void navigator.serviceWorker.getRegistration('/sw.js')
      .then((r) => r?.pushManager.getSubscription())
      .then((s) => setPushOn(!!s))
      .catch(() => {});
  }, []);

  const togglePush = async () => {
    setPushBusy(true);
    try {
      if (pushOn) {
        await disablePush();
        setPushOn(false);
        toast(t.push.disabledToast);
      } else {
        const result = await enablePush();
        if (result === 'granted') { setPushOn(true); toast(t.push.enabledToast); }
        else if (result === 'denied') toast(t.push.denied, 'error');
        else toast(t.push.unsupported, 'error');
      }
    } catch {
      toast(t.push.error, 'error');
    } finally {
      setPushBusy(false);
    }
  };

  if (me.isError) {
    return <div className="flex w-full min-w-0 flex-col"><ModuleHeader title={t.account.title} icon={UserCog} /><ErrorState message={t.common.daemonUnreachable} onRetry={() => me.refetch()} /></div>;
  }
  if (me.isLoading || !me.data?.user) {
    return <div className="flex w-full min-w-0 flex-col"><ModuleHeader title={t.account.title} icon={UserCog} /><LoadingState /></div>;
  }

  const u = me.data.user;
  const custom = config?.customModels ?? [];
  // Models the user may pick a default from: their admin allow-list, or all globally-allowed when
  // they have no per-user restriction.
  const restricted = u.allowed_execs.length > 0;
  const pickable = restricted ? u.allowed_execs : (config?.allowedExecs ?? []);
  // Worker presets name themselves; a brain exec takes its clean model name from the catalog (shared
  // helper — the exec must not be split on a slash, the model id may contain one).
  const labelOf = (exec: string) => allModels(custom).find((m) => m.exec === exec)?.label
    ?? brainModelLabel(exec, brainModels.data);
  // Standing alone in the summary, a brain model carries its provider — no group header does it there.
  const qualifiedLabelOf = (exec: string) => allModels(custom).find((m) => m.exec === exec)?.label
    ?? brainModelQualifiedLabel(exec, brainModels.data);

  // Every pickable exec is a selectable Default worker (writes default_exec) — INCLUDING Elowen AI models
  // enabled in Settings→Models, which the daemon runs as embedded brain workers. The separate Elowen AI
  // picker below sets a different thing entirely: the user's brain CHAT model (cli-settings), not a worker.
  const workerExecs = pickable;
  // Elowen AI chat models: honour a user's personal allow-list even as admin (mirrors the worker rail +
  // the Discord /model fix) — brainModels is already per-user-scoped server-side for non-admins.
  const elowenModels = (brainModels.data ?? []).filter((m) => !restricted || u.allowed_execs.includes(m.exec));

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) uploadAvatar.mutate(f, { onSuccess: () => toast(t.account.avatarSaved), onError: () => toast(t.account.saveError, 'error') });
    e.target.value = ''; // allow re-selecting the same file
  };
  const submitPassword = () => {
    if (newPassword.length < 8) { toast(t.account.passwordTooShort, 'error'); return; }
    if (newPassword !== confirmPassword) { toast(t.account.passwordMismatch, 'error'); return; }
    changePassword.mutate(
      { currentPassword, newPassword },
      {
        onSuccess: () => { setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); toast(t.account.passwordChanged); },
        // A wrong current password comes back as 403 (not a session failure); show the specific
        // translated message, falling back to the generic one for anything else.
        onError: (e) => toast(e instanceof ElowenApiError && e.status === 403 ? t.account.passwordWrong : t.account.passwordError, 'error'),
      },
    );
  };
  const canSubmitPassword = currentPassword.length > 0 && newPassword.length >= 8 && newPassword === confirmPassword;

  // Ordered by settings importance: account basics first, then the Elowen AI runtime and what shapes it
  // (memory, personality), then operational (notifications, security), with the cosmetic terminal last.
  const sections: { id: AccountSection; icon: LucideIcon; label: string }[] = [
    { id: 'profile', icon: UserCog, label: t.account.tabProfile },
    { id: 'cli', icon: Cpu, label: t.account.tabCli },
    { id: 'memory', icon: Brain, label: t.account.tabMemory },
    { id: 'personality', icon: Sparkles, label: t.account.tabPersonality },
    { id: 'notifications', icon: Bell, label: t.account.tabNotifications },
    { id: 'security', icon: KeyRound, label: t.account.tabSecurity },
    { id: 'terminal', icon: SquareTerminal, label: t.account.tabTerminal },
  ];
  const spatialSections = sections.map((item) => ({
    ...item,
    description: item.id === 'profile' ? t.account.profileHint
      : item.id === 'security' ? t.account.passwordHint
      : item.id === 'notifications' ? t.help.pushEnable
      : item.id === 'cli' ? t.account.defaultElowenAiHint
      : item.id === 'terminal' ? t.terminal.colorsHelp
      : item.id === 'memory' ? t.help.memoryRecall
      : t.personality.intro,
  }));
  const profileFeedback = combineSaveFeedback(
    { status: profileSave.status, retry: profileSave.retry },
    { status: linksSave.status, retry: linksSave.retry },
    { status: saveModel.isError ? 'error' : saveModel.isPending ? 'saving' : saveModel.isSuccess ? 'saved' : 'idle', retry: () => applyElowen(elowenSel) },
  );
  const activeFeedback = section === 'profile' ? profileFeedback : (sectionFeedback[section] ?? { status: 'idle' as const });

  return (
    /* Match the settings workspace width so account controls have the same calm, useful measure. */
    <div className="flex w-full min-w-0 flex-col">
      <ModuleHeader title={t.account.title} icon={UserCog} />

      <SpatialControlDeck
        eyebrow={t.account.title}
        ariaLabel={t.account.sectionsNav}
        sections={spatialSections}
        value={section}
        onChange={(v) => setSection(v as typeof section)}
        status={activeFeedback.status}
        onRetry={activeFeedback.retry}
      >
      <AccountPanel id="memory" active={section} visited={visitedSections}>
        <ConstellationScope core={t.account.tabMemory}><AccountMemorySection onSaveState={reportSaveState} /></ConstellationScope>
      </AccountPanel>
      <AccountPanel id="personality" active={section} visited={visitedSections}>
        <ConstellationScope core={t.account.tabPersonality}><PersonalitySection onSaveState={reportSaveState} /></ConstellationScope>
      </AccountPanel>
      <AccountPanel id="terminal" active={section} visited={visitedSections}>
        <ConstellationScope core={t.account.tabTerminal}><TerminalSection onSaveState={reportSaveState} /></ConstellationScope>
      </AccountPanel>

      {/* Elowen AI runtime controls. Default models live at the top of the profile workspace, where
          users see their most consequential personal preference immediately. */}
      <AccountPanel id="cli" active={section} visited={visitedSections}>
        <ConstellationScope core={t.account.tabCli}><CliSection onSaveState={reportSaveState} /></ConstellationScope>
      </AccountPanel>

      <AccountPanel id="profile" active={section} visited={visitedSections}>
      <ConstellationScope core={t.account.tabProfile}>
      {(() => {
        const rowWorker = workerExecs.length > 0 ? (
          <SpatialRow title={t.account.defaultWorker} description={t.account.defaultWorkerHint} icon={Cpu}>
            <WorkerField
              value={defaultExec}
              onChange={setDefaultExec}
              execs={workerExecs}
              labelOf={labelOf}
              summaryLabelOf={qualifiedLabelOf}
              defaultLabel={t.account.defaultWorkerNone}
              title={t.account.defaultWorker}
            />
          </SpatialRow>
        ) : null;
        const rowElowen = elowenModels.length > 0 ? (
          <SpatialRow title={t.account.defaultElowenAi} description={t.account.defaultElowenAiHint} icon={Brain}>
            <BrainModelField
              value={elowenSel}
              onChange={applyElowen}
              models={elowenModels}
              title={t.account.defaultElowenAi}
              subtitle={t.account.defaultElowenAiHint}
              defaultLabel={t.account.defaultElowenAiNone}
              keyOf={(m) => `${m.provider}::${m.model}`}
              manageAriaLabel={`${t.managePicker.manage}: ${t.account.defaultElowenAi}`}
            />
          </SpatialRow>
        ) : null;
        const rowName = (
          <SpatialRow title={t.account.name} icon={UserIcon}>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="sm:w-72" />
          </SpatialRow>
        );
        const rowEmail = (
          <SpatialRow title={t.account.email} icon={Mail}>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="sm:w-72" />
          </SpatialRow>
        );
        // Whole-app zoom — a per-device display preference, applied live via the UiScaleProvider. The
        // slider sets the personal factor; the window width supplies an automatic base underneath it, so
        // the applied zoom is shown alongside whenever the two disagree — otherwise a slider reading
        // 100% on a visibly shrunken app looks like a bug.
        const rowUiScale = (
          <SpatialRow title={t.account.uiScale} icon={ZoomIn} description={t.help.accountUiScale}>
            <div className="flex min-w-0 flex-wrap items-center justify-center gap-3">
              <Slider value={prefPct} min={MIN_SCALE * 100} max={MAX_SCALE * 100} step={5} onChange={(v) => setPreference(v / 100)} aria-label={t.account.uiScale} />
              <span className="w-12 shrink-0 text-right font-mono text-sm tabular-nums text-text">{prefPct}%</span>
              {appliedPct !== prefPct && (
                <span className="shrink-0 font-mono text-sm tabular-nums text-text-muted" title={t.account.uiScaleApplied}>→ {appliedPct}%</span>
              )}
              <button type="button" className="spatial-inline-action" onClick={() => setPreference(DEFAULT_SCALE)} disabled={prefPct === DEFAULT_SCALE * 100}>{t.account.uiScaleReset}</button>
            </div>
          </SpatialRow>
        );
        const rowEffects = (
          <SpatialRow title={t.account.effectsTitle} icon={Sparkles} description={t.account.effectsHint}>
            <ChoiceField
              title={t.account.effectsTitle}
              value={effects.mode}
              onChange={(value) => effects.setMode(value as EffectsMode)}
              options={[
                { value: 'auto', label: t.account.effectsAuto },
                { value: 'full', label: t.account.effectsFull },
                { value: 'reduced', label: t.account.effectsReduced },
                { value: 'off', label: t.account.effectsOff },
              ]}
            />
          </SpatialRow>
        );
        // Platform account links map authenticated sender identities to this Elowen account. Presentation
        // is a Record over the daemon's link keys, so it is EXHAUSTIVE by type: a platform added to the
        // identity descriptors fails this build until it has a label, a help text and a field here.
        const linkCopy: Record<PlatformLinkKey, { title: string; description: string }> = {
          discordUserId: { title: t.account.discordId, description: t.help.accountDiscordId },
          msteamsUserId: { title: t.account.msteamsIdentity, description: t.help.accountMsteamsIdentity },
          telegramUserId: { title: t.account.telegramId, description: t.help.accountTelegramId },
          whatsappNumber: { title: t.account.whatsappNumber, description: t.help.accountWhatsappNumber },
        };
        const linkRows = PLATFORM_LINK_ORDER.map((key) => {
          const { title, description } = linkCopy[key];
          const { placeholder, icon } = PLATFORM_LINK_INPUTS[key];
          return (
            <SpatialRow key={key} title={title} icon={icon} description={description}>
              <Input
                value={links[key] ?? ''}
                onChange={(e) => setLinks((current) => ({ ...current, [key]: e.target.value }))}
                placeholder={placeholder}
                className="font-mono sm:w-72"
                aria-label={title}
              />
            </SpatialRow>
          );
        });
        return (
          <div className="flex min-w-0 flex-col gap-6">
            <SpatialIdentity actions={(
              <button type="button" className="spatial-inline-action" onClick={() => fileRef.current?.click()} disabled={uploadAvatar.isPending}>
                <Upload size={14} aria-hidden />{t.account.uploadAvatar}
              </button>
            )}>
            <div className="flex items-center gap-4">
              <Avatar user={u} size={72} />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-lg font-semibold text-text">{u.name || u.username}</span>
                  {u.is_admin ? <Badge tone="accent"><ShieldCheck size={11} className="mr-1" aria-hidden />{t.users.admin}</Badge> : null}
                </span>
                <span className="truncate font-mono text-xs text-text-muted">@{u.username}</span>
              </div>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={onFile} />
            </div>
            </SpatialIdentity>

            <SpatialGroup>
              {rowWorker}{rowElowen}{rowName}{rowEmail}{rowUiScale}{rowEffects}{linkRows}
            </SpatialGroup>
          </div>
        );
      })()}
      </ConstellationScope>
      </AccountPanel>

      <AccountPanel id="security" active={section} visited={visitedSections}>
      <ConstellationScope core={t.account.tabSecurity}>
      {(() => {
        // Password change — verified server-side against the current password.
        const passwordForm = (
          <form
            className="flex flex-col gap-3 py-4"
            onSubmit={(e) => { e.preventDefault(); submitPassword(); }}
          >
            {/* Username hint helps password managers associate the credential. */}
            <input type="text" name="username" autoComplete="username" value={u.username} readOnly hidden />
            <div className="@container">
            <div className="grid grid-cols-1 gap-3 @sm:grid-cols-3">
              <Input
                type="password"
                autoComplete="current-password"
                placeholder={t.account.currentPassword}
                aria-label={t.account.currentPassword}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
              <Input
                type="password"
                autoComplete="new-password"
                placeholder={t.account.newPassword}
                aria-label={t.account.newPassword}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
              <Input
                type="password"
                autoComplete="new-password"
                placeholder={t.account.confirmPassword}
                aria-label={t.account.confirmPassword}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
            </div>
            <div className="flex justify-end">
              <Button type="submit" variant="accent" icon={KeyRound} disabled={!canSubmitPassword || changePassword.isPending}>
                {t.account.changePassword}
              </Button>
            </div>
          </form>
        );
        // The pod shows a masked hint; the form opens in a side drawer via the pod's orb.
        return (
          <>
            <SpatialGroup>
              <SpatialRow title={t.account.password} icon={KeyRound} description={t.account.passwordHint}>
                <span className="font-mono text-sm tracking-widest text-text-muted" aria-hidden>••••••••</span>
                <button type="button" data-selection-manage className="hidden" aria-label={t.account.changePassword} onClick={() => setPasswordOpen(true)} />
              </SpatialRow>
            </SpatialGroup>
            {passwordOpen ? (
              <WorkspaceDetailRail label={t.account.password} closeLabel={t.common.close} onClose={() => setPasswordOpen(false)}>
                <p className="mb-2 text-xs leading-relaxed text-text-muted">{t.account.passwordHint}</p>
                {passwordForm}
              </WorkspaceDetailRail>
            ) : null}
          </>
        );
      })()}
      </ConstellationScope>
      </AccountPanel>

      <AccountPanel id="notifications" active={section} visited={visitedSections}>
        {/* Phone push — a per-device opt-in. Subscribes this browser/device for off-device alerts.
           Rendered as an inline toggle row (like the other account settings) instead of a detached
           right-aligned button, so the control reads as a setting, not a submit form. */}
        {pushSupported ? (
          <ConstellationScope core={t.account.tabNotifications}>
          <SpatialGroup>
          <SpatialRow title={t.push.title} icon={Bell} description={t.help.pushEnable}>
            <label className="flex items-center gap-3 text-sm text-text">
              <Toggle checked={pushOn} onChange={togglePush} disabled={pushBusy} label={t.push.deviceToggle} />
              <span>{t.push.deviceToggle}</span>
            </label>
          </SpatialRow>
          </SpatialGroup>
          </ConstellationScope>
        ) : <p className="text-sm text-text-muted">{t.push.unsupported}</p>}
      </AccountPanel>
      </SpatialControlDeck>
    </div>
  );
}
