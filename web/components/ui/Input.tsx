import { forwardRef, type InputHTMLAttributes } from 'react';

const BASE = 'h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-text placeholder:text-text-muted transition-colors focus:border-accent focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed';
const VARIANTS = {
  default: '',
  line: '!rounded-none !border-x-0 !border-t-0 !bg-transparent !px-0',
} as const;

/** The multi-line counterpart of the input's look. A `<textarea>` cannot be the `Input` component (it
 *  takes no fixed height and no variants), but it must not drift from it either — a focus ring or border
 *  change has one place to happen. */
export const textareaClass = 'w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm text-text placeholder:text-text-muted focus:border-accent';

type InputProps = InputHTMLAttributes<HTMLInputElement> & { variant?: keyof typeof VARIANTS };

export const Input = forwardRef<HTMLInputElement, InputProps>(
  function Input({ className = '', variant = 'default', ...rest }, ref) {
    const extra = className.trim();
    return <input ref={ref} className={`${BASE} ${VARIANTS[variant]}${extra ? ` ${extra}` : ''}`} {...rest} />;
  },
);
