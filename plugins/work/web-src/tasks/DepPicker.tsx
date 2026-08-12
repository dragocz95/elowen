import { runtime } from '../runtime';
import type { Task } from '../types';

const { Checkbox } = runtime().components;

/** A scrollable checklist of candidate tasks to depend on. Presentational — the caller owns the
 *  selected set and persistence. Shared by the task editor and the standalone dependency picker. */
export function DepPicker({ candidates, selected, onToggle, maxHeightClass = 'max-h-32' }: {
  candidates: Task[];
  selected: string[];
  onToggle: (id: string) => void;
  maxHeightClass?: string;
}) {
  return (
    <div className={`${maxHeightClass} overflow-y-auto rounded-md border border-border bg-surface p-1`}>
      {candidates.map((dep) => (
        <button type="button" key={dep.id} onClick={() => onToggle(dep.id)} className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-elevated">
          <Checkbox checked={selected.includes(dep.id)} />
          <span className="min-w-0 flex-1 truncate text-text">{dep.title}</span>
          <span className="shrink-0 font-mono text-[11px] text-text-muted">{dep.id}</span>
        </button>
      ))}
    </div>
  );
}
