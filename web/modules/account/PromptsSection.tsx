'use client';
import { useState } from 'react';
import { Save, RotateCcw, Bot, Compass, ShieldCheck, Sparkles, Pencil, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { UserPrompt } from '../../lib/types';
import { useMyPrompts } from '../../lib/queries';
import { useSaveMyPrompt, useResetMyPrompt } from '../../lib/mutations';
import { MonacoEditor } from '../projects/editor/monacoLoader';
import { defineEditorThemes } from '../projects/editor/oledTheme';
import { useTheme } from '../../lib/useTheme';
import { SettingCard } from '../../components/ui/SettingCard';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { LoadingState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';

type Group = UserPrompt['group'];
const GROUP_ORDER: Group[] = ['workers', 'pilot', 'overseer', 'advisor'];
const GROUP_ICON: Record<Group, LucideIcon> = { workers: Bot, pilot: Compass, overseer: ShieldCheck, advisor: Sparkles };

/** Per-user prompt templates: compact rows grouped by agent role; editing happens in a full Monaco
 *  modal (markdown highlighting, the app's editor theme) instead of inline textareas. */
export function PromptsSection() {
  const { t } = useTranslation();
  const prompts = useMyPrompts();
  const [editing, setEditing] = useState<UserPrompt | null>(null);

  if (prompts.isLoading || !prompts.data) return <LoadingState />;

  const groupLabel: Record<Group, string> = {
    workers: t.prompts.groupWorkers, pilot: t.prompts.groupPilot, overseer: t.prompts.groupOverseer, advisor: t.prompts.groupAdvisor,
  };
  const byGroup = GROUP_ORDER
    .map((g) => ({ group: g, items: prompts.data!.filter((p) => p.group === g) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-text-muted">{t.prompts.intro}</p>
      {byGroup.map(({ group, items }) => (
        <SettingCard key={group} title={groupLabel[group]} icon={GROUP_ICON[group]}>
          <div className="flex flex-col divide-y divide-border">
            {items.map((p) => {
              const overridden = p.override !== null;
              const preview = p.appendOnly
                ? (p.override ?? t.prompts.appendEmpty).replace(/\s+/g, ' ').slice(0, 120)
                : (p.override ?? p.default).replace(/\s+/g, ' ').slice(0, 120);
              return (
                <button
                  key={p.name}
                  type="button"
                  onClick={() => setEditing(p)}
                  className="group flex items-center gap-3 py-2.5 text-left transition-colors first:pt-0 last:pb-0 hover:bg-elevated/40"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-xs font-medium text-text">{p.appendOnly ? t.prompts.appendTitle : p.name}</span>
                      {p.appendOnly ? <Badge tone="muted">{t.prompts.badgeManaged}</Badge> : null}
                      {overridden ? <Badge tone="accent">{p.appendOnly ? t.prompts.badgeCustomized : t.prompts.badgeOverridden}</Badge> : null}
                      {p.jsonContract ? <Badge tone="warning">{t.prompts.badgeJson}</Badge> : null}
                    </span>
                    <span className="truncate text-tiny text-text-muted">{preview}</span>
                  </div>
                  <Pencil size={14} className="shrink-0 text-text-muted opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
                </button>
              );
            })}
          </div>
        </SettingCard>
      ))}
      {editing ? <PromptModal prompt={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

/** The editing modal for one template. Regular prompts get the full Monaco editor; append-only ones
 *  (the Orca advisor identity) get a plain textarea for the user's OWN extra instructions — the system
 *  prompt itself is managed server-side and never shown or replaced. */
function PromptModal({ prompt, onClose }: { prompt: UserPrompt; onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { resolvedTheme } = useTheme();
  const save = useSaveMyPrompt();
  const reset = useResetMyPrompt();
  const appendOnly = prompt.appendOnly === true;
  const [draft, setDraft] = useState(appendOnly ? (prompt.override ?? '') : (prompt.override ?? prompt.default));

  const overridden = prompt.override !== null;
  const dirty = draft !== (appendOnly ? (prompt.override ?? '') : (prompt.override ?? prompt.default));
  const onSave = () => {
    if (!draft.trim()) { toast(t.prompts.empty, 'error'); return; }
    save.mutate({ name: prompt.name, content: draft }, {
      onSuccess: () => { toast(t.prompts.saved); onClose(); },
      onError: () => toast(t.prompts.saveError, 'error'),
    });
  };
  const onReset = () => reset.mutate(prompt.name, {
    onSuccess: () => { toast(t.prompts.resetDone); onClose(); },
    onError: () => toast(t.prompts.saveError, 'error'),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label={appendOnly ? t.prompts.appendTitle : prompt.name}>
      <div className={`flex w-full flex-col overflow-hidden rounded-lg border border-border bg-surface ${appendOnly ? 'max-w-2xl' : 'h-[85vh] max-w-4xl'}`}>
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <span className="font-mono text-sm font-semibold text-text">{appendOnly ? t.prompts.appendTitle : prompt.name}</span>
          {appendOnly
            ? <Badge tone="muted">{t.prompts.badgeManaged}</Badge>
            : <Badge tone={overridden ? 'accent' : 'default'}>{overridden ? t.prompts.badgeOverridden : t.prompts.badgeDefault}</Badge>}
          {prompt.jsonContract ? <Badge tone="warning">{t.prompts.badgeJson}</Badge> : null}
          <button type="button" onClick={onClose} aria-label={t.common.cancel} className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text">
            <X size={16} aria-hidden />
          </button>
        </div>
        {appendOnly ? (
          <div className="flex flex-col gap-3 p-4">
            <p className="text-xs leading-relaxed text-text-muted">{t.prompts.appendHint}</p>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={10}
              maxLength={4000}
              placeholder={t.prompts.appendPlaceholder}
              aria-label={t.prompts.appendTitle}
              className="w-full resize-none rounded-md border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent"
            />
          </div>
        ) : (
          <div className="min-h-0 flex-1">
            <MonacoEditor
              language="markdown"
              value={draft}
              onChange={(v) => setDraft(v ?? '')}
              theme={resolvedTheme === 'light' ? 'orca-light' : 'orca-oled'}
              beforeMount={defineEditorThemes}
              options={{ fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, padding: { top: 12 }, wordWrap: 'on', lineNumbers: 'off', folding: false }}
            />
          </div>
        )}
        <div className="flex items-center gap-2 border-t border-border px-4 py-2.5">
          {!appendOnly && prompt.vars.length > 0 ? (
            <p className="min-w-0 flex-1 truncate font-mono text-tiny text-text-muted">
              {t.prompts.varsLabel} {prompt.vars.map((v) => `{{${v}}}`).join('  ')}
            </p>
          ) : <span className="flex-1" />}
          {overridden ? <Button variant="ghost" icon={RotateCcw} onClick={onReset} disabled={reset.isPending}>{t.prompts.reset}</Button> : null}
          <Button variant="accent" icon={Save} onClick={onSave} disabled={!dirty || save.isPending}>{t.prompts.save}</Button>
        </div>
      </div>
    </div>
  );
}
