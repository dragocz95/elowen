'use client';
import { useState } from 'react';
import { Save, RotateCcw, Bot, Compass, ShieldCheck, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { UserPrompt } from '../../lib/types';
import { useMyPrompts } from '../../lib/queries';
import { useSaveMyPrompt, useResetMyPrompt } from '../../lib/mutations';
import { SettingCard } from '../../components/ui/SettingCard';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { LoadingState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';

const textareaClass = 'w-full resize-y rounded-md border border-border bg-bg px-3 py-2 font-mono text-xs leading-relaxed text-text transition-colors focus:border-accent';

type Group = UserPrompt['group'];
const GROUP_ORDER: Group[] = ['workers', 'pilot', 'overseer', 'advisor'];
const GROUP_ICON: Record<Group, LucideIcon> = { workers: Bot, pilot: Compass, overseer: ShieldCheck, advisor: Sparkles };

/** Per-user prompt editor: groups the editable templates and lets the user override each one (or reset
 *  to the shipped default). Each row owns its draft state so editing one prompt never disturbs another. */
export function PromptsSection() {
  const { t } = useTranslation();
  const prompts = useMyPrompts();

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
          <div className="flex flex-col gap-5">
            {items.map((p) => <PromptRow key={p.name} prompt={p} />)}
          </div>
        </SettingCard>
      ))}
    </div>
  );
}

function PromptRow({ prompt }: { prompt: UserPrompt }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const save = useSaveMyPrompt();
  const reset = useResetMyPrompt();
  // Draft seeds from the override (if any) else the shipped default. The query is invalidated on
  // save/reset, which remounts with fresh data, so we don't need to sync via effect.
  const [draft, setDraft] = useState(prompt.override ?? prompt.default);

  const overridden = prompt.override !== null;
  const trimmed = draft.trim();
  const dirty = draft !== (prompt.override ?? prompt.default);
  const onSave = () => {
    if (!trimmed) { toast(t.prompts.empty, 'error'); return; }
    save.mutate({ name: prompt.name, content: draft }, { onSuccess: () => toast(t.prompts.saved), onError: () => toast(t.prompts.saveError, 'error') });
  };
  const onReset = () => reset.mutate(prompt.name, { onSuccess: () => { setDraft(prompt.default); toast(t.prompts.resetDone); }, onError: () => toast(t.prompts.saveError, 'error') });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-medium text-text">{prompt.name}</span>
        <Badge tone={overridden ? 'accent' : 'default'}>{overridden ? t.prompts.badgeOverridden : t.prompts.badgeDefault}</Badge>
        {prompt.jsonContract ? <Badge tone="warning">{t.prompts.badgeJson}</Badge> : null}
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={Math.min(16, Math.max(4, draft.split('\n').length + 1))}
        spellCheck={false}
        className={textareaClass}
        aria-label={prompt.name}
      />
      {prompt.vars.length > 0 ? (
        <p className="font-mono text-tiny text-text-muted">
          {t.prompts.varsLabel} {prompt.vars.map((v) => `{{${v}}}`).join('  ')}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        {overridden ? <Button variant="ghost" icon={RotateCcw} onClick={onReset} disabled={reset.isPending}>{t.prompts.reset}</Button> : null}
        <Button variant="accent" icon={Save} onClick={onSave} disabled={!dirty || save.isPending}>{t.prompts.save}</Button>
      </div>
    </div>
  );
}
