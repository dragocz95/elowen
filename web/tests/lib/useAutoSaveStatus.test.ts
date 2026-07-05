import { describe, it, expect } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAutoSaveStatus } from '../../lib/useAutoSaveStatus';

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

  it('flushes a pending debounced save on unmount (never drops the last edit)', async () => {
    let saves = 0;
    const { rerender, unmount } = renderHook(({ v }) => useAutoSaveStatus([v], () => { saves++; }, { delay: 1000 }), { initialProps: { v: 'a' } });
    rerender({ v: 'b' }); // schedules a save 1000ms out
    expect(saves).toBe(0);
    unmount();             // must flush the pending save synchronously
    await waitFor(() => expect(saves).toBe(1));
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
