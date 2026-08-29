'use client';
import { useEffect, useMemo, useState } from 'react';
import { Boxes, ChevronDown, ChevronRight, Lock, Search } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { HelpTip } from '../../components/ui/HelpTip';
import { Input } from '../../components/ui/Input';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { Segmented } from '../../components/ui/Segmented';
import { Slider } from '../../components/ui/Slider';
import { Toggle } from '../../components/ui/Toggle';
import { useTranslation } from '../../lib/i18n';
import type { ConfigPatch, RuntimeConfig } from '../../lib/types';
import { SettingsGroup, SettingsRow } from '../../components/ui/SettingsSurface';

type ToolLoadingMode = 'immediate' | 'deferred';
type ToolDeferralOverrides = NonNullable<RuntimeConfig['toolDeferralOverrides']>;

type ToolDeferralTool = {
  name: string;
  label: string;
  description?: string;
  eligible: boolean;
  lockedReason: 'never-defer' | 'plan-safe' | null;
  defaultMode: ToolLoadingMode;
  override: ToolLoadingMode | null;
  effective: ToolLoadingMode;
  reason: string;
};

type ToolDeferralGroup = {
  sourceId: string;
  label: string;
  kind: 'plugin' | 'builtin';
  override: ToolLoadingMode | null;
  tools: ToolDeferralTool[];
};

type Draft = {
  enabled: boolean;
  threshold: number;
  overrides: ToolDeferralOverrides;
};

function cloneOverrides(overrides?: ToolDeferralOverrides): ToolDeferralOverrides {
  return {
    sources: { ...(overrides?.sources ?? {}) },
    tools: Object.fromEntries(Object.entries(overrides?.tools ?? {}).map(([source, tools]) => [source, { ...tools }])),
  };
}

function modeFromOverride(override: ToolLoadingMode | null): 'default' | ToolLoadingMode {
  return override ?? 'default';
}

function resolveDraftTool(draft: Draft, group: ToolDeferralGroup, tool: ToolDeferralTool): { effective: ToolLoadingMode; reason: string } {
  if (!draft.enabled) return { effective: 'immediate', reason: 'global-disabled' };
  if (tool.lockedReason) return { effective: 'immediate', reason: tool.lockedReason };
  const toolOverride = draft.overrides.tools[group.sourceId]?.[tool.name];
  if (toolOverride) return { effective: toolOverride, reason: 'tool-override' };
  const sourceOverride = draft.overrides.sources[group.sourceId];
  if (sourceOverride) return { effective: sourceOverride, reason: 'source-override' };
  if (tool.defaultMode === 'deferred') return { effective: 'deferred', reason: 'source-default' };
  return { effective: tool.effective, reason: tool.reason };
}

/** Settings editor for the stable tool-loading policy. It keeps all edits local until one explicit runtime patch. */
export function ToolDeferralModal({ runtime, onSave, onSaved, onClose, presentation }: {
  runtime: RuntimeConfig;
  onSave: (patch: ConfigPatch) => Promise<unknown>;
  onSaved?: (runtime: Pick<RuntimeConfig, 'toolDeferralEnabled' | 'toolDeferralOverrides'> & { limits: Pick<RuntimeConfig['limits'], 'toolDeferThreshold'> }) => void;
  onClose: () => void;
  presentation?: 'center' | 'drawer';
}) {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<ToolDeferralGroup[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<Draft>(() => ({
    enabled: runtime.toolDeferralEnabled,
    threshold: runtime.limits.toolDeferThreshold,
    overrides: cloneOverrides(runtime.toolDeferralOverrides),
  }));

  useEffect(() => {
    let active = true;
    void fetch('/api/config/tool-deferral', { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error('catalog request failed');
        return response.json() as Promise<ToolDeferralGroup[]>;
      })
      .then((groups) => {
        if (!active) return;
        setCatalog(groups);
        setCollapsed(new Set(groups.map((group) => group.sourceId)));
      })
      .catch(() => { if (active) setLoadError(true); });
    return () => { active = false; };
  }, []);

  const filteredGroups = useMemo(() => {
    if (!catalog) return [];
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return catalog;
    return catalog.flatMap((group) => {
      const groupMatches = group.label.toLocaleLowerCase().includes(needle);
      const tools = group.tools.filter((tool) => groupMatches
        || [tool.name, tool.label, tool.description ?? ''].some((value) => value.toLocaleLowerCase().includes(needle)));
      return tools.length > 0 ? [{ ...group, tools }] : [];
    });
  }, [catalog, query]);

  const summary = useMemo(() => {
    const tools = catalog?.flatMap((group) => group.tools.map((tool) => ({ group, tool }))) ?? [];
    return tools.reduce((counts, { group, tool }) => {
      const resolved = resolveDraftTool(draft, group, tool);
      if (tool.lockedReason) counts.locked += 1;
      else if (resolved.effective === 'deferred') counts.deferred += 1;
      else counts.immediate += 1;
      return counts;
    }, { deferred: 0, immediate: 0, locked: 0 });
  }, [catalog, draft]);

  const setSourceMode = (sourceId: string, mode: 'default' | ToolLoadingMode) => {
    setDraft((current) => {
      const sources = { ...current.overrides.sources };
      if (mode === 'default') delete sources[sourceId];
      else sources[sourceId] = mode;
      return { ...current, overrides: { ...current.overrides, sources } };
    });
  };
  const setToolMode = (sourceId: string, toolName: string, mode: 'default' | ToolLoadingMode) => {
    setDraft((current) => {
      const sourceTools = { ...(current.overrides.tools[sourceId] ?? {}) };
      if (mode === 'default') delete sourceTools[toolName];
      else sourceTools[toolName] = mode;
      const tools = { ...current.overrides.tools };
      if (Object.keys(sourceTools).length === 0) delete tools[sourceId];
      else tools[sourceId] = sourceTools;
      return { ...current, overrides: { ...current.overrides, tools } };
    });
  };
  const save = async () => {
    setSaving(true);
    setSaveError(false);
    try {
      await onSave({ runtime: {
        toolDeferralEnabled: draft.enabled,
        limits: { toolDeferThreshold: draft.threshold },
        toolDeferralOverrides: draft.overrides,
      } });
      onSaved?.({ toolDeferralEnabled: draft.enabled, limits: { toolDeferThreshold: draft.threshold }, toolDeferralOverrides: draft.overrides });
      onClose();
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };

  const options = [
    { value: 'default', label: t.brain.toolLoading.default },
    { value: 'immediate', label: t.brain.toolLoading.immediate },
    { value: 'deferred', label: t.brain.toolLoading.toolSearch },
  ];
  const reasonLabel = (reason: string) => t.brain.toolLoading.reason[reason as keyof typeof t.brain.toolLoading.reason] ?? reason;

  return (
    <Modal title={t.brain.toolLoading.title} description={t.brain.toolLoading.hint} icon={Boxes} size="xl" onClose={onClose} presentation={presentation}>
      <ModalBody gap={4}>
        <SettingsGroup title={t.brain.toolLoading.globalTitle} description={t.brain.toolLoading.globalHint} icon={Boxes}>
          <SettingsRow label={t.brain.toolLoading.enabled} description={t.brain.toolLoading.enabledHint} icon={Boxes}>
            <Toggle checked={draft.enabled} onChange={(enabled) => setDraft((current) => ({ ...current, enabled }))} label={t.brain.toolLoading.enabled} />
          </SettingsRow>
          <SettingsRow label={t.brain.toolLoading.threshold} description={t.brain.toolLoading.thresholdHint} icon={Search}>
            <div className="flex w-48 items-center gap-3">
              <Slider value={draft.threshold} min={1} max={100} step={1} onChange={(threshold) => setDraft((current) => ({ ...current, threshold }))} aria-label={t.brain.toolLoading.threshold} />
              <span className="w-7 text-right font-mono text-sm tabular-nums text-primary">{draft.threshold}</span>
            </div>
          </SettingsRow>
        </SettingsGroup>

        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground" aria-label={t.brain.toolLoading.summary}>
          {t.brain.toolLoading.summary
            .replace('{deferred}', String(summary.deferred))
            .replace('{immediate}', String(summary.immediate))
            .replace('{locked}', String(summary.locked))}
        </div>
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.brain.toolLoading.searchPlaceholder} aria-label={t.brain.toolLoading.search} />

        {catalog === null && !loadError ? <p className="text-sm text-muted-foreground">{t.common.loading}</p> : null}
        {loadError ? <p className="text-sm text-destructive">{t.brain.toolLoading.loadError}</p> : null}
        {catalog !== null && filteredGroups.length === 0 ? <p className="text-sm text-muted-foreground">{t.brain.toolLoading.empty}</p> : null}
        <div className={draft.enabled ? 'flex flex-col gap-3' : 'flex flex-col gap-3 opacity-55'}>
          {filteredGroups.map((group) => {
            const isCollapsed = collapsed.has(group.sourceId) && !query.trim();
            const groupMode = modeFromOverride(draft.overrides.sources[group.sourceId] ?? null);
            return (
              <SettingsGroup
                key={group.sourceId}
                title={group.label}
                description={group.kind === 'builtin' ? t.brain.toolLoading.builtIn : t.brain.toolLoading.plugin}
                actions={(
                  <div className="flex items-center gap-2">
                    <Segmented options={options} value={groupMode} onChange={(mode) => setSourceMode(group.sourceId, mode as 'default' | ToolLoadingMode)} size="sm" aria-label={t.brain.toolLoading.groupMode.replace('{group}', group.label)} />
                    <button type="button" aria-label={(isCollapsed ? t.brain.toolLoading.expand : t.brain.toolLoading.collapse).replace('{group}', group.label)} onClick={() => setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(group.sourceId)) next.delete(group.sourceId); else next.add(group.sourceId);
                      return next;
                    })} className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
                      {isCollapsed ? <ChevronRight size={16} aria-hidden /> : <ChevronDown size={16} aria-hidden />}
                    </button>
                  </div>
                )}
              >
                {!isCollapsed ? group.tools.map((tool) => {
                  const override = draft.overrides.tools[group.sourceId]?.[tool.name] ?? null;
                  const mode = modeFromOverride(override);
                  const resolved = resolveDraftTool(draft, group, tool);
                  const locked = tool.lockedReason !== null;
                  return (
                    <SettingsRow
                      key={tool.name}
                      label={tool.label}
                      description={tool.description}
                      status={<Badge tone={locked ? 'danger' : resolved.effective === 'deferred' ? 'accent' : undefined}>{reasonLabel(resolved.reason)}</Badge>}
                    >
                      {locked ? (
                        <button type="button" disabled aria-label={`${tool.label}: ${reasonLabel(resolved.reason)}`} className="inline-flex h-9 items-center gap-1.5 rounded border border-border px-3 text-xs text-muted-foreground">
                          <Lock size={13} aria-hidden />{reasonLabel(resolved.reason)}
                        </button>
                      ) : (
                        <Segmented options={options} value={mode} onChange={(next) => setToolMode(group.sourceId, tool.name, next as 'default' | ToolLoadingMode)} size="sm" aria-label={t.brain.toolLoading.toolMode.replace('{tool}', tool.label)} />
                      )}
                    </SettingsRow>
                  );
                }) : null}
              </SettingsGroup>
            );
          })}
        </div>
        {!draft.enabled ? <p className="text-xs text-muted-foreground"><HelpTip>{t.brain.toolLoading.disabledHint}</HelpTip>{t.brain.toolLoading.disabledHint}</p> : null}
        {saveError ? <p className="text-sm text-destructive">{t.brain.toolLoading.saveError}</p> : null}
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
        <Button variant="accent" onClick={() => void save()} disabled={saving || catalog === null}>{saving ? t.common.saving : t.common.save}</Button>
      </ModalFooter>
    </Modal>
  );
}
