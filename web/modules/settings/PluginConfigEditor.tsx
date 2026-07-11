'use client';
import { useState, type ReactNode } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight, Clock, Users, SlidersHorizontal, Link2, GraduationCap, Info, Wrench, type LucideIcon } from 'lucide-react';
import { CronJobsEditor } from './CronJobsEditor';
import { SkillsEditor } from './SkillsEditor';
import { WhatsAppPairSection } from './WhatsAppPairSection';
import { MonacoEditor } from '../projects/editor/monacoLoader';
import { defineEditorThemes } from '../projects/editor/oledTheme';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Collapsible } from '../../components/ui/Collapsible';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { HelpTip } from '../../components/ui/HelpTip';
import { ManageSelectionModal, type ManageSelectionItem } from '../../components/ui/ManageSelectionModal';
import { SelectionSummary } from '../../components/ui/SelectionSummary';
import { PluginIcon } from './PluginIcon';
import { Toggle } from '../../components/ui/Toggle';
import { Checkbox } from '../../components/ui/Checkbox';
import { BrainModelField } from '../../components/ui/BrainModelField';
import { Segmented } from '../../components/ui/Segmented';
import { ChoiceField } from '../../components/ui/ChoiceField';
import { ProviderPicker } from '../../components/ui/ProviderPicker';
import { useTranslation } from '../../lib/i18n';
import { usePlugins, useProjects, useConfig, useBrainModels } from '../../lib/queries';
import type { PluginConfigField, PluginDetail, RolePolicy, McpServerSpec } from '../../lib/types';
import { RISK_TONE, CONNECTION_KEYS } from './pluginDetail.shared';
import type { PluginConfigDraft } from './usePluginConfigDraft';
import { SettingsGroup, SettingsRow } from './SettingsSurface';

const textareaClass = 'w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm text-text placeholder:text-text-muted focus:border-accent';

/** Per-role tool allowlist: a compact summary (n selected / all) + a manage modal grouped by the
 *  owning plugin. Empty selection keeps the "no restriction — all tools allowed" semantics. A saved
 *  tool no longer contributed by any enabled plugin stays visible as a pinned row. */
function RoleToolsField({ tools, selected, onChange }: { tools: { name: string; plugin: string; pluginHasIcon: boolean }[]; selected: string[]; onChange: (v: string[]) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const known = new Set(tools.map((x) => x.name));
  const items: ManageSelectionItem[] = [
    ...selected.filter((x) => !known.has(x)).map((x) => ({ id: x, label: x, group: '', icon: <Wrench size={12} aria-hidden /> })),
    ...tools.map((x) => ({ id: x.name, label: x.name, group: x.plugin, icon: <PluginIcon name={x.plugin} hasIcon={x.pluginHasIcon} size={14} /> })),
  ];
  // The owning plugin's brand logo on each group header/chip (matching the users-admin look).
  const groupIcons = Object.fromEntries(
    [...new Map(tools.map((x) => [x.plugin, x.pluginHasIcon])).entries()]
      .map(([plugin, hasIcon]) => [plugin, <PluginIcon key={plugin} name={plugin} hasIcon={hasIcon} size={14} />]),
  );
  const countLabel = (n: number) => t.managePicker.toolsSelected.replace('{n}', String(n));
  return (
    <>
      <SelectionSummary
        countText={selected.length === 0 ? t.pluginCfg.roleToolsAll : countLabel(selected.length)}
        samples={selected.slice(0, 3).map((x) => ({ label: x }))}
        moreCount={Math.max(0, selected.length - 3)}
        onManage={() => setOpen(true)}
        manageLabel={t.managePicker.manage}
      />
      <ManageSelectionModal
        title={t.pluginCfg.roleTools}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        selected={new Set(selected)}
        onSave={(next) => onChange([...next])}
        emptySelectionHint={t.pluginCfg.roleToolsAll}
        countLabel={countLabel}
        groupIcons={groupIcons}
      />
    </>
  );
}

/** Generic `multiSelect` config field: a compact summary + a multi-select modal over the manifest's
 *  options (one ungrouped list, so no group-filter row). Saved values the manifest no longer offers
 *  stay visible as rows so a save never silently drops them. */
function MultiSelectField({ label, options, value, onChange }: { label: string; options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const byValue = new Map(options.map((o) => [o.value, o.label]));
  const items: ManageSelectionItem[] = [
    ...value.filter((v) => !byValue.has(v)).map((v) => ({ id: v, label: v, group: '' })),
    ...options.map((o) => ({ id: o.value, label: o.label, group: '' })),
  ];
  return (
    <>
      <SelectionSummary
        countText={t.managePicker.selectedCount.replace('{n}', String(value.length))}
        samples={value.slice(0, 3).map((v) => ({ label: byValue.get(v) ?? v }))}
        moreCount={Math.max(0, value.length - 3)}
        onManage={() => setOpen(true)}
        manageLabel={t.managePicker.manage}
      />
      <ManageSelectionModal
        title={label}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        selected={new Set(value)}
        onSave={(next) => onChange([...next])}
      />
    </>
  );
}

/** Structured editor for a `rolePolicies` field: each row maps a platform role (e.g. a Discord role id)
 *  to a name, the Elowen projects it may touch, and an extra prompt injected for that role — a per-role
 *  instructions pattern, kept in the plugin's own config. Rows collapse to a compact header so a
 *  long list stays scannable; a freshly added row starts expanded. */
function RolePoliciesEditor({ value, onChange }: { value: RolePolicy[]; onChange: (v: RolePolicy[]) => void }) {
  const { t } = useTranslation();
  const { data: projects } = useProjects();
  const { data: plugins } = usePlugins();
  // Every tool an enabled plugin contributes, tagged with its owner — the vocabulary (and the
  // modal grouping) for per-role tool allowlists. First owner wins on a name clash.
  const owners = new Map<string, string>();
  const pluginHasIcon = new Map<string, boolean>();
  for (const p of plugins ?? []) {
    if (!p.enabled) continue;
    pluginHasIcon.set(p.name, p.hasIcon ?? false);
    for (const tool of p.provides.tools ?? []) if (!owners.has(tool)) owners.set(tool, p.name);
  }
  const allTools = [...owners.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, plugin]) => ({ name, plugin, pluginHasIcon: pluginHasIcon.get(plugin) ?? false }));
  const patch = (i: number, p: Partial<RolePolicy>) => onChange(value.map((r, j) => (j === i ? { ...r, ...p } : r)));
  // Which rows are expanded (by index). Removing a row shifts the indices above it down by one.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleRow = (i: number) => setExpanded((prev) => { const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const addRole = () => { setExpanded((prev) => new Set(prev).add(value.length)); onChange([...value, { roleId: '', name: '', projectIds: [], prompt: '' }]); };
  const removeRole = (i: number) => {
    onChange(value.filter((_, j) => j !== i));
    setExpanded((prev) => { const n = new Set<number>(); for (const idx of prev) { if (idx < i) n.add(idx); else if (idx > i) n.add(idx - 1); } return n; });
  };
  return (
    <div className="flex flex-col gap-3">
      {value.length === 0 ? <p className="text-xs italic text-text-muted">{t.pluginCfg.noRoles}</p> : null}
      {value.map((r, i) => {
        const open = expanded.has(i);
        return (
          <div key={i} className="rounded-lg border border-border bg-elevated/40">
            <div className="flex items-center gap-2 p-3">
              <button type="button" onClick={() => toggleRow(i)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                {open ? <ChevronDown size={15} className="shrink-0 text-text-muted" aria-hidden /> : <ChevronRight size={15} className="shrink-0 text-text-muted" aria-hidden />}
                <span className="truncate text-sm font-medium text-text">{r.name || t.pluginCfg.roleNew}</span>
                {r.roleId ? <span className="truncate font-mono text-[11px] text-text-muted">{r.roleId}</span> : null}
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                  {r.admin === true ? <Badge tone="accent">{t.pluginCfg.roleAdminBadge}</Badge> : null}
                  <Badge>{t.pluginCfg.roleProjectsCount.replace('{n}', String(r.projectIds.length))}</Badge>
                  <Badge>{(r.tools ?? []).length === 0 ? t.pluginCfg.roleToolsAllBadge : t.pluginCfg.roleToolsCount.replace('{n}', String((r.tools ?? []).length))}</Badge>
                </span>
              </button>
              <Button variant="ghost" icon={Trash2} aria-label={t.pluginCfg.removeRole} onClick={() => removeRole(i)} />
            </div>
            {open ? (
              <div className="flex flex-col gap-3 border-t border-border p-3">
                <div className="@container">
                  <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
                    <Field label={t.pluginCfg.roleId}>
                      <Input value={r.roleId} onChange={(e) => patch(i, { roleId: e.target.value })} placeholder="1511041803225272420" className="font-mono" />
                    </Field>
                    <Field label={t.pluginCfg.roleName}>
                      <Input value={r.name} onChange={(e) => patch(i, { name: e.target.value })} placeholder="dev-team" />
                    </Field>
                  </div>
                </div>
                <label className="flex cursor-pointer items-center gap-2.5">
                  <Toggle checked={r.admin === true} onChange={(v) => patch(i, { admin: v })} label={t.pluginCfg.roleAdmin} />
                  <span className="flex flex-col">
                    <span className="text-sm text-text">{t.pluginCfg.roleAdmin}</span>
                    <span className="text-tiny text-text-muted">{t.pluginCfg.roleAdminHint}</span>
                  </span>
                </label>
                <Field label={t.pluginCfg.roleProjects} hint={t.help.roleProjects}>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {(projects ?? []).map((p) => {
                      const on = r.projectIds.includes(p.id);
                      return (
                        <label key={p.id} className="flex cursor-pointer items-center gap-2 text-sm text-text">
                          <span onClick={() => patch(i, { projectIds: on ? r.projectIds.filter((id) => id !== p.id) : [...r.projectIds, p.id] })}>
                            <Checkbox checked={on} />
                          </span>
                          {p.slug}
                        </label>
                      );
                    })}
                  </div>
                </Field>
                {/* A div-based label wrapper: `Field` renders a <label>, which would implicitly
                    re-label the summary's Manage button with the whole field text. */}
                <LabeledField label={t.pluginCfg.roleTools}>
                  <RoleToolsField tools={allTools} selected={r.tools ?? []} onChange={(tools) => patch(i, { tools })} />
                </LabeledField>
                <Field label={t.pluginCfg.rolePrompt} hint={t.help.rolePrompt}>
                  <textarea value={r.prompt} onChange={(e) => patch(i, { prompt: e.target.value })} rows={3} className={textareaClass} />
                </Field>
              </div>
            ) : null}
          </div>
        );
      })}
      <Button variant="ghost" icon={Plus} className="self-start" onClick={addRole}>
        {t.pluginCfg.addRole}
      </Button>
    </div>
  );
}

/** Editor for an `mcpServers`-type field: a list of external MCP server specs to launch and bridge into
 *  the agent's toolset. Mirrors RolePoliciesEditor's collapsible-rows shape. `args` is edited one per line;
 *  `env` as `KEY=value` lines. */
function McpServersEditor({ value, onChange }: { value: McpServerSpec[]; onChange: (v: McpServerSpec[]) => void }) {
  const { t } = useTranslation();
  const patch = (i: number, p: Partial<McpServerSpec>) => onChange(value.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleRow = (i: number) => setExpanded((prev) => { const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const addServer = () => { setExpanded((prev) => new Set(prev).add(value.length)); onChange([...value, { name: '', command: '', args: [], env: {}, enabled: true, transport: 'stdio' }]); };
  const removeServer = (i: number) => {
    onChange(value.filter((_, j) => j !== i));
    setExpanded((prev) => { const n = new Set<number>(); for (const idx of prev) { if (idx < i) n.add(idx); else if (idx > i) n.add(idx - 1); } return n; });
  };
  // env ⇄ text: one KEY=value per line. A line without '=' is ignored; keys are trimmed.
  const envToText = (env: Record<string, string>) => Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
  const textToEnv = (text: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const k = line.slice(0, eq).trim();
      if (k) out[k] = line.slice(eq + 1).trim();
    }
    return out;
  };
  return (
    <div className="flex flex-col gap-3">
      {value.length === 0 ? <p className="text-xs italic text-text-muted">{t.pluginCfg.mcpNoServers}</p> : null}
      {value.map((s, i) => {
        const open = expanded.has(i);
        return (
          <div key={i} className="rounded-lg border border-border bg-elevated/40">
            <div className="flex items-center gap-2 p-3">
              <button type="button" onClick={() => toggleRow(i)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                {open ? <ChevronDown size={15} className="shrink-0 text-text-muted" aria-hidden /> : <ChevronRight size={15} className="shrink-0 text-text-muted" aria-hidden />}
                <span className="truncate text-sm font-medium text-text">{s.name || t.pluginCfg.mcpServerNew}</span>
                {s.command ? <span className="truncate font-mono text-[11px] text-text-muted">{s.command}</span> : null}
                <span className="ml-auto shrink-0">
                  <Badge tone={s.enabled ? 'accent' : undefined}>{s.enabled ? t.pluginCfg.mcpEnabledBadge : t.pluginCfg.mcpDisabledBadge}</Badge>
                </span>
              </button>
              <Button variant="ghost" icon={Trash2} aria-label={t.pluginCfg.mcpRemoveServer} onClick={() => removeServer(i)} />
            </div>
            {open ? (
              <div className="flex flex-col gap-3 border-t border-border p-3">
                <label className="flex cursor-pointer items-center gap-2.5">
                  <Toggle checked={s.enabled} onChange={(v) => patch(i, { enabled: v })} label={t.pluginCfg.mcpEnabled} />
                  <span className="text-sm text-text">{t.pluginCfg.mcpEnabled}</span>
                </label>
                <div className="@container">
                  <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
                    <Field label={t.pluginCfg.mcpName}>
                      <Input value={s.name} onChange={(e) => patch(i, { name: e.target.value })} placeholder="chrome-devtools" />
                    </Field>
                    <Field label={t.pluginCfg.mcpTransport}>
                      <Segmented
                        aria-label={t.pluginCfg.mcpTransport}
                        size="sm"
                        options={[{ value: 'stdio', label: 'stdio' }, { value: 'http', label: 'HTTP' }, { value: 'sse', label: 'SSE' }]}
                        value={s.transport ?? 'stdio'}
                        onChange={(v) => patch(i, { transport: v as McpServerSpec['transport'] })}
                      />
                    </Field>
                  </div>
                </div>
                {(s.transport ?? 'stdio') === 'stdio' ? (
                  <>
                    <Field label={t.pluginCfg.mcpCommand}>
                      <Input value={s.command} onChange={(e) => patch(i, { command: e.target.value })} placeholder="npx" className="font-mono" />
                    </Field>
                    <Field label={t.pluginCfg.mcpArgs} hint={t.pluginCfg.mcpArgsHint}>
                      <textarea
                        value={s.args.join('\n')}
                        onChange={(e) => patch(i, { args: e.target.value.split('\n').map((a) => a.trim()).filter(Boolean) })}
                        rows={3} className={textareaClass} placeholder={'-y\nchrome-devtools-mcp@latest\n--browserUrl\nhttp://127.0.0.1:9222'}
                      />
                    </Field>
                    <Field label={t.pluginCfg.mcpEnv} hint={t.pluginCfg.mcpEnvHint}>
                      <textarea
                        value={envToText(s.env)}
                        onChange={(e) => patch(i, { env: textToEnv(e.target.value) })}
                        rows={2} className={textareaClass} placeholder={'KEY=value'}
                      />
                    </Field>
                  </>
                ) : (
                  <Field label={t.pluginCfg.mcpUrl} hint={t.pluginCfg.mcpUrlHint}>
                    <Input value={s.url ?? ''} onChange={(e) => patch(i, { url: e.target.value })} placeholder="https://mcp.example.com/mcp" className="font-mono" />
                  </Field>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
      <Button variant="ghost" icon={Plus} className="self-start" onClick={addServer}>
        {t.pluginCfg.mcpAddServer}
      </Button>
    </div>
  );
}

/** Provider picker for a `provider`-type field: choose one of the configured brain providers (its key
 *  is reused as the plugin's credentials, so no key is entered twice). Filtered to those with a key set
 *  and — when the field declares `providerType` — that type (e.g. `openai`, the only one with audio).
 *  Rendering is the shared ProviderPicker; this wrapper just applies the plugin-field filter. */
function PluginProviderField({ value, onChange, providerType }: { value: string; onChange: (v: string) => void; providerType?: string }) {
  const { data: config } = useConfig();
  const { t } = useTranslation();
  const providers = (config?.brain?.providers ?? []).filter((p) => p.apiKeySet && (!providerType || p.type === providerType));
  return <ProviderPicker providers={providers} value={value} onChange={onChange} emptyText={t.pluginCfg.noProviders} size="sm" />;
}

/** A config field's compact label row. Long manifest explanations stay behind the shared `?` affordance
 *  instead of expanding every plugin form vertically. A div keeps the help button out of a label. */
function LabeledField({ label, hint, help, risk, riskLabel, children }: {
  label: string;
  hint?: string;
  help?: string;
  risk?: 'low' | 'medium' | 'high';
  riskLabel?: string;
  children: ReactNode;
}) {
  const descriptions = [...new Set([hint, help].filter((value): value is string => Boolean(value?.trim())))];
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-text-muted">
        <span>{label}</span>
        {risk && riskLabel ? <Badge tone={RISK_TONE[risk]}>{riskLabel}</Badge> : null}
        {descriptions.length ? (
          <HelpTip align="left">
            <span className="flex flex-col gap-1.5">{descriptions.map((text) => <span key={text}>{text}</span>)}</span>
          </HelpTip>
        ) : null}
      </span>
      {children}
    </div>
  );
}

/** The schema-driven config editor: a form generated from the manifest's `configSchema`, rendered as
 *  one Config collapsible or one collapsible per declared `section`. Secrets are write-only (a
 *  placeholder shows they are set) and saving hot-reloads the brain. Also hosts the cronjob/skills
 *  special sections, whose content is data (jobs.json / .md files), not config schema. */
export type PluginConfigMode = 'setup' | 'behavior' | 'advanced';

export function PluginConfigEditor({ detail, fieldLabel, fieldHint, fieldOptions, riskText, draft, mode = 'behavior' }: {
  name: string;
  detail: PluginDetail;
  fieldLabel: (f: PluginConfigField) => string;
  fieldHint: (f: PluginConfigField) => string | undefined;
  fieldOptions: (f: PluginConfigField) => { value: string; label: string }[];
  riskText: (r: 'low' | 'medium' | 'high') => string;
  draft: PluginConfigDraft;
  mode?: PluginConfigMode;
}) {
  const { t } = useTranslation();
  const { data: brainModels } = useBrainModels();
  const { values, setValue: set } = draft;

  const renderField = (f: PluginConfigField) => {
    switch (f.type) {
      case 'boolean':
        return <Toggle checked={values[f.key] === true} onChange={(v) => set(f.key, v)} label={f.label} />;
      case 'number':
        return <Input type="number" min={f.min} max={f.max} step={f.step} placeholder={f.placeholder} aria-label={fieldLabel(f)} value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value === '' ? null : Number(e.target.value))} />;
      case 'textarea':
        return <textarea value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} rows={4} className={textareaClass} />;
      case 'secret':
        return (
          <Input
            type="password"
            value={String(values[f.key] ?? '')}
            onChange={(e) => set(f.key, e.target.value)}
            placeholder={detail.secretsSet.includes(f.key) ? t.pluginCfg.secretSet : ''}
            autoComplete="off"
          />
        );
      case 'model':
        // Brain-only picker: the shared modal/search catalog used by account and cron settings.
        return <BrainModelField value={String(values[f.key] ?? '')} onChange={(v) => set(f.key, v)} models={brainModels ?? []} title={fieldLabel(f)} subtitle={fieldHint(f)} defaultLabel={t.managePicker.none} allowDefault={false} keyOf={(m) => m.exec} />;
      case 'embeddingModel':
        // Same shared brain catalog, used to pick the model that produces embeddings.
        return <BrainModelField value={String(values[f.key] ?? '')} onChange={(v) => set(f.key, v)} models={brainModels ?? []} title={fieldLabel(f)} subtitle={fieldHint(f)} defaultLabel={t.managePicker.none} allowDefault={false} keyOf={(m) => m.exec} />;
      case 'provider':
        // Reuse a configured brain provider's key as this plugin's credentials (voice, image gen).
        return <PluginProviderField value={String(values[f.key] ?? '')} onChange={(v) => set(f.key, v)} providerType={f.providerType} />;
      case 'rolePolicies':
        return <RolePoliciesEditor value={Array.isArray(values[f.key]) ? (values[f.key] as RolePolicy[]) : []} onChange={(v) => set(f.key, v)} />;
      case 'mcpServers':
        return <McpServersEditor value={Array.isArray(values[f.key]) ? (values[f.key] as McpServerSpec[]) : []} onChange={(v) => set(f.key, v)} />;
      case 'enum':
        return <ChoiceField title={fieldLabel(f)} options={fieldOptions(f)} value={String(values[f.key] ?? '')} onChange={(v) => set(f.key, v)} />;
      case 'multiSelect': {
        const sel = Array.isArray(values[f.key]) ? (values[f.key] as string[]) : [];
        return <MultiSelectField label={fieldLabel(f)} options={fieldOptions(f)} value={sel} onChange={(v) => set(f.key, v)} />;
      }
      case 'code':
        return (
          <div className="overflow-hidden rounded-md border border-border" style={{ height: 260 }}>
            <MonacoEditor
              language={f.language ?? 'plaintext'}
              value={String(values[f.key] ?? '')}
              onChange={(v) => set(f.key, v ?? '')}
              theme="elowen-oled"
              beforeMount={defineEditorThemes}
              options={{ fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, padding: { top: 12 }, wordWrap: 'on', folding: false }}
            />
          </div>
        );
      case 'prompt':
        return (
          <div className="overflow-hidden rounded-md border border-border" style={{ height: 260 }}>
            <MonacoEditor
              language="markdown"
              value={String(values[f.key] ?? '')}
              onChange={(v) => set(f.key, v ?? '')}
              theme="elowen-oled"
              beforeMount={defineEditorThemes}
              options={{ fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, padding: { top: 12 }, wordWrap: 'on', lineNumbers: 'off', folding: false }}
            />
          </div>
        );
      case 'json': {
        const raw = values[f.key];
        const text = typeof raw === 'string' ? raw : raw === undefined ? '' : JSON.stringify(raw, null, 2);
        let invalid = false;
        if (text.trim() !== '') { try { JSON.parse(text); } catch { invalid = true; } }
        return (
          <div className="flex flex-col gap-1">
            <textarea
              value={text}
              onChange={(e) => set(f.key, e.target.value)}
              rows={6}
              spellCheck={false}
              className={`${textareaClass}${invalid ? ' border-danger focus:border-danger' : ''}`}
            />
            {invalid ? <span className="flex items-center gap-1 text-xs text-danger" role="alert"><Info size={13} aria-hidden />{t.pluginCfg.invalidJson}</span> : null}
          </div>
        );
      }
      default:
        return <Input value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} />;
    }
  };

  // A field is shown unless its `visibleWhen` guard points at a value the form doesn't currently hold.
  const isVisible = (f: PluginConfigField) => !f.visibleWhen || values[f.visibleWhen.key] === f.visibleWhen.equals;

  const fieldList = (fields: PluginConfigField[]) => (
    <div className="@container grid grid-cols-1 gap-x-5 gap-y-4 @lg:grid-cols-2">
      {fields.filter(isVisible).map((f) => {
        // A `section` field is a group heading carrying no input.
        if (f.type === 'section') {
          return (
            <div key={f.key} className="animate-fade-up @lg:col-span-2 flex items-center gap-2 border-t border-border pt-4 first:border-0 first:pt-0">
              <span className="text-xs font-semibold uppercase tracking-wide text-text">{fieldLabel(f)}</span>
              {fieldHint(f) ? <HelpTip align="left">{fieldHint(f)}</HelpTip> : null}
            </div>
          );
        }
        // Complex editors carry their own row headers, so they render bare (no outer label/hint).
        if (f.type === 'rolePolicies' || f.type === 'mcpServers') return <div key={f.key} className="animate-fade-up @lg:col-span-2">{renderField(f)}</div>;
        if ((f.type === 'boolean' || (f.type === 'enum' && (f.options?.length ?? 0) <= 3)) && !f.risk) {
          const description = [...new Set([fieldHint(f), f.help].filter((value): value is string => Boolean(value?.trim())))].join('\n\n');
          return <SettingsRow key={f.key} label={fieldLabel(f)} description={description || undefined} className="animate-fade-up @lg:col-span-2">{renderField(f)}</SettingsRow>;
        }
        return (
          <div key={f.key} className="animate-fade-up">
            <LabeledField label={fieldLabel(f)} hint={fieldHint(f)} help={f.help} risk={f.risk} riskLabel={f.risk ? riskText(f.risk) : undefined}>
              {renderField(f)}
            </LabeledField>
          </div>
        );
      })}
    </div>
  );

  // Preserve author-declared section boundaries while assigning them to the workspace tabs. A flat
  // legacy schema still falls back to key/type inference, so old third-party manifests remain valid.
  const schema = detail.configSchema;
  let sectionMode: PluginConfigMode = 'behavior';
  const classified = schema.map((field) => {
    if (field.type === 'section') {
      const key = `${field.key} ${field.label}`.toLowerCase();
      sectionMode = field.advanced ? 'advanced' : /connection|setup|auth|credential/.test(key) ? 'setup' : /advanced/.test(key) ? 'advanced' : 'behavior';
      return { field, mode: sectionMode };
    }
    // Every required input belongs to Setup regardless of its key or the manifest author's language;
    // otherwise the checklist can say "missing" while hiding the only control on another tab.
    if (field.required || sectionMode === 'setup' || field.type === 'secret' || CONNECTION_KEYS.has(field.key)) return { field, mode: 'setup' as const };
    if (field.advanced) return { field, mode: 'advanced' as const };
    return { field, mode: sectionMode };
  });
  const visibleSchema = classified.filter((entry, index) => {
    if (entry.field.type !== 'section') return entry.mode === mode;
    const nextSection = classified.findIndex((next, nextIndex) => nextIndex > index && next.field.type === 'section');
    const children = classified.slice(index + 1, nextSection === -1 ? classified.length : nextSection);
    const hasModeChild = children.some((child) => child.field.type !== 'section' && child.mode === mode);
    // A terminal section with no inputs is intentional documentation (e.g. Codebase's inherited
    // embedding model). Keep it on its declared tab instead of silently dropping its HelpTip.
    return hasModeChild || (children.length === 0 && entry.mode === mode);
  }).map((entry) => entry.field);
  const hasExplicitSections = schema.some((f) => f.type === 'section');
  const isComplex = (f: PluginConfigField) => f.type === 'rolePolicies' || f.type === 'mcpServers';
  const isConnection = (f: PluginConfigField) => f.type === 'secret' || CONNECTION_KEYS.has(f.key);
  const connectionFields = visibleSchema.filter((f) => isConnection(f) && !isComplex(f));
  const behaviorFields = visibleSchema.filter((f) => !isConnection(f) && !isComplex(f));
  const complexFields = visibleSchema.filter(isComplex);
  const group = (key: string, Icon: LucideIcon, title: string, hint: string | undefined, fields: PluginConfigField[]) => (
    <SettingsGroup key={key} title={title} description={hint} icon={Icon}>
      <div className="py-4">{fieldList(fields)}</div>
    </SettingsGroup>
  );

  const hasConnectionSection = visibleSchema.some((f) => f.type === 'section' && f.key === 'sec_connection');

  return (
    <>
      {visibleSchema.length === 0 && (detail.configSchema.length > 0 || mode !== 'behavior') ? null : visibleSchema.length === 0 ? (
        <Collapsible icon={SlidersHorizontal} title={t.pluginDetail.config} defaultOpen>
          <p className="text-sm text-text-muted">{t.pluginDetail.configEmpty}</p>
        </Collapsible>
      ) : hasExplicitSections ? (
        <SettingsGroup>
          <div className="py-5">
          {/* WhatsApp: the "Pair device" button (QR/code modal) lives at the top of the Connection section. */}
          {detail.name === 'whatsapp' && hasConnectionSection ? <WhatsAppPairSection /> : null}
          {fieldList(visibleSchema)}
          </div>
        </SettingsGroup>
      ) : (
        <div className="flex flex-col gap-4">
            {connectionFields.length ? group('connection', Link2, t.pluginCfg.sectionConnection, t.pluginCfg.sectionConnectionHint, connectionFields) : null}
            {behaviorFields.length ? group('behavior', SlidersHorizontal, t.pluginCfg.sectionBehavior, undefined, behaviorFields) : null}
            {complexFields.map((cf) => group(cf.key, Users, fieldLabel(cf), fieldHint(cf), [cf]))}
        </div>
      )}

      {/* The cronjob plugin's jobs are data, not config schema — a dedicated editor section. */}
      {mode === 'behavior' && detail.name === 'cronjob' ? (
        <Collapsible icon={Clock} title={t.cron.title} subtitle={t.cron.sectionHint} defaultOpen>
          <CronJobsEditor />
        </Collapsible>
      ) : null}

      {/* Same story for the skills plugin: its skills are .md files, not config schema. */}
      {mode === 'behavior' && detail.name === 'skills' ? (
        <Collapsible icon={GraduationCap} title={t.skills.title} subtitle={t.skills.sectionHint} defaultOpen>
          <SkillsEditor />
        </Collapsible>
      ) : null}
    </>
  );
}
