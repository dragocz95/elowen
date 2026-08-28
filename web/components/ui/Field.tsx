import { useId, type ReactNode } from 'react';
import { useLocaleSafe } from '../../lib/i18n/context';
import { dictionaries } from '../../lib/i18n/dictionaries';
import { HelpTip } from './HelpTip';

/** The ARIA a field produces for the control it labels. Only these three: everything else about the
 *  control belongs to the control. Spread it onto the element the user actually focuses. */
interface FieldControlProps {
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  'aria-required'?: true;
}

interface FieldBase {
  label: string;
  htmlFor?: string;
  /** A hover/focus tooltip beside the label. It is NOT an accessible description — the text only exists
   *  while the tip is open — so anything the reader needs in order to fill the field goes in
   *  `description` instead. */
  hint?: string;
}

/** A field that states nothing about its control: no description, no error, no required state. There is
 *  no ARIA to place, so the children render exactly as they are written. */
interface PlainFieldProps extends FieldBase {
  children: ReactNode;
  description?: never;
  error?: never;
  required?: never;
}

/** A field that states a description, a validation message or a required state. Its child is a function
 *  so the ARIA has exactly ONE place to go: the control the caller spreads it onto. */
interface DescribedFieldProps extends FieldBase {
  /** Persistent guidance under the control, wired as the control's accessible description. */
  description?: string;
  /** A validation message. It is announced when it arrives (`role="alert"`), joins the control's
   *  description, and marks the control invalid. */
  error?: string;
  /** Marks the field as required: a visible asterisk, the word in the label for a screen reader, and
   *  `aria-required` on the control. */
  required?: boolean;
  children: (control: FieldControlProps) => ReactNode;
}

export type FieldProps = PlainFieldProps | DescribedFieldProps;

/** Label + control wrapper for modals and forms. Keeps spacing, label styling and — for a field that
 *  states one — its description, error and required state consistent.
 *
 *  The label still WRAPS the control, which is what associates the two for callers that pass no
 *  `htmlFor`. The description and the error deliberately sit outside it: text inside a wrapping label
 *  joins the control's accessible NAME, and a validation message read as part of the field's name is
 *  worse than no message at all. They reach the control as `aria-describedby` instead.
 *
 *  Which control that is, only the caller knows — a field's children can be a wrapper, a picker, or two
 *  inputs side by side. So a field that has ARIA to place takes a FUNCTION as its child and hands the
 *  props to it:
 *
 *      <Field label="Slug" error={taken ? 'Already taken.' : undefined} required>
 *        {(control) => <Input value={slug} onChange={...} {...control} />}
 *      </Field>
 *
 *  A control that brings its own `aria-describedby` composes it: `{...control} aria-describedby={
 *  [ownId, control['aria-describedby']].filter(Boolean).join(' ')}`. */
export function Field(props: FieldProps) {
  // Read straight from the dictionary rather than through `useTranslation`, which throws without a
  // LanguageProvider: Field is mounted in bare test and plugin renders too.
  const locale = useLocaleSafe();
  const requiredLabel = dictionaries[locale].common.requiredField;
  const id = useId();
  const { label, htmlFor, hint, description, error, required = false, children } = props;

  // Plugin bundles are not typechecked against this host, so the union above is not the only guard the
  // seam needs. A field that has ARIA to place and no function to place it with used to be a silent
  // no-op — the description and the error rendered, and nothing was ever described by them.
  if ((description || error || required) && typeof children !== 'function') {
    throw new Error('Field: `description`, `error` and `required` require a function child that spreads the props onto the control — <Field …>{(control) => <Input {...control} />}</Field>.');
  }

  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(' ');
  const control: FieldControlProps = {
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
    ...(error ? { 'aria-invalid': true as const } : {}),
    ...(required ? { 'aria-required': true as const } : {}),
  };

  const body = typeof children === 'function' ? children(control) : children;
  const requiredMarker = required ? <span aria-hidden className="field__required text-danger">*</span> : null;
  const labelRowClass = 'field__label flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-text-muted';
  const stackClass = 'flex flex-col gap-1.5';

  // A `hint` renders a HelpTip, and a HelpTip is a BUTTON. A button inside a wrapping `<label>` is an
  // embedded control, and the accessible-name algorithm collapses the labelled control's computed name
  // to the empty string when it meets one — so a hinted field used to name its input NOTHING at all.
  //
  // The tip therefore stays out of the label: the visible row becomes plain text beside it (hidden from
  // the reader, since it no longer labels anything), and the label carries the same words for a screen
  // reader instead. Same elements, same classes, same gaps — `.field__label` is still one flex row six
  // pixels above the control — so every design renders exactly what it rendered before.
  const named = hint ? (
    <>
      <span className={labelRowClass}>
        <span aria-hidden className="flex items-center gap-1.5">{label}{requiredMarker}</span>
        <HelpTip align="left">{hint}</HelpTip>
      </span>
      <label htmlFor={htmlFor} className={stackClass}>
        <span className="sr-only">{required ? `${label} ${requiredLabel}` : label}</span>
        {body}
      </label>
    </>
  ) : (
    <label htmlFor={htmlFor} className={stackClass}>
      <span className={labelRowClass}>
        {label}
        {requiredMarker}
        {required ? <span className="sr-only">{requiredLabel}</span> : null}
      </span>
      {body}
    </label>
  );

  return (
    <div className="field flex flex-col gap-1.5">
      {named}
      {description ? <p id={descriptionId} className="field__description text-xs leading-relaxed text-text-muted">{description}</p> : null}
      {error ? <p id={errorId} role="alert" className="field__error text-xs leading-relaxed text-danger">{error}</p> : null}
    </div>
  );
}
