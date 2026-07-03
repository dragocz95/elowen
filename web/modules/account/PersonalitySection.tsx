'use client';
import { useState, useEffect, type ReactNode } from 'react';
import { Save, Copy, Trash2, Check, Plus, X, Sparkles } from 'lucide-react';
import type { PersonalityProfile, PersonalityPreview } from '../../lib/types';
import { usePersonalities, usePersonalityPreview, useMyCliSettings } from '../../lib/queries';
import { useCreatePersonality, useUpdatePersonality, useDeletePersonality, useActivatePersonality, useSaveMyCliSettings } from '../../lib/mutations';
import { useAutoSave } from '../../lib/useAutoSave';
import { MonacoEditor } from '../projects/editor/monacoLoader';
import { defineEditorThemes } from '../projects/editor/oledTheme';
import { useTheme } from '../../lib/useTheme';
import { Segmented } from '../../components/ui/Segmented';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Input } from '../../components/ui/Input';
import { Toggle } from '../../components/ui/Toggle';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { LoadingState, EmptyState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';

const PLATFORMS = ['web', 'discord'] as const;
type Platform = (typeof PLATFORMS)[number];

/** Which profile is currently pinned active, derived from the preview's append layer (the server's
 *  single source for the active chunk). `layers[1].text` embeds `Name: <name>` and ends with the
 *  profile's prompt, so we match on both — no separate active flag exists on the list response. */
export function activePersonalityId(profiles: PersonalityProfile[], preview: PersonalityPreview | undefined): number | null {
  const append = preview?.layers[1]?.text;
  if (!append || append === 'no active profile') return null;
  const match = profiles.find((p) => append.includes(`Name: ${p.name}`) && append.endsWith(p.prompt));
  return match?.id ?? null;
}

const THINKING_LEVELS = ['', 'minimal', 'low', 'medium', 'high', 'xhigh'];

/** Per-user personality: the assistant's behavior (communication style + reasoning effort, applied
 *  everywhere) plus named persona profiles per surface (web / discord). One profile can be pinned
 *  active; a live summary shows the resulting persona instead of the raw resolved prompt. */
export function PersonalitySection() {
  const { t } = useTranslation();
  const [platform, setPlatform] = useState<Platform>('web');
  const [editing, setEditing] = useState<PersonalityProfile | 'new' | null>(null);
  const profiles = usePersonalities(platform);
  const preview = usePersonalityPreview(platform);

  // Behavior knobs live in cli-settings (shared with the Orca AI runtime section); this section owns
  // the personality-facing subset. Autosave sends only these two — the PATCH merges server-side.
  const cli = useMyCliSettings();
  const saveCli = useSaveMyCliSettings();
  const [advisorStyle, setAdvisorStyle] = useState('professional');
  const [thinkingLevel, setThinkingLevel] = useState('');
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (cli.data && !seeded) {
      setAdvisorStyle(cli.data.advisorStyle);
      setThinkingLevel(cli.data.thinkingLevel ?? '');
      setSeeded(true);
    }
  }, [cli.data, seeded]);
  useAutoSave([advisorStyle, thinkingLevel], () => saveCli.mutate({ advisorStyle, thinkingLevel }), { ready: seeded });

  const platformOptions = [
    { value: 'web', label: t.personality.platformWeb },
    { value: 'discord', label: t.personality.platformDiscord },
  ];
  const styleOptions = [
    { value: 'professional', label: t.personality.styleProfessional },
    { value: 'friendly', label: t.personality.styleFriendly },
    { value: 'concise', label: t.personality.styleConcise },
    { value: 'detailed', label: t.personality.styleDetailed },
  ];
  const list = profiles.data ?? [];
  const activeId = activePersonalityId(list, preview.data);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-text-muted">{t.personality.intro}</p>

      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-tiny font-semibold uppercase tracking-wide text-text-muted">{t.personality.platformLabel}</span>
          <Segmented options={platformOptions} value={platform} onChange={(v) => setPlatform(v as Platform)} aria-label={t.personality.platformLabel} />
        </div>
        <Button variant="accent" icon={Plus} onClick={() => setEditing('new')}>{t.personality.newProfile}</Button>
      </div>

      {/* Behavior: style + reasoning pills (applied everywhere, on top of any active profile) */}
      <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
        <PillGroup label={t.personality.styleLabel}>
          {styleOptions.map((o) => (
            <Pill key={o.value} on={advisorStyle === o.value} onClick={() => setAdvisorStyle(o.value)}>{o.label}</Pill>
          ))}
        </PillGroup>

        <PillGroup label={t.personality.thinkingLabel}>
          {THINKING_LEVELS.map((lv) => (
            <Pill key={lv || 'default'} on={thinkingLevel === lv} onClick={() => setThinkingLevel(lv)}>
              {lv === '' ? t.personality.thinkingDefault : lv}
            </Pill>
          ))}
        </PillGroup>
      </div>

      {/* Persona profiles */}
      {profiles.isLoading ? (
        <LoadingState />
      ) : list.length === 0 ? (
        <EmptyState title={t.personality.empty} icon={Sparkles} />
      ) : (
        <div className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface">
          {list.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setEditing(p)}
              className="group flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-elevated/40"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-text">{p.name}</span>
                  {p.id === activeId ? <Badge tone="success">{t.personality.badgeActive}</Badge> : null}
                  {!p.enabled ? <Badge tone="muted">{t.personality.badgeDisabled}</Badge> : null}
                </span>
                {p.description ? <span className="truncate text-tiny text-text-muted">{p.description}</span> : null}
              </div>
              {p.id === activeId ? <Check size={15} className="shrink-0 text-success" aria-hidden /> : null}
            </button>
          ))}
        </div>
      )}

      {editing ? (
        <PersonalityModal
          platform={platform}
          profile={editing === 'new' ? null : editing}
          isActive={editing !== 'new' && editing.id === activeId}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

/** A labelled row of single-select pills (accent when active), mirroring the app's pill styling. */
function PillGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-tiny font-semibold uppercase tracking-wide text-text-muted">{label}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function Pill({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`inline-flex items-center rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${on ? 'border-accent/50 bg-accent/15 text-accent' : 'border-border bg-elevated text-text-muted hover:border-border-strong hover:text-text'}`}
      style={{ transitionDuration: 'var(--motion-fast)' }}
    >
      {children}
    </button>
  );
}

/** Create/edit one profile. Save + Duplicate + Delete + Activate; the prompt body uses the app's Monaco
 *  markdown editor. Duplicate creates a copy (name + copy suffix) on the same platform. */
function PersonalityModal({ platform, profile, isActive, onClose }: {
  platform: Platform;
  profile: PersonalityProfile | null;
  isActive: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { resolvedTheme } = useTheme();
  const create = useCreatePersonality();
  const update = useUpdatePersonality();
  const remove = useDeletePersonality();
  const activate = useActivatePersonality();

  const [name, setName] = useState(profile?.name ?? '');
  const [description, setDescription] = useState(profile?.description ?? '');
  const [tone, setTone] = useState(profile?.tone ?? '');
  const [style, setStyle] = useState(profile?.style ?? '');
  const [enabled, setEnabled] = useState(profile?.enabled ?? true);
  const [prompt, setPrompt] = useState(profile?.prompt ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const busy = create.isPending || update.isPending || remove.isPending || activate.isPending;
  const valid = name.trim().length > 0 && prompt.trim().length > 0;

  const onSave = () => {
    if (!valid) { toast(t.personality.nameRequired, 'error'); return; }
    const body = { name: name.trim(), description: description.trim(), tone: tone.trim(), style: style.trim(), enabled, prompt };
    if (profile) {
      update.mutate({ id: profile.id, patch: body }, {
        onSuccess: () => { toast(t.personality.saved); onClose(); },
        onError: () => toast(t.personality.saveError, 'error'),
      });
    } else {
      create.mutate({ platform, ...body }, {
        onSuccess: () => { toast(t.personality.created); onClose(); },
        onError: () => toast(t.personality.saveError, 'error'),
      });
    }
  };

  const onDuplicate = () => {
    if (!valid) { toast(t.personality.nameRequired, 'error'); return; }
    create.mutate(
      { platform, name: `${name.trim()}${t.personality.copySuffix}`, description: description.trim(), tone: tone.trim(), style: style.trim(), enabled, prompt },
      { onSuccess: () => { toast(t.personality.duplicated); onClose(); }, onError: () => toast(t.personality.saveError, 'error') },
    );
  };

  const onDelete = () => {
    if (!profile) return;
    remove.mutate(profile.id, {
      onSuccess: () => { toast(t.personality.deleted); onClose(); },
      onError: () => toast(t.personality.deleteError, 'error'),
    });
  };

  const onActivate = () => {
    if (!profile) return;
    activate.mutate(profile.id, {
      onSuccess: () => { toast(t.personality.activated); onClose(); },
      onError: () => toast(t.personality.activateError, 'error'),
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label={profile ? t.personality.editTitle : t.personality.createTitle}>
      <div className="flex h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-surface">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <Sparkles size={16} className="text-accent" aria-hidden />
          <span className="text-sm font-semibold text-text">{profile ? t.personality.editTitle : t.personality.createTitle}</span>
          {isActive ? <Badge tone="success">{t.personality.badgeActive}</Badge> : null}
          <button type="button" onClick={onClose} aria-label={t.common.cancel} className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text">
            <X size={16} aria-hidden />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
          <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-tiny font-medium text-text-muted">{t.personality.fieldName}</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.personality.fieldNamePlaceholder} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-tiny font-medium text-text-muted">{t.personality.fieldDescription}</span>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t.personality.fieldDescriptionPlaceholder} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-tiny font-medium text-text-muted">{t.personality.fieldTone}</span>
              <Input value={tone} onChange={(e) => setTone(e.target.value)} placeholder={t.personality.fieldTonePlaceholder} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-tiny font-medium text-text-muted">{t.personality.fieldStyle}</span>
              <Input value={style} onChange={(e) => setStyle(e.target.value)} placeholder={t.personality.fieldStylePlaceholder} />
            </label>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-bg px-3 py-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-text">{t.personality.fieldEnabled}</span>
              <span className="text-tiny text-text-muted">{t.personality.fieldEnabledHint}</span>
            </div>
            <Toggle checked={enabled} onChange={setEnabled} label={t.personality.fieldEnabled} />
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-1">
            <span className="text-tiny font-medium text-text-muted">{t.personality.fieldPrompt}</span>
            <div className="min-h-[240px] flex-1 overflow-hidden rounded-md border border-border">
              <MonacoEditor
                language="markdown"
                value={prompt}
                onChange={(v) => setPrompt(v ?? '')}
                theme={resolvedTheme === 'light' ? 'orca-light' : 'orca-oled'}
                beforeMount={defineEditorThemes}
                options={{ fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, padding: { top: 12 }, wordWrap: 'on', lineNumbers: 'off', folding: false }}
              />
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-border px-4 py-2.5">
          {profile ? <Button variant="danger" icon={Trash2} onClick={() => setConfirmDelete(true)} disabled={busy}>{t.personality.delete}</Button> : null}
          <span className="flex-1" />
          {profile ? <Button variant="ghost" icon={Copy} onClick={onDuplicate} disabled={busy}>{t.personality.duplicate}</Button> : null}
          {profile && !isActive ? <Button variant="ghost" icon={Check} onClick={onActivate} disabled={busy || !enabled}>{t.personality.activate}</Button> : null}
          <Button variant="accent" icon={Save} onClick={onSave} disabled={!valid || busy}>{t.personality.save}</Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title={t.personality.deleteConfirmTitle}
        description={t.personality.deleteConfirmBody}
        onConfirm={() => { setConfirmDelete(false); onDelete(); }}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}
