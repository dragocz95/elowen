import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createWrapper } from '../../test-utils';
import { en } from '../../../lib/i18n/dictionaries/en';
import { cs } from '../../../lib/i18n/dictionaries/cs';
import { interpolate } from '../../../lib/i18n/interpolate';
import { AskQuestionCard } from '../../../modules/advisor/AskQuestionCard';
import type { AskQuestion } from '../../../lib/types';

const LOCALE_KEY = 'elowen-locale';

/** The shape the daemon's approvalQuestion() emits for a blocked tool-permission ask
 *  (kind 'approval' on the `ask` event): single-select, no free-text Other, three fixed options. */
const approval: AskQuestion = {
  question: 'Run this command?\n$ rm -rf build',
  header: 'Approval',
  multiSelect: false,
  custom: false,
  options: [
    { label: 'Allow once', description: 'run it this time only', id: 'once' },
    { label: 'Always allow', description: 'always allow "rm*"', id: 'always' },
    { label: 'Deny', description: 'skip this call', id: 'deny' },
  ],
  approval: { tool: 'Bash', command: 'rm -rf build', alwaysPattern: 'rm*' },
};

describe('AskQuestionCard — approval kind', () => {
  it('renders the approval title, warning tone and all three options, without an Other escape', () => {
    const { container } = render(
      <AskQuestionCard questions={[approval]} kind="approval" onSubmit={vi.fn()} />,
      { wrapper: createWrapper().wrapper },
    );
    expect(screen.getByText(en.brainChat.approvalWaiting)).toBeTruthy();
    expect(container.querySelector('.border-warning\\/50')).toBeTruthy();
    for (const label of ['Allow once', 'Always allow', 'Deny']) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByRole('button', { name: en.brainChat.askOther })).toBeNull();
  });

  it('submits the picked decision label to /brain/answer', () => {
    const onSubmit = vi.fn();
    render(<AskQuestionCard questions={[approval]} kind="approval" onSubmit={onSubmit} />, { wrapper: createWrapper().wrapper });
    fireEvent.click(screen.getByRole('radio', { name: /Always allow/ }));
    fireEvent.click(screen.getByRole('button', { name: en.brainChat.askSubmit }));
    expect(onSubmit).toHaveBeenCalledWith([{ header: 'Approval', selected: ['Always allow'], other: undefined }]);
  });

  it('a regular question keeps the regular title (no approval styling)', () => {
    const { container } = render(
      <AskQuestionCard questions={[{ ...approval, header: 'Choice' }]} onSubmit={vi.fn()} />,
      { wrapper: createWrapper().wrapper },
    );
    expect(screen.getByText(en.brainChat.askWaiting)).toBeTruthy();
    expect(container.querySelector('.border-warning\\/50')).toBeNull();
  });
});

// The English labels ARE the decision contract: the daemon resolves a pick by matching them
// (`approvalDecision` in src/brain/toolPermissions.ts), and anything it does not recognise fails closed to
// deny. So a localized card must change the WORDING while still posting the English label back — the two
// tests below pin exactly that pair, because getting it half right silently denies every approval.
describe('AskQuestionCard — approval in another language', () => {
  beforeEach(() => localStorage.setItem(LOCALE_KEY, 'cs'));
  afterEach(() => localStorage.removeItem(LOCALE_KEY));

  it('renders the wording from the dictionary, composed from the structured facts', async () => {
    render(<AskQuestionCard questions={[approval]} kind="approval" onSubmit={vi.fn()} />, { wrapper: createWrapper().wrapper });

    expect(await screen.findByText(cs.brainChat.approvalOnce)).toBeTruthy();
    expect(screen.getByText(cs.brainChat.approvalAlways)).toBeTruthy();
    expect(screen.getByText(cs.brainChat.approvalDeny)).toBeTruthy();
    expect(screen.getByText(cs.brainChat.approvalHeader)).toBeTruthy();
    // The pattern is interpolated from `approval.alwaysPattern`, never parsed back out of the English.
    expect(screen.getByText(interpolate(cs.brainChat.approvalAlwaysHint, { pattern: 'rm*' }))).toBeTruthy();
    // The English wire text must be gone from the surface the human reads.
    expect(screen.queryByText('Allow once')).toBeNull();
    expect(screen.queryByText('skip this call')).toBeNull();
  });

  it('still posts the ENGLISH label back, so the daemon can resolve the decision', async () => {
    const onSubmit = vi.fn();
    render(<AskQuestionCard questions={[approval]} kind="approval" onSubmit={onSubmit} />, { wrapper: createWrapper().wrapper });

    fireEvent.click(await screen.findByRole('radio', { name: new RegExp(cs.brainChat.approvalAlways) }));
    fireEvent.click(screen.getByRole('button', { name: cs.brainChat.askSubmit }));
    expect(onSubmit).toHaveBeenCalledWith([{ header: 'Approval', selected: ['Always allow'], other: undefined }]);
  });

  // An ordinary AskUserQuestion has no `approval` block and no option ids; it must render exactly as sent.
  it('leaves a non-approval question untouched', async () => {
    const plain = { ...approval, approval: undefined, options: [{ label: 'Blue' }, { label: 'Green' }] };
    render(<AskQuestionCard questions={[plain]} onSubmit={vi.fn()} />, { wrapper: createWrapper().wrapper });
    expect(await screen.findByText('Blue')).toBeTruthy();
    expect(screen.getByText('Green')).toBeTruthy();
  });
});
