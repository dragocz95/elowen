import { describe, it, expect } from 'vitest';
import { render, renderHook, waitFor } from '@testing-library/react';
import { Activity } from 'react';
import { useAutoSaveStatus, type SaveStatus } from '../../lib/useAutoSaveStatus';

describe('useAutoSaveStatus', () => {
  it('does not save the seed value, then debounce-saves after a change', async () => {
    let saves = 0;
    const { rerender } = renderHook(({ v }) => useAutoSaveStatus([v], () => { saves++; }, { delay: 10 }), { initialProps: { v: 'a' } });
    await new Promise((r) => setTimeout(r, 30));
    expect(saves).toBe(0); // seeding never persists
    rerender({ v: 'b' });
    await waitFor(() => expect(saves).toBe(1));
  });

  it('drives status: saving → saved on success', async () => {
    const { result, rerender } = renderHook(({ v }) => useAutoSaveStatus([v], async () => {}, { delay: 5 }), { initialProps: { v: 'a' } });
    rerender({ v: 'b' });
    await waitFor(() => expect(result.current.status).toBe('saved'));
  });

  it('drives status: error on failure, and retry re-runs the save', async () => {
    let attempts = 0;
    const { result, rerender } = renderHook(({ v }) => useAutoSaveStatus([v], async () => { attempts++; if (attempts === 1) throw new Error('boom'); }, { delay: 5 }), { initialProps: { v: 'a' } });
    rerender({ v: 'b' });
    await waitFor(() => expect(result.current.status).toBe('error'));
    result.current.retry();
    await waitFor(() => expect(result.current.status).toBe('saved'));
    expect(attempts).toBe(2);
  });

  it('does not retry after the current value becomes invalid', async () => {
    let attempts = 0;
    let valid = true;
    const { result, rerender } = renderHook(({ v }) => useAutoSaveStatus([v], async () => { attempts++; throw new Error('boom'); }, { delay: 5, savable: valid }), { initialProps: { v: 'a' } });
    rerender({ v: 'b' });
    await waitFor(() => expect(result.current.status).toBe('error'));
    valid = false;
    rerender({ v: '' });
    await result.current.retry();
    expect(attempts).toBe(1);
    expect(result.current.status).toBe('error');
  });

  it('represents delayed activation instead of reporting a fully active save', async () => {
    const { result, rerender } = renderHook(({ v }) => useAutoSaveStatus([v], async () => ({ pending: true }), { delay: 5 }), { initialProps: { v: 'a' } });
    rerender({ v: 'b' });
    await waitFor(() => expect(result.current.status).toBe('pending'));
  });

  it('flushes a pending debounced save on unmount (never drops the last edit)', async () => {
    let saves = 0;
    const { rerender, unmount } = renderHook(({ v }) => useAutoSaveStatus([v], () => { saves++; }, { delay: 1000 }), { initialProps: { v: 'a' } });
    rerender({ v: 'b' }); // schedules a save 1000ms out
    expect(saves).toBe(0);
    unmount();             // must flush the pending save synchronously
    await waitFor(() => expect(saves).toBe(1));
  });

  it('lets a save that was still in flight at unmount finish on its own', async () => {
    // The real-world shape of the unmount flush: an async save that only settles after the modal is gone.
    // The write must still complete (that is the whole point of flushing), while the controller reports
    // nothing back — there is no longer anything rendering its status to report to.
    let settle: () => void = () => {};
    let saves = 0;
    const { unmount, rerender } = renderHook(
      ({ v }) => useAutoSaveStatus([v], () => { saves++; return new Promise<void>((resolve) => { settle = resolve; }); }, { delay: 1000 }),
      { initialProps: { v: 'a' } },
    );
    rerender({ v: 'b' });
    unmount();
    expect(saves).toBe(1); // flushed synchronously, before the debounce would have fired
    settle();
    await new Promise((r) => setTimeout(r, 0));
    expect(saves).toBe(1); // and it settles once, without the unmounted controller queueing another pass
  });

  // Every settings and account panel is wrapped in `<Activity>`, which tears its children's effects down
  // when the panel is hidden and builds them back up on return — while REFS survive, because the component
  // instance is kept alive. A hook that only ever clears a liveness flag in its cleanup therefore goes
  // permanently deaf the first time the user switches category, and the footer keeps claiming the last
  // status it managed to report. Silent for a save that succeeds; a lie for one that fails.
  it('keeps reporting status after the panel it lives in is hidden and shown again', async () => {
    let failing = false;
    let seen: SaveStatus = 'idle';
    function Probe({ v }: { v: string }) {
      const { status } = useAutoSaveStatus([v], async () => { if (failing) throw new Error('rejected'); }, { delay: 5 });
      seen = status;
      return null;
    }
    const harness = (hidden: boolean, v: string) => (
      <Activity mode={hidden ? 'hidden' : 'visible'}><Probe v={v} /></Activity>
    );

    const { rerender } = render(harness(false, 'a'));
    rerender(harness(true, 'a'));  // user switches category — effects are destroyed, refs are not
    rerender(harness(false, 'a')); // and back: effects are set up again on the SAME hook instance
    failing = true;
    rerender(harness(false, 'b')); // a real edit, whose save rejects
    await waitFor(() => expect(seen).toBe('error'));
  });

  it('only the latest save drives the terminal status (stale response is ignored)', async () => {
    // First save resolves slowly with an error; a second, newer save resolves fast and OK. The stale
    // slow error must NOT flip the status back once the newer save reported success.
    let call = 0;
    const { result, rerender } = renderHook(
      ({ v }) => useAutoSaveStatus([v], async () => {
        call++;
        if (call === 1) { await new Promise((r) => setTimeout(r, 40)); throw new Error('stale'); }
        return; // newer call: fast + ok
      }, { delay: 5 }),
      { initialProps: { v: 'a' } },
    );
    rerender({ v: 'b' }); // triggers save #1 (slow error)
    await new Promise((r) => setTimeout(r, 10));
    rerender({ v: 'c' }); // triggers save #2 (fast ok) before #1 settles
    await waitFor(() => expect(result.current.status).toBe('saved'));
    await new Promise((r) => setTimeout(r, 60)); // let the stale #1 reject
    expect(result.current.status).toBe('saved'); // not flipped to 'error'
  });
});
