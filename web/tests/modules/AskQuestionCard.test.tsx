import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createWrapper } from '../test-utils';
import { en } from '../../lib/i18n/dictionaries/en';
import { AskQuestionCard } from '../../modules/advisor/AskQuestionCard';
import type { AskQuestion } from '../../lib/types';

const single: AskQuestion = {
  question: 'Which colour?', header: 'Colour', multiSelect: false,
  options: [{ label: 'Blue' }, { label: 'Green', description: 'recommended' }],
};
const multi: AskQuestion = {
  question: 'Pick tools', header: 'Tools', multiSelect: true,
  options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
};

const renderCard = (questions: AskQuestion[], onSubmit = vi.fn()) => {
  render(<AskQuestionCard questions={questions} onSubmit={onSubmit} />, { wrapper: createWrapper().wrapper });
  return onSubmit;
};

describe('AskQuestionCard', () => {
  it('renders radios for single-select and submits the picked label', () => {
    const onSubmit = renderCard([single]);
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    fireEvent.click(screen.getByRole('radio', { name: /Green/ }));
    fireEvent.click(screen.getByRole('button', { name: en.brainChat.askSubmit }));
    expect(onSubmit).toHaveBeenCalledWith([{ header: 'Colour', selected: ['Green'], other: undefined }]);
  });

  it('renders checkboxes for multiSelect and submits every toggled label', () => {
    const onSubmit = renderCard([multi]);
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    fireEvent.click(screen.getByRole('checkbox', { name: 'A' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'C' }));
    fireEvent.click(screen.getByRole('button', { name: en.brainChat.askSubmit }));
    expect(onSubmit).toHaveBeenCalledWith([{ header: 'Tools', selected: ['A', 'C'], other: undefined }]);
  });

  it('offers a free-text "Other" by default and includes the typed answer', () => {
    const onSubmit = renderCard([single]);
    fireEvent.click(screen.getByRole('button', { name: en.brainChat.askOther }));
    fireEvent.change(screen.getByPlaceholderText(en.brainChat.askOtherPlaceholder), { target: { value: 'teal' } });
    fireEvent.click(screen.getByRole('button', { name: en.brainChat.askSubmit }));
    expect(onSubmit).toHaveBeenCalledWith([{ header: 'Colour', selected: [], other: 'teal' }]);
  });

  it('hides "Other" when the question sets custom: false', () => {
    renderCard([{ ...single, custom: false }]);
    expect(screen.queryByRole('button', { name: en.brainChat.askOther })).toBeNull();
  });

  it('keeps submit disabled until every question is answered', () => {
    renderCard([single, multi]);
    const submit = screen.getByRole('button', { name: en.brainChat.askSubmit });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /Blue/ }));
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'B' }));
    expect(submit).toBeEnabled();
  });
});
