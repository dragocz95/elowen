export const EXEC_PRESETS: { label: string; exec: string }[] = [
  { label: 'Claude Sonnet', exec: 'sonnet' },
  { label: 'DeepSeek v4 Flash', exec: 'deepseek/deepseek-v4-flash' },
  { label: 'Kimi k2.7 Code', exec: 'kimi-for-coding/k2p7' },
  { label: 'Minimax m2.7', exec: 'ollama/minimax-m2.7:cloud' },
  { label: 'Codex gpt-5.4', exec: 'codex:gpt-5.4' },
];

/** Preset models (minus hidden/deleted) merged with custom models, deduped by exec. Custom overrides preset labels. */
export function allModels(custom: { label: string; exec: string }[] = [], hidden: string[] = []): { label: string; exec: string }[] {
  const customExecs = new Set(custom.map((m) => m.exec));
  const hiddenExecs = new Set(hidden);
  const presets = EXEC_PRESETS.filter((p) => !customExecs.has(p.exec) && !hiddenExecs.has(p.exec));
  return [...presets, ...custom];
}
