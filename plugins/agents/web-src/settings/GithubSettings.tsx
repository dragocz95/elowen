import { useEffect, useState } from 'react';
import { GitPullRequest, KeyRound } from 'lucide-react';
import { runtime } from '../runtime';
import { GithubStatusBanner } from './GithubStatusBanner';

const inputClass = 'w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-muted transition-colors focus:border-accent';

interface Detail { config?: Record<string, unknown>; secretsSet?: string[] }

/** The moved core Settings → GitHub section: the PR workflow default and the write-only token,
 *  auto-persisted per field. Both keys are this plugin's own config slice (the PR workflow and the gh
 *  token are consumed only by mission PR automation), so the section belongs to the plugin that reads
 *  them — core no longer renders a section whose every value it would have to fetch from here.
 *  Reads GET /plugins/agents, saves through PATCH /plugins/agents/config. */
export function GithubSettings({ surface, plugin, params }: { surface: 'page' | 'deck'; plugin: string; params: Record<string, string> }) {
  const { components: C, hooks, api } = runtime();
  const s = hooks.usePluginStrings('agents');
  const { t } = hooks.useTranslation();
  const { toast } = hooks.useToast();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [ghToken, setGhToken] = useState('');
  const [prEnabled, setPrEnabled] = useState(false);
  // The GitHub text fields edit in one side drawer opened via pod orbs.
  const [githubOpen, setGithubOpen] = useState(false);

  // Seed once from the plugin detail. Re-seeding on a refetch would wipe a field the user just edited
  // before autosave fires.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    let alive = true;
    api('/plugins/agents')
      .then((d) => {
        if (!alive) return;
        const det = d as Detail;
        setDetail(det);
        setPrEnabled(det.config?.prEnabled === true);
        setSeeded(true);
      })
      .catch(() => { if (alive) setSeeded(true); });
    return () => { alive = false; };
  }, [api]);

  // The global prEnabled is the DEFAULT for new projects; each project can override it. The ghToken is
  // write-only — sent only when freshly typed (a secret field arriving empty keeps the stored value,
  // so it is simply omitted here).
  const saveGithub = async () => {
    try {
      const values = { prEnabled, ...(ghToken ? { ghToken } : {}) };
      await api('/plugins/agents/config', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values }) });
      if (ghToken) setGhToken('');
    } catch (error) { toast(String(error), 'error'); throw error; }
  };

  const { status, retry } = hooks.useAutoSaveStatus([prEnabled, ghToken], saveGithub, { ready: seeded });

  const ghTokenSet = detail?.secretsSet?.includes('ghToken') ?? false;

  // The section keeps the constellation (orbital) rendering it had as a core section — the manifest
  // entry declares `layout: 'orbital'`, which is what puts the panel wrapper in the same mode.
  return (
    <C.PluginPageFrame surface={surface} plugin={plugin} section={params.id}>
      <C.ConstellationScope core={s.github}>
      {/* variant="classic": the status banner is not a label/control row. */}
      <C.SettingsGroup variant="classic"><GithubStatusBanner /></C.SettingsGroup>
      <C.SettingsGroup actions={<C.AutoSaveStatus status={status} onRetry={retry} />}>
        {/* The token edits in a side drawer (opened via its pod orb); the toggle stays inline. */}
        <C.SettingsRow label={s.ghToken} description={ghTokenSet ? s.ghTokenHint : s.ghTokenNotSetHint} icon={KeyRound}>
          <span className="font-mono text-sm tracking-widest text-text-muted">{ghTokenSet || ghToken ? '••••••••' : '—'}</span>
          <button type="button" data-selection-manage className="hidden" aria-label={s.ghToken} onClick={() => setGithubOpen(true)} />
        </C.SettingsRow>
        <C.SettingsRow label={s.prEnabled} description={s.prEnabledHint} icon={GitPullRequest}>
          <C.Toggle checked={prEnabled} onChange={setPrEnabled} label={s.prEnabled} />
        </C.SettingsRow>
      </C.SettingsGroup>
      {githubOpen ? (
        <C.WorkspaceDetailRail label={s.github} closeLabel={t.common?.close} onClose={() => setGithubOpen(false)}>
          <div className="flex flex-col gap-5 py-2">
            <div className="flex flex-col gap-1.5">
              <span className="text-tiny font-semibold uppercase tracking-wide text-text-muted">{s.ghToken}</span>
              <input type="password" value={ghToken} onChange={(e) => setGhToken(e.target.value)} placeholder={ghTokenSet ? s.apiKeySetPlaceholder : s.ghTokenPlaceholder} className={inputClass} aria-label={s.ghToken} />
            </div>
          </div>
        </C.WorkspaceDetailRail>
      ) : null}
      </C.ConstellationScope>
    </C.PluginPageFrame>
  );
}
