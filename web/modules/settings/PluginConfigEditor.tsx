'use client';
import { useMemo, useState, type ReactNode } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight, Pencil, Users, SlidersHorizontal, Link2, Info, MessagesSquare, Mic, Image as ImageIcon, Puzzle, Wrench, type LucideIcon } from 'lucide-react';
import { TeamsAppPackageSection } from './TeamsAppPackageSection';
import { MonacoEditor } from '../../lib/monaco/monacoLoader';
import { defineEditorThemes, editorTheme } from '../../lib/monaco/oledTheme';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input, textareaClass } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { HelpTip } from '../../components/ui/HelpTip';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { ManageSelectionModal, type ManageSelectionItem } from '../../components/ui/ManageSelectionModal';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
import { RowPicker, ROW_TRIGGER_CLASS } from '../../components/ui/RowPicker';
import { Toggle } from '../../components/ui/Toggle';
import { BrainModelField } from '../../components/ui/BrainModelField';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { ProjectIcon } from '../../components/ui/ProjectIcon';
import { Segmented } from '../../components/ui/Segmented';
import { ChoiceField } from '../../components/ui/ChoiceField';
import { SelectMenu } from '../../components/ui/SelectMenu';
import { ProviderPicker } from '../../components/ui/ProviderPicker';
import { interpolate, useTranslation } from '../../lib/i18n';
import { useBrand } from '../../lib/brand';
import { useConfig, useBrainModels, useNotificationDestinations, usePlugins, usePluginTools, useProjects } from '../../lib/queries';
import type { BrainModelOption, PluginConfigField, PluginDetail, RolePolicy, McpServerSpec } from '../../lib/types';
import { RISK_TONE, CONNECTION_KEYS } from './pluginDetail.shared';
import type { PluginConfigCommitResult, PluginConfigDraft } from '../../lib/usePluginConfigDraft';
import { SettingsGroup, SettingsRow } from '../../components/ui/SettingsSurface';
import { Slider } from '../../components/ui/Slider';
import { normalizeTokenList, TokenList } from '../../components/ui/TokenList';
import { DirectoryPicker } from '../../components/ui/DirectoryPicker';


// A settings-group icon for an author-declared config section, inferred from its key/label. Falls back to
// the generic behavior glyph so every section card carries an icon-chip header like the rest of settings.
const SECTION_ICONS: { test: RegExp; icon: LucideIcon }[] = [
  { test: /connection|auth|credential|token|connect/, icon: Link2 },
  { test: /voice|audio|speech|tts|stt/, icon: Mic },
  { test: /conversation|context|history|memory/, icon: MessagesSquare },
  { test: /media|image|photo|file/, icon: ImageIcon },
  { test: /role|policies|policy|permission|access/, icon: Users },
];
function sectionIcon(field?: PluginConfigField): LucideIcon {
  if (!field) return SlidersHorizontal;
  const key = `${field.key} ${field.label}`.toLowerCase();
  return SECTION_ICONS.find((s) => s.test.test(key))?.icon ?? SlidersHorizontal;
}

/** Field types whose editing surface is a DOCUMENT (free text, code, a prompt, JSON) or a list of
 *  structured entries. None of them fits the one compact control a settings record allows, so the record
 *  carries a summary trigger and the editor keeps its full surface inside a modal. */
const MODAL_FIELD_TYPES = new Set<PluginConfigField['type']>(['textarea', 'code', 'prompt', 'json', 'rolePolicies', 'mcpServers']);

/** A `json` field is stored as the raw text the user typed, but an older config may still hold the parsed
 *  value — both have to render into the same editor. */
const jsonText = (raw: unknown): string => (typeof raw === 'string' ? raw : raw === undefined ? '' : JSON.stringify(raw, null, 2));
const isJsonInvalid = (text: string): boolean => {
  if (text.trim() === '') return false;
  try { JSON.parse(text); return false; } catch { return true; }
};

/** Multi-select twin of the shared {@link RowPicker}: one trigger the width of a record's control cell,
 *  opening the same {@link ManageSelectionModal}. RowPicker only offers `single` mode, and the
 *  `SelectionSummary` card this replaced — a count line, sample chips and a "Manage" button — wrapped onto
 *  three lines inside a record. Saved ids the catalog no longer offers are the caller's job to pin into
 *  `items`, so a save never silently drops them. */
function RowMultiPicker({ label, hint, items, value, onChange, groupIcons }: {
  label: string;
  hint?: string;
  items: ManageSelectionItem[];
  value: string[];
  onChange: (v: string[]) => void;
  groupIcons?: Record<string, ReactNode>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const countText = (n: number) => t.managePicker.selectedCount.replace('{n}', String(n));
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        data-row-picker
        className={ROW_TRIGGER_CLASS}
      >
        <span className="min-w-0 truncate text-left">{value.length ? countText(value.length) : t.managePicker.none}</span>
        <ChevronDown size={14} aria-hidden className="opacity-60" />
      </Button>
      <ManageSelectionModal
        title={label}
        subtitle={hint}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        selected={new Set(value)}
        onSave={(next) => onChange([...next])}
        countLabel={countText}
        groupIcons={groupIcons}
      />
    </>
  );
}

/** Generic `destination` config field: the shared single-choice row trigger over the live notification
 *  catalog. A saved value the catalog no longer lists stays pinned and selected. */
function DestinationField({ label, hint, value, onChange }: { label: string; hint?: string; value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const { data: destinations = [] } = useNotificationDestinations();
  const selected = destinations.find((destination) => destination.value === value);
  const items: ManageSelectionItem[] = [
    { id: '', label: t.managePicker.none, group: '' },
    ...(value && !selected ? [{ id: value, label: value, group: '' }] : []),
    ...destinations.map((destination) => ({
      id: destination.value,
      label: destination.label,
      group: `${destination.platform}:${destination.group ?? destination.platform}`,
      groupLabel: destination.group ?? destination.platform,
      badges: destination.subtitle ? [{ text: destination.subtitle, tone: 'muted' as const }] : undefined,
    })),
  ];
  return (
    <RowPicker
      label={label}
      subtitle={hint}
      summary={selected?.label ?? (value || t.managePicker.none)}
      items={items}
      value={value}
      onChange={onChange}
      emptySelectionHint={t.managePicker.none}
    />
  );
}

/** Generic `multiSelect` config field over the manifest's own options (one ungrouped list, so no
 *  group-filter row). Saved values the manifest no longer offers stay selectable. */
function MultiSelectField({ label, options, value, onChange }: { label: string; options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  const byValue = new Map(options.map((o) => [o.value, o.label]));
  const items: ManageSelectionItem[] = [
    ...value.filter((v) => !byValue.has(v)).map((v) => ({ id: v, label: v, group: '' })),
    ...options.map((o) => ({ id: o.value, label: o.label, group: '' })),
  ];
  return <RowMultiPicker label={label} items={items} value={value} onChange={onChange} />;
}

const supportedTimezones = (): string[] => {
  try {
    const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] }).supportedValuesOf;
    return supportedValuesOf?.call(Intl, 'timeZone') ?? [];
  } catch { return []; }
};
const browserTimezone = (): string => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }
  catch { return ''; }
};

const CUSTOM_TIMEZONE = '__custom_timezone__';

function TimezoneField({ label, hint, value, onChange }: { label: string; hint?: string; value: string; onChange: (value: string | null) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState('');
  const detected = useMemo(browserTimezone, []);
  const zones = useMemo(supportedTimezones, []);
  const known = new Set(zones);
  const pinned = new Set([detected, 'UTC'].filter(Boolean));
  const items: ManageSelectionItem[] = [
    { id: '', label: t.pluginCfg.timezoneServerDefault, group: '' },
    ...(detected ? [{ id: detected, label: detected, group: '', badges: [{ text: t.pluginCfg.timezoneBrowserDetected, tone: 'accent' as const }] }] : []),
    ...(detected === 'UTC' ? [] : [{ id: 'UTC', label: 'UTC', group: '' }]),
    ...(value && !pinned.has(value) && !known.has(value) ? [{ id: value, label: value, group: '', badges: [{ text: t.pluginCfg.timezoneSaved, tone: 'muted' as const }] }] : []),
    { id: CUSTOM_TIMEZONE, label: t.pluginCfg.timezoneCustom, group: '' },
    ...zones.filter((zone) => !pinned.has(zone)).map((zone) => ({ id: zone, label: zone, group: 'timezones', groupLabel: t.pluginCfg.timezoneCatalog })),
  ];
  const summary = value || t.pluginCfg.timezoneServerDefault;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open || customOpen}
        onClick={() => setOpen(true)}
        data-row-picker
        className={ROW_TRIGGER_CLASS}
      >
        <span className="min-w-0 truncate text-left">{summary}</span>
        <ChevronDown size={14} aria-hidden className="opacity-60" />
      </Button>
      <ManageSelectionModal
        title={label}
        subtitle={hint}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        selected={new Set([value])}
        onSave={(next) => {
          const selected = [...next][0] ?? '';
          if (selected === CUSTOM_TIMEZONE) {
            setCustomValue(value);
            setCustomOpen(true);
            return;
          }
          onChange(selected || null);
        }}
        emptySelectionHint={t.pluginCfg.timezoneServerDefault}
        single
      />
      {customOpen ? (
        <Modal title={t.pluginCfg.timezoneCustom} description={hint} onClose={() => setCustomOpen(false)} size="sm">
          <ModalBody>
            <Input
              autoFocus
              value={customValue}
              onChange={(event) => setCustomValue(event.target.value)}
              aria-label={t.pluginCfg.timezoneCustom}
              placeholder={t.pluginCfg.timezoneCustomPlaceholder}
            />
          </ModalBody>
          <ModalFooter>
            <Button type="button" variant="ghost" onClick={() => setCustomOpen(false)}>{t.common.cancel}</Button>
            <Button
              type="button"
              variant="accent"
              disabled={!customValue.trim()}
              onClick={() => { onChange(customValue.trim()); setCustomOpen(false); }}
            >
              {t.common.save}
            </Button>
          </ModalFooter>
        </Modal>
      ) : null}
    </>
  );
}

const tokenListValues = (raw: unknown): string[] => Array.isArray(raw)
  ? raw.filter((value): value is string => typeof value === 'string')
  : typeof raw === 'string' && raw !== '' ? [raw] : [];

function PluginTokenListField({ label, placeholder, value, browse, onChange }: {
  label: string;
  placeholder?: string;
  value: unknown;
  browse?: 'directory';
  onChange: (value: string[]) => void;
}) {
  const [browseOpen, setBrowseOpen] = useState(false);
  const tokens = tokenListValues(value);
  return (
    <>
      <TokenList label={label} value={tokens} onChange={onChange} placeholder={placeholder} onBrowse={browse === 'directory' ? () => setBrowseOpen(true) : undefined} />
      {browseOpen ? (
        <DirectoryPicker
          onClose={() => setBrowseOpen(false)}
          onSelect={(path) => {
            const normalized = path.trim();
            if (normalized) onChange(normalizeTokenList([...tokens, normalized]));
            setBrowseOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

/** Shared live-catalog multi-select: the catalog-specific wrappers only map their domain rows into the
 *  same row trigger + manage modal used by the Users drawer. Stale stored ids remain selectable. */
function CatalogMultiSelectField({ label, hint, items: catalogItems, value, onChange, groupIcons }: {
  label: string;
  hint?: string;
  items: ManageSelectionItem[];
  value: string[];
  onChange: (v: string[]) => void;
  groupIcons?: Record<string, ReactNode>;
}) {
  const byId = new Map(catalogItems.map((item) => [item.id, item]));
  const stale = value.filter((id) => !byId.has(id)).map((id) => ({ id, label: id, group: '' }));
  return <RowMultiPicker label={label} hint={hint} items={[...stale, ...catalogItems]} value={value} onChange={onChange} groupIcons={groupIcons} />;
}

function ProjectsField({ label, hint, value, onChange }: { label: string; hint?: string; value: string[]; onChange: (v: string[]) => void }) {
  const { t } = useTranslation();
  const { data: projects = [] } = useProjects();
  return <CatalogMultiSelectField label={label} hint={hint} value={value} onChange={onChange} items={projects.map((project) => ({
    id: String(project.id), label: project.slug, group: 'projects', groupLabel: t.pluginCfg.catalogProjects,
    icon: <ProjectIcon project={project} size={14} />,
  }))} />;
}

function PluginsField({ label, hint, value, onChange }: { label: string; hint?: string; value: string[]; onChange: (v: string[]) => void }) {
  const { t } = useTranslation();
  const { data: plugins = [] } = usePlugins();
  const grantable = plugins.filter((plugin) => plugin.userGrantable && !plugin.removed);
  return <CatalogMultiSelectField label={label} hint={hint} value={value} onChange={onChange} items={grantable.map((plugin) => ({
    id: plugin.name, label: plugin.name, group: 'plugins', groupLabel: t.pluginCfg.catalogPlugins,
    icon: <Puzzle size={14} aria-hidden />,
  }))} />;
}

function ToolsField({ label, hint, value, onChange }: { label: string; hint?: string; value: string[]; onChange: (v: string[]) => void }) {
  const { t } = useTranslation();
  const { data: tools = [] } = usePluginTools();
  return <CatalogMultiSelectField label={label} hint={hint} value={value} onChange={onChange} items={tools.map((tool) => ({
    id: tool.name,
    label: tool.label,
    group: tool.plugin ?? tool.group,
    groupLabel: tool.plugin ?? (tool.group === 'memory' ? t.managePicker.toolGroupMemory : t.managePicker.toolGroupElowen),
    icon: <span aria-hidden className="shrink-0 text-[13px] leading-none">{tool.icon ?? <Wrench size={12} className="inline" />}</span>,
  }))} />;
}

function ModelsField({ label, hint, models, value, onChange }: { label: string; hint?: string; models: BrainModelOption[]; value: string[]; onChange: (v: string[]) => void }) {
  const items: ManageSelectionItem[] = models.map((model) => ({
    id: model.exec,
    label: model.model,
    group: model.provider,
    groupLabel: model.providerLabel,
    icon: <ModelIcon name={model.model} size={14} />,
  }));
  const groupIcons = Object.fromEntries(
    [...new Map(models.map((model) => [model.provider, model.providerLabel])).entries()]
      .map(([provider, providerLabel]) => [provider, <ModelIcon key={provider} name={providerLabel} size={14} />]),
  );
  return <CatalogMultiSelectField label={label} hint={hint} value={value} onChange={onChange} items={items} groupIcons={groupIcons} />;
}

/** Structured editor for a `rolePolicies` field. A role decides admission, the room prompt, and
 *  whether the sender is a platform administrator. Account identity and project/tool permissions come
 *  from the linked Elowen account, so legacy fields stored by older versions are deliberately ignored. */
function RolePoliciesEditor({ value, onChange, onRemove }: {
  value: RolePolicy[];
  onChange: (v: RolePolicy[]) => void;
  onRemove: (v: RolePolicy[]) => Promise<PluginConfigCommitResult>;
}) {
  const { t } = useTranslation();
  const patch = (i: number, p: Partial<RolePolicy>) => onChange(value.map((r, j) => (j === i ? { ...r, ...p } : r)));
  // Which rows are expanded (by index). Removing a row shifts the indices above it down by one.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [removing, setRemoving] = useState<{ index: number; role: RolePolicy }>();
  const [removeError, setRemoveError] = useState<string>();
  const [activationPending, setActivationPending] = useState(false);
  const toggleRow = (i: number) => setExpanded((prev) => { const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const addRole = () => { setExpanded((prev) => new Set(prev).add(value.length)); onChange([...value, { roleId: '', name: '', prompt: '' }]); };
  const removeRole = async () => {
    if (!removing) return;
    const i = removing.index;
    setRemoveError(undefined);
    const outcome = await onRemove(value.filter((_, j) => j !== i));
    setActivationPending(outcome.pending);
    setExpanded((prev) => { const n = new Set<number>(); for (const idx of prev) { if (idx < i) n.add(idx); else if (idx > i) n.add(idx - 1); } return n; });
    setRemoving(undefined);
  };
  const removingName = removing ? (removing.role.name || removing.role.roleId || t.pluginCfg.roleNew) : '';
  return (
    <>
      <div className="flex flex-col gap-3">
        {activationPending ? <p className="text-sm text-warning" role="status">{t.pluginCfg.roleActivationPending}</p> : null}
        {value.length === 0 ? <p className="text-xs italic text-muted-foreground">{t.pluginCfg.noRoles}</p> : null}
        {value.map((r, i) => {
          const open = expanded.has(i);
          return (
            <div key={i} className="rounded-lg border border-border bg-muted/40">
              <div className="flex items-center gap-2 p-3">
                <button type="button" onClick={() => toggleRow(i)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  {open ? <ChevronDown size={15} className="shrink-0 text-muted-foreground" aria-hidden /> : <ChevronRight size={15} className="shrink-0 text-muted-foreground" aria-hidden />}
                  <span className="truncate text-sm font-medium text-foreground">{r.name || t.pluginCfg.roleNew}</span>
                  {r.roleId ? <span className="truncate font-mono text-[11px] text-muted-foreground">{r.roleId}</span> : null}
                  {r.admin === true ? <span className="ml-auto shrink-0"><Badge tone="accent">{t.pluginCfg.roleAdminBadge}</Badge></span> : null}
                </button>
                <Button variant="ghost" icon={Trash2} aria-label={t.pluginCfg.removeRole} onClick={() => { setRemoveError(undefined); setRemoving({ index: i, role: r }); }} />
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
                      <span className="text-sm text-foreground">{t.pluginCfg.roleAdmin}</span>
                      <span className="text-tiny text-muted-foreground">{t.pluginCfg.roleAdminHint}</span>
                    </span>
                  </label>
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
      <ConfirmDialog
        open={Boolean(removing)}
        title={interpolate(t.pluginCfg.removeRoleTitle, { name: removingName })}
        description={interpolate(t.pluginCfg.removeRoleDescription, { name: removingName })}
        confirmLabel={t.pluginCfg.removeRole}
        pendingLabel={t.pluginCfg.removingRole}
        error={removeError}
        onClose={() => { setRemoving(undefined); setRemoveError(undefined); }}
        onConfirm={removeRole}
        onConfirmError={() => setRemoveError(t.pluginCfg.removeRoleError)}
      />
    </>
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
      {value.length === 0 ? <p className="text-xs italic text-muted-foreground">{t.pluginCfg.mcpNoServers}</p> : null}
      {value.map((s, i) => {
        const open = expanded.has(i);
        return (
          <div key={i} className="rounded-lg border border-border bg-muted/40">
            <div className="flex items-center gap-2 p-3">
              <button type="button" onClick={() => toggleRow(i)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                {open ? <ChevronDown size={15} className="shrink-0 text-muted-foreground" aria-hidden /> : <ChevronRight size={15} className="shrink-0 text-muted-foreground" aria-hidden />}
                <span className="truncate text-sm font-medium text-foreground">{s.name || t.pluginCfg.mcpServerNew}</span>
                {s.command ? <span className="truncate font-mono text-[11px] text-muted-foreground">{s.command}</span> : null}
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
                  <span className="text-sm text-foreground">{t.pluginCfg.mcpEnabled}</span>
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
function PluginProviderField({ label, value, onChange, providerType }: { label: string; value: string; onChange: (v: string) => void; providerType?: string }) {
  const { data: config } = useConfig();
  const { t } = useTranslation();
  const { agentName } = useBrand();
  const providers = (config?.brain?.providers ?? []).filter((p) => p.apiKeySet && (!providerType || p.type === providerType));
  return <ProviderPicker providers={providers} value={value} onChange={onChange} label={label} emptyText={interpolate(t.pluginCfg.noProviders, { agentName })} size="sm" />;
}

const numberDivisor = (field: PluginConfigField): number => field.display?.divisor ?? 1;
const displayNumber = (field: PluginConfigField, canonical: number): number => canonical / numberDivisor(field);
const displayBound = (value: number | undefined, divisor: number): number | undefined => value === undefined ? undefined : value / divisor;
const displayPlaceholder = (field: PluginConfigField): string | undefined => {
  if (field.placeholder === undefined || numberDivisor(field) === 1) return field.placeholder;
  const value = Number(field.placeholder);
  return Number.isFinite(value) ? String(displayNumber(field, value)) : field.placeholder;
};
const decimalPlaces = (value: number): number => {
  const [mantissa, exponentText] = String(value).toLowerCase().split('e');
  const fraction = mantissa?.split('.')[1]?.length ?? 0;
  return Math.max(0, fraction - Number(exponentText ?? 0));
};
const stepAligned = (value: number, base: number, step: number): boolean => {
  const nearest = base + Math.round((value - base) / step) * step;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(base), Math.abs(step), Math.abs(nearest)) * 8;
  return Math.abs(value - nearest) <= tolerance;
};
const sliderCurrentValid = (field: PluginConfigField, canonical: number | undefined): canonical is number => (
  canonical !== undefined
  && canonical >= field.min!
  && canonical <= field.max!
  && stepAligned(canonical, field.min!, field.step!)
);
const sliderCanonicalValue = (field: PluginConfigField, displayed: number): number => {
  const divisor = numberDivisor(field);
  const min = field.min!;
  const max = field.max!;
  const step = field.step!;
  const displayedMin = min / divisor;
  const displayedStep = step / divisor;
  const stepIndex = Math.round((displayed - displayedMin) / displayedStep);
  return Math.min(max, Math.max(min, min + stepIndex * step));
};

/** The record a {@link MODAL_FIELD_TYPES} field wears: a summary trigger in the control cell, and the
 *  real editor in a modal raised from it. The trigger is named after the FIELD, not after what is stored,
 *  so a card full of them still reads as a list of settings to a screen reader. */
function ModalFieldRow({ label, description, hint, status, summary, fillsModal, trailingLayout, className, saveState, children }: {
  label: string;
  description?: string;
  hint?: string;
  status?: ReactNode;
  summary: string;
  trailingLayout?: 'inline' | 'stack';
  className?: string;
  /** Parent-owned persistence keeps status and Retry visible after this editor closes. */
  saveState?: Pick<PluginConfigDraft, 'status' | 'retry' | 'flush' | 'errorKind' | 'resolveConflict'>;
  /** A Monaco surface takes the modal's whole height; a textarea or an entry list scrolls in the body. */
  fillsModal?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const closeDisabled = saveState?.status === 'saving' || saveState?.status === 'error';
  const close = async () => {
    const finalStatus = await saveState?.flush();
    if (finalStatus !== 'error') setOpen(false);
  };
  return (
    <>
      <SettingsRow
        label={label}
        description={description}
        hint={hint}
        status={status}
        trailingLayout={trailingLayout}
        className={className}
        control={
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={label}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen(true)}
            data-row-picker
            className={ROW_TRIGGER_CLASS}
          >
            <span className="min-w-0 truncate text-left">{summary}</span>
            <Pencil size={14} aria-hidden className="opacity-60" />
          </Button>
        }
      />
      {open ? (
        <Modal title={label} description={description} size="lg" onClose={close} closeDisabled={closeDisabled}>
          {fillsModal ? <div className="min-h-0 flex-1 overflow-hidden">{children}</div> : <ModalBody>{children}</ModalBody>}
          <ModalFooter status={saveState && saveState.status !== 'idle' ? (
            <AutoSaveStatus
              status={saveState.status}
              errorKind={saveState.errorKind ?? undefined}
              onRetry={saveState.errorKind === 'transport' ? saveState.retry : undefined}
              onReload={saveState.errorKind === 'conflict' ? () => saveState.resolveConflict('reload') : undefined}
              onMerge={saveState.errorKind === 'conflict' ? () => saveState.resolveConflict('merge') : undefined}
            />
          ) : undefined}>
            <Button variant="accent" onClick={close} disabled={closeDisabled}>{t.common.done}</Button>
          </ModalFooter>
        </Modal>
      ) : null}
    </>
  );
}

/** The schema-driven config editor: a form generated from the manifest's `configSchema`, rendered as
 *  one Config collapsible or one collapsible per declared `section`. Every field is one canonical
 *  settings record — label on the left, ONE compact control on the right — so a plugin's settings read
 *  as the same table as the rest of the app. Secrets are write-only (stored values are reported but
 *  never shown back) and saving hot-reloads the brain. */
type PluginConfigMode = 'setup' | 'behavior' | 'advanced' | 'all';

export function PluginConfigEditor({ detail, fieldLabel, fieldHint, fieldOptions, riskText, draft, mode = 'behavior', showAppPackage = true }: {
  name: string;
  /** Only the three fields the form actually reads, so the per-ACCOUNT form can hand it its own schema
   *  and values instead of an instance-wide plugin detail it does not have. */
  detail: Pick<PluginDetail, 'name' | 'configSchema' | 'secretsSet'>;
  fieldLabel: (f: PluginConfigField) => string;
  fieldHint: (f: PluginConfigField) => string | undefined;
  fieldOptions: (f: PluginConfigField) => { value: string; label: string }[];
  riskText: (r: 'low' | 'medium' | 'high') => string;
  draft: PluginConfigDraft;
  mode?: PluginConfigMode;
  /** Custom plugin workspaces may expose the package download in their hero instead. */
  showAppPackage?: boolean;
}) {
  const { t, locale } = useTranslation();
  const { data: brainModels } = useBrainModels();
  // A connected Claude/ChatGPT account exposes no embeddings endpoint, so offering one for an
  // `embeddingModel` field can only ever produce a runtime failure. Same filter the core embedding role
  // uses; every other model field keeps the whole catalog, because a chat completion works there.
  const embeddingCapableModels = useMemo(() => (brainModels ?? []).filter((m) => m.source !== 'oauth'), [brainModels]);
  const { values, setValue: set } = draft;
  const [replacingSecrets, setReplacingSecrets] = useState<Set<string>>(new Set());
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [secretSaving, setSecretSaving] = useState<Set<string>>(new Set());
  const [secretErrors, setSecretErrors] = useState<Record<string, string>>({});
  const commitSecret = async (key: string) => {
    const value = secretDrafts[key] ?? '';
    if (!value.trim() || secretSaving.has(key)) return;
    setSecretErrors((current) => { const next = { ...current }; delete next[key]; return next; });
    setSecretSaving((current) => new Set(current).add(key));
    try {
      await draft.commitValue(key, value);
      setReplacingSecrets((current) => { const next = new Set(current); next.delete(key); return next; });
      setSecretDrafts((current) => { const next = { ...current }; delete next[key]; return next; });
    } catch {
      setSecretErrors((current) => ({ ...current, [key]: t.common.saveFailed }));
    } finally {
      setSecretSaving((current) => { const next = new Set(current); next.delete(key); return next; });
    }
  };

  /** The one compact control a record carries. Modal-backed types are not here — their record is built
   *  by {@link renderRow} instead. */
  const renderField = (f: PluginConfigField) => {
    switch (f.type) {
      case 'boolean':
        return <Toggle checked={values[f.key] === true} onChange={(v) => set(f.key, v)} label={fieldLabel(f)} />;
      case 'number': {
        const divisor = numberDivisor(f);
        const raw = values[f.key];
        const numeric = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
        const canonical = Number.isFinite(numeric) ? numeric : undefined;
        const displayed = divisor === 1 ? String(raw ?? '') : canonical === undefined ? String(raw ?? '') : String(displayNumber(f, canonical));
        const unit = f.display?.unit?.trim();
        if (f.display?.control === 'slider' && (raw === undefined || sliderCurrentValid(f, canonical))) {
          const fallback = typeof f.default === 'number' && Number.isFinite(f.default) ? f.default : f.min!;
          const sliderValue = displayNumber(f, canonical ?? fallback);
          const sliderMin = f.min! / divisor;
          const sliderMax = f.max! / divisor;
          const sliderStep = f.step! / divisor;
          const maximumFractionDigits = Math.min(20, Math.max(decimalPlaces(sliderMin), decimalPlaces(sliderStep)));
          const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits }).format(sliderValue);
          const readout = unit ? `${formatted} ${unit}` : formatted;
          return (
            <div className="flex w-full min-w-0 items-center gap-3">
              <Slider
                value={sliderValue}
                min={sliderMin}
                max={sliderMax}
                step={sliderStep}
                onChange={(value) => set(f.key, sliderCanonicalValue(f, value))}
                aria-label={fieldLabel(f)}
                aria-valuetext={readout}
                className="min-w-24 flex-1"
              />
              <span className="shrink-0 font-mono text-sm tabular-nums text-primary">{readout}</span>
            </div>
          );
        }
        const input = (
          <Input
            type="number"
            min={displayBound(f.min, divisor)}
            max={displayBound(f.max, divisor)}
            step={displayBound(f.step, divisor)}
            placeholder={displayPlaceholder(f)}
            aria-label={fieldLabel(f)}
            value={displayed}
            onChange={(e) => set(f.key, e.target.value === '' ? null : Number(e.target.value) * divisor)}
          />
        );
        return unit ? <div className="flex items-center gap-2">{input}<span className="shrink-0 text-sm text-muted-foreground">{unit}</span></div> : input;
      }
      case 'secret':
        return <Input type="password" aria-label={fieldLabel(f)} value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} autoComplete="off" />;
      case 'model':
        // Brain-only picker: the shared modal/search catalog used by account and cron settings.
        return <BrainModelField value={String(values[f.key] ?? '')} onChange={(v) => set(f.key, v)} models={brainModels ?? []} title={fieldLabel(f)} subtitle={fieldHint(f)} defaultLabel={t.managePicker.none} allowDefault={false} keyOf={(m) => m.exec} />;
      case 'embeddingModel':
        // Same shared brain catalog, minus the OAuth accounts that cannot embed at all (see above).
        return <BrainModelField value={String(values[f.key] ?? '')} onChange={(v) => set(f.key, v)} models={embeddingCapableModels} title={fieldLabel(f)} subtitle={fieldHint(f)} defaultLabel={t.managePicker.none} allowDefault={false} keyOf={(m) => m.exec} />;
      case 'provider':
        // Reuse a configured brain provider's key as this plugin's credentials (voice, image gen).
        return <PluginProviderField label={fieldLabel(f)} value={String(values[f.key] ?? '')} onChange={(v) => set(f.key, v)} providerType={f.providerType} />;
      case 'destination':
        return <DestinationField label={fieldLabel(f)} hint={fieldHint(f)} value={String(values[f.key] ?? '')} onChange={(v) => set(f.key, v)} />;
      case 'projects': {
        const selected = Array.isArray(values[f.key]) ? (values[f.key] as string[]) : [];
        return <ProjectsField label={fieldLabel(f)} hint={fieldHint(f)} value={selected} onChange={(v) => set(f.key, v)} />;
      }
      case 'plugins': {
        const selected = Array.isArray(values[f.key]) ? (values[f.key] as string[]) : [];
        return <PluginsField label={fieldLabel(f)} hint={fieldHint(f)} value={selected} onChange={(v) => set(f.key, v)} />;
      }
      case 'tools': {
        const selected = Array.isArray(values[f.key]) ? (values[f.key] as string[]) : [];
        return <ToolsField label={fieldLabel(f)} hint={fieldHint(f)} value={selected} onChange={(v) => set(f.key, v)} />;
      }
      case 'models': {
        const selected = Array.isArray(values[f.key]) ? (values[f.key] as string[]) : [];
        return <ModelsField label={fieldLabel(f)} hint={fieldHint(f)} models={brainModels ?? []} value={selected} onChange={(v) => set(f.key, v)} />;
      }
      case 'timezone':
        return <TimezoneField label={fieldLabel(f)} hint={fieldHint(f)} value={String(values[f.key] ?? '')} onChange={(value) => set(f.key, value)} />;
      case 'tokenList':
        return <PluginTokenListField label={fieldLabel(f)} placeholder={f.placeholder} value={values[f.key]} browse={f.browse} onChange={(value) => set(f.key, value)} />;
      case 'enum': {
        const options = fieldOptions(f);
        const value = String(values[f.key] ?? '');
        // Risk modes tend to carry explanatory labels ("including delete", "including anonymize"). A
        // segmented track exposes every sentence at once and its min-content width crushes the shared label
        // column. The shared shadcn Select keeps one compact trigger and preserves the full labels in its menu.
        return f.risk
          ? <SelectMenu label={fieldLabel(f)} options={options} value={value} onChange={(v) => set(f.key, v)} />
          : <ChoiceField title={fieldLabel(f)} options={options} value={value} onChange={(v) => set(f.key, v)} />;
      }
      case 'multiSelect': {
        const sel = Array.isArray(values[f.key]) ? (values[f.key] as string[]) : [];
        return <MultiSelectField label={fieldLabel(f)} options={fieldOptions(f)} value={sel} onChange={(v) => set(f.key, v)} />;
      }
      default:
        return <Input aria-label={fieldLabel(f)} value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} />;
    }
  };

  const editorOptions = { fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, padding: { top: 12 }, wordWrap: 'on' as const, folding: false };

  /** The full editing surface a modal-backed field opens. */
  const renderEditor = (f: PluginConfigField) => {
    switch (f.type) {
      case 'textarea':
        return <textarea aria-label={fieldLabel(f)} value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} rows={14} className={textareaClass} />;
      case 'code':
        return (
          <MonacoEditor
            language={f.language ?? 'plaintext'}
            value={String(values[f.key] ?? '')}
            onChange={(v) => set(f.key, v ?? '')}
            theme={editorTheme()}
            beforeMount={defineEditorThemes}
            height="100%"
            options={{ ...editorOptions, ariaLabel: fieldLabel(f) }}
          />
        );
      case 'prompt':
        return (
          <MonacoEditor
            language="markdown"
            value={String(values[f.key] ?? '')}
            onChange={(v) => set(f.key, v ?? '')}
            theme={editorTheme()}
            beforeMount={defineEditorThemes}
            height="100%"
            options={{ ...editorOptions, lineNumbers: 'off', ariaLabel: fieldLabel(f) }}
          />
        );
      case 'json': {
        const text = jsonText(values[f.key]);
        const invalid = isJsonInvalid(text);
        return (
          <div className="flex flex-col gap-1">
            <textarea
              aria-label={fieldLabel(f)}
              value={text}
              onChange={(e) => set(f.key, e.target.value)}
              rows={16}
              spellCheck={false}
              className={`${textareaClass}${invalid ? ' border-destructive focus:border-destructive' : ''}`}
            />
            {invalid ? <span className="flex items-center gap-1 text-xs text-destructive" role="alert"><Info size={13} aria-hidden />{t.pluginCfg.invalidJson}</span> : null}
          </div>
        );
      }
      case 'rolePolicies':
        return (
          <RolePoliciesEditor
            value={Array.isArray(values[f.key]) ? (values[f.key] as RolePolicy[]) : []}
            onChange={(v) => set(f.key, v)}
            onRemove={(v) => draft.commitValue(f.key, v)}
          />
        );
      case 'mcpServers':
        return <McpServersEditor value={Array.isArray(values[f.key]) ? (values[f.key] as McpServerSpec[]) : []} onChange={(v) => set(f.key, v)} />;
      default:
        return null;
    }
  };

  /** What a modal-backed record reports: HOW MUCH is stored, never the content itself. */
  const editorSummary = (f: PluginConfigField): string => {
    if (f.type === 'rolePolicies' || f.type === 'mcpServers') {
      const count = Array.isArray(values[f.key]) ? (values[f.key] as unknown[]).length : 0;
      return count ? t.pluginCfg.editorItems.replace('{n}', String(count)) : t.pluginCfg.editorEmpty;
    }
    const text = f.type === 'json' ? jsonText(values[f.key]) : String(values[f.key] ?? '');
    return text.trim() ? t.pluginCfg.editorLines.replace('{n}', String(text.split('\n').length)) : t.pluginCfg.editorEmpty;
  };

  const renderRow = (f: PluginConfigField) => {
    const label = fieldLabel(f);
    const description = fieldHint(f);
    // The manifest's long-form `help` only earns the second HelpTip paragraph when it says something the
    // one-line hint does not.
    const help = f.help?.trim() && f.help.trim() !== description?.trim() ? f.help : undefined;
    const risk = f.risk ? <Badge tone={RISK_TONE[f.risk]}>{riskText(f.risk)}</Badge> : null;

    if (MODAL_FIELD_TYPES.has(f.type)) {
      const invalid = f.type === 'json' && isJsonInvalid(jsonText(values[f.key]));
      return (
        <ModalFieldRow
          key={f.key}
          label={label}
          description={description}
          hint={help}
          status={risk || invalid ? (
            <span className="flex flex-wrap items-center gap-2">
              {risk}
              {invalid ? <span className="text-destructive" role="alert">{t.pluginCfg.invalidJson}</span> : null}
            </span>
          ) : undefined}
          // A risk badge plus a control are two trailing values. Let them wrap instead of letting their
          // combined min-content width overflow left across the label in narrow plugin cards.
          trailingLayout={risk ? 'stack' : undefined}
          className={risk ? 'plugin-config-risk-row' : undefined}
          summary={editorSummary(f)}
          saveState={draft}
          fillsModal={f.type === 'code' || f.type === 'prompt'}
        >
          {renderEditor(f)}
        </ModalFieldRow>
      );
    }

    if (f.type === 'secret') {
      const stored = detail.secretsSet.includes(f.key);
      // A stored secret is never shown back: the record reports that one exists and offers to replace it.
      if (stored && !replacingSecrets.has(f.key)) {
        return (
          <SettingsRow
            key={f.key}
            label={label}
            description={description}
            hint={[help, t.pluginCfg.secretKeepHint].filter(Boolean).join(' ')}
            status={<span className="flex flex-wrap items-center gap-2">{risk}<Badge tone="success">{t.pluginCfg.secretSet}</Badge></span>}
            trailingLayout="stack"
            className={risk ? 'plugin-config-risk-row' : undefined}
            actions={
              <Button type="button" variant="ghost" className="h-8" onClick={() => {
                setSecretErrors((current) => { const next = { ...current }; delete next[f.key]; return next; });
                setSecretDrafts((current) => ({ ...current, [f.key]: '' }));
                setReplacingSecrets((current) => new Set(current).add(f.key));
              }}>
                {t.pluginCfg.secretReplace}
              </Button>
            }
          />
        );
      }
      // An unset secret uses the same explicit commit boundary as replacement. It must not fall through to
      // the generic controlled field: draft.setValue intentionally ignores secrets, which made a fresh
      // required credential appear editable while every keystroke was discarded.
      const error = secretErrors[f.key];
      const saving = secretSaving.has(f.key);
      return (
        <SettingsRow
          key={f.key}
          label={label}
          description={description}
          hint={help}
          status={<span className="flex flex-wrap items-center gap-2">{risk}{error ? <span role="alert" className="text-destructive">{error}</span> : null}</span>}
          trailingLayout="stack"
          className={risk ? 'plugin-config-risk-row' : undefined}
          control={(
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
              <Input
                type="password"
                aria-label={label}
                value={secretDrafts[f.key] ?? ''}
                onChange={(e) => setSecretDrafts((current) => ({ ...current, [f.key]: e.target.value }))}
                placeholder={t.pluginCfg.secretReplacementPlaceholder}
                autoComplete="off"
                autoFocus={replacingSecrets.has(f.key)}
              />
              <Button type="button" variant="accent" className="h-8" disabled={saving || !(secretDrafts[f.key] ?? '').trim()} onClick={() => void commitSecret(f.key)}>
                {saving ? t.common.saving : t.common.save}
              </Button>
            </div>
          )}
        />
      );
    }

    return (
      <SettingsRow
        key={f.key}
        label={label}
        description={description}
        hint={help}
        status={risk ?? undefined}
        trailingLayout={risk ? 'stack' : undefined}
        className={risk ? 'plugin-config-risk-row' : undefined}
        control={renderField(f)}
      />
    );
  };

  // A field is shown unless its `visibleWhen` guard points at a value the form doesn't currently hold.
  const isVisible = (f: PluginConfigField) => !f.visibleWhen || values[f.visibleWhen.key] === f.visibleWhen.equals;
  const fieldRows = (fields: PluginConfigField[]) => fields.filter(isVisible).map(renderRow);

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
  const visibleSchema = mode === 'all' ? schema : classified.filter((entry, index) => {
    if (entry.field.type !== 'section') return entry.mode === mode;
    const nextSection = classified.findIndex((next, nextIndex) => nextIndex > index && next.field.type === 'section');
    const children = classified.slice(index + 1, nextSection === -1 ? classified.length : nextSection);
    const hasModeChild = children.some((child) => child.field.type !== 'section' && child.mode === mode);
    // A terminal section with no inputs is intentional documentation (e.g. Codebase's inherited
    // embedding model). Keep it on its declared tab instead of silently dropping its HelpTip.
    return hasModeChild || (children.length === 0 && entry.mode === mode);
  }).map((entry) => entry.field);
  const hasExplicitSections = schema.some((f) => f.type === 'section');
  const isConnection = (f: PluginConfigField) => f.type === 'secret' || CONNECTION_KEYS.has(f.key);
  const connectionFields = visibleSchema.filter(isConnection);
  const behaviorFields = visibleSchema.filter((f) => !isConnection(f));
  const group = (key: string, Icon: LucideIcon, title: string, hint: string | undefined, fields: PluginConfigField[]) => {
    const rows = fieldRows(fields);
    if (rows.length === 0) return null;
    return (
      <SettingsGroup key={key} className="plugin-card" title={title} description={hint} icon={Icon}>
        {rows}
      </SettingsGroup>
    );
  };

  // Split the schema into author-declared sections so each becomes its own settings-group card (icon-chip
  // header) instead of one long form separated by naked divider lines. Fields before the first section
  // (rare) fall into a leading headerless card. The section's manifest hint stays behind a `?` affordance
  // in the header — never a visible description — matching the compact per-field help convention.
  const sectionCards: { section?: PluginConfigField; fields: PluginConfigField[] }[] = [];
  for (const f of visibleSchema) {
    if (f.type === 'section') sectionCards.push({ section: f, fields: [] });
    else {
      if (sectionCards.length === 0) sectionCards.push({ fields: [] });
      sectionCards[sectionCards.length - 1]!.fields.push(f);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {visibleSchema.length === 0 && (detail.configSchema.length > 0 || mode !== 'behavior') ? null : visibleSchema.length === 0 ? (
        <SettingsGroup className="plugin-card" icon={SlidersHorizontal} title={t.pluginDetail.config}>
          <div className="settings-group__panel"><p className="text-sm text-muted-foreground">{t.pluginDetail.configEmpty}</p></div>
        </SettingsGroup>
      ) : hasExplicitSections ? (
        // One settings-group card per author-declared section: an icon-chip header (label + `?` hint),
        // the section's fields as records in the padded body.
        sectionCards.map((card, i) => {
          const hint = card.section ? fieldHint(card.section) : undefined;
          const isConnCard = card.section?.key === 'sec_connection';
          const showPackageAction = showAppPackage && detail.name === 'msteams' && isConnCard;
          const rows = fieldRows(card.fields);
          return (
            <SettingsGroup
              key={card.section?.key ?? `lead-${i}`}
              className="plugin-card"
              icon={sectionIcon(card.section)}
              title={card.section ? fieldLabel(card.section) : undefined}
              actions={hint ? <HelpTip align="left">{hint}</HelpTip> : undefined}
            >
              {showPackageAction || rows.length > 0 ? (
                <>
                  {/* Not a record — it is one action with a paragraph of instructions — so it spans the
                      record grid's tracks instead of being placed into the label column. */}
                  {showPackageAction ? <div className="col-span-full px-4 pt-4"><TeamsAppPackageSection /></div> : null}
                  {rows}
                </>
              ) : null}
            </SettingsGroup>
          );
        })
      ) : (
        <>
          {connectionFields.length ? group('connection', Link2, t.pluginCfg.sectionConnection, t.pluginCfg.sectionConnectionHint, connectionFields) : null}
          {behaviorFields.length ? group('behavior', SlidersHorizontal, t.pluginCfg.sectionBehavior, undefined, behaviorFields) : null}
        </>
      )}

    </div>
  );
}
