'use client';
import { useState, useEffect, useRef } from 'react';
import { UserCog, Mail, Cpu, Upload, ShieldCheck, Check, User as UserIcon, KeyRound, ZoomIn, Bell, MessagesSquare, Sparkles, AtSign, Brain } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { OrcaApiError } from '../../lib/orcaClient';
import { useMe, useConfig, useMyCliSettings, useBrainModels } from '../../lib/queries';
import { useUpdateMe, useUploadAvatar, useChangePassword, useSaveMyCliSettings } from '../../lib/mutations';
import { allModels } from '../../lib/execPresets';
import { execProvider } from '../../lib/modelProvider';
import { PROVIDERS, ProviderLogo } from '../settings/providers';
import { Avatar } from '../../components/ui/Avatar';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { SettingCard } from '../../components/ui/SettingCard';
import { Slider } from '../../components/ui/Slider';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { LoadingState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { usePersistentState } from '../../lib/usePersistentState';
import { useAutoSave } from '../../lib/useAutoSave';
import { useUiScale, MIN_SCALE, MAX_SCALE, DEFAULT_SCALE } from '../../lib/useUiScale';
import { isPushSupported, enablePush, disablePush } from '../../lib/pushClient';
import { SettingsLayout } from '../../components/ui/SettingsLayout';
import { PromptsSection } from './PromptsSection';
import { PersonalitySection } from './PersonalitySection';
import { CliSection } from './CliSection';
import { AccountMemorySection } from './AccountMemorySection';

/** One selectable model card in the default-model rail: brand icon + label + a monospace sub-line,
 *  accent-outlined + checked when it's the active default. Shared by the worker and Orca AI groups. */
function ModelCard({ on, icon, label, sub, onClick }: { on: boolean; icon: string; label: string; sub: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      className={`group flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${on ? 'border-accent bg-accent/10' : 'border-border bg-surface hover:bg-elevated'}`}
      style={{ transitionDuration: 'var(--motion-fast)' }}
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-elevated">
        <ModelIcon name={icon} size={28} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-text">{label}</span>
        <span className="truncate font-mono text-tiny text-text-muted">{sub}</span>
      </span>
      {on ? <Check size={16} className="ml-auto shrink-0 text-accent" aria-hidden /> : null}
    </button>
  );
}

export function AccountView() {
  const me = useMe();
  const { data: config } = useConfig();
  const cli = useMyCliSettings();
  const brainModels = useBrainModels();
  const updateMe = useUpdateMe();
  const saveCli = useSaveMyCliSettings();
  const uploadAvatar = useUploadAvatar();
  const changePassword = useChangePassword();
  const { toast } = useToast();
  const { t } = useTranslation();
  const { scale, setScale } = useUiScale();
  const fileRef = useRef<HTMLInputElement>(null);
  const scalePct = Math.round(scale * 100);
  const [section, setSection] = usePersistentState<'profile' | 'security' | 'notifications' | 'prompts' | 'personality' | 'cli' | 'memory'>(
    'orca.account.section', 'profile', ['profile', 'security', 'notifications', 'prompts', 'personality', 'cli', 'memory']);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [defaultExec, setDefaultExec] = useState('');
  // The user's default Orca AI chat model, kept as `provider::model` ('' = server default). Lives in
  // cliSettings (not on the User) — seeded once, then this local state drives the picker highlight.
  const [orcaSel, setOrcaSel] = useState('');
  const [orcaSeeded, setOrcaSeeded] = useState(false);
  // Discord account link lives in cliSettings; seeded alongside the Orca-AI default, autosaved on change.
  const [discordUserId, setDiscordUserId] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
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
  const saveProfile = () => updateMe.mutate(
    { name: name.trim(), email: email.trim(), default_exec: defaultExec },
    { onError: () => toast(t.account.saveError, 'error') },
  );
  useAutoSave([name, email, defaultExec], saveProfile, { ready: formSeeded });

  // Seed the Orca-AI default once cliSettings load; thereafter local state is the source of truth.
  useEffect(() => {
    if (cli.data && !orcaSeeded) {
      setOrcaSel(cli.data.model ? `${cli.data.modelProvider ?? ''}::${cli.data.model}` : '');
      setDiscordUserId(cli.data.discordUserId ?? '');
      setOrcaSeeded(true);
    }
  }, [cli.data, orcaSeeded]);
  // Autosave the Discord link (cli-settings PATCH merges, so the model picks stay untouched).
  useAutoSave([discordUserId], () => saveCli.mutate({ discordUserId }), { ready: orcaSeeded });

  // Picking an Orca AI model writes ONLY model+modelProvider (the cli-settings PATCH merges, so the
  // CLI tab's other fields are untouched) and the daemon restarts a running brain on the new model.
  const pickOrca = (provider: string, model: string) => {
    const key = `${provider}::${model}`;
    const prev = orcaSel;
    const next = orcaSel === key ? '' : key;
    setOrcaSel(next);
    saveCli.mutate(
      { model: next ? model : '', modelProvider: next ? provider : '' },
      // Revert the optimistic highlight if the server rejects the pick, so it can't drift from state.
      { onError: () => { setOrcaSel(prev); toast(t.account.saveError, 'error'); } },
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
    return <><ModuleHeader title={t.account.title} icon={UserCog} /><LoadingState /></>;
  }

  const u = me.data.user;
  const custom = config?.customModels ?? [];
  // Models the user may pick a default from: their admin allow-list, or all globally-allowed when
  // they have no per-user restriction.
  const restricted = u.allowed_execs.length > 0;
  const pickable = restricted ? u.allowed_execs : (config?.allowedExecs ?? []);
  const labelOf = (exec: string) => allModels(custom).find((m) => m.exec === exec)?.label ?? exec;

  // Split the pickable execs into worker engines (set default_exec) vs the embedded Orca AI brain (set
  // the cli-settings chat model) — the two defaults live apart, shown side by side and grouped by
  // provider. Worker groups come off the exec prefix; Orca groups off the brain catalog's real upstream.
  const workerGroups = PROVIDERS.filter((p) => p.id !== 'orca')
    .map((p) => ({ meta: p, execs: pickable.filter((e) => execProvider(e) === p.id) }))
    .filter((g) => g.execs.length > 0);
  // Orca AI chat models: honour a user's personal allow-list even as admin (mirrors the worker rail +
  // the Discord /model fix) — brainModels is already per-user-scoped server-side for non-admins.
  const orcaModels = (brainModels.data ?? []).filter((m) => !restricted || u.allowed_execs.includes(m.exec));
  const orcaGroups = Object.values(
    orcaModels.reduce<Record<string, { label: string; provider: string; models: typeof orcaModels }>>((acc, m) => {
      (acc[m.provider] ??= { label: m.providerLabel, provider: m.provider, models: [] }).models.push(m);
      return acc;
    }, {}),
  );

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
        onError: (e) => toast(e instanceof OrcaApiError && e.status === 403 ? t.account.passwordWrong : t.account.passwordError, 'error'),
      },
    );
  };
  const canSubmitPassword = currentPassword.length > 0 && newPassword.length >= 8 && newPassword === confirmPassword;

  const sections: { id: 'profile' | 'security' | 'notifications' | 'prompts' | 'personality' | 'cli' | 'memory'; icon: LucideIcon; label: string }[] = [
    { id: 'profile', icon: UserCog, label: t.account.tabProfile },
    { id: 'security', icon: KeyRound, label: t.account.tabSecurity },
    { id: 'notifications', icon: Bell, label: t.account.tabNotifications },
    { id: 'cli', icon: Cpu, label: t.account.tabCli },
    { id: 'memory', icon: Brain, label: t.account.tabMemory },
    { id: 'prompts', icon: MessagesSquare, label: t.account.tabPrompts },
    { id: 'personality', icon: Sparkles, label: t.account.tabPersonality },
  ];

  return (
    <>
      <ModuleHeader title={t.account.title} icon={UserCog} />

      <SettingsLayout
        ariaLabel={t.account.sectionsNav}
        sections={sections.map(({ id, icon, label }) => ({ id, label, icon }))}
        value={section}
        onChange={(v) => setSection(v as typeof section)}
      >
      {section === 'cli' ? <CliSection /> : section === 'memory' ? <AccountMemorySection /> : section === 'prompts' ? <PromptsSection /> : section === 'personality' ? <PersonalitySection /> : null}

      {section === 'profile' ? (
      <div className="@container">
      <div className="flex flex-col gap-6 @3xl:flex-row @3xl:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-6">
        {/* Identity hero — avatar, display name, admin badge, avatar upload. */}
        <div className="flex items-center gap-4 rounded-xl border border-border bg-surface p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
          <Avatar user={u} size={72} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-lg font-semibold text-text">{u.name || u.username}</span>
              {u.is_admin ? <Badge tone="accent"><ShieldCheck size={11} className="mr-1" aria-hidden />{t.users.admin}</Badge> : null}
            </span>
            <span className="truncate font-mono text-xs text-text-muted">@{u.username}</span>
          </div>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={onFile} />
          <Button variant="ghost" icon={Upload} onClick={() => fileRef.current?.click()} disabled={uploadAvatar.isPending}>{t.account.uploadAvatar}</Button>
        </div>

        <div className="@container">
        <div className="grid grid-cols-1 gap-4 @sm:grid-cols-2">
          <SettingCard title={t.account.name} icon={UserIcon}>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </SettingCard>
          <SettingCard title={t.account.email} icon={Mail}>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </SettingCard>
        </div>
        </div>

        {/* Whole-app zoom — a per-device display preference, applied live via the UiScaleProvider. */}
        <SettingCard title={t.account.uiScale} icon={ZoomIn} description={t.help.accountUiScale}>
          <div className="flex items-center gap-4">
            <Slider value={scalePct} min={MIN_SCALE * 100} max={MAX_SCALE * 100} step={5} onChange={(v) => setScale(v / 100)} aria-label={t.account.uiScale} />
            <span className="w-12 shrink-0 text-right font-mono text-sm tabular-nums text-text">{scalePct}%</span>
            <Button variant="ghost" onClick={() => setScale(DEFAULT_SCALE)} disabled={scalePct === DEFAULT_SCALE * 100}>{t.account.uiScaleReset}</Button>
          </div>
        </SettingCard>

        {/* Discord account link — maps your Discord user to this Orca account (owner persona on Discord). */}
        <SettingCard title={t.account.discordId} icon={AtSign} description={t.help.accountDiscordId}>
          <Input value={discordUserId} onChange={(e) => setDiscordUserId(e.target.value)} placeholder="123456789012345678" className="max-w-xs font-mono" aria-label={t.account.discordId} />
        </SettingCard>

      </div>

      {/* Right rail: the models you may run — the default worker and the default Orca AI chat model,
          each grouped by provider. Tapping a card makes it that default (they are separate settings). */}
      <div className="flex shrink-0 flex-col gap-4 @3xl:w-72">
        <div className="flex flex-col gap-1.5">
          <span className="flex items-center gap-2 text-sm font-medium text-text">
            <Cpu size={16} className="text-text-muted" aria-hidden />{t.account.defaultModel}
          </span>
          <p className="text-xs text-text-muted">{restricted ? t.account.restrictedHint : t.account.defaultModelHint}</p>
        </div>

        {workerGroups.length === 0 && orcaGroups.length === 0 ? (
          <p className="text-xs italic text-text-muted">{t.account.noModelLimit}</p>
        ) : null}

        {/* Default worker (default_exec) */}
        {workerGroups.length > 0 ? (
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-col gap-0.5">
              <span className="text-tiny font-semibold uppercase tracking-wide text-text-muted">{t.account.defaultWorker}</span>
              <span className="text-tiny text-text-muted">{t.account.defaultWorkerHint}</span>
            </div>
            {workerGroups.map((g) => (
              <div key={g.meta.id} className="flex flex-col gap-1.5">
                <span className="flex items-center gap-1.5 text-xs text-text-muted"><ProviderLogo meta={g.meta} size={18} />{g.meta.label}</span>
                <div role="radiogroup" className="flex flex-col gap-2">
                  {g.execs.map((exec) => (
                    <ModelCard
                      key={exec} on={defaultExec === exec} icon={exec} label={labelOf(exec)} sub={exec}
                      onClick={() => setDefaultExec(defaultExec === exec ? '' : exec)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {/* Default Orca AI model — the embedded brain used by BOTH the web chat and the orca chat
            CLI (cliSettings.model), not just chat. */}
        {orcaGroups.length > 0 ? (
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-col gap-0.5">
              <span className="text-tiny font-semibold uppercase tracking-wide text-text-muted">{t.account.defaultOrcaAi}</span>
              <span className="text-tiny text-text-muted">{t.account.defaultOrcaAiHint}</span>
            </div>
            {orcaGroups.map((g) => (
              <div key={g.provider} className="flex flex-col gap-1.5">
                <span className="text-xs text-text-muted">{g.label}</span>
                <div role="radiogroup" className="flex flex-col gap-2">
                  {g.models.map((m) => (
                    <ModelCard
                      key={m.exec} on={orcaSel === `${m.provider}::${m.model}`} icon={m.model} label={m.model} sub={g.label}
                      onClick={() => pickOrca(m.provider, m.model)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      </div>
      </div>
      ) : null}

      {section === 'security' ? (
        /* Password change — verified server-side against the current password. */
        <SettingCard title={t.account.password} icon={KeyRound}>
          <p className="mb-3 text-xs text-text-muted">{t.account.passwordHint}</p>
          <form
            className="flex flex-col gap-3"
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
        </SettingCard>
      ) : null}

      {section === 'notifications' ? (
        /* Phone push — a per-device opt-in. Subscribes this browser/device for off-device alerts. */
        pushSupported ? (
          <SettingCard title={t.push.title} icon={Bell} description={t.help.pushEnable}>
            <div className="flex justify-end">
              <Button variant={pushOn ? 'ghost' : 'accent'} icon={Bell} onClick={togglePush} disabled={pushBusy}>
                {pushOn ? t.push.disable : t.push.enable}
              </Button>
            </div>
          </SettingCard>
        ) : <p className="text-sm text-text-muted">{t.push.unsupported}</p>
      ) : null}
      </SettingsLayout>
    </>
  );
}
