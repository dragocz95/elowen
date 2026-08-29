'use client';
import { Check } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import type { BrainModelOption } from '../../lib/types';
import { SOURCE_BADGE } from '../../lib/modelProvider';
import { ModelIcon } from '../../components/ui/ModelIcon';
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '../../components/ui/shadcn/dropdown-menu';
import { useBrainChat } from './BrainChatProvider';

/** Group the flat catalog into ordered provider buckets keyed by the provider's display label, preserving
 *  the server's ordering (first occurrence wins the slot). */
function groupByProvider(models: BrainModelOption[]): { label: string; source: BrainModelOption['source']; items: BrainModelOption[] }[] {
  const groups: { label: string; source: BrainModelOption['source']; items: BrainModelOption[] }[] = [];
  for (const m of models) {
    let group = groups.find((g) => g.label === m.providerLabel);
    if (!group) { group = { label: m.providerLabel, source: m.source, items: [] }; groups.push(group); }
    group.items.push(m);
  }
  return groups;
}

function modelValue(model: Pick<BrainModelOption, 'provider' | 'model'>): string {
  return JSON.stringify([model.provider, model.model]);
}

function ModelOptionRow({
  model,
  active,
  activeLabel,
  reasoningLabel,
}: {
  model: BrainModelOption;
  active: boolean;
  activeLabel: string;
  reasoningLabel: string;
}) {
  const levels = model.reasoningLevels ?? [];
  return (
    <>
      <span className="flex items-center gap-1.5">
        {active ? <Check size={12} className="shrink-0 text-primary" aria-label={activeLabel} /> : <span className="w-3 shrink-0" aria-hidden />}
        <ModelIcon name={model.model} size={14} />
        <span className="truncate font-mono text-sm">{model.model}</span>
      </span>
      {levels.length > 0 ? (
        <span className="flex flex-wrap gap-1 pl-[2.125rem]" title={reasoningLabel}>
          {levels.map((level) => (
            <span key={level} className="rounded bg-muted px-1 py-0.5 text-[0.6rem] text-muted-foreground">
              {model.reasoningLabels?.[level] ?? level}
            </span>
          ))}
        </span>
      ) : null}
    </>
  );
}

/** The selectable model catalog, rendered ONCE for both surfaces that offer it: the header popover
 *  (ModelPicker) and the `/model` overlay (ModelModal). Both used to be free to drift — the slash showed a
 *  flat `provider/model` line in the composer dropdown while the header showed grouped rows — which is the
 *  same command answering in two shapes depending on where it was invoked.
 *
 *  The picker host uses Radix radio items, while the dialog host keeps plain focusable buttons: its filter
 *  input and always-visible results are a dialog workflow, not a transient menu. Both wrappers share this
 *  grouping and the exact same row content, so the catalog cannot drift while each host keeps the keyboard
 *  model appropriate to its surface.
 *
 *  Brand icons come from ModelIcon, on the row AND on the provider header, matching BrainModelField and the
 *  users-admin allowed-models modal. Data and the switch action are read off the chat controller, so there
 *  is one catalog and one fetch no matter how many places render this. */
export function ModelOptionList({
  filter = '',
  onPickAction,
  presentation = 'menu',
}: {
  filter?: string;
  onPickAction?: () => void;
  presentation?: 'menu' | 'list';
}) {
  const { t } = useTranslation();
  const { models, currentModel, provider, setModel, modelsLoading, modelsError, loadModels } = useBrainChat();

  const needle = filter.trim().toLowerCase();
  const matches = (models ?? []).filter(
    (m) => !needle || m.model.toLowerCase().includes(needle) || m.providerLabel.toLowerCase().includes(needle),
  );
  const groups = groupByProvider(matches);

  if (modelsLoading) {
    const message = t.brainChat.modelPickerLoading;
    return presentation === 'menu'
      ? <DropdownMenuItem disabled className="text-tiny italic text-muted-foreground">{message}</DropdownMenuItem>
      : <div className="px-3 py-2 text-tiny italic text-muted-foreground">{message}</div>;
  }
  if (modelsError) {
    return (
      <div className="flex flex-col gap-1.5 px-3 py-2 text-tiny text-muted-foreground">
        <span>{t.brainChat.modelPickerError}</span>
        {presentation === 'menu' ? (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              loadModels();
            }}
            className="w-auto self-start rounded-md border border-border px-2 py-0.5 text-tiny text-foreground"
          >
            {t.brainChat.modelPickerRetry}
          </DropdownMenuItem>
        ) : (
          <button
            type="button"
            onClick={() => loadModels()}
            className="self-start rounded-md border border-border px-2 py-0.5 text-tiny text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            {t.brainChat.modelPickerRetry}
          </button>
        )}
      </div>
    );
  }
  if (groups.length === 0) {
    const message = t.brainChat.modelPickerEmpty;
    return presentation === 'menu'
      ? <DropdownMenuItem disabled className="text-tiny italic text-muted-foreground">{message}</DropdownMenuItem>
      : <div className="px-3 py-2 text-tiny italic text-muted-foreground">{message}</div>;
  }

  const pick = (model: BrainModelOption): void => {
    setModel(model);
    onPickAction?.();
  };
  const currentValue = modelValue({ provider, model: currentModel });
  const content = groups.map((group) => (
    <div key={group.label} className="py-0.5">
      <div className="flex items-center gap-1.5 px-3 py-1 text-tiny font-medium uppercase tracking-wide text-muted-foreground">
        <ModelIcon name={group.label} size={14} />
        <span className="truncate">{group.label}</span>
        <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[0.6rem] font-normal normal-case tracking-normal text-muted-foreground">
          {SOURCE_BADGE[group.source]}
        </span>
      </div>
      {group.items.map((model) => {
        const active = model.provider === provider && model.model === currentModel;
        return presentation === 'menu' ? (
          <DropdownMenuRadioItem
            key={modelValue(model)}
            value={modelValue(model)}
            className="flex-col items-stretch gap-0.5 rounded-none px-3 py-1.5 text-left text-muted-foreground data-[state=checked]:text-foreground [&>span:first-child]:hidden"
          >
            <ModelOptionRow
              model={model}
              active={active}
              activeLabel={t.brainChat.modelActive}
              reasoningLabel={t.brainChat.modelReasoning}
            />
          </DropdownMenuRadioItem>
        ) : (
          <button
            key={modelValue(model)}
            type="button"
            aria-pressed={active}
            onClick={() => pick(model)}
            className={`flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground ${active ? 'text-foreground' : 'text-muted-foreground'}`}
          >
            <ModelOptionRow
              model={model}
              active={active}
              activeLabel={t.brainChat.modelActive}
              reasoningLabel={t.brainChat.modelReasoning}
            />
          </button>
        );
      })}
    </div>
  ));

  if (presentation === 'list') return <>{content}</>;

  return (
    <DropdownMenuRadioGroup
      value={currentValue}
      onValueChange={(value) => {
        const model = matches.find((candidate) => modelValue(candidate) === value);
        if (model) pick(model);
      }}
    >
      {content}
    </DropdownMenuRadioGroup>
  );
}
