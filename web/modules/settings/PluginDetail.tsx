'use client';
import { Activity as ReactActivity, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, Check, Circle, Settings2, SlidersHorizontal, Sparkles, Activity, ShieldCheck } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { LoadingState, ErrorState } from '../../components/ui/states';
import { Segmented } from '../../components/ui/Segmented';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
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
import { SettingsGroup, SettingsState, SettingsToolbar } from '../../components/ui/SettingsSurface';

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

function PluginWorkspace({ name, detail, contributions, logs, hookExecutions, uiEntry, onBack }: {
  name: string;
  detail: PluginDetailData;
  contributions: PluginContributions | undefined;
  logs: PluginLogs | undefined;
  hookExecutions: PluginHookExecutions | undefined;
  /** This plugin's row of the /plugins/ui listing, when it ships a browser bundle. */
  uiEntry: PluginUiListing | undefined;
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
  const [tab, setTab] = useState<WorkspaceTab>(missingRequired.length ? 'setup' : 'behavior');
  const [visitedTabs, setVisitedTabs] = useState<Set<WorkspaceTab>>(() => new Set([tab]));
  useEffect(() => {
    setVisitedTabs((current) => current.has(tab) ? current : new Set(current).add(tab));
  }, [tab]);
  // A contributed section owns its own saves, so it reports through the channel the kit gives it and the
  // workspace shows THAT while its tab is open — the config draft's status belongs to the config form.
  const [sectionSave, setSectionSave] = useState<{ status: SaveStatus; retry?: () => void }>({ status: 'idle' });
  const onSectionSaveState = useCallback((status: SaveStatus, retry?: () => void) => setSectionSave({ status, retry }), []);

  // `#plugin-activity` etc. makes a workspace tab shareable without changing the existing settings URL.
  // The listing arrives after mount, so a contributed section is matched once it is actually known —
  // a link to a section tab must survive the round trip that tells the workspace the section exists.
  useEffect(() => {
    const hash = window.location.hash.replace('#plugin-', '');
    if ((CORE_TABS as readonly string[]).includes(hash)) setTab(hash as WorkspaceTab);
    else if (detailSections.some((s) => sectionTabId(s.id) === hash)) setTab(hash as WorkspaceTab);
  }, [detailSections]);
  const changeTab = (next: string) => {
    const value = next as WorkspaceTab;
    setTab(value);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#plugin-${value}`);
  };

  const pluginDescription = tr?.description ?? detail.description;
  const toolCount = detail.provides.tools?.length ?? 0;
  const platformCount = detail.provides.platforms?.length ?? 0;
  const tabs = [
    { value: 'setup', label: t.pluginDetail.tabSetup, icon: Settings2 },
    { value: 'behavior', label: t.pluginDetail.tabBehavior, icon: SlidersHorizontal },
    { value: 'capabilities', label: t.pluginDetail.tabCapabilities, icon: ShieldCheck },
    { value: 'activity', label: t.pluginDetail.tabActivity, icon: Activity },
    { value: 'advanced', label: t.pluginDetail.tabAdvanced, icon: Sparkles },
    ...detailSections.map((s) => ({ value: sectionTabId(s.id), label: s.label, icon: pluginLucideIcon(s.icon) })),
  ];
  const editorProps = { name, detail, fieldLabel, fieldHint, fieldOptions, riskText, draft };

  return (
    <>
      <SettingsGroup>
        <div className="flex flex-col gap-5 p-5 sm:p-6">
          <div><Button variant="ghost" icon={ArrowLeft} onClick={onBack}>{t.pluginCfg.back}</Button></div>
          <PluginHero name={name} detail={detail} description={pluginDescription} toolCount={toolCount} />
        </div>
      </SettingsGroup>
      <SettingsGroup>
        <SettingsToolbar>
          <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {/* `flex`, not `overflow-x-auto`: the Segmented track wraps on its own, so it never needs a
                scroll axis — and declaring `overflow-x: auto` promotes the Y axis out of `visible`, so a
                sub-pixel row height (routine once the shell zoom scales the layout) overflows by a fraction
                and draws a stray vertical scrollbar beside the tabs at some widths. Same fix as PluginsSection. */}
            <div className="flex min-w-0"><Segmented variant="line" value={tab} onChange={changeTab} options={tabs} aria-label={t.pluginDetail.workspaceNav} /></div>
            {/* One indicator, whichever tab owns the last save: the config draft on the workspace's own
                tabs, the contributed section on its own. Showing the draft's "saved" beside a section
                that just failed would report on the wrong surface. */}
            {tab.startsWith('section:') ? (
              <AutoSaveStatus status={sectionSave.status} onRetry={sectionSave.retry} />
            ) : (
              <AutoSaveStatus
                status={draft.status}
                errorKind={draft.errorKind ?? undefined}
                onRetry={draft.errorKind === 'transport' ? draft.retry : undefined}
                onReload={draft.errorKind === 'conflict' ? () => draft.resolveConflict('reload') : undefined}
                onMerge={draft.errorKind === 'conflict' ? () => draft.resolveConflict('merge') : undefined}
              />
            )}
          </div>
        </SettingsToolbar>
        <div className="p-5 sm:p-6">
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
              {uiEntry ? <PluginSettingsSection entry={uiEntry} sectionId={section.id} onSaveState={onSectionSaveState} /> : null}
            </WorkspacePanel>
          ))}
        </div>
      </SettingsGroup>
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
  return <PluginWorkspace key={name} name={name} detail={data} contributions={contributions} logs={logs} hookExecutions={hookExecutions} uiEntry={pluginUi?.find((p) => p.name === name)} onBack={onBack} />;
}
