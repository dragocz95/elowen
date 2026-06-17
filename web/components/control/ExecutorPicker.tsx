'use client';
import { EXEC_PRESETS } from '../../lib/execPresets';
import { useConfig } from '../../lib/queries';

export function ExecutorPicker({ onPick }: { onPick: (exec: string) => void }) {
  const { data } = useConfig();
  const allowed = data?.allowedExecs;
  const presets = allowed ? EXEC_PRESETS.filter((p) => allowed.includes(p.exec)) : EXEC_PRESETS;
  return (
    <select
      defaultValue=""
      onChange={(e) => e.target.value && onPick(e.target.value)}
      className="bg-surface border border-border rounded-none px-2 py-1 text-xs text-text"
    >
      <option value="" disabled>Launch as…</option>
      {presets.map((p) => <option key={p.exec} value={p.exec}>{p.label}</option>)}
    </select>
  );
}
