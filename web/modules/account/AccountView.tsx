'use client';
import { Activity, useCallback, useState, useEffect, useRef, type ReactNode } from 'react';
import { UserCog, Mail, Cpu, Upload, ShieldCheck, User as UserIcon, KeyRound, ZoomIn, Bell, Sparkles, AtSign, Brain, MessageCircle, SquareTerminal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ElowenApiError } from '../../lib/elowenClient';
import { useMe, useConfig, useMyCliSettings, useBrainModels } from '../../lib/queries';
import { useUpdateMe, useUploadAvatar, useChangePassword, useSaveMyCliSettings } from '../../lib/mutations';
import { allModels } from '../../lib/execPresets';
import { execProvider, type ProviderId } from '../../lib/modelProvider';
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
import { LoadingState } from '../../components/ui/states';
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
import { AccountDeckHero } from './AccountDeckHero';

/** PROTOTYPE(constellation): the AI-centric account sections (Elowen AI, Memory) render as an
 *  orbital constellation instead of stacked rows. Flip to false to restore the classic layout —
 *  no other change needed. */
const ACCOUNT_CONSTELLATION = true;
function ConstellationMaybe({ core, children }: { core: string; children: ReactNode }) {
  return ACCOUNT_CONSTELLATION ? <ConstellationScope core={core}>{children}</ConstellationScope> : <>{children}</>;
}

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
      {/* PROTOTYPE(constellation): data-constellation drops the card frame so sections float on the
          page background. */}
      <MotionReveal data-account-panel={id} data-constellation={ACCOUNT_CONSTELLATION ? '' : undefined}>{children}</MotionReveal>
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
function WorkerField({ value, onChange, execs, labelOf, defaultLabel, title }: {
  value: string;
  onChange: (v: string) => void;
  execs: string[];
  labelOf: (exec: string) => string;
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
        samples={[value ? { label: labelOf(value), icon: <ModelIcon name={value} size={13} /> } : { label: defaultLabel }]}
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
  // Discord / WhatsApp account links live in cliSettings; seeded alongside the Elowen-AI default, autosaved.
  const [discordUserId, setDiscordUserId] = useState('');
  const [whatsappNumber, setWhatsappNumber] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  // PROTOTYPE(constellation): the password form lives in a side drawer opened via the pod's orb.
  const [passwordOpen, setPasswordOpen] = useState(false);
  // Phone push is a per-device preference (like UI scale): reflect this device's current state.
  const [pushSupported, setPushSupported] = useState(true);
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  const [formSeeded, setFormSeeded] = useState(false);
  useEffect(() => {
    if (me.data?.user) {
      setName(me.data.user.name);
      setEmail(me.data.user.email);
      setDefaultExec(me.data.user.default_exec);
      setFormSeeded(true);
    }
  }, [me.data]);

  // Auto-persist the profile shortly after any change — no Save button.
  const profileSave = useAutoSaveStatus([name, email, defaultExec], async () => {
    try {
      await updateMe.mutateAsync({ name: name.trim(), email: email.trim(), default_exec: defaultExec });
    } catch (error) {
      toast(t.account.saveError, 'error');
      throw error;
    }
  }, { ready: formSeeded });

  // Seed the Elowen-AI default once cliSettings load; thereafter local state is the source of truth.
  useEffect(() => {
    if (cli.data && !elowenSeeded) {
      setElowenSel(cli.data.model ? `${cli.data.modelProvider ?? ''}::${cli.data.model}` : '');
      setDiscordUserId(cli.data.discordUserId ?? '');
      setWhatsappNumber(cli.data.whatsappNumber ?? '');
      setElowenSeeded(true);
    }
  }, [cli.data, elowenSeeded]);
  // Autosave the Discord / WhatsApp links (cli-settings PATCH merges, so the model picks stay untouched).
  const linksSave = useAutoSaveStatus([discordUserId, whatsappNumber], async () => {
    try {
      await saveLinks.mutateAsync({ discordUserId, whatsappNumber });
    } catch (error) {
      toast(t.account.saveError, 'error');
      throw error;
    }
  }, { ready: elowenSeeded });

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

  if (me.isLoading || !me.data?.user) {
    return <div className="flex w-full min-w-0 flex-col"><ModuleHeader title={t.account.title} icon={UserCog} /><LoadingState /></div>;
  }

  const u = me.data.user;
  const custom = config?.customModels ?? [];
  // Models the user may pick a default from: their admin allow-list, or all globally-allowed when
  // they have no per-user restriction.
  const restricted = u.allowed_execs.length > 0;
  const pickable = restricted ? u.allowed_execs : (config?.allowedExecs ?? []);
  const brainLabelByExec = new Map((brainModels.data ?? []).map((m) => [m.exec, m.model]));
  const labelOf = (exec: string) => allModels(custom).find((m) => m.exec === exec)?.label ?? brainLabelByExec.get(exec) ?? exec;

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
  const activeSection = spatialSections.find((item) => item.id === section) ?? spatialSections[0]!;

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
        compact={ACCOUNT_CONSTELLATION}
        hero={ACCOUNT_CONSTELLATION ? undefined : <AccountDeckHero section={activeSection} user={u} adminLabel={t.users.admin} />}
      >
      <AccountPanel id="memory" active={section} visited={visitedSections}>
        <ConstellationMaybe core={t.account.tabMemory}><AccountMemorySection onSaveState={reportSaveState} /></ConstellationMaybe>
      </AccountPanel>
      <AccountPanel id="personality" active={section} visited={visitedSections}>
        <ConstellationMaybe core={t.account.tabPersonality}><PersonalitySection onSaveState={reportSaveState} /></ConstellationMaybe>
      </AccountPanel>
      <AccountPanel id="terminal" active={section} visited={visitedSections}>
        <ConstellationMaybe core={t.account.tabTerminal}><TerminalSection onSaveState={reportSaveState} /></ConstellationMaybe>
      </AccountPanel>

      {/* Elowen AI runtime controls. Default models live at the top of the profile workspace, where
          users see their most consequential personal preference immediately. */}
      <AccountPanel id="cli" active={section} visited={visitedSections}>
        <ConstellationMaybe core={t.account.tabCli}><CliSection onSaveState={reportSaveState} /></ConstellationMaybe>
      </AccountPanel>

      <AccountPanel id="profile" active={section} visited={visitedSections}>
      <ConstellationMaybe core={t.account.tabProfile}>
      {(() => {
        // PROTOTYPE(constellation): the same rows feed both layouts — one merged orbit in cosmos
        // mode, the original four themed groups in the classic layout.
        const rowWorker = workerExecs.length > 0 ? (
          <SpatialRow title={t.account.defaultWorker} description={t.account.defaultWorkerHint} icon={Cpu}>
            <WorkerField
              value={defaultExec}
              onChange={setDefaultExec}
              execs={workerExecs}
              labelOf={labelOf}
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
        // Discord / WhatsApp account links — map the platform identity to this Elowen account.
        const rowDiscord = (
          <SpatialRow title={t.account.discordId} icon={AtSign} description={t.help.accountDiscordId}>
            <Input value={discordUserId} onChange={(e) => setDiscordUserId(e.target.value)} placeholder="123456789012345678" className="font-mono sm:w-72" aria-label={t.account.discordId} />
          </SpatialRow>
        );
        const rowWhatsapp = (
          <SpatialRow title={t.account.whatsappNumber} icon={MessageCircle} description={t.help.accountWhatsappNumber}>
            <Input value={whatsappNumber} onChange={(e) => setWhatsappNumber(e.target.value)} placeholder="420778433908" className="font-mono sm:w-72" aria-label={t.account.whatsappNumber} />
          </SpatialRow>
        );
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

            {ACCOUNT_CONSTELLATION ? (
              <SpatialGroup>
                {rowWorker}{rowElowen}{rowName}{rowEmail}{rowUiScale}{rowEffects}{rowDiscord}{rowWhatsapp}
              </SpatialGroup>
            ) : (
              <>
                <SpatialGroup
                  title={t.account.defaultModel}
                  icon={Cpu}
                  description={restricted ? t.account.restrictedHint : t.account.defaultModelHint}
                >
                  {rowWorker}
                  {rowElowen}
                  {workerExecs.length === 0 && elowenModels.length === 0 ? (
                    <p className="py-4 text-xs italic text-text-muted">{t.account.noModelLimit}</p>
                  ) : null}
                </SpatialGroup>
                <SpatialGroup>{rowName}{rowEmail}</SpatialGroup>
                <SpatialGroup>{rowUiScale}{rowEffects}</SpatialGroup>
                <SpatialGroup>{rowDiscord}{rowWhatsapp}</SpatialGroup>
              </>
            )}
          </div>
        );
      })()}
      </ConstellationMaybe>
      </AccountPanel>

      <AccountPanel id="security" active={section} visited={visitedSections}>
      <ConstellationMaybe core={t.account.tabSecurity}>
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
        if (!ACCOUNT_CONSTELLATION) {
          return (
            <SpatialGroup title={t.account.password} icon={KeyRound} description={t.account.passwordHint}>
              {passwordForm}
            </SpatialGroup>
          );
        }
        // PROTOTYPE(constellation): the pod shows a masked hint; the form opens in a side drawer
        // via the pod's orb.
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
      </ConstellationMaybe>
      </AccountPanel>

      <AccountPanel id="notifications" active={section} visited={visitedSections}>
        {/* Phone push — a per-device opt-in. Subscribes this browser/device for off-device alerts.
           Rendered as an inline toggle row (like the other account settings) instead of a detached
           right-aligned button, so the control reads as a setting, not a submit form. */}
        {pushSupported ? (
          <ConstellationMaybe core={t.account.tabNotifications}>
          <SpatialGroup>
          <SpatialRow title={t.push.title} icon={Bell} description={t.help.pushEnable}>
            <label className="flex items-center gap-3 text-sm text-text">
              <Toggle checked={pushOn} onChange={togglePush} disabled={pushBusy} label={t.push.deviceToggle} />
              <span>{t.push.deviceToggle}</span>
            </label>
          </SpatialRow>
          </SpatialGroup>
          </ConstellationMaybe>
        ) : <p className="text-sm text-text-muted">{t.push.unsupported}</p>}
      </AccountPanel>
      </SpatialControlDeck>
    </div>
  );
}
