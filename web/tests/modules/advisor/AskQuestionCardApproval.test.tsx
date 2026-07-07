import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createWrapper } from '../../test-utils';
import { en } from '../../../lib/i18n/dictionaries/en';
import { AskQuestionCard } from '../../../modules/advisor/AskQuestionCard';
import type { AskQuestion } from '../../../lib/types';

/** The shape the daemon's approvalQuestion() emits for a blocked tool-permission ask
 *  (kind 'approval' on the `ask` event): single-select, no free-text Other, three fixed options. */
const approval: AskQuestion = {
  question: 'Run this command?\n$ rm -rf build',
  header: 'Approval',
  multiSelect: false,
  custom: false,
  options: [
    { label: 'Allow once', description: 'run it this time only' },
    { label: 'Always allow', description: 'always allow "rm*"' },
    { label: 'Deny', description: 'skip this call' },
  ],
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
