// Keep in sync with the server-side allow-list (`src/shared/execs.ts` → KNOWN_EXECS / EXEC_NOTES).
const EXEC_PRESETS: { label: string; exec: string }[] = [
  { label: 'GLM 5.2', exec: 'ollama-cloud/glm-5.2' },
  { label: 'GPT 5.5', exec: 'codex:gpt-5.5' },
  { label: 'Claude Sonnet 4.5', exec: 'sonnet' },
  { label: 'Claude Opus 4.8', exec: 'opus' },
  { label: 'DeepSeek V4 Pro', exec: 'ollama-cloud/deepseek-v4-pro' },
  { label: 'Kimi k2.7 Code', exec: 'ollama/kimi-k2.7-code' },
  { label: 'MiniMax M3', exec: 'ollama-cloud/minimax-m3' },
  { label: 'DeepSeek v4 Flash', exec: 'ollama-cloud/deepseek-v4-flash' },
  { label: 'MiniMax M2.7', exec: 'ollama-cloud/minimax-m2.7' },
  { label: 'GLM 5.1', exec: 'ollama-cloud/glm-5.1' },
  { label: 'QWEN 3.5', exec: 'ollama-cloud/qwen3.5' },
];

/** Preset models (minus hidden/deleted) merged with custom models, deduped by exec. Custom overrides preset labels. */
export function allModels(custom: { label: string; exec: string }[] = [], hidden: string[] = []): { label: string; exec: string }[] {
  const customExecs = new Set(custom.map((m) => m.exec));
  const hiddenExecs = new Set(hidden);
  const presets = EXEC_PRESETS.filter((p) => !customExecs.has(p.exec) && !hiddenExecs.has(p.exec));
  return [...presets, ...custom];
}

/** Whether an exec is one of the built-in presets. */
export const isPresetExec = (exec: string): boolean => EXEC_PRESETS.some((p) => p.exec === exec);

export interface ModelState { allowed: string[]; customModels: { label: string; exec: string }[]; hiddenPresets: string[]; modelNotes: Record<string, string> }

/** Remove a model entirely, whatever its provenance. A custom *override* of a preset lives in BOTH
 *  customModels (the override entry) and the preset list, so deleting it must strip the custom entry
 *  AND hide the preset — touching only one (the old bug: presets only got hidden) leaves the other
 *  behind, so `allModels` keeps returning it and the row never disappears. The note is keyed by exec,
 *  so drop it too — otherwise it lingers as an orphan and re-attaches if the exec is ever re-added. */
export function removeModel(s: ModelState, exec: string): ModelState {
  const modelNotes = { ...s.modelNotes }; delete modelNotes[exec];
  return {
    allowed: s.allowed.filter((e) => e !== exec),
    customModels: s.customModels.filter((m) => m.exec !== exec),
    hiddenPresets: isPresetExec(exec) && !s.hiddenPresets.includes(exec) ? [...s.hiddenPresets, exec] : s.hiddenPresets,
    modelNotes,
  };
}

/** Add a new model, or edit an existing one in place. When editing, `original` is the exec being
 *  edited; the existing entry is dropped by its ORIGINAL exec — not the new one — so a rename can't
 *  leave the old copy behind as a duplicate (the old bug: it filtered by the new exec). If the edited
 *  model shadows a preset, that preset is hidden so it doesn't reappear next to the override. The note
 *  (keyed by exec) follows the model across a rename — otherwise editing a model's exec silently drops
 *  its description, which is what the autopilot model-picker reads. */
export function upsertModel(s: ModelState, model: { label: string; exec: string }, original?: string): ModelState {
  const key = original ?? model.exec;
  const customModels = [...s.customModels.filter((x) => x.exec !== key && x.exec !== model.exec), model];
  const base = s.allowed.filter((e) => e !== key);
  const allowed = base.includes(model.exec) ? base : [...base, model.exec];
  const hiddenPresets = original && isPresetExec(original) && !s.hiddenPresets.includes(original)
    ? [...s.hiddenPresets, original] : s.hiddenPresets;
  const modelNotes = { ...s.modelNotes };
  if (original && original !== model.exec && modelNotes[original] !== undefined) {
    modelNotes[model.exec] = modelNotes[original]; // carry the description onto the new exec…
    delete modelNotes[original];                   // …and don't leave it orphaned under the old one
  }
  return { allowed, customModels, hiddenPresets, modelNotes };
}
