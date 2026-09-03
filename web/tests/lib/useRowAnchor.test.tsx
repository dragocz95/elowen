import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { useState } from 'react';

// The hook reads the parameter from `useSearchParams` (a client navigation) AND from the live URL (first
// load / F5 / popstate). The mock mirrors production: it answers from `window.location`, which is what a
// navigation in this suite changes.
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(window.location.search) }));

import { useRowAnchor } from '../../lib/useRowAnchor';
import { ROW_FLASH_CLASS } from '../../lib/rowAnchors';
import { SettingsGroup, SettingsRow } from '../../components/ui/SettingsSurface';

const ROW = 'settings.modelRoles.digest';

/** A page: rows with anchors, plus the ability to mount one late the way a lazy section does. */
function Page({ rows = [ROW], onMountLate }: { rows?: string[]; onMountLate?: (mount: () => void) => void }) {
  useRowAnchor();
  const [late, setLate] = useState<string | null>(null);
  onMountLate?.(() => setLate(ROW));
  return (
    <div>
      {rows.map((row) => <div key={row} data-row-id={row}>{row}</div>)}
      {late ? <div data-row-id={late}>late</div> : null}
    </div>
  );
}

const rowNode = (id = ROW) => document.querySelector<HTMLElement>(`[data-row-id="${id}"]`)!;
const navigate = (url: string) => window.history.replaceState(null, '', url);

let scrollIntoView: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  scrollIntoView.mockRestore();
  navigate('/settings');
});

/** A page whose anchored row sits inside a folded group — the shape Settings → Models has. */
function FoldedPage() {
  useRowAnchor();
  return (
    <SettingsGroup title="Model roles" collapsible>
      <SettingsRow label="Digest model" rowId={ROW} />
    </SettingsGroup>
  );
}

describe('useRowAnchor', () => {
  it('opens the folded group the row lives in before revealing it', () => {
    navigate(`/settings?cat=models&row=${ROW}`);
    const { container } = render(<FoldedPage />);

    const trigger = container.querySelector('.settings-group__trigger')!;
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('.settings-group__body')).not.toHaveAttribute('hidden');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(rowNode()).toHaveClass(ROW_FLASH_CLASS);
  });

  it('reveals the row the URL names and consumes the anchor', () => {
    navigate(`/settings?cat=models&row=${ROW}`);
    render(<Page />);

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(rowNode()).toHaveClass(ROW_FLASH_CLASS);
    // THE ANCHOR IS CONSUMED: a reload must not blink the row again. The section stays selected.
    expect(window.location.search).toBe('?cat=models');
  });

  it('takes the highlight off again when the animation ends', () => {
    navigate(`/settings?cat=models&row=${ROW}`);
    render(<Page />);
    const row = rowNode();
    expect(row).toHaveClass(ROW_FLASH_CLASS);

    act(() => { row.dispatchEvent(new Event('animationend')); });
    expect(row).not.toHaveClass(ROW_FLASH_CLASS);
    // …and the backstop timer that would otherwise fire later finds nothing left to do.
    act(() => { vi.advanceTimersByTime(5000); });
    expect(row).not.toHaveClass(ROW_FLASH_CLASS);
  });

  it('clears the highlight on a timer when no animation runs (quiet effects)', () => {
    navigate(`/settings?cat=models&row=${ROW}`);
    render(<Page />);
    expect(rowNode()).toHaveClass(ROW_FLASH_CLASS);

    act(() => { vi.advanceTimersByTime(1799); });
    expect(rowNode()).toHaveClass(ROW_FLASH_CLASS);
    act(() => { vi.advanceTimersByTime(1); });
    expect(rowNode()).not.toHaveClass(ROW_FLASH_CLASS);
  });

  it('waits for a row that mounts after the navigation', async () => {
    navigate(`/settings?cat=models&row=${ROW}`);
    let mountLate = () => {};
    render(<Page rows={[]} onMountLate={(mount) => { mountLate = mount; }} />);
    // Nothing to reveal yet, and the anchor is still in the URL — the wait is on.
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(window.location.search).toBe(`?cat=models&row=${ROW}`);

    act(() => { mountLate(); });
    await waitFor(() => expect(rowNode()).toHaveClass(ROW_FLASH_CLASS));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(window.location.search).toBe('?cat=models');
  });

  it('gives up quietly on a stale anchor — the section simply opens', async () => {
    navigate('/settings?cat=models&row=settings.rowThatMoved');
    render(<Page />);

    act(() => { vi.advanceTimersByTime(2000); });
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.querySelector(`.${ROW_FLASH_CLASS}`)).toBeNull();
    expect(window.location.search).toBe('?cat=models');
  });

  it('does nothing at all when no row is named', () => {
    navigate('/settings?cat=models');
    render(<Page />);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.querySelector(`.${ROW_FLASH_CLASS}`)).toBeNull();
    expect(window.location.search).toBe('?cat=models');
  });

  it('follows back/forward: a popstate carrying an anchor reveals its row', () => {
    navigate('/settings?cat=models');
    render(<Page />);
    expect(scrollIntoView).not.toHaveBeenCalled();

    act(() => {
      navigate(`/settings?cat=models&row=${ROW}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(rowNode()).toHaveClass(ROW_FLASH_CLASS);
    expect(window.location.search).toBe('?cat=models');
  });

  it('does not move focus into the row it reveals', () => {
    navigate(`/settings?cat=models&row=${ROW}`);
    render(<Page />);
    // A blink says "here"; it does not take over the keyboard from whatever the palette handed focus to.
    expect(document.activeElement).toBe(document.body);
  });
});
