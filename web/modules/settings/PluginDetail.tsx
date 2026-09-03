'use client';
import { Activity as ReactActivity, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, Check, Circle, Settings2, SlidersHorizontal, Sparkles, Activity, ShieldCheck } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { LoadingState, ErrorState } from '../../components/ui/states';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
import { WorkspaceShell } from '../../components/ui/WorkspaceShell';
import { MotionReveal } from '../../components/ui/Motion';
import { useTranslation } from '../../lib/i18n';
import { usePluginDetail, usePluginContributions, usePluginLogs, usePluginHookExecutions, usePluginUi } from '../../lib/queries';
import type { PluginConfigField, PluginContributions, PluginDetail as PluginDetailData, PluginHookExecutions, PluginLogs, PluginUiListing } from '../../lib/types';
import { pluginLucideIcon } from '../../lib/pluginIcons';
import { PluginSettingsSection } from './PluginSettingsSection';
import type { SaveStatus } from '../../lib/useAutoSaveStatus';
import { PluginConfigEditor } from './PluginConfigEditor';
import { PluginStatusPanel } from './PluginStatusPanel';
import { PluginHero } from './PluginSummary';
import { PluginToolsPanel } from './PluginToolsPanel';
import { PluginHooksPanel } from './PluginHooksPanel';
import { PluginPermissionsPanel } from './PluginPermissionsPanel';
import { PluginDataPanel } from './PluginDataPanel';
import { PluginLogsPanel } from './PluginLogsPanel';
import { usePluginConfigDraft } from '../../lib/usePluginConfigDraft';
import { SettingsGroup, SettingsState } from '../../components/ui/SettingsSurface';

const CORE_TABS = ['setup', 'behavior', 'capabilities', 'activity', 'advanced'] as const;
/** The workspace's own tabs, plus one per plugin-contributed section placed here. A contributed id is
 *  namespaced so a plugin can call its section "activity" without stealing the workspace's tab. */
type WorkspaceTab = (typeof CORE_TABS)[number] | `section:${string}`;
const sectionTabId = (id: string): WorkspaceTab => `section:${id}`;

/** Lazily retain visited tabs. Config editors keep disclosure/search state, while unvisited panels do
 *  not mount expensive editors simply because the plugin workspace opened. */
function WorkspacePanel({ id, active, visited, children }: {
  id: WorkspaceTab;
  active: WorkspaceTab;
  visited: ReadonlySet<WorkspaceTab>;
  children: ReactNode;
}) {
  if (id !== active && !visited.has(id)) return null;
  return (
    <ReactActivity mode={id === active ? 'visible' : 'hidden'}>
      <MotionReveal data-plugin-panel={id}>{children}</MotionReveal>
    </ReactActivity>
  );
}

function PluginWorkspace({ name, detail, contributions, logs, hookExecutions, uiEntry, uiListingLoaded, onBack }: {
  name: string;
  detail: PluginDetailData;
  contributions: PluginContributions | undefined;
  logs: PluginLogs | undefined;
  hookExecutions: PluginHookExecutions | undefined;
  /** This plugin's row of the /plugins/ui listing, when it ships a browser bundle. */
  uiEntry: PluginUiListing | undefined;
  /** Distinguishes a loaded listing with no matching section from the listing still being pending. */
  uiListingLoaded: boolean;
  onBack: () => void;
}) {
  const { t, locale } = useTranslation();
  const tr = detail.i18n?.[locale];
  const fieldLabel = (field: PluginConfigField) => tr?.fields?.[field.key]?.label ?? field.label;
  const fieldHint = (field: PluginConfigField) => tr?.fields?.[field.key]?.hint ?? field.hint;
  const fieldOptions = (field: PluginConfigField) => (field.options ?? []).map((option) => ({
    ...option,
    label: tr?.fields?.[field.key]?.options?.[option.value] ?? option.label,
  }));
  const riskText = (risk: 'low' | 'medium' | 'high') => risk === 'high' ? t.pluginDetail.riskHigh : risk === 'medium' ? t.pluginDetail.riskMedium : t.pluginDetail.riskLow;
  const draft = usePluginConfigDraft(name, detail);
  const missingRequired = useMemo(() => detail.configSchema.filter((field) => {
    if (!field.required) return false;
    const draftValue = draft.values[field.key] ?? field.default;
    if (field.type === 'secret') return !detail.secretsSet.includes(field.key) && !String(draftValue ?? '').trim();
    return draftValue == null || String(draftValue).trim() === '';
  }), [detail.configSchema, detail.secretsSet, draft.values]);
  // Sections the plugin asked to be offered HERE rather than in the main navigation. A section placed
  // 'page' (the default) owns a world of its own and is reached there; mounting it here as well would put
  // one surface in two places, which is the split this placement exists to avoid.
  const detailSections = useMemo(
    () => (uiEntry?.settings ?? []).filter((s) => s.placement === 'pluginDetail'),
    [uiEntry],
  );
  const fallbackTab: WorkspaceTab = missingRequired.length ? 'setup' : 'behavior';
  const [tab, setTab] = useState<WorkspaceTab>(fallbackTab);
  const [visitedTabs, setVisitedTabs] = useState<Set<WorkspaceTab>>(() => new Set([tab]));
  useEffect(() => {
    setVisitedTabs((current) => current.has(tab) ? current : new Set(current).add(tab));
  }, [tab]);
  // A contributed section owns its own saves, so it reports through the channel the kit gives it and the
  // workspace shows THAT while its tab is open — the config draft's status belongs to the config form.
  // Keyed by section id, because the panels stay MOUNTED once visited: a section that failed a save
  // keeps reporting that failure while the reader is looking at a different one, and a single slot would
  // show them the other section's status under this section's tab.
  const [sectionSave, setSectionSave] = useState<Record<string, { status: SaveStatus; retry?: () => void }>>({});
  const sectionSaveHandlers = useMemo(() => new Map(detailSections.map((section) => [
    section.id,
    (status: SaveStatus, retry?: () => void) => setSectionSave((current) => ({ ...current, [section.id]: { status, retry } })),
  ])), [detailSections]);
  const activeSectionSave = tab.startsWith('section:') ? sectionSave[tab.slice('section:'.length)] : undefined;

  const replaceTabHash = useCallback((value: WorkspaceTab) => {
    const url = new URL(window.location.href);
    url.hash = `plugin-${value}`;
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);
  // `#plugin-activity` etc. makes a workspace tab shareable. Core tabs can be validated immediately, but
  // contributed sections exist only after /plugins/ui resolves: preserving that pending hash is what lets
  // a reload of `#plugin-section:runtime` land on Runtime instead of being canonicalized to Behavior first.
  useEffect(() => {
    const applyHash = () => {
      // Parent history navigation can remove `plugin=` before React unmounts this workspace. Ignore that
      // popstate so the outgoing detail cannot stamp its fallback hash onto the plugin list entry.
      if (window.location.pathname === '/settings' && new URLSearchParams(window.location.search).get('plugin') !== name) return;
      const rawHash = window.location.hash;
      const value = rawHash.startsWith('#plugin-') ? rawHash.slice('#plugin-'.length) : '';
      if ((CORE_TABS as readonly string[]).includes(value)) {
        setTab(value as WorkspaceTab);
        return;
      }
      if (value.startsWith('section:')) {
        if (!uiListingLoaded) return;
        if (detailSections.some((section) => sectionTabId(section.id) === value)) {
          setTab(value as WorkspaceTab);
          return;
        }
      }
      setTab(fallbackTab);
      if (value !== fallbackTab) replaceTabHash(fallbackTab);
    };
    applyHash();
    window.addEventListener('popstate', applyHash);
    window.addEventListener('hashchange', applyHash);
    return () => {
      window.removeEventListener('popstate', applyHash);
      window.removeEventListener('hashchange', applyHash);
    };
  }, [detailSections, fallbackTab, name, replaceTabHash, uiListingLoaded]);
  const changeTab = (next: string) => {
    const value = next as WorkspaceTab;
    setTab(value);
    replaceTabHash(value);
  };

  const pluginDescription = tr?.description ?? detail.description;
  const toolCount = detail.provides.tools?.length ?? 0;
  const platformCount = detail.provides.platforms?.length ?? 0;
  const sections = [
    { id: 'setup', label: t.pluginDetail.tabSetup, icon: Settings2 },
    // Right after Setup, ahead of the workspace's own tuning tabs: a contributed section reports what the
    // plugin is DOING — whether it can run at all — which is the second question an operator asks after
    // "is it configured", not something to find past Advanced.
    ...detailSections.map((s) => ({ id: sectionTabId(s.id), label: s.label, icon: pluginLucideIcon(s.icon) })),
    { id: 'behavior', label: t.pluginDetail.tabBehavior, icon: SlidersHorizontal },
    { id: 'capabilities', label: t.pluginDetail.tabCapabilities, icon: ShieldCheck },
    { id: 'activity', label: t.pluginDetail.tabActivity, icon: Activity },
    { id: 'advanced', label: t.pluginDetail.tabAdvanced, icon: Sparkles },
  ];
  const saveStatus = tab.startsWith('section:') ? (
    <AutoSaveStatus status={activeSectionSave?.status ?? 'idle'} onRetry={activeSectionSave?.retry} />
  ) : (
    <AutoSaveStatus
      status={draft.status}
      errorKind={draft.errorKind ?? undefined}
      onRetry={draft.errorKind === 'transport' ? draft.retry : undefined}
      onReload={draft.errorKind === 'conflict' ? () => draft.resolveConflict('reload') : undefined}
      onMerge={draft.errorKind === 'conflict' ? () => draft.resolveConflict('merge') : undefined}
    />
  );
  const editorProps = { name, detail, fieldLabel, fieldHint, fieldOptions, riskText, draft };

  return (
    <>
      <SettingsGroup>
        <div className="flex flex-col gap-5 p-5 sm:p-6">
          <div><Button variant="ghost" icon={ArrowLeft} onClick={onBack}>{t.pluginCfg.back}</Button></div>
          <PluginHero name={name} detail={detail} description={pluginDescription} toolCount={toolCount} />
        </div>
      </SettingsGroup>
      <WorkspaceShell
        variant="deck"
        embedded
        className="plugin-detail-workspace"
        navigationLayout="tabs"
        navigation={{ sections, value: tab, onChange: changeTab, ariaLabel: t.pluginDetail.workspaceNav }}
        toolbar={{ actions: saveStatus }}
      >
        <div>
          <WorkspacePanel id="setup" active={tab} visited={visitedTabs}>
            <div className="flex min-w-0 flex-col gap-4">
              {/* Above the checklist: the checklist answers "did I fill the fields in", this answers
                  "does it actually work" — and a plugin can have every field set and still be dark. */}
              <PluginStatusPanel name={name} />
              <SettingsGroup
                className="plugin-card"
                icon={Check}
                title={t.pluginDetail.setupChecklist}
                description={t.pluginDetail.setupChecklistHint}
                actions={<span className={`text-xs font-medium ${missingRequired.length ? 'text-warning' : 'text-success'}`}>{missingRequired.length ? t.pluginDetail.setupMissing.replace('{n}', String(missingRequired.length)) : t.pluginDetail.setupComplete}</span>}
              >
                <div className="settings-group__panel flex flex-wrap gap-2">
                  {detail.configSchema.filter((field) => field.required).map((field) => {
                    const missing = missingRequired.includes(field);
                    return <span key={field.key} className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground">{missing ? <Circle size={10} className="text-warning" aria-hidden /> : <Check size={11} className="text-success" aria-hidden />}{fieldLabel(field)}</span>;
                  })}
                  {detail.configSchema.every((field) => !field.required) ? <span className="text-xs text-muted-foreground">{t.pluginDetail.setupNoRequired}</span> : null}
                </div>
              </SettingsGroup>
              <PluginConfigEditor {...editorProps} mode="setup" />
            </div>
          </WorkspacePanel>

          <WorkspacePanel id="behavior" active={tab} visited={visitedTabs}>
            <PluginConfigEditor {...editorProps} mode="behavior" />
          </WorkspacePanel>
          <WorkspacePanel id="capabilities" active={tab} visited={visitedTabs}>
            <div className="flex flex-col gap-4">
              <PluginToolsPanel contributions={contributions} />
              <PluginHooksPanel contributions={contributions} hookExecutions={hookExecutions} />
              <PluginPermissionsPanel detail={detail} fieldLabel={fieldLabel} riskText={riskText} toolCount={toolCount} platformCount={platformCount} />
            </div>
          </WorkspacePanel>
          <WorkspacePanel id="activity" active={tab} visited={visitedTabs}><PluginLogsPanel logs={logs} /></WorkspacePanel>
          <WorkspacePanel id="advanced" active={tab} visited={visitedTabs}>
            <div className="flex flex-col gap-4">
              <PluginConfigEditor {...editorProps} mode="advanced" />
              <PluginDataPanel name={name} summary={detail.data} />
            </div>
          </WorkspacePanel>
          {/* Mounted lazily like every other tab: a plugin bundle is third-party code and must not be
              fetched, let alone executed, because somebody opened the plugin's configuration form. */}
          {detailSections.map((section) => (
            <WorkspacePanel key={section.id} id={sectionTabId(section.id)} active={tab} visited={visitedTabs}>
              {uiEntry ? <PluginSettingsSection entry={uiEntry} sectionId={section.id} onSaveState={sectionSaveHandlers.get(section.id)!} /> : null}
            </WorkspacePanel>
          ))}
        </div>
      </WorkspaceShell>
    </>
  );
}

/** Plugin detail is a tabbed workspace. Loading stays outside `PluginWorkspace` so the draft hook is
 *  always mounted with a complete detail object and never violates hook ordering during refetches. */
export function PluginDetail({ name, onBack }: { name: string; onBack: () => void }) {
  const { t, locale } = useTranslation();
  const { data, isLoading, isError, refetch } = usePluginDetail(name);
  const { data: contributions } = usePluginContributions(name);
  const { data: logs } = usePluginLogs(name);
  const { data: hookExecutions } = usePluginHookExecutions(name);
  // The same listing the menu is built from, so a section's label, icon and placement are read from one
  // server-localized source rather than a second projection of the manifest that could disagree with it.
  const { data: pluginUi } = usePluginUi(locale);
  if (isError) return <SettingsGroup><SettingsState tone="danger"><ErrorState message={t.common.daemonUnreachable} onRetry={() => refetch()} /></SettingsState></SettingsGroup>;
  if (isLoading || !data) return <SettingsGroup><SettingsState><LoadingState /></SettingsState></SettingsGroup>;
  return <PluginWorkspace key={name} name={name} detail={data} contributions={contributions} logs={logs} hookExecutions={hookExecutions} uiEntry={pluginUi?.find((p) => p.name === name)} uiListingLoaded={pluginUi !== undefined} onBack={onBack} />;
}
