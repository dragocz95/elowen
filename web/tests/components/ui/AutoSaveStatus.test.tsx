import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AutoSaveStatus } from '../../../components/ui/AutoSaveStatus';
import { createWrapper } from '../../test-utils';

describe('AutoSaveStatus', () => {
  it.each([
    ['saving', 'Saving…'],
    ['pending', 'Saved; activation pending'],
  ] as const)('announces %s through a polite status region', (status, text) => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><AutoSaveStatus status={status} /></Wrapper>);
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('status')).toHaveTextContent(text);
  });

  it('keeps a successful autosave silent', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><AutoSaveStatus status="saved" /></Wrapper>);
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('keeps a failed save actionable in an alert', () => {
    const retry = vi.fn();
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><AutoSaveStatus status="error" onRetry={retry} /></Wrapper>);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't save");
    screen.getByRole('button', { name: 'Retry' }).click();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('keeps an idle polite live region in the accessibility tree', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><AutoSaveStatus status="idle" /></Wrapper>);
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });
});
