'use client';
import { Check } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import type { BrainModelOption } from '../../lib/types';
import { SOURCE_BADGE } from '../../lib/modelProvider';
import { ModelIcon } from '../../components/ui/ModelIcon';
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

/** The selectable model catalog, rendered ONCE for both surfaces that offer it: the header popover
 *  (ModelPicker) and the `/model` overlay (ModelModal). Both used to be free to drift — the slash showed a
 *  flat `provider/model` line in the composer dropdown while the header showed grouped rows — which is the
 *  same command answering in two shapes depending on where it was invoked.
 *
 *  Brand icons come from ModelIcon, on the row AND on the provider header, matching BrainModelField and the
 *  users-admin allowed-models modal. Data and the switch action are read off the chat controller, so there
 *  is one catalog and one fetch no matter how many places render this. */
export function ModelOptionList({ filter = '', onPick }: { filter?: string; onPick?: () => void }) {
  const { t } = useTranslation();
  const { models, currentModel, provider, setModel, modelsLoading, modelsError, loadModels } = useBrainChat();

  const needle = filter.trim().toLowerCase();
  const matches = (models ?? []).filter(
    (m) => !needle || m.model.toLowerCase().includes(needle) || m.providerLabel.toLowerCase().includes(needle),
  );
  const groups = groupByProvider(matches);

  if (modelsLoading) return <div className="px-3 py-2 text-tiny italic text-text-muted">{t.brainChat.modelPickerLoading}</div>;
  if (modelsError) {
    return (
      <div className="flex flex-col gap-1.5 px-3 py-2 text-tiny text-text-muted">
        <span>{t.brainChat.modelPickerError}</span>
        <button
          type="button"
          onClick={() => loadModels()}
          className="self-start rounded-md border border-border px-2 py-0.5 text-tiny text-text transition-colors hover:bg-bg"
        >
          {t.brainChat.modelPickerRetry}
        </button>
      </div>
    );
  }
  if (groups.length === 0) return <div className="px-3 py-2 text-tiny italic text-text-muted">{t.brainChat.modelPickerEmpty}</div>;

  return (
    <>
      {groups.map((group) => (
        <div key={group.label} className="py-0.5">
          <div className="flex items-center gap-1.5 px-3 py-1 text-tiny font-medium uppercase tracking-wide text-text-muted">
            <ModelIcon name={group.label} size={14} />
            <span className="truncate">{group.label}</span>
            <span className="shrink-0 rounded bg-bg px-1 py-0.5 text-[0.6rem] font-normal normal-case tracking-normal text-text-muted">
              {SOURCE_BADGE[group.source]}
            </span>
          </div>
          {group.items.map((m) => {
            const active = m.provider === provider && m.model === currentModel;
            const levels = m.reasoningLevels ?? [];
            return (
              <button
                key={`${m.provider}/${m.model}`}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => { setModel(m); onPick?.(); }}
                className={`flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors hover:bg-bg ${active ? 'text-text' : 'text-text-muted'}`}
              >
                <span className="flex items-center gap-1.5">
                  {active ? <Check size={12} className="shrink-0 text-primary" aria-label={t.brainChat.modelActive} /> : <span className="w-3 shrink-0" aria-hidden />}
                  <ModelIcon name={m.model} size={14} />
                  <span className="truncate font-mono text-sm">{m.model}</span>
                </span>
                {levels.length > 0 ? (
                  <span className="flex flex-wrap gap-1 pl-[2.125rem]" title={t.brainChat.modelReasoning}>
                    {levels.map((level) => (
                      <span key={level} className="rounded bg-bg px-1 py-0.5 text-[0.6rem] text-text-muted">
                        {m.reasoningLabels?.[level] ?? level}
                      </span>
                    ))}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ))}
    </>
  );
}
