'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2, XCircle, AlertCircle, Save, Key, Users,
  Radio, Terminal, HardDrive, UserPlus, ArrowRight,
  type LucideIcon,
} from 'lucide-react';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { Badge } from '../../components/ui/Badge';
import { useToast } from '../../components/ui/Toast';
import { LoadingState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';
import { useCliStatus, useConfig, useUsers, useHermesStatus } from '../../lib/queries';
import { useUpdateConfig, useCreateUser, useHermesInstall } from '../../lib/mutations';
import { PROVIDERS } from '../../modules/settings/providers';
import { getToken, setToken } from '../../lib/token';
import { orcaClient } from '../../lib/orcaClient';
import type { CliStatus as CliStatusType } from '../../lib/types';
import type { LocaleDict } from '../../lib/i18n/types';

const STATUS_TONES = {
  success: { dot: 'bg-[var(--color-success)]', bg: 'bg-[var(--color-success)]/10', border: 'border-[var(--color-success)]/30', text: 'text-[var(--color-success)]' },
  danger: { dot: 'bg-[var(--color-error)]', bg: 'bg-[var(--color-error)]/10', border: 'border-[var(--color-error)]/30', text: 'text-[var(--color-error)]' },
  muted: { dot: 'bg-[var(--color-text-muted)]', bg: 'bg-surface', border: 'border-border', text: 'text-text-muted' },
} as const;

function StatusDot({ tone }: { tone: keyof typeof STATUS_TONES }) {
  const t = STATUS_TONES[tone];
  return <span className={`inline-block h-2 w-2 rounded-full ${t.dot}`} aria-hidden />;
}

function CliRow({ tool, dict }: { tool: CliStatusType; dict: LocaleDict }) {
  const tone = tool.functional ? 'success' : 'danger';
  const st = STATUS_TONES[tone];
  return (
    <div className={`flex items-center gap-3 rounded-lg border px-4 py-3 ${st.bg} ${st.border}`}>
      <StatusDot tone={tone} />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="text-sm font-medium text-text uppercase tracking-wide">{tool.name}</span>
        <span className={`text-xs font-mono ${st.text}`}>
          {tool.functional ? (tool.version ?? '') : tool.error ?? dict.onboarding.statusNotFound}
        </span>
      </div>
      <span className={`shrink-0 text-xs font-medium ${st.text}`}>
        {tool.functional ? dict.onboarding.statusOk : dict.onboarding.statusFail}
      </span>
    </div>
  );
}

function SectionCard({ title, icon: Icon, children }: { title: string; icon?: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-5 py-4">
        {Icon ? <Icon size={16} className="text-text-muted" aria-hidden /> : null}
        <h2 className="text-sm font-semibold tracking-tight text-text">{title}</h2>
      </div>
      <div className="px-5 py-5">{children}</div>
    </div>
  );
}

export default function OnboardingPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const router = useRouter();

  const cliStatus = useCliStatus();
  const config = useConfig();
  const users = useUsers();
  const updateConfig = useUpdateConfig();
  const createUser = useCreateUser();

  // Provider form state
  const [providers, setProviders] = useState<Record<string, { bin: string; args: string }>>({});

  // API key form
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');

  // Hermes form
  const [hHome, setHHome] = useState('/var/www/.hermes');
  const [hUrl, setHUrl] = useState('');
  const [hToken, setHToken] = useState('');
  const hermesStatus = useHermesStatus(hHome);
  const hermesInstall = useHermesInstall();

  // User form
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');

  // Pre-fill forms from config
  useEffect(() => {
    if (config.data) {
      setProviders(config.data.providers ?? {});
      setApiUrl(config.data.autopilot.apiUrl);
    }
  }, [config.data]);

  useEffect(() => {
    setHUrl(process.env.NEXT_PUBLIC_ORCA_URL ?? (typeof window !== 'undefined' ? window.location.origin : ''));
    const tk = getToken();
    if (tk) setHToken(tk);
  }, []);

  const isLoading = cliStatus.isLoading || config.isLoading || users.isLoading;
  const isFresh = cliStatus.data?.freshInstall;
  const allFunctional = cliStatus.data?.summary.allFunctional ?? false;

  const handleSaveProviders = () => {
    updateConfig.mutate(
      { providers },
      { onSuccess: () => toast(t.onboarding.providerSaved), onError: (e) => toast(String(e), 'error') },
    );
  };

  const handleSaveApiKey = () => {
    updateConfig.mutate(
      { autopilot: { apiUrl, ...(apiKey ? { apiKey } : {}) } },
      { onSuccess: () => { toast(t.onboarding.keySaved); setApiKey(''); }, onError: (e) => toast(String(e), 'error') },
    );
  };

  const handleCreateUser = () => {
    const username = newUsername.trim(), password = newPassword.trim();
    if (!username || !password) return;
    const firstRun = getToken() == null; // setup mode — this becomes the bootstrap admin
    createUser.mutate(
      { username, password },
      {
        onSuccess: async () => {
          toast(t.onboarding.userCreated); setNewUsername(''); setNewPassword('');
          // In setup mode the daemon was open; the moment the first admin exists, auth re-engages.
          // Log that admin in immediately so the app unlocks seamlessly instead of bouncing to login.
          if (firstRun) {
            try { const res = await orcaClient.login(username, password); setToken(res.token); } catch { /* fall back to manual login */ }
          }
        },
        onError: (e) => toast(t.onboarding.userCreateError + ': ' + String(e), 'error'),
      },
    );
  };

  const handleInstallHermes = () => {
    hermesInstall.mutate(
      { home: hHome.trim() || undefined, url: hUrl.trim(), token: hToken.trim() },
      { onSuccess: () => toast(t.onboarding.pluginInstalled), onError: (e) => toast(String(e), 'error') },
    );
  };

  const allStepsDone = !isFresh?.noConfigPersisted && !isFresh?.noApiKey && users.data && users.data.length > 0;

  const agentTools = cliStatus.data?.tools.filter((t) => ['claude', 'codex', 'opencode'].includes(t.name)) ?? [];
  const sysTools = cliStatus.data?.tools.filter((t) => ['node', 'tmux', 'git'].includes(t.name)) ?? [];

  return (
    <ModuleShell moduleId="onboarding">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        {/* Header */}
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <img src="/orca-logo.png" alt="Orca" className="h-12 w-auto" />
          <h1 className="text-display font-bold tracking-tight text-text">{t.onboarding.title}</h1>
          <p className="max-w-md text-sm text-text-muted">{t.onboarding.subtitle}</p>
        </div>

        {/* Progress indicator */}
        {isFresh && (
          <div className="flex items-center justify-center gap-3 rounded-lg border border-border bg-surface px-5 py-3">
            {allStepsDone ? (
              <>
                <CheckCircle2 size={18} className="text-[var(--color-success)]" />
                <span className="text-sm font-medium text-[var(--color-success)]">{t.onboarding.setupComplete}</span>
              </>
            ) : (
              <>
                <AlertCircle size={18} className="text-[var(--color-warning)]" />
                <span className="text-sm text-text-muted">{t.onboarding.setupIncomplete}</span>
              </>
            )}
          </div>
        )}

        {isLoading ? (
          <LoadingState label={t.common.loading} />
        ) : (
          <>
            {/* System Dependencies */}
            <SectionCard title={t.onboarding.systemDeps} icon={Terminal}>
              <p className="mb-4 text-xs text-text-muted">{t.onboarding.systemDepsDesc}</p>

              <div className="mb-4 flex flex-col gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t.onboarding.sectionAgentCLIs}</span>
                {agentTools.map((tool) => (
                  <CliRow key={tool.name} tool={tool} dict={t} />
                ))}
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t.onboarding.sectionSystem}</span>
                {sysTools.map((tool) => (
                  <CliRow key={tool.name} tool={tool} dict={t} />
                ))}
              </div>

              <div className="mt-4 flex items-center gap-2 text-xs">
                {allFunctional ? (
                  <>
                    <CheckCircle2 size={13} className="text-[var(--color-success)]" />
                    <span className="text-[var(--color-success)]">{t.onboarding.allGood}</span>
                  </>
                ) : (
                  <>
                    <AlertCircle size={13} className="text-[var(--color-warning)]" />
                    <span className="text-text-muted">{t.onboarding.missingTools}</span>
                  </>
                )}
              </div>
            </SectionCard>

            {/* Provider Binaries */}
            <SectionCard title={t.onboarding.providers} icon={HardDrive}>
              <p className="mb-4 text-xs text-text-muted">{t.onboarding.providersDesc}</p>
              <div className="flex flex-col gap-4">
                {PROVIDERS.map((p) => {
                  const cur = providers[p.id] ?? { bin: p.binHint, args: '' };
                  const set = (patch: Partial<{ bin: string; args: string }>) =>
                    setProviders((prev) => ({ ...prev, [p.id]: { ...cur, ...patch } }));
                  return (
                    <div key={p.id} className="flex flex-col gap-3 rounded-lg border border-border bg-elevated/40 p-4 sm:flex-row sm:items-center">
                      <div className="flex items-center gap-3 sm:w-40 sm:shrink-0">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-elevated">
                          <img src={p.icon} alt="" width={22} height={22} style={{ objectFit: 'contain' }} />
                        </span>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-text">{p.label}</div>
                          <div className="font-mono text-[11px] text-text-muted">{p.id}</div>
                        </div>
                      </div>
                      <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
                        <Field label={t.onboarding.fieldBin}>
                          <Input value={cur.bin} placeholder={p.binHint} onChange={(e) => set({ bin: e.target.value })} className="font-mono text-xs" />
                        </Field>
                        <Field label={t.onboarding.fieldArgs}>
                          <Input value={cur.args} placeholder={p.argsHint} onChange={(e) => set({ args: e.target.value })} className="font-mono text-xs" />
                        </Field>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-4 flex justify-end">
                <Button variant="accent" icon={Save} onClick={handleSaveProviders}>{t.onboarding.saveProviders}</Button>
              </div>
            </SectionCard>

            {/* API Key */}
            <SectionCard title={t.onboarding.autopilotKey} icon={Key}>
              <p className="mb-4 text-xs text-text-muted">{t.onboarding.autopilotKeyDesc}</p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label={t.onboarding.fieldApiUrl}>
                  <Input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} className="font-mono text-xs" />
                </Field>
                <Field label={t.onboarding.fieldApiKey}>
                  <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                    placeholder={config.data?.autopilot.apiKeySet ? '•••• set' : ''} className="font-mono text-xs" />
                </Field>
              </div>
              <div className="mt-4 flex items-center justify-between">
                <span className="text-xs text-text-muted">
                  {config.data?.autopilot.apiKeySet
                    ? <><CheckCircle2 size={12} className="inline mr-1 text-[var(--color-success)]" />{t.onboarding.keySet}</>
                    : <><XCircle size={12} className="inline mr-1 text-[var(--color-error)]" />{t.onboarding.keyNotSet}</>}
                </span>
                <Button variant="accent" icon={Save} onClick={handleSaveApiKey}>{t.onboarding.saveKey}</Button>
              </div>
            </SectionCard>

            {/* Users */}
            <SectionCard title={t.onboarding.users} icon={Users}>
              <p className="mb-4 text-xs text-text-muted">{t.onboarding.usersDesc}</p>

              {/* Existing users */}
              {users.data && users.data.length > 0 ? (
                <div className="mb-4 flex flex-col gap-2">
                  {users.data.map((u) => (
                    <div key={u.id} className="flex items-center gap-3 rounded-lg border border-border bg-elevated/40 px-4 py-2.5">
                      <div className="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-elevated">
                        <span className="text-xs font-medium text-text-muted">{u.username.charAt(0).toUpperCase()}</span>
                      </div>
                      <span className="text-sm text-text">{u.username}</span>
                      <span className="ml-auto text-xs text-text-muted">{t.onboarding.userId}: {u.id}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-elevated/40 px-4 py-3">
                  <AlertCircle size={14} className="text-[var(--color-warning)] shrink-0" />
                  <span className="text-xs text-text-muted">{t.onboarding.noUsers}</span>
                </div>
              )}

              {/* Add user form */}
              <div className="flex flex-col gap-3 rounded-lg border border-border bg-elevated/40 p-4">
                <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t.onboarding.addUser}</span>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                  <div className="flex-1">
                    <Field label={t.onboarding.fieldUsername}>
                      <Input value={newUsername} onChange={(e) => setNewUsername(e.target.value)}
                        placeholder={t.onboarding.fieldUsername} className="font-mono text-xs" />
                    </Field>
                  </div>
                  <div className="flex-1">
                    <Field label={t.onboarding.fieldPassword}>
                      <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                        placeholder={t.onboarding.fieldPassword} className="font-mono text-xs" />
                    </Field>
                  </div>
                  <Button variant="accent" icon={UserPlus} disabled={!newUsername.trim() || !newPassword.trim() || createUser.isPending}
                    onClick={handleCreateUser} className="shrink-0">
                    {t.onboarding.createUser}
                  </Button>
                </div>
              </div>
            </SectionCard>

            {/* Hermes */}
            <SectionCard title={t.onboarding.hermes} icon={Radio}>
              <p className="mb-4 text-xs text-text-muted">{t.onboarding.hermesDesc}</p>

              <div className="flex flex-wrap items-center gap-2 mb-4">
                <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t.onboarding.pluginStatus}</span>
                {hermesStatus.isLoading ? (
                  <Badge tone="muted">{t.common.loading}</Badge>
                ) : hermesStatus.isError ? (
                  <Badge tone="warning">{t.onboarding.statusUnknown}</Badge>
                ) : (
                  <>
                    <Badge tone={hermesStatus.data?.pluginInstalled ? 'success' : 'danger'}>
                      {hermesStatus.data?.pluginInstalled ? t.onboarding.statusInstalled : t.onboarding.statusNotInstalled}
                    </Badge>
                    <Badge tone={hermesStatus.data?.enabled ? 'success' : 'danger'}>
                      {hermesStatus.data?.enabled ? t.onboarding.statusEnabled : t.onboarding.statusDisabled}
                    </Badge>
                  </>
                )}
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label={t.onboarding.fieldHome}>
                  <Input value={hHome} onChange={(e) => setHHome(e.target.value)} className="font-mono text-xs" />
                </Field>
                <Field label={t.onboarding.fieldUrl}>
                  <Input value={hUrl} onChange={(e) => setHUrl(e.target.value)} className="font-mono text-xs" />
                </Field>
                <Field label={t.onboarding.fieldToken}>
                  <Input type="password" value={hToken} onChange={(e) => setHToken(e.target.value)} className="font-mono text-xs" />
                </Field>
              </div>

              <div className="mt-4 flex flex-col gap-3">
                <Button variant="accent" className="self-start" disabled={hermesInstall.isPending || !hUrl.trim() || !hToken.trim()} onClick={handleInstallHermes}>
                  {hermesInstall.isPending ? t.onboarding.installing : t.onboarding.installPlugin}
                </Button>
                <p className="text-xs text-text-muted">{t.onboarding.restartNote}</p>
              </div>
            </SectionCard>

            {/* Action bar */}
            <div className="flex items-center justify-center gap-4 border-t border-border pt-6 pb-8">
              <Button variant="accent" icon={ArrowRight} onClick={() => router.push('/dash')}>
                {t.onboarding.goToDashboard}
              </Button>
            </div>
          </>
        )}
      </div>
    </ModuleShell>
  );
}
