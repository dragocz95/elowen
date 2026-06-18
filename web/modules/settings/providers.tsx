export interface ProviderMeta { id: string; label: string; color: string; binHint: string; argsHint: string; icon: string }

export const PROVIDERS: ProviderMeta[] = [
  { id: 'claude-code', label: 'Claude Code', color: '#d97757', binHint: 'claude', argsHint: '--permission-mode acceptEdits', icon: '/providers/anthropic.png' },
  { id: 'opencode', label: 'OpenCode', color: '#7c8cff', binHint: 'opencode', argsHint: '--pure', icon: '/providers/opencode.png' },
  { id: 'codex', label: 'Codex', color: '#ededed', binHint: 'codex', argsHint: '--full-auto', icon: '/providers/openai.svg' },
];

export function ProviderLogo({ meta, alt, size = 36 }: { meta: ProviderMeta; alt?: string; size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-elevated"
      style={{ width: size, height: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={meta.icon} alt={alt ?? meta.label} width={size * 0.62} height={size * 0.62} style={{ objectFit: 'contain' }} />
    </span>
  );
}

export const providerMeta = (id: string): ProviderMeta | undefined => PROVIDERS.find((p) => p.id === id);

/** Compact provider chip: brand icon + label, for model cards. */
export function ProviderTag({ id }: { id: string }) {
  const meta = providerMeta(id);
  if (!meta) return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-elevated/60 px-2 py-1 text-[11px] text-text-muted">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={meta.icon} alt="" width={13} height={13} style={{ objectFit: 'contain' }} aria-hidden />
      {meta.label}
    </span>
  );
}
