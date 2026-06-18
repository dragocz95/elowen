'use client';
export function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (next: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`inline-flex h-5 w-9 items-center border border-border px-0.5 transition-colors ${checked ? 'bg-accent' : 'bg-elevated'} ${disabled ? 'opacity-40' : 'cursor-pointer'}`}
      style={{ transitionDuration: 'var(--motion-fast)' }}
    >
      <span
        className={`block h-3.5 w-3.5 transition-transform ${checked ? 'translate-x-4 bg-bg' : 'translate-x-0 bg-text-muted'}`}
        style={{ transitionDuration: 'var(--motion-base)', transitionTimingFunction: 'var(--ease-spring)' }}
      />
    </button>
  );
}
