'use client';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, Check, Circle, Settings2, SlidersHorizontal, Sparkles, Activity, ShieldCheck } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { LoadingState } from '../../components/ui/states';
import { Segmented } from '../../components/ui/Segmented';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
import { useTranslation } from '../../lib/i18n';
import { usePluginDetail, usePluginContributions, usePluginLogs, usePluginHookExecutions } from '../../lib/queries';
import type { PluginConfigField, PluginContributions, PluginDetail as PluginDetailData, PluginHookExecutions, PluginLogs } from '../../lib/types';
import { PluginConfigEditor } from './PluginConfigEditor';
import { PluginHero } from './PluginSummary';
import { PluginToolsPanel } from './PluginToolsPanel';
import { PluginHooksPanel } from './PluginHooksPanel';
import { PluginPermissionsPanel } from './PluginPermissionsPanel';
import { PluginDataPanel } from './PluginDataPanel';
import { PluginLogsPanel } from './PluginLogsPanel';
import { PluginLivePreview } from './PluginLivePreview';
import { usePluginConfigDraft } from './usePluginConfigDraft';

type WorkspaceTab = 'setup' | 'behavior' | 'capabilities' | 'activity' | 'advanced';

/** Document-like configuration with a contextual preview rail. The rail only appears beside the
 *  editor when its real container is wide enough; narrower settings layouts keep a single flow. */
function PluginEditorLayout({ preview, children }: { preview: ReactNode; children: ReactNode }) {
  return (
    <div data-testid="plugin-editor-layout" className="@container grid min-w-0 gap-6 @4xl:grid-cols-[minmax(0,1fr)_19rem] @5xl:grid-cols-[minmax(0,1fr)_21rem]">
      <div className="min-w-0">{children}</div>
      <aside data-testid="plugin-preview-rail" className="min-w-0 self-start @4xl:sticky @4xl:top-20">{preview}</aside>
    </div>
  );
}

function PluginWorkspace({ name, detail, contributions, logs, hookExecutions, onBack }: {
  name: string;
  detail: PluginDetailData;
  contributions: PluginContributions | undefined;
  logs: PluginLogs | undefined;
  hookExecutions: PluginHookExecutions | undefined;
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
  const [tab, setTab] = useState<WorkspaceTab>(missingRequired.length ? 'setup' : 'behavior');

  // `#plugin-activity` etc. makes a workspace tab shareable without changing the existing settings URL.
  useEffect(() => {
    const hash = window.location.hash.replace('#plugin-', '') as WorkspaceTab;
    if (['setup', 'behavior', 'capabilities', 'activity', 'advanced'].includes(hash)) setTab(hash);
  }, []);
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
  ];
  const editorProps = { name, detail, fieldLabel, fieldHint, fieldOptions, riskText, draft };
  const preview = <PluginLivePreview detail={detail} values={draft.values} fieldLabel={fieldLabel} />;

  return (
    <div className="flex flex-col gap-6">
      <div><Button variant="ghost" icon={ArrowLeft} onClick={onBack}>{t.pluginCfg.back}</Button></div>
      <PluginHero name={name} detail={detail} description={pluginDescription} toolCount={toolCount} />

      <div className="flex flex-col gap-3 border-y border-border/80 py-3 sm:flex-row sm:items-center sm:justify-between">
        <Segmented value={tab} onChange={changeTab} options={tabs} aria-label={t.pluginDetail.workspaceNav} />
        <AutoSaveStatus status={draft.status} onRetry={draft.retry} />
      </div>

      {tab === 'setup' ? (
        <PluginEditorLayout preview={preview}>
          <section className="border-y border-border/80 py-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div><h2 className="text-sm font-semibold text-text">{t.pluginDetail.setupChecklist}</h2><p className="mt-0.5 text-xs text-text-muted">{t.pluginDetail.setupChecklistHint}</p></div>
              <span className={`text-xs font-medium ${missingRequired.length ? 'text-warning' : 'text-success'}`}>{missingRequired.length ? t.pluginDetail.setupMissing.replace('{n}', String(missingRequired.length)) : t.pluginDetail.setupComplete}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {detail.configSchema.filter((field) => field.required).map((field) => {
                const missing = missingRequired.includes(field);
                return <span key={field.key} className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-text-muted">{missing ? <Circle size={10} className="text-warning" aria-hidden /> : <Check size={11} className="text-success" aria-hidden />}{fieldLabel(field)}</span>;
              })}
              {detail.configSchema.every((field) => !field.required) ? <span className="text-xs text-text-muted">{t.pluginDetail.setupNoRequired}</span> : null}
            </div>
          </section>
          <PluginConfigEditor {...editorProps} mode="setup" />
        </PluginEditorLayout>
      ) : null}

      {tab === 'behavior' ? (
        <PluginEditorLayout preview={preview}>
          <PluginConfigEditor {...editorProps} mode="behavior" />
        </PluginEditorLayout>
      ) : null}
      {tab === 'capabilities' ? (
        <div className="flex flex-col gap-4">
          <PluginToolsPanel contributions={contributions} />
          <PluginHooksPanel contributions={contributions} hookExecutions={hookExecutions} />
          <PluginPermissionsPanel detail={detail} fieldLabel={fieldLabel} riskText={riskText} toolCount={toolCount} platformCount={platformCount} />
        </div>
      ) : null}
      {tab === 'activity' ? <PluginLogsPanel logs={logs} /> : null}
      {tab === 'advanced' ? (
        <div className="flex flex-col gap-4">
          <PluginConfigEditor {...editorProps} mode="advanced" />
          <PluginDataPanel name={name} summary={detail.data} />
        </div>
      ) : null}
    </div>
  );
}

/** Plugin detail is a tabbed workspace. Loading stays outside `PluginWorkspace` so the draft hook is
 *  always mounted with a complete detail object and never violates hook ordering during refetches. */
export function PluginDetail({ name, onBack }: { name: string; onBack: () => void }) {
  const { data, isLoading } = usePluginDetail(name);
  const { data: contributions } = usePluginContributions(name);
  const { data: logs } = usePluginLogs(name);
  const { data: hookExecutions } = usePluginHookExecutions(name);
  if (isLoading || !data) return <LoadingState />;
  return <PluginWorkspace key={name} name={name} detail={data} contributions={contributions} logs={logs} hookExecutions={hookExecutions} onBack={onBack} />;
}
