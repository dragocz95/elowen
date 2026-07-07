'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, Plus, Trash2, KeyRound, ChevronDown, ChevronRight, Clock, Users, SlidersHorizontal, Link2, GraduationCap, Info, Wrench, Webhook, ShieldCheck, HardDrive, ScrollText, Search, Globe, type LucideIcon } from 'lucide-react';
import { useAutoSave } from '../../lib/useAutoSave';
import { useTheme } from '../../lib/useTheme';
import { PluginIcon } from './PluginIcon';
import { CronJobsEditor } from './CronJobsEditor';
import { SkillsEditor } from './SkillsEditor';
import { WhatsAppPairSection } from './WhatsAppPairSection';
import { MonacoEditor } from '../projects/editor/monacoLoader';
import { defineEditorThemes } from '../projects/editor/oledTheme';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Collapsible } from '../../components/ui/Collapsible';
import { HeroCard } from '../../components/ui/HeroCard';
import { PageLayout } from '../../components/ui/PageLayout';
import { RailCard } from '../../components/ui/RailCard';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { HelpTip } from '../../components/ui/HelpTip';
import { ManageSelectionModal, type ManageSelectionItem } from '../../components/ui/ManageSelectionModal';
import { SelectionSummary } from '../../components/ui/SelectionSummary';
import { MorePill } from '../../components/ui/MorePill';
import { Toggle } from '../../components/ui/Toggle';
import { Checkbox } from '../../components/ui/Checkbox';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { ExecutorPicker } from '../../components/ui/ExecutorPicker';
import { Segmented } from '../../components/ui/Segmented';
import { ProviderPicker } from '../../components/ui/ProviderPicker';
import { EmptyState, LoadingState } from '../../components/ui/states';
import type { Tone } from '../../components/ui/tone';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { usePluginDetail, usePluginContributions, usePluginLogs, usePluginHookExecutions, usePlugins, useProjects, useConfig } from '../../lib/queries';
import { useSavePluginConfig, useTogglePlugin, useClearPluginData } from '../../lib/mutations';
import type { PluginConfigField, PluginContributions, PluginHookExecution, RolePolicy, McpServerSpec } from '../../lib/types';

const textareaClass = 'w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm text-text placeholder:text-text-muted focus:border-accent';

/** Human-readable byte size for the Data section (KB/MB steps, 1 decimal above 10 units). */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const n = bytes / 1024 ** i;
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/** Risk level → Badge tone (high danger, medium warning, low muted). */
const RISK_TONE: Record<'low' | 'medium' | 'high', Tone> = { low: 'muted', medium: 'warning', high: 'danger' };

/** Hook-execution outcome → Badge tone: accepted patch is success, fail-open (threw/timeout) is danger,
 *  a capability-gate rejection is a warning (expected deny, not a fault). */
const OUTCOME_TONE: Record<PluginHookExecution['outcome'], Tone> = { ok: 'success', threw: 'danger', timeout: 'danger', rejected: 'warning' };

/** Mutation target → Badge tone by blast radius: tools/memory reach beyond the turn (danger),
 *  prompt/turnContext ride only the ephemeral live prompt (warning). */
const MUTATE_TONE: Record<'prompt' | 'turnContext' | 'tools' | 'memory', Tone> = { prompt: 'warning', turnContext: 'warning', tools: 'danger', memory: 'danger' };

/** Per-role tool allowlist: a compact summary (n selected / all) + a manage modal grouped by the
 *  owning plugin. Empty selection keeps the "no restriction — all tools allowed" semantics. A saved
 *  tool no longer contributed by any enabled plugin stays visible as a pinned row. */
function RoleToolsField({ tools, selected, onChange }: { tools: { name: string; plugin: string }[]; selected: string[]; onChange: (v: string[]) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const known = new Set(tools.map((x) => x.name));
  const items: ManageSelectionItem[] = [
    ...selected.filter((x) => !known.has(x)).map((x) => ({ id: x, label: x, group: '' })),
    ...tools.map((x) => ({ id: x.name, label: x.name, group: x.plugin })),
  ];
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
 *  to a name, the Orca projects it may touch, and an extra prompt injected for that role — a per-role
 *  instructions pattern, kept in the plugin's own config. Rows collapse to a compact header so a
 *  long list stays scannable; a freshly added row starts expanded. */
function RolePoliciesEditor({ value, onChange }: { value: RolePolicy[]; onChange: (v: RolePolicy[]) => void }) {
  const { t } = useTranslation();
  const { data: projects } = useProjects();
  const { data: plugins } = usePlugins();
  // Every tool an enabled plugin contributes, tagged with its owner — the vocabulary (and the
  // modal grouping) for per-role tool allowlists. First owner wins on a name clash.
  const owners = new Map<string, string>();
  for (const p of plugins ?? []) {
    if (!p.enabled) continue;
    for (const tool of p.provides.tools ?? []) if (!owners.has(tool)) owners.set(tool, p.name);
  }
  const allTools = [...owners.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, plugin]) => ({ name, plugin }));
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

// Connection-ish plain keys that belong with the secrets section (endpoints/ids), not with behavior.
const CONNECTION_KEYS = new Set(['guildId', 'threadIds', 'notifyChannelId', 'channelId', 'apiUrl', 'baseUrl', 'url', 'endpoint', 'host', 'port', 'appId', 'clientId', 'webhookUrl']);

/** Drop `json`-typed fields whose current text doesn't parse from the save payload, so a malformed blob
 *  never round-trips to the backend (and into reloadPlugins). The field stays editable/red in the UI —
 *  only the persisted patch skips it, so a valid edit later saves normally. */
function sanitizeConfig(values: Record<string, unknown>, schema: PluginConfigField[]): Record<string, unknown> {
  const jsonKeys = new Set(schema.filter((f) => f.type === 'json').map((f) => f.key));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (jsonKeys.has(k) && typeof v === 'string' && v.trim() !== '') {
      try { JSON.parse(v); } catch { continue; } // invalid JSON → don't persist this field
    }
    out[k] = v;
  }
  return out;
}

/** A label → value pair for the read-only detail grids (Overview, Data). */
function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</span>
      <span className="min-w-0 text-sm text-text">{children}</span>
    </div>
  );
}

/** A config field's label row (label + optional risk badge + help tip) above its control, with an
 *  optional hint below. A div rather than a `<label>` so the help-tip button doesn't nest in a label. */
function LabeledField({ label, hint, help, risk, riskLabel, children }: {
  label: string;
  hint?: string;
  help?: string;
  risk?: 'low' | 'medium' | 'high';
  riskLabel?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-text-muted">
        <span>{label}</span>
        {risk && riskLabel ? <Badge tone={RISK_TONE[risk]}>{riskLabel}</Badge> : null}
        {help ? <HelpTip align="left">{help}</HelpTip> : null}
      </span>
      {children}
      {hint ? <span className="text-xs text-text-muted">{hint}</span> : null}
    </div>
  );
}

// A read-only pill for a contribution / hook name.
const namePill = 'rounded-full border border-border px-2.5 py-1 font-mono text-[11px] text-text-muted';
const PILL_PREVIEW = 4;

/** A wrapping pill row that keeps the UI tidy: shows the first `PILL_PREVIEW` pills and folds the rest
 *  behind a "+N more" toggle. `expandAll` forces the full list open (e.g. while a search filter is active). */
function PillRow({ pills, expandAll = false }: { pills: ReactNode[]; expandAll?: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll || expandAll ? pills : pills.slice(0, PILL_PREVIEW);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {visible}
      {!expandAll && pills.length > PILL_PREVIEW ? (
        <MorePill expanded={showAll} hidden={pills.length - PILL_PREVIEW} onToggle={() => setShowAll((v) => !v)} />
      ) : null}
    </div>
  );
}

/** Tools section body: the plugin's live tools / skills / platforms, grouped and searchable by name. */
function ContributionsList({ contributions }: { contributions?: PluginContributions }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const groups = [
    { key: 'tools' as const, label: t.pluginDetail.tools },
    { key: 'skills' as const, label: t.pluginDetail.skills },
    { key: 'platforms' as const, label: t.pluginDetail.platforms },
  ];
  const total = (contributions?.tools.length ?? 0) + (contributions?.skills.length ?? 0) + (contributions?.platforms.length ?? 0);
  if (total === 0) return <EmptyState title={t.pluginDetail.toolsEmpty} icon={Wrench} />;
  const filtered = groups
    .map((g) => ({ ...g, items: (contributions?.[g.key] ?? []).filter((i) => i.name.toLowerCase().includes(q)) }))
    .filter((g) => g.items.length > 0);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-text-muted">{t.pluginDetail.toolsHint}</p>
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" aria-hidden />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.plugins.searchPlaceholder} className="pl-9" />
      </div>
      {filtered.map((g) => (
        <div key={g.key} className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">{g.label}</span>
          <PillRow expandAll={q.length > 0} pills={g.items.map((i) => <span key={i.name} className={namePill}>{i.name}</span>)} />
        </div>
      ))}
    </div>
  );
}

/** Data section body: the plugin's on-disk footprint plus a destructive "clear" behind a confirm. */
function DataSection({ name, summary }: { name: string; summary: { path: string; exists: boolean; files: number; bytes: number } }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const clear = useClearPluginData();
  const [confirm, setConfirm] = useState(false);
  if (!summary.exists || summary.files === 0) return <EmptyState title={t.pluginDetail.dataEmpty} icon={HardDrive} />;
  const doClear = () => {
    setConfirm(false);
    clear.mutate(name, {
      onSuccess: () => toast(t.pluginDetail.dataCleared),
      onError: () => toast(t.pluginDetail.dataClearError, 'error'),
    });
  };
  return (
    <div className="@container flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 @sm:grid-cols-3">
        <Meta label={t.pluginDetail.dataSize}>{formatBytes(summary.bytes)}</Meta>
        <Meta label={t.pluginDetail.dataFiles.replace('{n}', String(summary.files))}><span className="font-mono">{summary.files}</span></Meta>
        <div className="min-w-0 @sm:col-span-3">
          <Meta label={t.pluginDetail.dataPath}><span className="block break-all font-mono text-xs text-text-muted">{summary.path}</span></Meta>
        </div>
      </div>
      <Button variant="danger" icon={Trash2} className="self-start" onClick={() => setConfirm(true)} disabled={clear.isPending}>{t.pluginDetail.dataClear}</Button>
      <ConfirmDialog
        open={confirm}
        title={t.pluginDetail.dataClear}
        description={t.pluginDetail.dataClearConfirm}
        confirmLabel={t.pluginDetail.dataClear}
        onConfirm={doClear}
        onClose={() => setConfirm(false)}
      />
    </div>
  );
}

// Log level → text colour for the Logs panel.
const LOG_LEVEL_CLASS: Record<'debug' | 'info' | 'warn' | 'error', string> = {
  debug: 'text-text-muted/70',
  info: 'text-text-muted',
  warn: 'text-warning',
  error: 'text-danger',
};

/** One plugin's rich detail view: an identity hero plus collapsible Overview / Config / Tools / Hooks /
 *  Permissions / Data / Logs sections. Config is a form generated from the manifest's `configSchema`;
 *  secrets are write-only (a placeholder shows they are set) and saving hot-reloads the brain. */
export function PluginDetail({ name, onBack }: { name: string; onBack: () => void }) {
  const { data, isLoading } = usePluginDetail(name);
  const { data: contributions } = usePluginContributions(name);
  const { data: logs } = usePluginLogs(name);
  const { data: hookExecutions } = usePluginHookExecutions(name);
  const save = useSavePluginConfig();
  const toggle = useTogglePlugin();
  const { toast } = useToast();
  const { t, locale } = useTranslation();
  const { resolvedTheme } = useTheme();
  const monacoTheme = resolvedTheme === 'light' ? 'orca-light' : 'orca-oled';
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [seeded, setSeeded] = useState(false);

  // Seed the local draft once, on first arrival. A save invalidates the detail query → refetch; re-seeding
  // from that refetch would clobber whatever the user is still typing, so only seed while not yet seeded.
  useEffect(() => { if (data && !seeded) { setValues(data.config); setSeeded(true); } }, [data, seeded]);

  // Auto-persist shortly after any field change; the daemon hot-reloads the brain on save.
  useAutoSave([values], () => save.mutate(
    { name, values: sanitizeConfig(values, data?.configSchema ?? []) },
    { onError: () => toast(t.pluginCfg.saveError, 'error') }, // auto-save is silent on success — only failures surface
  ), { ready: seeded, delay: 1200 });

  if (isLoading || !data) return <LoadingState />;
  const detail = data;

  const set = (key: string, v: unknown) => setValues((cur) => ({ ...cur, [key]: v }));

  // Manifest strings are English; a plugin's own `i18n/<locale>.json` overrides description + per-field
  // label/hint. Fall back to the manifest English whenever a translation is absent.
  const tr = detail.i18n?.[locale];
  const fieldLabel = (f: PluginConfigField) => tr?.fields?.[f.key]?.label ?? f.label;
  const fieldHint = (f: PluginConfigField) => tr?.fields?.[f.key]?.hint ?? f.hint;

  const renderField = (f: PluginConfigField) => {
    switch (f.type) {
      case 'boolean':
        return <Toggle checked={values[f.key] === true} onChange={(v) => set(f.key, v)} label={f.label} />;
      case 'number':
        return <Input type="number" value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value === '' ? undefined : Number(e.target.value))} />;
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
        // Brain-only picker: full Orca AI catalog (incl. OAuth accounts) — image gen never runs a CLI worker.
        return <ExecutorPicker value={String(values[f.key] ?? '')} onChange={(v) => set(f.key, v)} models={[]} allowDefault={false} kind="brain" />;
      case 'embeddingModel':
        // Same brain catalog, used to pick the model that produces embeddings (parallels `model`).
        return <ExecutorPicker value={String(values[f.key] ?? '')} onChange={(v) => set(f.key, v)} models={[]} allowDefault={false} kind="brain" />;
      case 'provider':
        // Reuse a configured brain provider's key as this plugin's credentials (voice, image gen).
        return <PluginProviderField value={String(values[f.key] ?? '')} onChange={(v) => set(f.key, v)} providerType={f.providerType} />;
      case 'rolePolicies':
        return <RolePoliciesEditor value={Array.isArray(values[f.key]) ? (values[f.key] as RolePolicy[]) : []} onChange={(v) => set(f.key, v)} />;
      case 'mcpServers':
        return <McpServersEditor value={Array.isArray(values[f.key]) ? (values[f.key] as McpServerSpec[]) : []} onChange={(v) => set(f.key, v)} />;
      case 'enum':
        return <Segmented size="sm" options={(f.options ?? []).map((o) => ({ value: o.value, label: o.label }))} value={String(values[f.key] ?? '')} onChange={(v) => set(f.key, v)} />;
      case 'multiSelect': {
        const sel = Array.isArray(values[f.key]) ? (values[f.key] as string[]) : [];
        return <MultiSelectField label={fieldLabel(f)} options={f.options ?? []} value={sel} onChange={(v) => set(f.key, v)} />;
      }
      case 'code':
        return (
          <div className="overflow-hidden rounded-md border border-border" style={{ height: 260 }}>
            <MonacoEditor
              language={f.language ?? 'plaintext'}
              value={String(values[f.key] ?? '')}
              onChange={(v) => set(f.key, v ?? '')}
              theme={monacoTheme}
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
              theme={monacoTheme}
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
            {/* No copy for the parse error is in the locked i18n contract yet, so the invalid state is
                signalled visually (red field + marker) rather than with a hardcoded string. */}
            {invalid ? <span className="flex items-center gap-1 text-danger" aria-hidden><Info size={13} /></span> : null}
          </div>
        );
      }
      default:
        return <Input value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} />;
    }
  };

  const pluginDescription = tr?.description ?? detail.description;
  const riskText = (r: 'low' | 'medium' | 'high') => (r === 'high' ? t.pluginDetail.riskHigh : r === 'medium' ? t.pluginDetail.riskMedium : t.pluginDetail.riskLow);
  const outcomeText = (o: PluginHookExecution['outcome']) =>
    o === 'ok' ? t.pluginDetail.outcomeOk
      : o === 'threw' ? t.pluginDetail.outcomeThrew
        : o === 'timeout' ? t.pluginDetail.outcomeTimeout
          : t.pluginDetail.outcomeRejected;
  // A field is shown unless its `visibleWhen` guard points at a value the form doesn't currently hold.
  const isVisible = (f: PluginConfigField) => !f.visibleWhen || values[f.visibleWhen.key] === f.visibleWhen.equals;

  const fieldList = (fields: PluginConfigField[]) => (
    <div className="flex flex-col gap-4">
      {fields.filter(isVisible).map((f) => {
        // A `section` field is a group heading carrying no input.
        if (f.type === 'section') {
          return (
            <div key={f.key} className="border-t border-border pt-3 first:border-0 first:pt-0">
              <span className="text-xs font-semibold uppercase tracking-wide text-text">{fieldLabel(f)}</span>
              {fieldHint(f) ? <p className="mt-1 text-xs text-text-muted">{fieldHint(f)}</p> : null}
            </div>
          );
        }
        // Complex editors carry their own row headers, so they render bare (no outer label/hint).
        if (f.type === 'rolePolicies' || f.type === 'mcpServers') return <div key={f.key}>{renderField(f)}</div>;
        return (
          <LabeledField key={f.key} label={fieldLabel(f)} hint={fieldHint(f)} help={f.help} risk={f.risk} riskLabel={f.risk ? riskText(f.risk) : undefined}>
            {renderField(f)}
          </LabeledField>
        );
      })}
    </div>
  );

  // Config body: when the schema uses explicit `section` headers the author organised it, so render it
  // in declared order. Otherwise bucket generically (connection/secrets vs behaviour vs complex editors)
  // so a flat schema with many fields still reads cleanly.
  const schema = detail.configSchema;
  const hasExplicitSections = schema.some((f) => f.type === 'section');
  const isComplex = (f: PluginConfigField) => f.type === 'rolePolicies' || f.type === 'mcpServers';
  const isConnection = (f: PluginConfigField) => f.type === 'secret' || CONNECTION_KEYS.has(f.key);
  const connectionFields = schema.filter((f) => isConnection(f) && !isComplex(f));
  const behaviorFields = schema.filter((f) => !isConnection(f) && !isComplex(f));
  const complexFields = schema.filter(isComplex);
  const group = (key: string, Icon: LucideIcon, title: string, hint: string | undefined, fields: PluginConfigField[]) => (
    <div key={key} className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Icon size={14} className="text-text-muted" aria-hidden />
        <span className="text-sm font-medium text-text">{title}</span>
      </div>
      {hint ? <p className="text-xs text-text-muted">{hint}</p> : null}
      {fieldList(fields)}
    </div>
  );

  // When the author used explicit `section` headers, each section becomes its OWN top-level collapsible
  // (a peer of Tools/Hooks/Permissions) instead of being crammed into one Config panel. Partition the flat
  // schema into { title, hint, fields } groups on section boundaries; fields before the first header (if
  // any) fall into a generic Config group.
  type ConfigGroup = { key: string; title: string; hint?: string; fields: PluginConfigField[] };
  const configGroups: ConfigGroup[] = [];
  if (hasExplicitSections) {
    let current: ConfigGroup | null = null;
    for (const f of schema) {
      if (f.type === 'section') {
        current = { key: f.key, title: fieldLabel(f), hint: fieldHint(f), fields: [] };
        configGroups.push(current);
      } else {
        if (!current) { current = { key: '__config', title: t.pluginDetail.config, fields: [] }; configGroups.push(current); }
        current.fields.push(f);
      }
    }
  }
  const groupHasUnsetSecret = (g: ConfigGroup) =>
    g.fields.some((f) => f.type === 'secret' && f.required && !detail.secretsSet.includes(f.key));

  // Permissions derived from what EXISTS in the manifest — required secret fields read as credential
  // requirements, the rest as plain config; a coarse risk level from secrets/network/tool-count.
  const requiredSecrets = schema.filter((f) => f.required && f.type === 'secret');
  const requiredConfig = schema.filter((f) => f.required && f.type !== 'secret' && f.type !== 'section');
  const hasSecrets = schema.some((f) => f.type === 'secret') || detail.secretsSet.length > 0;
  const platformCount = detail.provides.platforms?.length ?? 0;
  const declaresNetwork = schema.some((f) => CONNECTION_KEYS.has(f.key)) || platformCount > 0;
  const toolCount = detail.provides.tools?.length ?? 0;
  const anyHighRiskField = schema.some((f) => f.risk === 'high');
  const riskLevel: 'low' | 'medium' | 'high' =
    anyHighRiskField || (hasSecrets && (declaresNetwork || toolCount > 3)) ? 'high'
      : hasSecrets || declaresNetwork || toolCount > 0 ? 'medium'
        : 'low';

  // Open Config first only when there's a required-but-unset secret to fill in; otherwise Overview.
  const hasUnsetRequiredSecret = schema.some((f) => f.type === 'secret' && f.required && !detail.secretsSet.includes(f.key));
  const health = logs?.health ?? detail.health ?? 'ok';
  const hookCount = detail.provides.hooks?.length ?? 0;

  // Declared manifest capabilities — deny-by-default: an absent target means the plugin CANNOT do it.
  const capabilities = detail.capabilities ?? {};
  const mutates = capabilities.mutates ?? [];
  const reads = capabilities.reads ?? [];
  const hasCapabilities = mutates.length > 0 || reads.length > 0 || capabilities.network === true;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Button variant="ghost" icon={ArrowLeft} onClick={onBack}>{t.pluginCfg.back}</Button>
      </div>

      {/* Hero: the plugin's identity card — icon, name, description, live enable toggle, and key facts. */}
      <HeroCard
        icon={detail.hasIllustration
          ? // eslint-disable-next-line @next/next/no-img-element -- served from the daemon route via BFF
            <img src={`/api/plugins/${encodeURIComponent(detail.name)}/illustration`} alt="" className="h-full w-full object-contain" />
          : <PluginIcon name={detail.name} hasIcon={detail.hasIcon} size={64} />}
        title={detail.name}
        subtitle={pluginDescription}
        badge={<Badge tone={detail.enabled ? 'success' : 'muted'}>{detail.enabled ? t.pluginDetail.statusEnabled : t.pluginDetail.statusDisabled}</Badge>}
        meta={[
          { label: t.pluginDetail.overviewVersion, value: <span className="font-mono">v{detail.version}</span> },
          { label: t.pluginDetail.overviewSource, value: detail.source === 'bundled' ? t.plugins.bundled : t.plugins.user },
          { label: t.pluginDetail.tools, value: <span className="font-mono">{toolCount}</span> },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Toggle checked={detail.enabled} onChange={(v) => toggle.mutate({ name, enabled: v })} label={detail.name} disabled={toggle.isPending} />
            <HelpTip align="left">{t.help.pluginEnable}</HelpTip>
          </div>
        }
      />

      {/* Two-column body: the config + capability sections in the main column, a status rail on the right. */}
      <PageLayout
        rail={
          <RailCard title={t.pluginDetail.overviewStatus}>
            <dl className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <dt className="flex items-center gap-1 text-xs text-text-muted">{t.pluginDetail.health}<HelpTip align="left">{t.help.pluginHealth}</HelpTip></dt>
                <dd><Badge tone={health === 'error' ? 'danger' : 'success'}>{health === 'error' ? t.plugins.healthError : t.plugins.healthOk}</Badge></dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-xs text-text-muted">{t.pluginDetail.tools}</dt>
                <dd className="font-mono text-sm text-text">{toolCount}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-xs text-text-muted">{t.pluginDetail.hooks}</dt>
                <dd className="font-mono text-sm text-text">{hookCount}</dd>
              </div>
              {platformCount > 0 ? (
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-xs text-text-muted">{t.pluginDetail.platforms}</dt>
                  <dd className="font-mono text-sm text-text">{platformCount}</dd>
                </div>
              ) : null}
            </dl>
          </RailCard>
        }
      >

      {/* Config: when the author declared `section` headers, each section is its own collapsible (a
          peer of Tools/Hooks below); otherwise a single generated Config panel. */}
      {schema.length === 0 ? (
        <Collapsible icon={SlidersHorizontal} title={t.pluginDetail.config}>
          <p className="text-sm text-text-muted">{t.pluginDetail.configEmpty}</p>
        </Collapsible>
      ) : hasExplicitSections ? (
        configGroups.map((g, i) => (
          <Collapsible key={g.key} icon={SlidersHorizontal} title={g.title} subtitle={g.hint} defaultOpen={i === 0 || groupHasUnsetSecret(g)}>
            {/* WhatsApp: the "Pair device" button (QR/code modal) lives at the top of the Connection section. */}
            {detail.name === 'whatsapp' && g.key === 'sec_connection' ? <WhatsAppPairSection /> : null}
            {fieldList(g.fields)}
          </Collapsible>
        ))
      ) : (
        <Collapsible icon={SlidersHorizontal} title={t.pluginDetail.config} defaultOpen={hasUnsetRequiredSecret}>
          <div className="flex flex-col gap-6">
            {connectionFields.length ? group('connection', Link2, t.pluginCfg.sectionConnection, t.pluginCfg.sectionConnectionHint, connectionFields) : null}
            {behaviorFields.length ? group('behavior', SlidersHorizontal, t.pluginCfg.sectionBehavior, undefined, behaviorFields) : null}
            {complexFields.map((cf) => group(cf.key, Users, fieldLabel(cf), fieldHint(cf), [cf]))}
          </div>
        </Collapsible>
      )}

      {/* The cronjob plugin's jobs are data, not config schema — a dedicated editor section. */}
      {detail.name === 'cronjob' ? (
        <Collapsible icon={Clock} title={t.cron.title} subtitle={t.cron.sectionHint} defaultOpen>
          <CronJobsEditor />
        </Collapsible>
      ) : null}

      {/* Same story for the skills plugin: its skills are .md files, not config schema. */}
      {detail.name === 'skills' ? (
        <Collapsible icon={GraduationCap} title={t.skills.title} subtitle={t.skills.sectionHint} defaultOpen>
          <SkillsEditor />
        </Collapsible>
      ) : null}


      {/* 3 — Tools: the plugin's live tools / skills / platforms. */}
      <Collapsible icon={Wrench} title={t.pluginDetail.tools}>
        <ContributionsList contributions={contributions} />
      </Collapsible>

      {/* 4 — Hooks: the plugin's registered runtime hooks (subscriptions) + a recent-execution audit. */}
      <Collapsible icon={Webhook} title={t.pluginDetail.hooks}>
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-3">
            <p className="text-xs text-text-muted">{t.pluginDetail.hooksHint}</p>
            {(contributions?.hooks.length ?? 0) === 0 ? (
              <EmptyState title={t.pluginDetail.hooksEmpty} icon={Webhook} />
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {(contributions?.hooks ?? []).map((h, i) => <span key={`${h.name}-${i}`} className={namePill}>{h.name}</span>)}
              </div>
            )}
          </div>
          {/* Recent-execution audit: only shown once at least one hook has actually run — an empty audit
              is noise (no bundled plugin registers hooks), so the panel stays hidden until there's data. */}
          {hookExecutions && hookExecutions.entries.length > 0 ? (
            <div className="flex flex-col gap-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t.pluginDetail.hookExecutions}</span>
              <p className="text-xs text-text-muted">{t.pluginDetail.hookExecutionsHint}</p>
              <div className="max-h-72 overflow-auto rounded-md border border-border bg-bg p-3 text-[11px] leading-relaxed">
                {hookExecutions.entries.map((e, i) => (
                  <div key={i} className="flex items-center gap-2 py-1">
                    <span className="shrink-0 font-mono text-text-muted">{new Date(e.ts).toLocaleTimeString(locale)}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-text">{e.hook}</span>
                    {e.changed ? <span className="shrink-0 font-mono text-text-muted">{e.changed}</span> : null}
                    <span className="shrink-0 font-mono text-text-muted">{`${e.durationMs} ms`}</span>
                    <Badge tone={OUTCOME_TONE[e.outcome]}>{outcomeText(e.outcome)}</Badge>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </Collapsible>

      {/* 5 — Permissions: derived requirements + risk summary (read-only). */}
      <Collapsible icon={ShieldCheck} title={t.pluginDetail.permissions}>
        <div className="flex flex-col gap-4">
          <p className="text-xs text-text-muted">{t.pluginDetail.permissionsHint}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={RISK_TONE[riskLevel]}>{riskText(riskLevel)}</Badge>
            {hasSecrets ? <Badge tone="accent"><KeyRound size={10} className="mr-1" aria-hidden />{t.brain.keySet}</Badge> : null}
            {declaresNetwork ? <Badge><Globe size={10} className="mr-1" aria-hidden />{t.pluginDetail.platforms}</Badge> : null}
            {toolCount > 0 ? <Badge>{`${toolCount} ${t.pluginDetail.tools}`}</Badge> : null}
          </div>
          {/* Declared manifest capabilities — the deny-by-default permission surface. Shown only when the
              plugin actually declares something; an absent declaration means "cannot do anything", so an
              empty panel carries no information and stays hidden. */}
          {hasCapabilities ? (
            <div className="flex flex-col gap-2 rounded-md border border-border bg-bg p-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t.pluginDetail.capabilities}</span>
              <p className="text-xs text-text-muted">{t.pluginDetail.capabilitiesDeny}</p>
              <div className="flex flex-col gap-2">
                {mutates.length ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-medium text-text-muted">{t.pluginDetail.capMutates}</span>
                    {mutates.map((m) => <Badge key={m} tone={MUTATE_TONE[m]}>{m}</Badge>)}
                  </div>
                ) : null}
                {capabilities.network === true ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-medium text-text-muted">{t.pluginDetail.capNetwork}</span>
                    <Badge tone="warning"><Globe size={10} className="mr-1" aria-hidden />{t.pluginDetail.capNetworkOn}</Badge>
                  </div>
                ) : null}
                {reads.length ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-medium text-text-muted">{t.pluginDetail.capReads}</span>
                    {reads.map((r) => <span key={r} className={namePill}>{r}</span>)}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
          {requiredSecrets.length === 0 && requiredConfig.length === 0 ? (
            <p className="text-sm text-text-muted">{t.pluginDetail.requiresNone}</p>
          ) : (
            <div className="flex flex-col gap-3">
              {requiredSecrets.length ? (
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t.pluginDetail.requiresEnv}</span>
                  <div className="flex flex-wrap gap-1.5">{requiredSecrets.map((f) => <span key={f.key} className={namePill}>{fieldLabel(f)}</span>)}</div>
                </div>
              ) : null}
              {requiredConfig.length ? (
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t.pluginDetail.requiresConfig}</span>
                  <div className="flex flex-wrap gap-1.5">{requiredConfig.map((f) => <span key={f.key} className={namePill}>{fieldLabel(f)}</span>)}</div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </Collapsible>

      {/* 6 — Data: on-disk footprint + destructive clear. */}
      <Collapsible icon={HardDrive} title={t.pluginDetail.data}>
        <DataSection name={name} summary={detail.data} />
      </Collapsible>

      {/* 7 — Logs: the tail of the plugin's log ring, newest last. */}
      <Collapsible icon={ScrollText} title={t.pluginDetail.logs}>
        <div className="flex flex-col gap-3">
          <p className="text-xs text-text-muted">{t.pluginDetail.logsHint}</p>
          {!logs || logs.entries.length === 0 ? (
            <EmptyState title={t.pluginDetail.logsEmpty} icon={ScrollText} />
          ) : (
            <div className="max-h-72 overflow-auto rounded-md border border-border bg-bg p-3 font-mono text-[11px] leading-relaxed">
              {logs.entries.map((e, i) => (
                <div key={i} className="flex gap-2 py-0.5">
                  <span className="shrink-0 text-text-muted">{new Date(e.ts).toLocaleTimeString(locale)}</span>
                  <span className={`shrink-0 uppercase ${LOG_LEVEL_CLASS[e.level]}`}>{e.level}</span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-text">{e.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Collapsible>
      </PageLayout>
    </div>
  );
}
