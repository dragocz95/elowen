import type { ButtonHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';

type Variant = 'default' | 'accent' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  default: 'bg-elevated border-border text-text hover:border-border-strong hover:bg-elevated/80',
  accent: 'bg-accent border-accent text-white hover:opacity-90',
  ghost: 'bg-transparent border-transparent text-text-muted hover:bg-elevated hover:text-text',
  danger: 'bg-transparent border-danger/60 text-danger hover:bg-danger hover:text-white',
};

export function Button({ variant = 'default', icon: Icon, className = '', children, ...rest }: { variant?: Variant; icon?: LucideIcon } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const extra = className.trim();
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 border px-3.5 py-2 text-sm font-medium rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${VARIANTS[variant]}${extra ? ` ${extra}` : ''}`}
      {...rest}
    >
      {Icon ? <Icon size={14} aria-hidden /> : null}
      {children}
    </button>
  );
}
