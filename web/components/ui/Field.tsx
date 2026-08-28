import { Fragment, cloneElement, isValidElement, useId, type ReactNode } from 'react';
import { useLocaleSafe } from '../../lib/i18n/context';
import { dictionaries } from '../../lib/i18n/dictionaries';
import { HelpTip } from './HelpTip';

/** The ARIA a field wires onto the control it wraps. Only these three: everything else about the
 *  control belongs to the control. */
type FieldAria = {
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  'aria-required'?: boolean | 'true' | 'false';
};

export interface FieldProps {
  label: string;
  htmlFor?: string;
  children: ReactNode;
  /** A hover/focus tooltip beside the label. It is NOT an accessible description — the text only exists
   *  while the tip is open — so anything the reader needs in order to fill the field goes in
   *  `description` instead. */
  hint?: string;
  /** Persistent guidance under the control, wired as the control's accessible description. */
  description?: string;
  /** A validation message. It is announced when it arrives (`role="alert"`), joins the control's
   *  description, and marks the control invalid. */
  error?: string;
  /** Marks the field as required: a visible asterisk, the word in the label for a screen reader, and
   *  `aria-required` on the control. */
  required?: boolean;
}

/** Label + control wrapper for modals and forms. Keeps spacing, label styling and — for a field that
 *  states one — its description, error and required state consistent.
 *
 *  The label still WRAPS the control, which is what associates the two for callers that pass no
 *  `htmlFor`. The description and the error deliberately sit outside it: text inside a wrapping label
 *  joins the control's accessible NAME, and a validation message read as part of the field's name is
 *  worse than no message at all. They reach the control as `aria-describedby` instead.
 *
 *  That wiring is applied by cloning the child, so it lands on any control that spreads its props onto
 *  the element it renders (`Input`, a bare `<input>`, `<select>`, `<textarea>`). A field whose children
 *  are a fragment or a list is left untouched — there would be no single control to describe — and the
 *  required state still reaches a screen reader through the label. */
export function Field({ label, htmlFor, children, hint, description, error, required = false }: FieldProps) {
  // Read straight from the dictionary rather than through `useTranslation`, which throws without a
  // LanguageProvider: Field is mounted in bare test and plugin renders too.
  const locale = useLocaleSafe();
  const requiredLabel = dictionaries[locale].common.requiredField;
  const id = useId();
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;

  return (
    <div className="field flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="flex flex-col gap-1.5">
        <span className="field__label flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-text-muted">
          {label}
          {required ? (
            <>
              <span aria-hidden className="field__required text-danger">*</span>
              <span className="sr-only">{requiredLabel}</span>
            </>
          ) : null}
          {hint ? <HelpTip align="left">{hint}</HelpTip> : null}
        </span>
        {describeControl(children, { descriptionId, errorId, invalid: !!error, required })}
      </label>
      {description ? <p id={descriptionId} className="field__description text-xs leading-relaxed text-text-muted">{description}</p> : null}
      {error ? <p id={errorId} role="alert" className="field__error text-xs leading-relaxed text-danger">{error}</p> : null}
    </div>
  );
}

function describeControl(
  children: ReactNode,
  { descriptionId, errorId, invalid, required }: { descriptionId?: string; errorId?: string; invalid: boolean; required: boolean },
): ReactNode {
  const describedBy = [descriptionId, errorId].filter(Boolean).join(' ');
  if (!describedBy && !invalid && !required) return children;
  // A fragment takes no props at all — cloning one with ARIA on it is a React warning and a silent
  // no-op — and a list of children has no single control to point at.
  if (!isValidElement<FieldAria>(children) || children.type === Fragment) return children;
  const own = children.props['aria-describedby'];
  return cloneElement(children, {
    'aria-describedby': [own, describedBy].filter(Boolean).join(' ') || undefined,
    'aria-invalid': invalid ? true : children.props['aria-invalid'],
    'aria-required': required ? true : children.props['aria-required'],
  });
}
