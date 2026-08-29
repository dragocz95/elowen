import type { ButtonHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';

type Variant = 'default' | 'accent' | 'ghost' | 'danger' | 'ghost-danger';
const VARIANTS: Record<Variant, string> = {
  default: 'bg-elevated border-border text-text hover:border-border-strong hover:bg-elevated/80',
  accent: 'bg-primary border-primary text-bg hover:opacity-90',
  ghost: 'bg-transparent border-transparent text-text-muted hover:bg-elevated hover:text-text',
  danger: 'bg-danger border-danger text-bg hover:opacity-90',
  // A destructive action that has to sit quietly in a row or a form: it reads as a ghost until the
  // pointer is on it, and only then admits what it does. A filled danger button in every row would
  // shout the one thing the user is least likely to want.
  'ghost-danger': 'bg-transparent border-transparent text-text-muted hover:bg-danger/10 hover:text-danger hover:border-danger/40',
};

export function buttonClassName(variant: Variant = 'default', className = ''): string {
  const extra = className.trim();
  return `inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap border px-3.5 text-sm font-medium rounded-md transition-[color,background-color,border-color,transform] duration-150 active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 ${VARIANTS[variant]}${extra ? ` ${extra}` : ''}`;
}

export function Button({ variant = 'default', icon: Icon, className = '', children, ...rest }: { variant?: Variant; icon?: LucideIcon } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={buttonClassName(variant, className)}
      {...rest}
    >
      {Icon ? <Icon size={14} aria-hidden /> : null}
      {children}
    </button>
  );
}
