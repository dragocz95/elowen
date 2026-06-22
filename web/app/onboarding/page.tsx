'use client';
export const dynamic = 'force-dynamic';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2, XCircle, AlertCircle, Save, Key, Users,
  Radio, Terminal, HardDrive, UserPlus, ArrowRight, Bot, Eye,
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
import { useCliStatus, useConfig, useUsers } from '../../lib/queries';
import { useUpdateConfig, useCreateUser } from '../../lib/mutations';
import { PROVIDERS } from '../../modules/settings/providers';
import { useHermesForm } from '../../modules/settings/useHermesForm';
import { Segmented } from '../../components/ui/Segmented';
import { Select } from '../../components/ui/Select';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { allModels } from '../../lib/execPresets';
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

  // Autopilot backend: either 'relay' (API key) or 'agents' (CLI agents). One or the other.
  const [reasoningMode, setReasoningMode] = useState<'relay' | 'agents'>('relay');
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [pilotExec, setPilotExec] = useState('');
  const [overseerExec, setOverseerExec] = useState('');

  // Hermes form — state + status + install shared with Settings (useHermesForm).
  const { home: hHome, setHome: setHHome, url: hUrl, setUrl: setHUrl, token: hToken, setToken: setHToken, status: hermesStatus, install: hermesInstall } = useHermesForm();

  // User form
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');

  // Pre-fill forms from config
  useEffect(() => {
    if (config.data) {
      setProviders(config.data.providers ?? {});
      setApiUrl(config.data.autopilot.apiUrl);
      setPilotExec(config.data.autopilot.pilotExec ?? '');
      setOverseerExec(config.data.autopilot.overseerExec ?? '');
      setReasoningMode((config.data.autopilot.pilotExec || config.data.autopilot.overseerExec) ? 'agents' : 'relay');
    }
  }, [config.data]);

  const models = allModels(config.data?.customModels, config.data?.hiddenPresets);
  const switchReasoning = (m: 'relay' | 'agents') => {
    setReasoningMode(m);
    if (m === 'relay') { setPilotExec(''); setOverseerExec(''); }
    else { const def = models[0]?.exec ?? ''; if (!pilotExec) setPilotExec(def); if (!overseerExec) setOverseerExec(def); }
  };
  const handleSaveAgents = () => {
    updateConfig.mutate(
      { autopilot: { pilotExec, overseerExec } },
      { onSuccess: () => toast(t.onboarding.keySaved), onError: (e) => toast(String(e), 'error') },
    );
  };

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

  const handleCreateUser = async () => {
    const username = newUsername.trim(), password = newPassword.trim();
    if (!username || !password) return;
    // Setup mode = the daemon still reports needsSetup (no admin yet); this user becomes the bootstrap
    // admin. Derived from the daemon's own status, not a client token (which no longer exists).
    let firstRun = false;
    try { firstRun = (await orcaClient.setupStatus()).needsSetup; } catch { /* assume not first-run */ }
    createUser.mutate(
      { username, password },
      {
        onSuccess: async () => {
          toast(t.onboarding.userCreated); setNewUsername(''); setNewPassword('');
          // In setup mode the daemon was open; the moment the first admin exists, auth re-engages.
          // Log that admin in immediately (the proxy sets the httpOnly cookie) so the app unlocks
          // seamlessly instead of bouncing to login.
          if (firstRun) {
            try { await orcaClient.login(username, password); } catch { /* fall back to manual login */ }
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

  // The autopilot backend is ready with EITHER a relay API key OR a configured CLI agent.
  // Explicit isFresh guard: while CLI status is still loading (isFresh undefined) the backend
  // is NOT assumed ready, so we never flash "setup complete" before the data arrives.
  const backendReady = isFresh
    ? (!isFresh.noApiKey || !!(config.data?.autopilot.pilotExec || config.data?.autopilot.overseerExec))
    : false;
  const allStepsDone = !isFresh?.noConfigPersisted && backendReady && users.data && users.data.length > 0;

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

            {/* Autopilot backend — one choice: Relay (API key) OR CLI agents. */}
            <SectionCard title={t.onboarding.autopilotBackend} icon={Key}>
              <p className="mb-3 text-xs text-text-muted">{t.onboarding.autopilotBackendDesc}</p>
              <Segmented
                value={reasoningMode}
                onChange={(v) => switchReasoning(v as 'relay' | 'agents')}
                options={[
                  { value: 'relay', label: t.settings.modeRelay, icon: Radio },
                  { value: 'agents', label: t.settings.modeAgents, icon: Bot },
                ]}
              />
              <p className="mt-2 mb-4 text-xs text-text-muted">{reasoningMode === 'relay' ? t.settings.modeRelayDesc : t.settings.modeAgentsDesc}</p>

              {reasoningMode === 'relay' ? (
                <>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label={t.onboarding.fieldApiUrl}>
                      <Input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} className="font-mono text-xs" />
                    </Field>
                    <Field label={t.onboarding.fieldApiKey}>
                      <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                        placeholder={config.data?.autopilot.apiKeySet ? t.settings.apiKeySetPlaceholder : ''} className="font-mono text-xs" />
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
                </>
              ) : (
                <>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label={t.settings.plannerModel}>
                      <div className="flex items-center gap-2">
                        {pilotExec ? <ModelIcon name={pilotExec} size={16} /> : <Bot size={14} className="text-text-muted" />}
                        <Select value={pilotExec} onChange={(e) => setPilotExec(e.target.value)}>
                          {models.map((m) => <option key={m.exec} value={m.exec}>{m.label}</option>)}
                        </Select>
                      </div>
                    </Field>
                    <Field label={t.settings.overseerModel}>
                      <div className="flex items-center gap-2">
                        {overseerExec ? <ModelIcon name={overseerExec} size={16} /> : <Eye size={14} className="text-text-muted" />}
                        <Select value={overseerExec} onChange={(e) => setOverseerExec(e.target.value)}>
                          {models.map((m) => <option key={m.exec} value={m.exec}>{m.label}</option>)}
                        </Select>
                      </div>
                    </Field>
                  </div>
                  <div className="mt-4 flex items-center justify-between">
                    <span className="text-xs text-text-muted">
                      {(config.data?.autopilot.pilotExec || config.data?.autopilot.overseerExec)
                        ? <><CheckCircle2 size={12} className="inline mr-1 text-[var(--color-success)]" />{t.onboarding.agentsSet}</>
                        : <><XCircle size={12} className="inline mr-1 text-[var(--color-error)]" />{t.onboarding.agentsNotSet}</>}
                    </span>
                    <Button variant="accent" icon={Save} onClick={handleSaveAgents}>{t.onboarding.saveBackend}</Button>
                  </div>
                </>
              )}
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
