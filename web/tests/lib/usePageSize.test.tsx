import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { usePageSize } from '../../lib/usePageSize';

/** A probe rather than `renderHook`: what matters is the value a register would slice its rows with, and
 *  a number that arrives as the string localStorage gave back reads identically in a hook result. */
function Probe({ storageKey, fallback }: { storageKey: string; fallback: number }) {
  const [size, setSize] = usePageSize(storageKey, fallback);
  return (
    <button type="button" onClick={() => setSize(100)}>
      {`${typeof size}:${size}`}
    </button>
  );
}

describe('usePageSize', () => {
  beforeEach(() => localStorage.clear());

  it('starts at the register\u2019s own default and reports a number, never a stored string', () => {
    render(<Probe storageKey="memory" fallback={25} />);
    // `page * pageSize` on a string is concatenation, not an offset — the type is the contract here.
    expect(screen.getByRole('button')).toHaveTextContent('number:25');
  });

  it('remembers the choice under a key of its own, so two registers do not follow each other', () => {
    render(<Probe storageKey="memory" fallback={25} />);
    act(() => screen.getByRole('button').click());
    expect(screen.getByRole('button')).toHaveTextContent('number:100');
    expect(localStorage.getItem('elowen.pageSize.memory')).toBe('100');
    // A second register reads its own slot and stays on its own default.
    expect(localStorage.getItem('elowen.pageSize.skills')).toBeNull();
  });

  it('rehydrates a stored choice on mount', () => {
    localStorage.setItem('elowen.pageSize.memory', '50');
    render(<Probe storageKey="memory" fallback={25} />);
    expect(screen.getByRole('button')).toHaveTextContent('number:50');
  });

  it('rejects a stored value no control could have produced', () => {
    // A page size is a slice bound: "0" divides the page count by zero and "100000" renders the whole
    // table at once. Neither is reachable through the select, so a hand-edited or stale key falls back.
    for (const poison of ['0', '100000', 'all', '', '25.5']) {
      localStorage.setItem('elowen.pageSize.memory', poison);
      const view = render(<Probe storageKey="memory" fallback={25} />);
      expect(screen.getByRole('button'), `stored "${poison}" was honoured`).toHaveTextContent('number:25');
      view.unmount();
    }
  });

  it('honours a register\u2019s own default even when it is not one of the offered steps', () => {
    localStorage.setItem('elowen.pageSize.legacy', '20');
    render(<Probe storageKey="legacy" fallback={20} />);
    expect(screen.getByRole('button')).toHaveTextContent('number:20');
  });
});
