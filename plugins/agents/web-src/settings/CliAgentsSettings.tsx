import { useEffect, useRef, useState } from 'react';
import { Sparkles, SquareTerminal } from 'lucide-react';
import { runtime, type CliProviderConfig } from '../runtime';

/** The moved core Settings → CLI Agents section: the workflow-skill installer status and the per-agent
 *  launch configuration (binary, args, permission/resume toggles). Reads and writes the SAME main
 *  config key as before (`providers` over GET/PUT /config) — only the component moved into the plugin
 *  bundle. */
export function CliAgentsSettings({ surface, plugin, params }: { surface: 'page' | 'deck'; plugin: string; params: Record<string, string> }) {
  const { components: C, hooks, utils } = runtime();
  const s = hooks.usePluginStrings('agents');
  const { t } = hooks.useTranslation();
  const { toast } = hooks.useToast();
  const config = hooks.useConfig();
  const update = hooks.useUpdateConfig();
  const systemSkills = hooks.useSystemSkills();
  const installSkills = hooks.useInstallSkills();

  const [providers, setProviders] = useState<Record<string, CliProviderConfig>>({});
  // Seed ONCE from the config (a refetch must not clobber in-progress edits).
  const seeded = useRef(false);
  useEffect(() => {
    if (config.data && !seeded.current) { seeded.current = true; setProviders(config.data.providers ?? {}); }
  }, [config.data]);

  const saveProviders = async () => {
    try { await update.mutateAsync({ providers }); }
    catch (error) { toast(String(error), 'error'); throw error; }
  };
  const providersSave = hooks.useAutoSaveStatus([providers], saveProviders, { ready: seeded.current });

  if (config.isLoading) return <C.LoadingState variant="list" />;
  if (config.isError) return <C.ErrorState message={t.common.daemonUnreachable} onRetry={() => config.refetch()} />;

  return (
    <C.PluginPageFrame surface={surface} plugin={plugin} section={params.id}>
      <div className="flex flex-col gap-4">
      {/* Agent skills sit at the top — they install/verify the `elowen-workflow` skill into the very
          CLI agents this section configures. The daemon self-installs on startup; this is the
          on-demand re-apply + per-provider status. */}
      <C.SettingsGroup
        title={s.agentSkills}
        description={s.agentSkillsHint}
        icon={Sparkles}
        actions={<C.Button
            variant="accent"
            className="h-8 shrink-0"
            disabled={installSkills.isPending || !(systemSkills.data?.skills ?? []).some((sk) => sk.present && !sk.upToDate)}
            onClick={() => installSkills.mutate(undefined, {
              onSuccess: () => toast(s.skillsInstalled),
              onError: (e: unknown) => toast(String(e), 'error'),
            })}
          >
            {installSkills.isPending ? s.skillInstalling : s.skillInstall}
          </C.Button>}
      >
        {/* Per-provider status pills, laid out to wrap side by side so the block stays compact. */}
        <div className="settings-skill-statuses">
          {(systemSkills.data?.skills ?? []).map((sk) => {
            const tone = !sk.present ? 'muted' : sk.upToDate ? 'success' : sk.installed ? 'warning' : 'default';
            const label = !sk.present ? s.skillProviderAbsent : sk.upToDate ? s.skillUpToDate : sk.installed ? s.skillOutdated : s.skillMissing;
            return (
              <div key={sk.provider} className="flex items-center gap-2">
                <span className="font-mono text-sm text-text">{sk.provider}</span>
                <C.Badge tone={tone}>{label}</C.Badge>
              </div>
            );
          })}
        </div>
      </C.SettingsGroup>
      <C.SettingsGroup title={s.cliAgents} description={s.cliAgentsHint} icon={SquareTerminal} density="compact" actions={<C.AutoSaveStatus status={providersSave.status} onRetry={providersSave.retry} />}>
        {utils.cliProviders.map((p) => {
          const cur = providers[p.id] ?? { bin: p.binHint, args: '', skipPermissions: true, resume: true };
          const set = (patch: Partial<CliProviderConfig>) => setProviders((prev) => ({ ...prev, [p.id]: { ...cur, ...patch } }));
          return (
            <div key={p.id} className="settings-agent-row @container">
            <div className="flex flex-col gap-3 @sm:flex-row @sm:items-start">
              <div className="flex items-center gap-3 @sm:w-44 @sm:shrink-0 @sm:pt-1">
                <C.ProviderLogo meta={p} alt={p.label} size={56} />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-medium text-text">
                    {p.label}
                    {p.embedded ? <C.HelpTip align="left">{s.embeddedProviderHint}</C.HelpTip> : null}
                  </div>
                  <div className="font-mono text-[11px] text-text-muted">{p.id}</div>
                </div>
              </div>
              {p.embedded ? null : (
              <div className="flex flex-1 flex-col gap-3">
                <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
                  <C.Field label={s.binary}>
                    <C.Input value={cur.bin} placeholder={p.binHint} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ bin: e.target.value })} className="font-mono text-xs" />
                  </C.Field>
                  <C.Field label={s.extraArgs}>
                    <C.Input value={cur.args} placeholder={p.argsHint} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ args: e.target.value })} className="font-mono text-xs" />
                  </C.Field>
                </div>
                {p.noBypassFlag ? (
                  <p className="border-t border-border/70 pt-2 text-[11px] leading-relaxed text-text-muted">{s.skipPermissionsNoop}</p>
                ) : (
                  <label className="flex items-center justify-between gap-3 border-t border-border/70 pt-2">
                    <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-text">
                      {s.skipPermissions}
                      <C.HelpTip align="left">{s.skipPermissionsHint}</C.HelpTip>
                    </span>
                    <C.Toggle checked={cur.skipPermissions !== false} onChange={(v: boolean) => set({ skipPermissions: v })} label={s.skipPermissions} />
                  </label>
                )}
                <label className="flex items-center justify-between gap-3 border-t border-border/70 pt-2">
                  <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-text">
                    {s.resumeSessions}
                    <C.HelpTip align="left">{s.resumeSessionsHint}</C.HelpTip>
                  </span>
                  <C.Toggle checked={cur.resume !== false} onChange={(v: boolean) => set({ resume: v })} label={s.resumeSessions} />
                </label>
              </div>
              )}
            </div>
            </div>
          );
        })}
      </C.SettingsGroup>
      </div>
    </C.PluginPageFrame>
  );
}
