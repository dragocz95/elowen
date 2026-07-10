import { forwardRef, type InputHTMLAttributes } from 'react';

const BASE = 'h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-text placeholder:text-text-muted transition-colors focus:border-accent focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed';
const VARIANTS = {
  default: '',
  line: '!rounded-none !border-x-0 !border-t-0 !bg-transparent !px-0',
} as const;

type InputProps = InputHTMLAttributes<HTMLInputElement> & { variant?: keyof typeof VARIANTS };

export const Input = forwardRef<HTMLInputElement, InputProps>(
  function Input({ className = '', variant = 'default', ...rest }, ref) {
    const extra = className.trim();
    return <input ref={ref} className={`${BASE} ${VARIANTS[variant]}${extra ? ` ${extra}` : ''}`} {...rest} />;
  },
);
