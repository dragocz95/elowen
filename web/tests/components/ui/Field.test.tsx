import type { ReactNode } from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { Field } from '../../../components/ui/Field';
import { Input } from '../../../components/ui/Input';
import { ModelModal } from '../../../modules/settings/ModelModal';

const wrap = (node: ReactNode) => render(<LanguageProvider>{node}</LanguageProvider>);

/** A control that renders a DOM node but forwards nothing to it — the shape `cloneElement` used to wire
 *  silently and fruitlessly, leaving the field's description pointing at nothing. */
function DeafControl() {
  return <input aria-label="deaf" />;
}

/** The anatomy the application had no accessible form errors without: a persistent description, a
 *  validation message that announces itself, a required state, and the wiring that connects all three
 *  to the control rather than leaving them as text near it. */
describe('Field', () => {
  it('describes the control with its description and its error, in that order', () => {
    wrap(
      <Field label="Slug" description="Lowercase, no spaces." error="Slug is already taken.">
        {(control) => <Input defaultValue="" {...control} />}
      </Field>,
    );

    const control = screen.getByRole('textbox');
    const describedBy = control.getAttribute('aria-describedby')?.split(' ') ?? [];
    expect(describedBy).toHaveLength(2);
    expect(document.getElementById(describedBy[0]!)).toHaveTextContent('Lowercase, no spaces.');
    expect(document.getElementById(describedBy[1]!)).toHaveTextContent('Slug is already taken.');
    expect(control).toHaveAttribute('aria-invalid', 'true');
  });

  it('announces the validation message and keeps it out of the control name', () => {
    wrap(
      <Field label="Slug" error="Slug is already taken.">
        {(control) => <Input defaultValue="" {...control} />}
      </Field>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Slug is already taken.');
    // The label WRAPS the control, so anything left inside it would be read as the field's name.
    expect(screen.getByRole('textbox', { name: 'Slug' })).toBeInTheDocument();
  });

  it('states a required field both on the control and in its name', () => {
    wrap(
      <Field label="Slug" required>
        {(control) => <Input defaultValue="" {...control} />}
      </Field>,
    );

    expect(screen.getByRole('textbox', { name: 'Slug Required' })).toHaveAttribute('aria-required', 'true');
  });

  it('adds nothing to a plain field, and lets a control compose its own description', () => {
    wrap(
      <>
        <Field label="Notes"><Input defaultValue="" /></Field>
        <Field label="Path" description="Absolute path.">
          {(control) => (
            <Input
              defaultValue=""
              {...control}
              aria-describedby={['own-hint', control['aria-describedby']].filter(Boolean).join(' ')}
            />
          )}
        </Field>
      </>,
    );

    const [notes, path] = screen.getAllByRole('textbox');
    expect(notes).not.toHaveAttribute('aria-describedby');
    expect(notes).not.toHaveAttribute('aria-invalid');
    expect(path!.getAttribute('aria-describedby')).toMatch(/^own-hint \S+$/);
  });

  it('lets a field of several controls name the one the ARIA belongs to', () => {
    wrap(
      <Field label="Range" required description="Both ends are inclusive.">
        {(control) => (
          <div className="flex gap-2">
            <Input aria-label="From" defaultValue="" {...control} />
            <Input aria-label="To" defaultValue="" />
          </div>
        )}
      </Field>,
    );

    expect(screen.getByRole('textbox', { name: 'From' })).toHaveAccessibleDescription('Both ends are inclusive.');
    expect(screen.getByRole('textbox', { name: 'To' })).not.toHaveAttribute('aria-required');
  });

  // A HelpTip is a button, and a button inside the wrapping label is an embedded control: the name
  // algorithm collapsed the whole computed name to '' the moment it met one. Every hinted field in the
  // application named its control NOTHING, in every design.
  it('still names its control when the label carries a hint, and keeps the tip reachable', () => {
    wrap(
      <>
        <Field label="Slug" hint="Lowercase, no spaces."><Input defaultValue="" /></Field>
        <Field label="Path" hint="Absolute path." required description="No trailing slash.">
          {(control) => <Input {...control} defaultValue="" />}
        </Field>
      </>,
    );

    expect(screen.getByRole('textbox', { name: 'Slug' })).toBeInTheDocument();
    const path = screen.getByRole('textbox', { name: 'Path Required' });
    expect(path).toHaveAttribute('aria-required', 'true');
    expect(path).toHaveAccessibleDescription('No trailing slash.');
    // The hint is still a control the reader can operate — it was not silenced to buy the name back.
    expect(screen.getAllByRole('button', { name: 'Help' })).toHaveLength(2);
  });

  it('renders a hinted field with the same anatomy classes as an unhinted one', () => {
    const { container } = wrap(
      <>
        <Field label="Slug" hint="Lowercase, no spaces." required>{(control) => <Input {...control} defaultValue="" />}</Field>
        <Field label="Path" required>{(control) => <Input {...control} defaultValue="" />}</Field>
      </>,
    );

    // The skins style `.field`, `.field__label` and `.field__required` and nothing structural, so both
    // shapes have to present the same anatomy — one label row six pixels above the control either way.
    const [hinted, plain] = Array.from(container.querySelectorAll('.field'));
    for (const field of [hinted!, plain!]) {
      expect(field.querySelectorAll('.field__label')).toHaveLength(1);
      expect(field.querySelector('.field__label')).toHaveClass('flex', 'items-center', 'gap-1.5');
      expect(field.querySelectorAll('.field__required')).toHaveLength(1);
    }
  });
});

/** The three shapes `cloneElement` swallowed. None of them typecheck any more, and an untypechecked
 *  caller — every plugin bundle — is told so instead of rendering a description that describes nothing. */
describe('Field with ARIA it cannot place', () => {
  afterEach(() => vi.restoreAllMocks());

  const expectRefusal = (node: ReactNode) => {
    // React re-throws a render error after logging it; the log is noise, not the assertion.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => wrap(node)).toThrow(/^Field: `description`, `error` and `required` require a function child/);
  };

  it('refuses a fragment', () => {
    expectRefusal(
      // @ts-expect-error a field that states an error cannot take a fragment: there is no control in it
      <Field label="Range" error="Out of range.">
        <>
          <Input defaultValue="" />
          <Input defaultValue="" />
        </>
      </Field>,
    );
  });

  it('refuses a list of children', () => {
    expectRefusal(
      // @ts-expect-error same for an array: nothing says which entry is the control
      <Field label="Range" description="Both ends are inclusive.">
        {[<Input key="a" defaultValue="" />, <Input key="b" defaultValue="" />]}
      </Field>,
    );
  });

  it('refuses a component that would drop the props', () => {
    expectRefusal(
      // @ts-expect-error the old seam cloned this happily and the ARIA reached no DOM node at all
      <Field label="Slug" required>
        <DeafControl />
      </Field>,
    );
  });
});

/** The seam proved where it actually ships: the model dialog's id field carries both the exec it
 *  resolves to and the duplicate-exec verdict, which used to be two loose paragraphs after the form. */
describe('ModelModal model id field', () => {
  it('describes the control with the resolved exec and the duplicate error', () => {
    wrap(
      <ModelModal
        initial={null}
        existingExecs={new Set(['codex:gpt-5'])}
        activeProviders={['codex']}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByRole('textbox', { name: 'Label Required' })).toHaveAttribute('aria-required', 'true');
    // Named, not queried by placeholder: this field carries a HelpTip, and the tip's button no longer
    // sits inside the wrapping label where it flattened the computed name to nothing.
    const modelId = screen.getByRole('textbox', { name: 'Model ID Required' });
    expect(modelId).toHaveAttribute('placeholder', 'e.g. sonnet, gpt-5.4, deepseek-v4-flash');
    expect(modelId).toHaveAttribute('aria-required', 'true');
    expect(modelId).not.toHaveAttribute('aria-invalid');

    fireEvent.change(modelId, { target: { value: 'gpt-5' } });

    expect(modelId).toHaveAttribute('aria-invalid', 'true');
    expect(modelId).toHaveAccessibleDescription('Resolves to codex:gpt-5 A model with this exec already exists.');
    expect(screen.getByRole('alert')).toHaveTextContent('A model with this exec already exists.');
  });
});
