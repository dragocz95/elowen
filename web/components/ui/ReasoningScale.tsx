'use client';

export interface ReasoningOption { value: string; label: string }

/** A discrete but draggable reasoning-effort scale: native range semantics with visible labelled stops. */
export function ReasoningScale({ options, value, onChange, ariaLabel }: {
  options: ReasoningOption[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  const selected = Math.max(0, options.findIndex((option) => option.value === value));
  return (
    <div className="relative w-full min-w-72 pb-1 pt-1">
      <div className="absolute bottom-[9px] left-3 right-3 h-px bg-border-strong" aria-hidden />
      <div className="relative z-10 grid items-end" style={{ gridTemplateColumns: `repeat(${Math.max(options.length, 1)}, minmax(0, 1fr))` }}>
        {options.map((option, index) => {
          const active = index === selected;
          return (
            <button
              key={option.value || 'default'}
              type="button"
              aria-label={option.label}
              aria-pressed={active}
              onClick={() => onChange(option.value)}
              className={`group flex min-w-0 flex-col items-center gap-2 text-[9px] transition-colors sm:text-[10px] ${active ? 'text-accent' : 'text-text-muted hover:text-text'}`}
            >
              <span className="w-full truncate px-0.5 text-center">{option.label}</span>
              <span className={`block rounded-full transition-[width,height,background-color,box-shadow] ${active ? 'h-3.5 w-3.5 bg-accent shadow-[0_0_18px_rgb(255_82_54_/_0.8)]' : 'h-2.5 w-2.5 bg-text-subtle group-hover:bg-text-muted'}`} aria-hidden />
            </button>
          );
        })}
      </div>
      <input
        type="range"
        min={0}
        max={Math.max(0, options.length - 1)}
        step={1}
        value={selected}
        onChange={(event) => onChange(options[Number(event.target.value)]?.value ?? '')}
        aria-label={ariaLabel}
        className="absolute inset-x-0 bottom-0 z-20 h-8 w-full cursor-ew-resize opacity-0"
      />
    </div>
  );
}
