import { describe, expect, it, vi } from 'vitest';
import { combineSaveFeedback } from '../../lib/saveFeedback';

describe('combineSaveFeedback', () => {
  it('retries every failed child in declaration order', () => {
    const first = vi.fn();
    const second = vi.fn();
    const feedback = combineSaveFeedback(
      { status: 'error', retry: first },
      { status: 'error', retry: second },
    );

    expect(feedback.status).toBe('error');
    feedback.retry?.();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('keeps saving ahead of delayed activation and delayed activation ahead of saved', () => {
    expect(combineSaveFeedback({ status: 'saved' }, { status: 'pending' }).status).toBe('pending');
    expect(combineSaveFeedback({ status: 'pending' }, { status: 'saving' }).status).toBe('saving');
  });
});
