import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { ChoiceField } from '../../../components/ui/ChoiceField';

describe('ChoiceField', () => {
  it('uses an inline segmented control for three or fewer options', () => {
    render(<LanguageProvider><ChoiceField title="Mode" value="a" onChange={() => {}} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} /></LanguageProvider>);
    expect(screen.getByRole('radiogroup', { name: 'Mode' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'A' })).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps an unknown persisted value visible in the compact picker', () => {
    render(<LanguageProvider><ChoiceField title="Mode" value="legacy" onChange={() => {}} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} /></LanguageProvider>);
    expect(screen.getByRole('radio', { name: 'legacy' })).toHaveAttribute('aria-checked', 'true');
  });

  it('uses the shared searchable single-select modal for larger choices', () => {
    render(<LanguageProvider><ChoiceField title="Effects" value="auto" onChange={() => {}} options={[
      { value: 'auto', label: 'Auto' }, { value: 'full', label: 'Full' }, { value: 'reduced', label: 'Reduced' }, { value: 'off', label: 'Off' },
    ]} /></LanguageProvider>);
    // The trigger is named for the FIELD and shows the current pick — not a "Manage" button beside a
    // summary card, which is what a record's trailing cell has no room for.
    const trigger = screen.getByRole('button', { name: 'Effects' });
    expect(trigger).toHaveTextContent('Auto');
    fireEvent.click(trigger);
    expect(screen.getByRole('searchbox', { name: 'Search…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders the option icon on the trigger and inside the shared picker rows', () => {
    render(<LanguageProvider><ChoiceField
      title="Project scope"
      picker="always"
      value="project-1"
      onChange={() => {}}
      options={[{ value: 'project-1', label: 'elowen', icon: <span data-testid="project-icon" /> }]}
    /></LanguageProvider>);

    // The trigger IS the current pick — its own mark included, so the row reads as the choice rather
    // than as a button that leads to one.
    const trigger = screen.getByRole('button', { name: 'Project scope' });
    expect(trigger.querySelector('[data-testid="project-icon"]')).not.toBeNull();

    fireEvent.click(trigger);

    expect(screen.getByRole('button', { name: 'elowen' }).querySelector('[data-testid="project-icon"]')).not.toBeNull();
  });
});
