import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrameScheduler } from '../../../src/cli/chat/frameScheduler.js';

describe('FrameScheduler', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000); });
  afterEach(() => vi.useRealTimers());

  it('coalesces a burst into one frame and preserves every reason', async () => {
    const frames: { reasons: string[]; forced: boolean }[] = [];
    const scheduler = new FrameScheduler((frame) => frames.push(frame));
    for (let i = 0; i < 100; i++) scheduler.schedule(`stream:${i % 3}`, 'normal');
    expect(vi.getTimerCount()).toBe(1);
    await vi.runOnlyPendingTimersAsync();
    expect(frames).toEqual([{ reasons: ['stream:0', 'stream:1', 'stream:2'], forced: false }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('limits normal frames to 30fps while interactive scroll may render at 60fps', async () => {
    const frames: { at: number; reasons: string[] }[] = [];
    const scheduler = new FrameScheduler((frame) => frames.push({ at: Date.now(), reasons: frame.reasons }));
    scheduler.schedule('boot', 'normal');
    await vi.runOnlyPendingTimersAsync();

    vi.advanceTimersByTime(5);
    scheduler.schedule('stream:text', 'normal');
    await vi.advanceTimersByTimeAsync(27);
    expect(frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(frames).toHaveLength(2);

    vi.advanceTimersByTime(2);
    scheduler.schedule('scroll:wheel', 'interactive');
    await vi.advanceTimersByTimeAsync(13);
    expect(frames).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(frames).toHaveLength(3);
  });

  it('escalates a pending ordinary frame to one immediate forced repaint', async () => {
    const frames: { reasons: string[]; forced: boolean }[] = [];
    const scheduler = new FrameScheduler((frame) => frames.push(frame));
    scheduler.schedule('stream:text', 'normal');
    scheduler.scheduleForced('resize');
    expect(vi.getTimerCount()).toBe(1);
    await vi.runOnlyPendingTimersAsync();
    expect(frames).toEqual([{ reasons: ['stream:text', 'resize'], forced: true }]);
  });

  it('pulls a pending normal frame forward when interactive input arrives', async () => {
    const frames: { at: number; reasons: string[] }[] = [];
    const scheduler = new FrameScheduler((frame) => frames.push({ at: Date.now(), reasons: frame.reasons }));
    scheduler.schedule('boot', 'normal');
    await vi.runOnlyPendingTimersAsync();

    vi.advanceTimersByTime(1);
    scheduler.schedule('stream:text', 'normal');
    vi.advanceTimersByTime(1);
    scheduler.schedule('scroll:wheel', 'interactive');

    await vi.advanceTimersByTimeAsync(14);
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual({ at: 1_016, reasons: ['stream:text', 'scroll:wheel'] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops scheduled work while paused and resumes only on an explicit new request', async () => {
    const render = vi.fn();
    const scheduler = new FrameScheduler(render);
    scheduler.schedule('before-editor', 'interactive');
    scheduler.pause();
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(render).not.toHaveBeenCalled();
    scheduler.schedule('ignored-while-paused', 'interactive');
    expect(vi.getTimerCount()).toBe(0);
    scheduler.resume();
    scheduler.scheduleForced('external-editor:return');
    await vi.runOnlyPendingTimersAsync();
    expect(render).toHaveBeenCalledOnce();
  });

  it('stop is idempotent and an idle scheduler owns no timer', async () => {
    const render = vi.fn();
    const scheduler = new FrameScheduler(render);
    expect(vi.getTimerCount()).toBe(0);
    scheduler.schedule('pending', 'normal');
    scheduler.stop();
    scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    scheduler.schedule('after-stop', 'interactive');
    expect(render).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
