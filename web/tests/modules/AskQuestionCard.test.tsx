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

  it('clips a header longer than the chip width and answers with the full header', () => {
    // The tool accepts any header length, so the card is where the chip budget is applied. The answer
    // still carries the header the question was created with — only the drawing is shortened.
    const onSubmit = renderCard([{ ...single, header: 'Authentication m' }]);
    expect(screen.getByText('Authenticat…')).toBeTruthy();
    // The full header stays reachable on hover — the chip has a fixed budget, the wording does not.
    expect(screen.getByText('Authenticat…').getAttribute('title')).toBe('Authentication m');
    expect(screen.queryByText('Authentication m')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Blue/ }));
    fireEvent.click(screen.getByRole('button', { name: en.brainChat.askSubmit }));
    expect(onSubmit).toHaveBeenCalledWith([{ header: 'Authentication m', selected: ['Blue'], other: undefined }]);
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

  // A `preview` lets the user compare choices visually (a layout, a code shape) rather than reading about
  // them. It shows the FOCUSED option, so they can look at each one WITHOUT committing to a pick.
  describe('option previews', () => {
    const withPreview: AskQuestion = {
      question: 'Which dashboard layout?', header: 'Layout', multiSelect: false,
      options: [
        { label: 'Grid', description: 'cards in a grid', preview: 'GRID-MOCKUP' },
        { label: 'List', description: 'rows stacked', preview: 'LIST-MOCKUP' },
      ],
    };

    it('shows the first option\'s preview, and follows the pointer to another option', () => {
      renderCard([withPreview]);
      const pane = screen.getByTestId('ask-preview-0');
      expect(pane).toHaveTextContent('GRID-MOCKUP');

      fireEvent.mouseEnter(screen.getByRole('radio', { name: /List/ }));
      expect(pane).toHaveTextContent('LIST-MOCKUP');
      expect(pane).not.toHaveTextContent('GRID-MOCKUP');
    });

    it('previewing an option does not select it — looking is not choosing', () => {
      const onSubmit = renderCard([withPreview]);
      fireEvent.mouseEnter(screen.getByRole('radio', { name: /List/ }));
      expect(screen.getByRole('button', { name: en.brainChat.askSubmit })).toBeDisabled();

      fireEvent.click(screen.getByRole('radio', { name: /Grid/ }));
      fireEvent.click(screen.getByRole('button', { name: en.brainChat.askSubmit }));
      expect(onSubmit).toHaveBeenCalledWith([{ header: 'Layout', selected: ['Grid'], other: undefined }]);
    });

    it('keyboard focus drives the preview too, so it is not pointer-only', () => {
      renderCard([withPreview]);
      fireEvent.focus(screen.getByRole('radio', { name: /List/ }));
      expect(screen.getByTestId('ask-preview-0')).toHaveTextContent('LIST-MOCKUP');
    });

    it('falls back to a hint when the focused option has no preview of its own', () => {
      renderCard([{
        ...withPreview,
        options: [{ label: 'Grid' }, { label: 'List', preview: 'LIST-MOCKUP' }],
      }]);
      expect(screen.getByTestId('ask-preview-0')).toHaveTextContent(en.brainChat.askPreviewHint);
      fireEvent.mouseEnter(screen.getByRole('radio', { name: /List/ }));
      expect(screen.getByTestId('ask-preview-0')).toHaveTextContent('LIST-MOCKUP');
    });

    it('renders no preview pane at all for a question without previews', () => {
      renderCard([single]);
      expect(screen.queryByTestId('ask-preview-0')).toBeNull();
    });

    it('renders no preview pane for a multi-select question — there is no single focused option', () => {
      renderCard([{ ...multi, options: [{ label: 'A', preview: 'A-MOCK' }, { label: 'B' }] }]);
      expect(screen.queryByTestId('ask-preview-0')).toBeNull();
    });
  });
});
