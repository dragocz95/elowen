import { useEffect, useState } from 'react';
import { GitPullRequest, KeyRound } from 'lucide-react';
import { runtime } from '../runtime';
import { GithubStatusBanner } from './GithubStatusBanner';

const inputClass = 'w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-muted transition-colors focus:border-accent';

/** The moved core Settings → GitHub section: the PR workflow default and the write-only token,
 *  auto-persisted per field. Both keys are this plugin's own config slice (the PR workflow and the gh
 *  token are consumed only by mission PR automation), so the section belongs to the plugin that reads
 *  them — core no longer renders a section whose every value it would have to fetch from here.
 *  Reads and writes go through the HOST's cache hooks for `/plugins/agents`, which is the same cache
 *  entry the Plugins settings detail edits: two surfaces, one stored answer to "is a token set". */
export function GithubSettings({ surface, plugin, params, onSaveState }: {
  surface: 'page' | 'deck';
  plugin: string;
  params: Record<string, string>;
  onSaveState?: (status: 'idle' | 'saving' | 'saved' | 'error', retry?: () => void) => void;
}) {
  const { components: C, hooks } = runtime();
  const s = hooks.usePluginStrings('agents');
  const { t } = hooks.useTranslation();
  const { toast } = hooks.useToast();
  const detail = hooks.usePluginDetail('agents');
  const saveConfig = hooks.useSavePluginConfig();
  const [ghToken, setGhToken] = useState('');
  const [prEnabled, setPrEnabled] = useState(false);
  // The GitHub text fields edit in one side drawer opened via pod orbs.
  const [githubOpen, setGithubOpen] = useState(false);

  // Seed the form once. The READ stays live afterwards (that is how the token row learns the save
  // landed), but re-seeding the editable value on every refetch would wipe a field the user has just
  // typed into and autosave has not written yet.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (seeded) return;
    if (detail.data) {
      setPrEnabled(detail.data.config?.prEnabled === true);
      setSeeded(true);
    } else if (detail.isError) {
      // Unreadable config still has to arm autosave, or the section would silently swallow every edit.
      setSeeded(true);
    }
  }, [detail.data, detail.isError, seeded]);

  // The global prEnabled is the DEFAULT for new projects; each project can override it. The ghToken is
  // write-only — sent only when freshly typed (a secret field arriving empty keeps the stored value,
  // so it is simply omitted here).
  const saveGithub = async () => {
    try {
      const values = { prEnabled, ...(ghToken ? { ghToken } : {}) };
      await saveConfig.mutateAsync({ name: 'agents', values });
      if (ghToken) setGhToken('');
    } catch (error) { toast(String(error), 'error'); throw error; }
  };

  const { status, retry } = hooks.useAutoSaveStatus([prEnabled, ghToken], saveGithub, { ready: seeded });

  // This section renders orbital, and an orbital group is a field of pods with no header — an
  // indicator handed to one would be dropped, and with it the only notice that a save failed. The
  // deck's shared header is where it belonged as a core category, and where it belongs now.
  useEffect(() => { onSaveState?.(status, retry); }, [onSaveState, retry, status]);

  const ghTokenSet = detail.data?.secretsSet?.includes('ghToken') ?? false;

  // The section keeps the constellation (orbital) rendering it had as a core section — the manifest
  // entry declares `layout: 'orbital'`, which is what puts the panel wrapper in the same mode.
  return (
    <C.PluginPageFrame surface={surface} plugin={plugin} section={params.id}>
      <C.ConstellationScope core={s.github}>
      {/* variant="classic": the status banner is not a label/control row. */}
      <C.SettingsGroup variant="classic"><GithubStatusBanner /></C.SettingsGroup>
      <C.SettingsGroup>
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
