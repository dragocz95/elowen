import type { ReactNode } from 'react';
import { HelpTip } from './HelpTip';

/** Label + control wrapper for modal/forms. Keeps spacing and label styling consistent.
 *  `hint` renders as a HelpTip (?) next to the label rather than as text under the control. */
export function Field({ label, htmlFor, children, hint }: { label: string; htmlFor?: string; children: ReactNode; hint?: string }) {
  return (
    <label htmlFor={htmlFor} className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-text-muted">
        {label}
        {hint ? <HelpTip align="left">{hint}</HelpTip> : null}
      </span>
      {children}
    </label>
  );
}
