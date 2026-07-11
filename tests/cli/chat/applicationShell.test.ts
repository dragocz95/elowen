import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { Component, TUI } from '@earendil-works/pi-tui';
import { AnimationController } from '../../../src/cli/chat/animationController.js';
import { InputRouter } from '../../../src/cli/chat/inputRouter.js';
import type { ChatInputContext } from '../../../src/cli/chat/inputRouter.js';
import { OverlayController } from '../../../src/cli/chat/overlayController.js';
import { RenderShell } from '../../../src/cli/chat/renderShell.js';
import { ChatApplication } from '../../../src/cli/chat/chatApplication.js';

describe('chat application shell ownership', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000); });
  afterEach(() => vi.useRealTimers());

  it('AnimationController owns only self-cancelling visual timers and is idle at rest', async () => {
    const render = vi.fn();
    let panelVisible = false;
    const animation = new AnimationController({ render, canAnimateMascot: () => panelVisible });
    expect(animation.timerCount).toBe(0);

    animation.updateThinking(true);
    expect(animation.timerCount).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(render).toHaveBeenCalledWith('animation:thinking');
    expect(animation.timerCount).toBe(0);

    animation.nudgeMascot(1);
    expect(animation.timerCount).toBe(0); // hidden panel never arms decorative work
    panelVisible = true;
    animation.nudgeMascot(1);
    expect(animation.timerCount).toBe(1);
    animation.stop();
    expect(animation.timerCount).toBe(0);
  });

  it('OverlayController sanitizes one overlay boundary and forces structural open/close frames', () => {
    let rendered!: Component;
    const hide = vi.fn();
    const nativeShow = vi.fn((component: Component) => {
      rendered = component;
      return { hide, focus: vi.fn(), isHidden: () => false, setHidden: vi.fn() };
    });
    const force = vi.fn();
    const tui = { showOverlay: nativeShow } as unknown as TUI;
    const overlays = new OverlayController(tui, force);
    const handle = overlays.show('suggestions', {
      invalidate: () => {}, render: () => ['safe\x1b[2J row'],
    }, { anchor: 'top-left' });
    expect(rendered.render(20).join('')).toBe('safe row');
    expect(force).toHaveBeenCalledWith('overlay:open');
    handle.hide();
    expect(hide).toHaveBeenCalledOnce();
    expect(force).toHaveBeenCalledWith('overlay:close');
    overlays.stop();
  });

  it('OverlayController gives suggestions all small-screen space above the protected composer', () => {
    let options: { maxHeight?: number; margin?: unknown } | undefined;
    const tui = {
      showOverlay: vi.fn((_component: Component, next) => {
        options = next;
        return { hide: vi.fn(), focus: vi.fn(), isHidden: () => false, setHidden: vi.fn() };
      }),
    } as unknown as TUI;
    const setMaxRows = vi.fn();
    const overlay = { invalidate: () => {}, render: () => [], setMaxRows };
    const controller = new OverlayController(tui, vi.fn());
    controller.showSuggestion('slash', overlay, {
      columns: 40, rows: 12, hasMessages: true, panelReserve: 0,
      input: { invalidate: () => {}, render: () => [] }, notice: '',
      budget: {
        compactFallback: false, terminalColumns: 40, terminalRows: 12, chatColumns: 40,
        telemetryColumns: 0, telemetryGutter: 0, rootRows: 12,
        sections: { header: 1, transcript: 5, cards: 0, subagents: 0, queue: 0, attachments: 0, editor: 3, status: 1, hints: 1 },
      },
    });
    expect(setMaxRows).toHaveBeenCalledWith(6);
    expect(options?.maxHeight).toBe(6);
    controller.stop();
  });

  it('RenderShell is the only terminal render sink and coalesces explicit reasons', async () => {
    const nativeRequest = vi.fn();
    const prepare = vi.fn();
    const tui = { requestRender: nativeRequest } as unknown as TUI;
    const term = { columns: 80, rows: 24 };
    const render = new RenderShell({ tui, term, prepare });

    render.scheduleRender('stream:text');
    render.scheduleRender('state:queue');
    expect(vi.getTimerCount()).toBe(1);
    await vi.runOnlyPendingTimersAsync();
    expect(prepare).toHaveBeenCalledOnce();
    expect(nativeRequest).toHaveBeenCalledOnce();
    expect(render.takeFrame()?.reasons).toEqual(new Set(['stream:text', 'state:queue']));

    render.scheduleForcedRender('resize');
    await vi.runOnlyPendingTimersAsync();
    expect(nativeRequest).toHaveBeenLastCalledWith(true);
    render.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('RenderShell owns the sole layout allocation and final root bounds', () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const render = new RenderShell({ tui, term: { columns: 20, rows: 10 }, prepare: vi.fn() });
    const budget = render.allocateLayout({
      columns: 20, rows: 10, hasTranscript: true, telemetryRequested: true,
      desired: { editor: 30, queue: 20, attachments: 4, cards: 20, subagents: 20 },
    });
    expect(budget.rootRows).toBe(10);
    const frame = render.composeRoot(['x'.repeat(80), ...Array.from({ length: 20 }, () => 'row')], 20, 10);
    expect(frame).toHaveLength(10);
    expect(frame.every((line) => visibleWidth(line) === 20)).toBe(true);
    render.stop();
  });

  it('InputRouter registers one listener, routes input once, and detaches idempotently', () => {
    let listener!: (data: string) => { consume: true } | undefined;
    const remove = vi.fn();
    const tui = { addInputListener: vi.fn((next) => { listener = next; return remove; }) } as unknown as TUI;
    const route = vi.fn(() => ({ consume: true } as const));
    const router = new InputRouter(tui, route);
    router.attach();
    router.attach();
    expect(tui.addInputListener).toHaveBeenCalledOnce();
    expect(listener('x')).toEqual({ consume: true });
    expect(route).toHaveBeenCalledWith('x');
    router.stop();
    router.stop();
    expect(remove).toHaveBeenCalledOnce();
  });

  it('InputRouter gives the transcript scrollbar first refusal and preserves drag through release', () => {
    let listener!: (data: string) => { consume: boolean } | undefined;
    const tui = { addInputListener: vi.fn((next) => { listener = next; return vi.fn(); }) } as unknown as TUI;
    const viewport = {
      isScrollbarHit: vi.fn(() => true),
      beginScrollbarDrag: vi.fn(() => false),
      updateScrollbarDrag: vi.fn(() => false),
      endScrollbarDrag: vi.fn(),
    };
    const context = {
      rt: { term: { columns: 120 }, editor: { focused: true } },
      stream: {},
      keymap: () => ({}), leader: () => ({}), dispatchAction: vi.fn(), render: vi.fn(),
      animations: { nudgeMascot: vi.fn() },
      hasMessages: () => true,
      activeViewport: () => viewport,
      panelVisible: () => true,
      panelLeftEdge: () => 80,
    } as unknown as ChatInputContext;
    const router = new InputRouter(tui, context);
    router.attach();

    expect(listener('\x1b[<0;79;5M')).toEqual({ consume: true });
    expect(viewport.beginScrollbarDrag).toHaveBeenCalledWith(5);
    expect(listener('\x1b[<32;79;8M')).toEqual({ consume: true });
    expect(viewport.updateScrollbarDrag).toHaveBeenCalledWith(8);
    expect(listener('\x1b[<0;79;8m')).toEqual({ consume: true });
    expect(viewport.endScrollbarDrag).toHaveBeenCalledOnce();
    router.stop();
  });

  it('ChatApplication composes one terminal lifecycle and tears every owned controller down', () => {
    const writes: string[] = [];
    const renderOwner = { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() };
    const animations = { pause: vi.fn(), stop: vi.fn() };
    const overlays = { stop: vi.fn() };
    const input = { stop: vi.fn() };
    const cleanup = vi.fn();
    const force = vi.fn();
    const app = new ChatApplication({
      term: { write: (data: string) => writes.push(data) },
      tui: { start: vi.fn(), stop: vi.fn() },
      renderOwner,
      animations,
      overlays,
      inputRouter: () => input,
      render: vi.fn(),
      renderForced: force,
      attachInput: vi.fn(),
      showPanel: vi.fn(),
      reshowPanel: vi.fn(),
      reloadKeymap: vi.fn(),
      cleanup,
    });
    app.terminalLifecycle.start();
    expect(force).toHaveBeenCalledWith('lifecycle:start');
    app.terminalLifecycle.stop();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(animations.stop).toHaveBeenCalled();
    expect(overlays.stop).toHaveBeenCalled();
    expect(input.stop).toHaveBeenCalled();
    expect(renderOwner.stop).toHaveBeenCalled();
    expect(writes.length).toBeGreaterThan(0);
  });
});
