'use client';
import { useState, useEffect, useRef } from 'react';
import { UserCog, Mail, Cpu, Upload, ShieldCheck, Save, Check, User as UserIcon, KeyRound, ZoomIn } from 'lucide-react';
import { useMe, useConfig } from '../../lib/queries';
import { useUpdateMe, useUploadAvatar, useChangePassword } from '../../lib/mutations';
import { allModels } from '../../lib/execPresets';
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
import { useUiScale, MIN_SCALE, MAX_SCALE, DEFAULT_SCALE } from '../../lib/useUiScale';

export function AccountView() {
  const me = useMe();
  const { data: config } = useConfig();
  const updateMe = useUpdateMe();
  const uploadAvatar = useUploadAvatar();
  const changePassword = useChangePassword();
  const { toast } = useToast();
  const { t } = useTranslation();
  const { scale, setScale } = useUiScale();
  const fileRef = useRef<HTMLInputElement>(null);
  const scalePct = Math.round(scale * 100);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [defaultExec, setDefaultExec] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  useEffect(() => {
    if (me.data?.user) {
      setName(me.data.user.name);
      setEmail(me.data.user.email);
      setDefaultExec(me.data.user.default_exec);
    }
  }, [me.data]);

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

  const save = () => updateMe.mutate(
    { name: name.trim(), email: email.trim(), default_exec: defaultExec },
    { onSuccess: () => toast(t.account.saved), onError: (e) => toast(String(e) || t.account.saveError, 'error') },
  );
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) uploadAvatar.mutate(f, { onSuccess: () => toast(t.account.avatarSaved), onError: (er) => toast(String(er) || t.account.saveError, 'error') });
    e.target.value = ''; // allow re-selecting the same file
  };
  const submitPassword = () => {
    if (newPassword.length < 8) { toast(t.account.passwordTooShort, 'error'); return; }
    if (newPassword !== confirmPassword) { toast(t.account.passwordMismatch, 'error'); return; }
    changePassword.mutate(
      { currentPassword, newPassword },
      {
        onSuccess: () => { setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); toast(t.account.passwordChanged); },
        onError: (e) => toast(String(e) || t.account.passwordError, 'error'),
      },
    );
  };
  const canSubmitPassword = currentPassword.length > 0 && newPassword.length >= 8 && newPassword === confirmPassword;

  return (
    <>
      <ModuleHeader title={t.account.title} icon={UserCog}>
        <Button variant="accent" icon={Save} onClick={save} disabled={updateMe.isPending}>{t.account.save}</Button>
      </ModuleHeader>

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        {/* Left rail: the models you may run, big icons — tap one to make it your default. */}
        <div className="flex shrink-0 flex-col gap-2 lg:w-72">
          <span className="flex items-center gap-2 text-sm font-medium text-text">
            <Cpu size={16} className="text-text-muted" aria-hidden />{t.account.defaultModel}
          </span>
          <p className="text-xs text-text-muted">{restricted ? t.account.restrictedHint : t.account.defaultModelHint}</p>
          {pickable.length === 0 ? (
            <p className="mt-1 text-xs italic text-text-muted">{t.account.noModelLimit}</p>
          ) : (
            <div role="radiogroup" className="mt-1 flex flex-col gap-2">
              {pickable.map((exec) => {
                const on = defaultExec === exec;
                return (
                  <button
                    key={exec}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={labelOf(exec)}
                    onClick={() => setDefaultExec(on ? '' : exec)}
                    className={`group flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${on ? 'border-accent bg-accent/10' : 'border-border bg-surface hover:bg-elevated'}`}
                    style={{ transitionDuration: 'var(--motion-fast)' }}
                  >
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-elevated">
                      <ModelIcon name={exec} size={28} />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium text-text">{labelOf(exec)}</span>
                      <span className="truncate font-mono text-tiny text-text-muted">{exec}</span>
                    </span>
                    {on ? <Check size={16} className="ml-auto shrink-0 text-accent" aria-hidden /> : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Main: identity + profile, full width. */}
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="flex items-center gap-4 rounded-lg border border-border bg-surface p-5">
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

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SettingCard title={t.account.name} icon={UserIcon}>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </SettingCard>
            <SettingCard title={t.account.email} icon={Mail}>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </SettingCard>
          </div>

          {/* Password change — verified server-side against the current password. */}
          <SettingCard title={t.account.password} icon={KeyRound}>
            <p className="mb-3 text-xs text-text-muted">{t.account.passwordHint}</p>
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => { e.preventDefault(); submitPassword(); }}
            >
              {/* Username hint helps password managers associate the credential. */}
              <input type="text" name="username" autoComplete="username" value={u.username} readOnly hidden />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
              <div className="flex justify-end">
                <Button type="submit" variant="accent" icon={KeyRound} disabled={!canSubmitPassword || changePassword.isPending}>
                  {t.account.changePassword}
                </Button>
              </div>
            </form>
          </SettingCard>

          {/* Whole-app zoom — a per-device display preference, applied live via the UiScaleProvider. */}
          <SettingCard title={t.account.uiScale} icon={ZoomIn} description={t.account.uiScaleHint}>
            <div className="flex items-center gap-4">
              <Slider value={scalePct} min={MIN_SCALE * 100} max={MAX_SCALE * 100} step={5} onChange={(v) => setScale(v / 100)} aria-label={t.account.uiScale} />
              <span className="w-12 shrink-0 text-right font-mono text-sm tabular-nums text-text">{scalePct}%</span>
              <Button variant="ghost" onClick={() => setScale(DEFAULT_SCALE)} disabled={scalePct === DEFAULT_SCALE * 100}>{t.account.uiScaleReset}</Button>
            </div>
          </SettingCard>
        </div>
      </div>
    </>
  );
}
