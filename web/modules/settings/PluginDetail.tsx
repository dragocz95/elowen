'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, Plus, Trash2, KeyRound, ChevronDown, ChevronRight, Clock, Users, SlidersHorizontal, Link2, GraduationCap, type LucideIcon } from 'lucide-react';
import { useAutoSave } from '../../lib/useAutoSave';
import { pluginIcon } from './pluginMeta';
import { CronJobsEditor } from './CronJobsEditor';
import { SkillsEditor } from './SkillsEditor';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { Toggle } from '../../components/ui/Toggle';
import { Checkbox } from '../../components/ui/Checkbox';
import { ExecutorPicker } from '../../components/ui/ExecutorPicker';
import { Segmented } from '../../components/ui/Segmented';
import { LoadingState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { usePluginDetail, usePlugins, useProjects, useConfig } from '../../lib/queries';
import { useSavePluginConfig, useTogglePlugin } from '../../lib/mutations';
import type { PluginConfigField, RolePolicy } from '../../lib/types';

const textareaClass = 'w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm text-text placeholder:text-text-muted focus:border-accent';

/** A collapsible section: an icon chip + title header with a rotating chevron, and content that hides
 *  when closed. Matches SettingCard styling so a group of these reads as one system. */
function Collapsible({ icon: Icon, title, description, defaultOpen = false, children }: {
  icon: LucideIcon;
  title: string;
  description?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-border bg-surface" style={{ boxShadow: 'var(--shadow-card)' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 rounded-xl px-5 py-4 text-left transition-colors hover:bg-elevated/40"
        style={{ transitionDuration: 'var(--motion-fast)' }}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-elevated text-text-muted">
          <Icon size={15} aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium text-text">{title}</span>
          {description ? <span className="text-xs leading-relaxed text-text-muted">{description}</span> : null}
        </span>
        <ChevronDown size={16} className={`shrink-0 text-text-muted transition-transform ${open ? '' : '-rotate-90'}`} style={{ transitionDuration: 'var(--motion-fast)' }} aria-hidden />
      </button>
      {open ? <div className="border-t border-border px-5 py-4">{children}</div> : null}
    </div>
  );
}

/** Per-role tool allowlist pills. Selected tools always show; the unselected vocabulary is previewed
 *  (first N) with a "+xx more" expander so a big tool set doesn't wall the form. Empty = everything. */
const TOOL_PREVIEW = 10;
function ToolPills({ allTools, selected, onChange }: { allTools: string[]; selected: string[]; onChange: (v: string[]) => void }) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const unselected = allTools.filter((x) => !selected.includes(x));
  const visible = [...selected, ...(showAll ? unselected : unselected.slice(0, Math.max(0, TOOL_PREVIEW - selected.length)))];
  const hidden = allTools.length - visible.length;
  const pill = (tool: string, on: boolean) => (
    <button
      key={tool}
      type="button"
      onClick={() => onChange(on ? selected.filter((x) => x !== tool) : [...selected, tool])}
      className={`rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors ${on ? 'border-accent bg-accent/15 text-accent' : 'border-border text-text-muted hover:bg-elevated'}`}
    >
      {tool}
    </button>
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {visible.map((tool) => pill(tool, selected.includes(tool)))}
        {hidden > 0 ? (
          <button type="button" onClick={() => setShowAll(true)} className="rounded-full border border-dashed border-border px-2.5 py-1 text-[11px] text-text-muted transition-colors hover:bg-elevated">
            {t.pluginCfg.roleToolsMore.replace('{n}', String(hidden))}
          </button>
        ) : null}
        {showAll && unselected.length > 0 ? (
          <button type="button" onClick={() => setShowAll(false)} className="rounded-full border border-dashed border-border px-2.5 py-1 text-[11px] text-text-muted transition-colors hover:bg-elevated">
            {t.pluginCfg.roleToolsLess}
          </button>
        ) : null}
      </div>
      {selected.length === 0 ? <span className="text-[11px] italic text-text-muted">{t.pluginCfg.roleToolsAll}</span> : null}
    </div>
  );
}

/** Structured editor for a `rolePolicies` field: each row maps a platform role (e.g. a Discord role id)
 *  to a name, the Orca projects it may touch, and an extra prompt injected for that role — the Hermes
 *  role-instructions pattern, kept in the plugin's own config. Rows collapse to a compact header so a
 *  long list stays scannable; a freshly added row starts expanded. */
function RolePoliciesEditor({ value, onChange }: { value: RolePolicy[]; onChange: (v: RolePolicy[]) => void }) {
  const { t } = useTranslation();
  const { data: projects } = useProjects();
  const { data: plugins } = usePlugins();
  // Every tool an enabled plugin contributes — the vocabulary for per-role tool allowlists.
  const allTools = [...new Set((plugins ?? []).filter((p) => p.enabled).flatMap((p) => p.provides.tools ?? []))].sort();
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
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label={t.pluginCfg.roleId}>
                    <Input value={r.roleId} onChange={(e) => patch(i, { roleId: e.target.value })} placeholder="1511041803225272420" className="font-mono" />
                  </Field>
                  <Field label={t.pluginCfg.roleName}>
                    <Input value={r.name} onChange={(e) => patch(i, { name: e.target.value })} placeholder="dev-team" />
                  </Field>
                </div>
                <label className="flex cursor-pointer items-center gap-2.5">
                  <Toggle checked={r.admin === true} onChange={(v) => patch(i, { admin: v })} label={t.pluginCfg.roleAdmin} />
                  <span className="flex flex-col">
                    <span className="text-sm text-text">{t.pluginCfg.roleAdmin}</span>
                    <span className="text-tiny text-text-muted">{t.pluginCfg.roleAdminHint}</span>
                  </span>
                </label>
                <Field label={t.pluginCfg.roleProjects} hint={t.pluginCfg.roleProjectsHint}>
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
                <Field label={t.pluginCfg.roleTools}>
                  <ToolPills allTools={allTools} selected={r.tools ?? []} onChange={(tools) => patch(i, { tools })} />
                </Field>
                <Field label={t.pluginCfg.rolePrompt} hint={t.pluginCfg.rolePromptHint}>
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

/** Provider picker for a `provider`-type field: choose one of the configured brain providers (its key
 *  is reused as the plugin's credentials, so no key is entered twice). Filtered to those with a key set
 *  and — when the field declares `providerType` — that type (e.g. `openai`, the only one with audio). */
function ProviderPicker({ value, onChange, providerType }: { value: string; onChange: (v: string) => void; providerType?: string }) {
  const { data: config } = useConfig();
  const { t } = useTranslation();
  const providers = (config?.brain?.providers ?? []).filter((p) => p.apiKeySet && (!providerType || p.type === providerType));
  if (providers.length === 0) return <p className="text-xs text-text-muted">{t.pluginCfg.noProviders}</p>;
  return (
    <Segmented
      size="sm"
      options={providers.map((p) => ({ value: p.id, label: p.label }))}
      value={value}
      onChange={onChange}
    />
  );
}

// Connection-ish plain keys that belong with the secrets section (endpoints/ids), not with behavior.
const CONNECTION_KEYS = new Set(['guildId', 'threadIds', 'notifyChannelId', 'channelId', 'apiUrl', 'baseUrl', 'url', 'endpoint', 'host', 'port', 'appId', 'clientId', 'webhookUrl']);

/** One plugin's own settings section: header (enable toggle) + a form generated from the manifest's
 *  configSchema, grouped into collapsible sections. Secrets are write-only (placeholder shows they are
 *  set); saving hot-reloads the brain. */
export function PluginDetail({ name, onBack }: { name: string; onBack: () => void }) {
  const { data, isLoading } = usePluginDetail(name);
  const save = useSavePluginConfig();
  const toggle = useTogglePlugin();
  const { toast } = useToast();
  const { t, locale } = useTranslation();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [seeded, setSeeded] = useState(false);

  useEffect(() => { if (data) { setValues(data.config); setSeeded(true); } }, [data]);

  // Auto-persist shortly after any field change; the daemon hot-reloads the brain on save.
  useAutoSave([values], () => save.mutate(
    { name, values },
    { onError: () => toast(t.pluginCfg.saveError, 'error') }, // auto-save is silent on success — only failures surface
  ), { ready: seeded, delay: 1200 });

  if (isLoading || !data) return <LoadingState />;

  const set = (key: string, v: unknown) => setValues((cur) => ({ ...cur, [key]: v }));

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
            placeholder={data.secretsSet.includes(f.key) ? t.pluginCfg.secretSet : ''}
            autoComplete="off"
          />
        );
      case 'model':
        // Brain-only picker: full Orca AI catalog (incl. OAuth accounts) — image gen never runs a CLI worker.
        return <ExecutorPicker value={String(values[f.key] ?? '')} onChange={(v) => set(f.key, v)} models={[]} allowDefault={false} kind="brain" />;
      case 'provider':
        // Reuse a configured brain provider's key as this plugin's credentials (voice, image gen).
        return <ProviderPicker value={String(values[f.key] ?? '')} onChange={(v) => set(f.key, v)} providerType={f.providerType} />;
      case 'rolePolicies':
        return <RolePoliciesEditor value={Array.isArray(values[f.key]) ? (values[f.key] as RolePolicy[]) : []} onChange={(v) => set(f.key, v)} />;
      default:
        return <Input value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} />;
    }
  };

  const Icon = pluginIcon(data.name);
  // Manifest strings are English; a plugin's own `i18n/<locale>.json` overrides description + per-field
  // label/hint. Fall back to the manifest English whenever a translation is absent.
  const tr = data.i18n?.[locale];
  const fieldLabel = (f: PluginConfigField) => tr?.fields?.[f.key]?.label ?? f.label;
  const fieldHint = (f: PluginConfigField) => tr?.fields?.[f.key]?.hint ?? f.hint;
  const pluginDescription = tr?.description ?? data.description;
  const fieldList = (fields: PluginConfigField[]) => (
    <div className="flex flex-col gap-4">
      {fields.map((f) => (
        // Complex editors carry their own section header (title + hint), so they render bare — wrapping
        // them in a labelled Field would repeat the label above and the hint below the editor.
        f.type === 'rolePolicies'
          ? <div key={f.key}>{renderField(f)}</div>
          : <Field key={f.key} label={fieldLabel(f)} hint={fieldHint(f)}>{renderField(f)}</Field>
      ))}
    </div>
  );

  // Bucket the schema generically (by type / known connection keys) into collapsible sections so a
  // plugin with many settings reads cleanly. Complex editors (rolePolicies) each get their own section.
  const isComplex = (f: PluginConfigField) => f.type === 'rolePolicies';
  const isConnection = (f: PluginConfigField) => f.type === 'secret' || CONNECTION_KEYS.has(f.key);
  const connectionFields = data.configSchema.filter((f) => isConnection(f) && !isComplex(f));
  const behaviorFields = data.configSchema.filter((f) => !isConnection(f) && !isComplex(f));
  const complexFields = data.configSchema.filter(isComplex);

  const sections: { id: string; title: string; description?: string; icon: LucideIcon; fields: PluginConfigField[] }[] = [];
  if (connectionFields.length) sections.push({ id: 'connection', title: t.pluginCfg.sectionConnection, description: t.pluginCfg.sectionConnectionHint, icon: Link2, fields: connectionFields });
  if (behaviorFields.length) sections.push({ id: 'behavior', title: t.pluginCfg.sectionBehavior, icon: SlidersHorizontal, fields: behaviorFields });
  for (const cf of complexFields) sections.push({ id: cf.key, title: fieldLabel(cf), description: fieldHint(cf), icon: Users, fields: [cf] });

  // Open the section with a required-but-unset secret first (the thing the user must fill in), else the
  // first section — the rest start collapsed so the page reads calmly.
  const hasUnsetRequiredSecret = connectionFields.some((f) => f.type === 'secret' && f.required && !data.secretsSet.includes(f.key));
  const openId = hasUnsetRequiredSecret && connectionFields.length ? 'connection' : sections[0]?.id;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Button variant="ghost" icon={ArrowLeft} onClick={onBack}>{t.pluginCfg.back}</Button>
      </div>

      {/* Hero header: the plugin's identity card, with the live enable toggle. */}
      <div className="flex items-start gap-4 rounded-xl border border-border bg-surface p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
        <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border ${data.enabled ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border bg-elevated text-text-muted'}`}>
          <Icon size={22} aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text">
            {data.name}
            <span className="font-mono text-tiny text-text-muted">v{data.version}</span>
            {data.secretsSet.length > 0 ? <Badge tone="accent"><KeyRound size={10} className="mr-1" aria-hidden />{t.brain.keySet}</Badge> : null}
          </span>
          <p className="text-xs leading-relaxed text-text-muted">{pluginDescription}</p>
        </div>
        <span className="flex shrink-0 items-center gap-2 pt-1 text-sm text-text-muted">
          {data.enabled ? t.plugins.disable : t.plugins.enable}
          <Toggle checked={data.enabled} onChange={(v) => toggle.mutate({ name, enabled: v })} label={data.name} disabled={toggle.isPending} />
        </span>
      </div>

      {sections.map((s) => (
        <Collapsible key={s.id} icon={s.icon} title={s.title} description={s.description} defaultOpen={s.id === openId}>
          {fieldList(s.fields)}
        </Collapsible>
      ))}

      {/* The cronjob plugin's jobs are data, not config schema — a dedicated editor section. */}
      {data.name === 'cronjob' ? (
        <Collapsible icon={Clock} title={t.cron.title} description={t.cron.sectionHint} defaultOpen>
          <CronJobsEditor />
        </Collapsible>
      ) : null}

      {/* Same story for the skills plugin: its skills are .md files, not config schema. */}
      {data.name === 'skills' ? (
        <Collapsible icon={GraduationCap} title={t.skills.title} description={t.skills.sectionHint} defaultOpen>
          <SkillsEditor />
        </Collapsible>
      ) : null}

    </div>
  );
}
