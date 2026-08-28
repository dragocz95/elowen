import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { Field } from '../../../components/ui/Field';
import { Input } from '../../../components/ui/Input';

/** The anatomy the application had no accessible form errors without: a persistent description, a
 *  validation message that announces itself, a required state, and the wiring that connects all three
 *  to the control rather than leaving them as text near it. */
describe('Field', () => {
  it('describes the control with its description and its error, in that order', () => {
    render(
      <LanguageProvider>
        <Field label="Slug" description="Lowercase, no spaces." error="Slug is already taken.">
          <Input defaultValue="" />
        </Field>
      </LanguageProvider>,
    );

    const control = screen.getByRole('textbox');
    const describedBy = control.getAttribute('aria-describedby')?.split(' ') ?? [];
    expect(describedBy).toHaveLength(2);
    expect(document.getElementById(describedBy[0]!)).toHaveTextContent('Lowercase, no spaces.');
    expect(document.getElementById(describedBy[1]!)).toHaveTextContent('Slug is already taken.');
    expect(control).toHaveAttribute('aria-invalid', 'true');
  });

  it('announces the validation message and keeps it out of the control name', () => {
    render(
      <LanguageProvider>
        <Field label="Slug" error="Slug is already taken.">
          <Input defaultValue="" />
        </Field>
      </LanguageProvider>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Slug is already taken.');
    // The label WRAPS the control, so anything left inside it would be read as the field's name.
    expect(screen.getByRole('textbox', { name: 'Slug' })).toBeInTheDocument();
  });

  it('states a required field both on the control and in its name', () => {
    render(
      <LanguageProvider>
        <Field label="Slug" required>
          <Input defaultValue="" />
        </Field>
      </LanguageProvider>,
    );

    expect(screen.getByRole('textbox', { name: 'Slug Required' })).toHaveAttribute('aria-required', 'true');
  });

  it('adds nothing to a plain field, and never overwrites a description the control brought itself', () => {
    render(
      <LanguageProvider>
        <>
          <Field label="Notes"><Input defaultValue="" /></Field>
          <Field label="Path" description="Absolute path.">
            <Input defaultValue="" aria-describedby="own-hint" />
          </Field>
        </>
      </LanguageProvider>,
    );

    const [notes, path] = screen.getAllByRole('textbox');
    expect(notes).not.toHaveAttribute('aria-describedby');
    expect(notes).not.toHaveAttribute('aria-invalid');
    expect(path.getAttribute('aria-describedby')).toMatch(/^own-hint \S+$/);
  });

  it('still renders a field whose children are not a single control', () => {
    render(
      <LanguageProvider>
        <Field label="Range" required description="Both ends are inclusive.">
          <>
            <Input defaultValue="" />
            <Input defaultValue="" />
          </>
        </Field>
      </LanguageProvider>,
    );

    // Nothing to clone onto — the fragment must not be cloned with ARIA props — but the description is
    // still shown and the required state still reaches a screen reader through the label.
    expect(screen.getByText('Both ends are inclusive.')).toBeInTheDocument();
    for (const control of screen.getAllByRole('textbox')) {
      expect(control).not.toHaveAttribute('aria-required');
    }
  });
});
