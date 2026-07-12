import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { Component, OverlayHandle, OverlayOptions, TUI } from '@earendil-works/pi-tui';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { AnimationController } from '../../../src/cli/chat/animationController.js';
import { InputRouter } from '../../../src/cli/chat/inputRouter.js';
import type { ChatInputContext } from '../../../src/cli/chat/inputRouter.js';
import { OverlayController } from '../../../src/cli/chat/overlayController.js';
import { RenderShell } from '../../../src/cli/chat/renderShell.js';
import { createChatComposition } from '../../../src/cli/chat/chatComposition.js';
import type { ChatComposition, ShellInputDeps } from '../../../src/cli/chat/chatComposition.js';
import { openPicker } from '../../../src/cli/chat/picker.js';
import type { TuiDiagnostics } from '../../../src/cli/chat/tuiDiagnostics.js';
import { startScreenBox, startScreenInputTop, TOP_RULE_ROWS } from '../../../src/cli/chat/startScreen.js';
import { TerminalLifecycle } from '../../../src/cli/chat/terminalLifecycle.js';
import { terminalPlainText } from '../../../src/cli/ui/text.js';
import { compositionHarness } from './chatCompositionHarness.js';

type Harness = ReturnType<typeof compositionHarness>;
const noopInput: ShellInputDeps = {
  cycleThinkingLevel: () => {},
  openHelpModal: () => {},
  openThemePicker: () => {},
  openModelPicker: () => {},
  openSessionsModal: () => {},
};

/** Composition fixture only: terminal lifecycle and stream teardown remain covered by their own owners. */
const makeComposition = (h: Harness): ChatComposition => {
  const composition = createChatComposition(
    h.rt, h.resources, { quit: vi.fn() }, h.stream, h.mdTheme, h.diagnostics,
  );
  composition.attachInput(noopInput);
  return composition;
};

function nativeOverlayHandle(hide = vi.fn()): OverlayHandle {
  let hidden = false;
  let focused = false;
  return {
    hide,
    setHidden: (next) => { hidden = next; },
    isHidden: () => hidden,
    focus: () => { focused = true; },
    unfocus: () => { focused = false; },
    isFocused: () => focused,
  };
}

describe('chat application shell ownership', () => {
  beforeAll(() => initTheme());
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
      return nativeOverlayHandle(hide);
    });
    const force = vi.fn();
    const tui = { showOverlay: nativeShow } as unknown as TUI;
    const overlays = new OverlayController(tui, force);
    overlays.resume();
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

  it('OverlayController defers native overlay state until the alternate-screen lifecycle is active', () => {
    const first = nativeOverlayHandle();
    const second = nativeOverlayHandle();
    const nativeShow = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const force = vi.fn();
    const tui = { showOverlay: nativeShow } as unknown as TUI;
    const overlays = new OverlayController(tui, force);

    const handle = overlays.show('picker', {
      invalidate: () => {}, render: () => ['picker'],
    }, { anchor: 'center' });
    handle.focus();
    expect(nativeShow).not.toHaveBeenCalled();
    expect(force).not.toHaveBeenCalled();

    overlays.resume();
    expect(nativeShow).toHaveBeenCalledOnce();
    expect(first.isFocused()).toBe(true);

    overlays.pause();
    handle.hide();
    const late = overlays.show('plan', {
      invalidate: () => {}, render: () => ['plan'],
    }, { anchor: 'center' });
    late.focus();
    expect(nativeShow).toHaveBeenCalledOnce();
    overlays.resume();
    expect(nativeShow).toHaveBeenCalledTimes(2);
    expect(second.isFocused()).toBe(true);
    overlays.stop();
  });

  it('OverlayController keeps the intercepted TUI boundary inert after permanent stop', () => {
    const native = nativeOverlayHandle();
    const nativeShow = vi.fn(() => native);
    const force = vi.fn();
    const tui = { showOverlay: nativeShow } as unknown as TUI;
    const overlays = new OverlayController(tui, force);
    overlays.resume();
    overlays.stop();
    nativeShow.mockClear();
    force.mockClear();

    const delayed = tui.showOverlay({ invalidate: () => {}, render: () => ['late'] });
    delayed.focus();
    delayed.unfocus();
    delayed.setHidden(true);
    delayed.hide();

    expect(nativeShow).not.toHaveBeenCalled();
    expect(force).not.toHaveBeenCalled();
    expect(delayed.isHidden()).toBe(true);
    expect(delayed.isFocused()).toBe(false);
  });

  it('OverlayController gives suggestions all small-screen space above the protected composer', () => {
    let options: { maxHeight?: number; margin?: unknown } | undefined;
    const tui = {
      showOverlay: vi.fn((_component: Component, next) => {
        options = next;
        return nativeOverlayHandle();
      }),
    } as unknown as TUI;
    const setMaxRows = vi.fn();
    const overlay = { invalidate: () => {}, render: () => [], setMaxRows };
    const controller = new OverlayController(tui, vi.fn());
    controller.resume();
    controller.showSuggestion('slash', overlay, () => ({
      columns: 40, rows: 12, hasMessages: true, panelReserve: 0,
      input: { invalidate: () => {}, render: () => [] }, notice: '',
      budget: {
        compactFallback: false, terminalColumns: 40, terminalRows: 12, chatColumns: 40,
        telemetryColumns: 0, telemetryGutter: 0, rootRows: 12,
        sections: { header: 1, transcript: 5, cards: 0, subagents: 0, queue: 0, attachments: 0, editor: 3, status: 1, hints: 1 },
      },
    }));
    expect(setMaxRows).toHaveBeenCalledWith(6);
    expect(options?.maxHeight).toBe(6);
    controller.stop();
  });

  it('OverlayController tracks intercepted generic overlays and closes them on stop', () => {
    const hide = vi.fn();
    const tui = {
      terminal: { columns: 80, rows: 24 },
      showOverlay: vi.fn(() => nativeOverlayHandle(hide)),
    } as unknown as TUI;
    const controller = new OverlayController(tui, vi.fn());
    controller.resume();
    tui.showOverlay({ invalidate: () => {}, render: () => ['generic'] }, { anchor: 'center', width: 60 });
    controller.stop();
    expect(hide).toHaveBeenCalledOnce();
  });

  it('OverlayController reopens every active overlay with geometry constrained to the resized terminal', () => {
    const terminal = { columns: 80, rows: 24 };
    const native: { options?: OverlayOptions; handle: OverlayHandle }[] = [];
    const tui = {
      terminal,
      showOverlay: vi.fn((_component: Component, options?: OverlayOptions) => {
        const record = { options, handle: nativeOverlayHandle() };
        native.push(record);
        return record.handle;
      }),
    } as unknown as TUI;
    const controller = new OverlayController(tui, vi.fn());
    controller.resume();
    const stable = tui.showOverlay({ invalidate: () => {}, render: () => ['generic'] }, {
      anchor: 'center', width: 70, maxHeight: 20, margin: 2,
    });
    terminal.columns = 30;
    terminal.rows = 9;
    controller.reflow();

    expect(native).toHaveLength(2);
    expect(native[0]!.handle.isFocused()).toBe(false);
    expect(native[1]!.options?.width).toBeLessThanOrEqual(30);
    expect(native[1]!.options?.maxHeight).toBeLessThanOrEqual(9);
    stable.hide();
    expect(native[1]!.handle.isFocused()).toBe(false);
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
    render.beginRender();
    expect(prepare).toHaveBeenCalledOnce();
    expect(nativeRequest).toHaveBeenCalledOnce();
    expect(render.takeFrame()?.reasons).toEqual(new Set(['stream:text', 'state:queue']));

    render.scheduleForcedRender('resize');
    await vi.runOnlyPendingTimersAsync();
    expect(nativeRequest).toHaveBeenLastCalledWith(true);
    render.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('RenderShell delegates the physical 60fps clock to PI and prepares at most once for its pending frame', async () => {
    const nativeRequest = vi.fn();
    let state = 'old';
    const preparedState: string[] = [];
    const prepare = vi.fn(() => preparedState.push(state));
    const onFlush = vi.fn();
    const tui = { requestRender: nativeRequest } as unknown as TUI;
    const render = new RenderShell({ tui, term: { columns: 80, rows: 24 }, prepare, onFlush });

    render.scheduleRender('stream:tool');
    await vi.advanceTimersByTimeAsync(0);
    expect(prepare).not.toHaveBeenCalled();
    expect(nativeRequest).toHaveBeenCalledOnce();

    // PI has accepted the request but has not called the root yet. Later SSE events must join that same
    // physical frame, whose one preparation pass reads the newest mutable state (not the stale first one).
    state = 'new';
    render.scheduleRender('stream:tool-output');
    expect(vi.getTimerCount()).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
    render.beginRender();
    expect(prepare).toHaveBeenCalledOnce();
    expect(preparedState).toEqual(['new']);
    expect(nativeRequest).toHaveBeenCalledOnce();
    expect(render.takeFrame()?.reasons).toEqual(new Set(['stream:tool', 'stream:tool-output']));
    expect(onFlush).toHaveBeenLastCalledWith({
      reasons: ['stream:tool', 'stream:tool-output'], forced: false,
    });
    render.stop();
  });

  it('RenderShell upgrades one pending frame to forced exactly once without losing its earliest reasons', async () => {
    const nativeRequest = vi.fn();
    const tui = { requestRender: nativeRequest } as unknown as TUI;
    const render = new RenderShell({ tui, term: { columns: 80, rows: 24 }, prepare: vi.fn() });
    render.scheduleRender('stream:text');
    await vi.advanceTimersByTimeAsync(0);
    render.scheduleForcedRender('resize');
    render.scheduleForcedRender('overlay:reflow');
    expect(nativeRequest.mock.calls).toEqual([[false], [true]]);
    render.beginRender();
    expect(render.takeFrame()).toMatchObject({
      reasons: new Set(['stream:text', 'resize', 'overlay:reflow']), forced: true,
    });
    render.stop();
  });

  it('RenderShell upgrades an ordinary pending frame when geometry changes before PI renders it', async () => {
    const nativeRequest = vi.fn();
    const term = { columns: 80, rows: 24 };
    const tui = { requestRender: nativeRequest } as unknown as TUI;
    const render = new RenderShell({ tui, term, prepare: vi.fn() });
    render.scheduleForcedRender('initial');
    await vi.advanceTimersByTimeAsync(0);
    render.beginRender();
    render.takeFrame();
    nativeRequest.mockClear();

    render.scheduleRender('stream:text');
    await vi.advanceTimersByTimeAsync(0);
    term.columns = 40;
    term.rows = 15;
    render.scheduleRender('pi-tui:request');
    expect(nativeRequest.mock.calls).toEqual([[false], [true]]);
    render.beginRender();
    expect(render.takeFrame()).toMatchObject({
      reasons: new Set(['stream:text', 'pi-tui:request', 'resize']), forced: true,
    });
    render.stop();
  });

  it('RenderShell drops a canceled pending request across terminal suspend and issues a fresh forced resume', async () => {
    const nativeRequest = vi.fn();
    const tui = { requestRender: nativeRequest } as unknown as TUI;
    const render = new RenderShell({ tui, term: { columns: 80, rows: 24 }, prepare: vi.fn() });
    render.scheduleForcedRender('lifecycle:start');
    await vi.advanceTimersByTimeAsync(0);
    expect(nativeRequest.mock.calls).toEqual([[true]]);

    // TerminalLifecycle calls pause before TUI.stop; that stop cancels PI's native pending request.
    render.pause();
    render.resume();
    render.scheduleForcedRender('lifecycle:resume');
    await vi.advanceTimersByTimeAsync(0);
    expect(nativeRequest.mock.calls).toEqual([[true], [true]]);
    render.beginRender();
    expect(render.takeFrame()?.reasons).toEqual(new Set(['lifecycle:resume']));
    render.stop();
  });

  it('RenderShell turns a forced request raised during ordinary preparation into a real forced follow-up', async () => {
    const nativeRequest = vi.fn();
    let tui!: TUI;
    tui = { requestRender: nativeRequest } as unknown as TUI;
    const render = new RenderShell({
      tui, term: { columns: 80, rows: 24 }, prepare: () => tui.requestRender(true),
    });
    render.scheduleRender('stream:text');
    await vi.advanceTimersByTimeAsync(0);
    expect(nativeRequest.mock.calls).toEqual([[false]]);
    render.beginRender();
    const ordinary = render.takeFrame();
    expect(ordinary).toMatchObject({ forced: false });
    expect(ordinary?.reasons).toContain('pi-tui:forced-request-during-frame');
    expect(nativeRequest.mock.calls).toEqual([[false]]);

    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    expect(nativeRequest.mock.calls).toEqual([[false], [true]]);
    render.beginRender();
    expect(render.takeFrame()).toMatchObject({ forced: true });
    render.stop();
  });

  it('RenderShell schedules a real forced follow-up when resize first becomes visible inside beginRender', async () => {
    const nativeRequest = vi.fn();
    const term = { columns: 80, rows: 24 };
    const tui = { requestRender: nativeRequest } as unknown as TUI;
    const render = new RenderShell({ tui, term, prepare: vi.fn() });
    render.scheduleForcedRender('initial');
    await vi.advanceTimersByTimeAsync(0);
    render.beginRender();
    render.takeFrame();
    nativeRequest.mockClear();

    render.scheduleRender('stream:text');
    await vi.advanceTimersByTimeAsync(0);
    expect(nativeRequest.mock.calls).toEqual([[false]]);
    term.columns = 40;
    term.rows = 15;
    render.beginRender();
    const ordinaryResize = render.takeFrame();
    expect(ordinaryResize).toMatchObject({ forced: false });
    expect(ordinaryResize?.reasons).toContain('resize');

    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    expect(nativeRequest.mock.calls).toEqual([[false], [true]]);
    render.beginRender();
    expect(render.takeFrame()).toMatchObject({ forced: true });
    render.stop();
  });

  it('RenderShell reports a real dimension transition once before preparing the resized frame', async () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const term = { columns: 80, rows: 24 };
    const onResize = vi.fn();
    const render = new RenderShell({ tui, term, prepare: vi.fn(), onResize });
    render.scheduleForcedRender('initial');
    await vi.runOnlyPendingTimersAsync();
    render.beginRender();
    render.takeFrame();
    term.columns = 44;
    term.rows = 13;
    render.scheduleRender('pi-tui:resize');
    await vi.runOnlyPendingTimersAsync();
    render.beginRender();
    expect(onResize).toHaveBeenCalledOnce();
    expect(onResize).toHaveBeenCalledWith({ columns: 44, rows: 13 });
    render.stop();
  });

  it('RenderShell absorbs PI component requests raised during preparation into the current frame', async () => {
    const nativeRequest = vi.fn();
    const tui = { requestRender: nativeRequest } as unknown as TUI;
    const render = new RenderShell({
      tui,
      term: { columns: 80, rows: 24 },
      prepare: () => tui.requestRender(),
    });
    render.scheduleForcedRender('test:prepare');
    await vi.runOnlyPendingTimersAsync();
    render.beginRender();
    expect(nativeRequest).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(render.takeFrame()?.reasons).toContain('pi-tui:request-during-frame');
    render.stop();
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

  it('folds embedded newlines at the final root physical-row boundary', () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const render = new RenderShell({ tui, term: { columns: 40, rows: 2 }, prepare: vi.fn() });
    const frame = render.composeRoot(['root row\r\nforged physical row'], 40, 2);

    expect(frame).toHaveLength(2);
    expect(frame.every((line) => !/[\r\n]/.test(line))).toBe(true);
    expect(terminalPlainText(frame[0]!).trim()).toBe('root row forged physical row');
    expect(terminalPlainText(frame[1]!).trim()).toBe('');
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
      state: { childView: null },
      term: { columns: 120 },
      editor: { focused: true },
      stream: {},
      quit: vi.fn(), renderForced: vi.fn(),
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

  it('requests every wheel, page and scrollbar-drag frame before synchronous viewport work', async () => {
    let listener!: (data: string) => { consume: boolean } | undefined;
    const tui = { addInputListener: vi.fn((next) => { listener = next; return vi.fn(); }) } as unknown as TUI;
    const calls: string[] = [];
    const viewport = {
      isScrollbarHit: vi.fn(() => true),
      beginScrollbarDrag: vi.fn(() => { calls.push('work:drag-start'); return false; }),
      updateScrollbarDrag: vi.fn(() => { calls.push('work:drag'); return true; }),
      continueScrollbarDrag: vi.fn(() => { calls.push('work:drag-index'); return false; }),
      endScrollbarDrag: vi.fn(),
      scroll: vi.fn((delta: number) => { calls.push(`work:scroll:${delta}`); }),
    };
    const context = {
      state: { childView: null },
      term: { columns: 120, write: vi.fn() },
      editor: { focused: true, getText: () => '' },
      stream: {},
      quit: vi.fn(), renderForced: vi.fn(),
      keymap: () => ({ matches: () => false, isLeader: () => false, directAction: () => null }),
      leader: () => ({ pending: () => false }),
      dispatchAction: vi.fn(),
      render: vi.fn((reason: string) => { calls.push(`request:${reason}`); }),
      animations: { nudgeMascot: vi.fn() },
      hasMessages: () => true,
      activeViewport: () => viewport,
      panelVisible: () => false,
      panelLeftEdge: () => 80,
      slashOverlay: () => null,
      mentionOverlay: () => null,
    } as unknown as ChatInputContext;
    const router = new InputRouter(tui, context);
    router.attach();

    const expectBefore = (input: string, request: string, work: string): void => {
      calls.length = 0;
      expect(listener(input)).toEqual({ consume: true });
      expect(calls.indexOf(request)).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf(request)).toBeLessThan(calls.indexOf(work));
    };
    expectBefore('\x1b[<64;10;10M', 'request:scroll:wheel', 'work:scroll:3');
    expectBefore('\x1b[5~', 'request:scroll:page-up', 'work:scroll:4');
    expectBefore('\x1b[6~', 'request:scroll:page-down', 'work:scroll:-4');
    expectBefore('\x1b[<0;79;5M', 'request:scroll:drag-start', 'work:drag-start');
    expectBefore('\x1b[<32;79;8M', 'request:scroll:drag', 'work:drag');

    calls.length = 0;
    await vi.advanceTimersByTimeAsync(16);
    expect(calls.indexOf('request:scroll:drag-index')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('request:scroll:drag-index')).toBeLessThan(calls.indexOf('work:drag-index'));
    listener('\x1b[<0;79;8m');
    router.stop();
  });

  it('chat composition mounts paused and TerminalLifecycle alone enters the renderable alternate screen', async () => {
    const h = compositionHarness({ turns: 4 });
    const composition = makeComposition(h);
    const lifecycle = new TerminalLifecycle({
      term: h.resources.term,
      tui: h.resources.tui,
      scheduler: {
        pause: () => composition.pause(),
        resume: () => composition.resume(),
        stop: () => composition.stop(),
      },
      forceRender: (reason) => composition.renderForced(reason),
      beforeStop: () => composition.dispose(),
    });
    expect(h.tui.children).toHaveLength(1);
    expect(h.tui.overlays).toHaveLength(0);
    expect(h.term.writes).toEqual([]);
    expect(h.tui.renderRequests).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    lifecycle.start();
    expect(h.tui.starts).toBe(1);
    expect(h.term.writes[0]).toBe('\x1b[?1049h');
    expect(h.tui.overlays).toHaveLength(1);
    await vi.runOnlyPendingTimersAsync();
    expect(h.tui.renderRequests).toEqual([true]);
    lifecycle.stop();
    expect(h.tui.stops).toBe(1);
  });

  it('defers a picker opened while suspended and activates it only after alternate-screen resume', () => {
    const h = compositionHarness({ turns: 4 });
    const composition = makeComposition(h);
    const lifecycle = new TerminalLifecycle({
      term: h.resources.term,
      tui: h.resources.tui,
      scheduler: {
        pause: () => composition.pause(),
        resume: () => composition.resume(),
        stop: () => composition.stop(),
      },
      forceRender: (reason) => composition.renderForced(reason),
      beforeStop: () => composition.dispose(),
    });
    lifecycle.start();
    lifecycle.suspend();
    const nativeCount = h.tui.overlays.length;
    const writes = [...h.term.writes];
    const renders = [...h.tui.renderRequests];

    openPicker({
      tui: h.resources.tui,
      editor: h.resources.editor,
      title: 'Late plan picker',
      items: [{ value: 'plan', label: 'Plan' }],
      onPick: () => {},
    });
    expect(h.tui.overlays).toHaveLength(nativeCount);
    expect(h.term.writes).toEqual(writes);
    expect(h.tui.renderRequests).toEqual(renders);

    lifecycle.resume();
    expect(h.tui.overlays).toHaveLength(nativeCount + 2); // telemetry + suspended picker reopen
    lifecycle.stop();
  });

  it('keeps delayed picker work inert after quit without native overlay, focus or render effects', () => {
    const h = compositionHarness({ turns: 4 });
    const composition = makeComposition(h);
    const lifecycle = new TerminalLifecycle({
      term: h.resources.term,
      tui: h.resources.tui,
      scheduler: {
        pause: () => composition.pause(),
        resume: () => composition.resume(),
        stop: () => composition.stop(),
      },
      forceRender: (reason) => composition.renderForced(reason),
      beforeStop: () => composition.dispose(),
    });
    lifecycle.start();
    lifecycle.stop();
    const nativeCount = h.tui.overlays.length;
    const writes = [...h.term.writes];
    const renders = [...h.tui.renderRequests];
    const focused = h.tui.focused;

    openPicker({
      tui: h.resources.tui,
      editor: h.resources.editor,
      title: 'Delayed picker',
      items: [{ value: 'late', label: 'Late' }],
      onPick: () => {},
    });

    expect(h.tui.overlays).toHaveLength(nativeCount);
    expect(h.term.writes).toEqual(writes);
    expect(h.tui.renderRequests).toEqual(renders);
    expect(h.tui.focused).toBe(focused);
  });

  it('real composition mounts one bounded root with exactly one footer and one input listener', async () => {
    const h = compositionHarness({ columns: 80, rows: 24, turns: 40 });
    const composition = makeComposition(h);
    composition.resume();
    composition.renderForced('test:initial');
    await vi.runOnlyPendingTimersAsync();

    expect(h.tui.children).toHaveLength(1);
    expect(h.tui.listeners.size).toBe(1);
    const frame = composition.root.render(h.term.columns);
    expect(frame).toHaveLength(h.term.rows);
    expect(frame.every((line) => visibleWidth(line) === h.term.columns)).toBe(true);
    const plain = frame.map(terminalPlainText);
    expect(plain.filter((line) => line.includes('Build')).length).toBe(1);
    composition.dispose();
    composition.stop();
    expect(h.tui.listeners.size).toBe(0);
    expect(h.tui.children).toHaveLength(1);
  });

  it('defers process-only invalidation while telemetry is invisible and shows the stored snapshot after grow', async () => {
    const h = compositionHarness({ columns: 96, rows: 24, turns: 40 });
    const composition = makeComposition(h);
    composition.renderShell.resume();
    composition.renderForced('test:initial');
    await vi.runOnlyPendingTimersAsync();
    composition.root.render(h.term.columns);
    const requestsBeforeMetadata = h.tui.renderRequests.length;

    h.rt.processes = [{
      id: 'background-e2e', command: 'node hidden-process.js', cwd: '/tmp',
      startedAt: new Date().toISOString(), running: true, exitCode: null,
    }];
    composition.render('metadata:processes');
    await vi.runOnlyPendingTimersAsync();
    expect(h.tui.renderRequests).toHaveLength(requestsBeforeMetadata);

    h.term.columns = 120;
    composition.renderForced('test:grow');
    await vi.runOnlyPendingTimersAsync();
    composition.root.render(h.term.columns);
    const telemetry = h.tui.overlays.find((overlay) => !overlay.removed
      && overlay.options?.anchor === 'top-right');
    expect(telemetry?.component.render(46).map(terminalPlainText).join('\n')).toContain('hidden-process.js');

    const requestsBeforeVisibleMetadata = h.tui.renderRequests.length;
    composition.render('stream:process');
    await vi.runOnlyPendingTimersAsync();
    expect(h.tui.renderRequests).toHaveLength(requestsBeforeVisibleMetadata + 1);
    composition.dispose();
    composition.renderShell.stop();
  });

  it('records content-free frame geometry and bounded viewport work for machine analysis', () => {
    const h = compositionHarness({ columns: 80, rows: 24, turns: 40 });
    const events: Record<string, unknown>[] = [];
    const diagnostics: TuiDiagnostics = {
      enabled: true,
      path: '/tmp/unused-test-diagnostics.jsonl',
      record: (event) => events.push(event as unknown as Record<string, unknown>),
      close: async () => {},
    };
    const composition = createChatComposition(
      h.rt, h.resources, { quit: vi.fn() }, h.stream, h.mdTheme, diagnostics,
    );
    composition.attachInput(noopInput);
    const rendered = composition.root.render(h.term.columns);
    const frame = events.find((event) => event.type === 'frame');

    expect(frame).toMatchObject({
      queueMs: expect.any(Number),
      rootRenderMs: expect.any(Number),
      maxVisibleWidth: Math.max(...rendered.map(visibleWidth)),
      reconciledTurns: expect.any(Number),
      layoutVisits: expect.any(Number),
      scrollOffset: expect.any(Number),
      maxScrollOffset: expect.any(Number),
      heightIndexOperations: expect.any(Number),
      rootRows: h.term.rows,
    });
    expect(Object.values(frame?.sections as Record<string, number>)
      .reduce((sum, value) => sum + value, 0)).toBe(frame?.rootRows);
    expect(JSON.stringify(frame)).not.toContain('question 0');
    expect(JSON.stringify(frame)).not.toContain('answer 0');
    composition.dispose();
    composition.stop();
  });

  it('reports a section total equal to the constrained root on the start screen too', () => {
    const h = compositionHarness({ columns: 40, rows: 15, turns: 0 });
    const events: Record<string, unknown>[] = [];
    const diagnostics: TuiDiagnostics = {
      enabled: true,
      path: '/tmp/unused-start-diagnostics.jsonl',
      record: (event) => events.push(event as unknown as Record<string, unknown>),
      close: async () => {},
    };
    const composition = createChatComposition(
      h.rt, h.resources, { quit: vi.fn() }, h.stream, h.mdTheme, diagnostics,
    );
    composition.attachInput(noopInput);
    composition.root.render(h.term.columns);
    const frame = events.find((event) => event.type === 'frame');
    expect(Object.values(frame?.sections as Record<string, number>)
      .reduce((sum, value) => sum + value, 0)).toBe(frame?.rootRows);
    composition.dispose();
    composition.stop();
  });

  it('records zero transcript work when a normal chat frame shrinks into compact fallback', async () => {
    const h = compositionHarness({ columns: 80, rows: 24, turns: 80 });
    const events: Record<string, unknown>[] = [];
    const diagnostics: TuiDiagnostics = {
      enabled: true,
      path: '/tmp/unused-compact-diagnostics.jsonl',
      record: (event) => events.push(event as unknown as Record<string, unknown>),
      close: async () => {},
    };
    const composition = createChatComposition(
      h.rt, h.resources, { quit: vi.fn() }, h.stream, h.mdTheme, diagnostics,
    );
    composition.attachInput(noopInput);
    composition.resume();
    composition.renderForced('test:normal');
    await vi.runOnlyPendingTimersAsync();
    composition.root.render(h.term.columns);

    h.term.columns = 20;
    h.term.rows = 10;
    composition.renderForced('test:compact');
    await vi.runOnlyPendingTimersAsync();
    composition.root.render(h.term.columns);

    const frames = events.filter((event) => event.type === 'frame');
    expect(frames.at(-2)?.renderedTurns).toBeGreaterThan(0);
    expect(frames.at(-1)).toMatchObject({
      transcriptMs: 0,
      transcriptRows: 0,
      visibleRows: 0,
      renderedTurns: 0,
      reconciledTurns: 0,
      indexedTurns: 0,
      cachedRows: 0,
      layoutVisits: 0,
      scrollOffset: 0,
      maxScrollOffset: 0,
      heightIndexOperations: 0,
      terminal: { columns: 20, rows: 10 },
      rootRows: 10,
      maxVisibleWidth: 20,
    });
    composition.dispose();
    composition.stop();
  });

  it('resets a prior chat allocation before rendering the same editor on the roomy start screen', async () => {
    const h = compositionHarness({ columns: 80, rows: 24, turns: 0 });
    h.resources.editor.setMaxRows(3);
    h.resources.editor.setText(Array.from({ length: 6 }, (_, index) => `session-draft-${index + 1}`).join('\n'));
    const composition = makeComposition(h);
    composition.resume();
    composition.renderForced('test:start-screen');
    await vi.runOnlyPendingTimersAsync();
    const frame = composition.root.render(h.term.columns).map(terminalPlainText).join('\n');
    expect(frame).toContain('session-draft-1');
    expect(frame).toContain('session-draft-6');
    composition.dispose();
    composition.stop();
  });

  it('real composition routes a mouse drag through the rendered transcript scrollbar', async () => {
    const h = compositionHarness({ columns: 80, rows: 24, turns: 80 });
    const composition = makeComposition(h);
    composition.resume();
    composition.renderForced('test:initial');
    await vi.runOnlyPendingTimersAsync();
    const frame = composition.root.render(h.term.columns).map(terminalPlainText);
    const thumbRow = frame.findIndex((line) => line.includes('█'));
    expect(thumbRow).toBeGreaterThan(0);
    const x = frame[thumbRow]!.lastIndexOf('█') + 1;
    const y = thumbRow + 1;
    expect(h.tui.emit(`\x1b[<0;${x};${y}M`)?.consume).toBe(true);
    expect(h.tui.emit(`\x1b[<32;${x};${Math.max(2, y - 5)}M`)?.consume).toBe(true);
    expect(h.tui.emit(`\x1b[<0;${x};${Math.max(2, y - 5)}m`)?.consume).toBe(true);
    await vi.runOnlyPendingTimersAsync();
    expect(composition.root.render(h.term.columns).map(terminalPlainText).join('\n')).toContain('History');
    composition.dispose();
    composition.stop();
  });

  it('real composition reflows generic and named overlays on resize and disposal hides every handle', async () => {
    const h = compositionHarness({ columns: 120, rows: 30, turns: 8 });
    const composition = makeComposition(h);
    composition.resume();
    composition.renderForced('test:initial');
    await vi.runOnlyPendingTimersAsync();
    composition.root.render(h.term.columns);
    h.resources.tui.showOverlay({ invalidate: () => {}, render: () => ['generic modal'] }, {
      anchor: 'center', width: 90, maxHeight: 24, margin: 2,
    });
    await vi.runOnlyPendingTimersAsync();
    const beforeResize = [...h.tui.overlays];
    h.term.columns = 42;
    h.term.rows = 12;
    composition.renderForced('test:resize');
    await vi.runOnlyPendingTimersAsync();
    composition.root.render(h.term.columns);

    expect(h.tui.overlays.length).toBeGreaterThan(beforeResize.length);
    expect(beforeResize.every((overlay) => overlay.removed)).toBe(true);
    const current = h.tui.overlays.filter((overlay) => !overlay.removed);
    expect(current.length).toBeGreaterThanOrEqual(2);
    expect(current.every((overlay) => typeof overlay.options?.width !== 'number' || overlay.options.width <= 42)).toBe(true);
    composition.dispose();
    composition.stop();
    expect(h.tui.overlays.every((overlay) => overlay.removed)).toBe(true);
  });

  it.each([
    ['slash', '/'],
    ['mention', '@'],
  ] as const)('reflows the active %s suggestion overlay from live geometry', async (_name, input) => {
    const h = compositionHarness({ columns: 120, rows: 30, turns: 8 });
    const composition = makeComposition(h);
    composition.resume();
    composition.renderForced('test:initial');
    await vi.runOnlyPendingTimersAsync();
    composition.root.render(h.term.columns);
    h.tui.emit(input);
    await vi.runOnlyPendingTimersAsync();
    const before = h.tui.overlays.filter((overlay) => !overlay.removed);
    const suggestion = before.find((overlay) => overlay.options?.anchor === 'bottom-left');
    expect(suggestion).toBeDefined();

    h.term.columns = 50;
    h.term.rows = 14;
    composition.renderForced('test:resize');
    await vi.runOnlyPendingTimersAsync();
    composition.root.render(h.term.columns);
    expect(before.every((overlay) => overlay.removed)).toBe(true);
    const reflowed = h.tui.overlays.filter((overlay) => !overlay.removed)
      .find((overlay) => overlay.options?.anchor === 'bottom-left');
    expect(reflowed).toBeDefined();
    expect(reflowed?.options?.width).toBeLessThanOrEqual(50);
    expect(reflowed?.options?.maxHeight).toBeLessThanOrEqual(14);
    composition.dispose();
    composition.stop();
  });

  it('reflows an active suggestion from the prepared editor, queue, attachment, and panel budget exactly once', async () => {
    const h = compositionHarness({ columns: 120, rows: 30, turns: 8 });
    const composition = makeComposition(h);
    composition.resume();
    composition.renderForced('test:initial');
    await vi.runOnlyPendingTimersAsync();
    composition.root.render(h.term.columns);
    h.tui.emit('/');
    await vi.runOnlyPendingTimersAsync();
    composition.root.render(h.term.columns);

    const initial = h.tui.overlays.filter((overlay) => !overlay.removed)
      .find((overlay) => overlay.options?.anchor === 'bottom-left');
    expect(initial).toBeDefined();
    expect(typeof initial?.options?.margin).toBe('object');
    expect((initial?.options?.margin as { bottom?: number }).bottom).toBe(5);

    h.resources.editor.setText(`/${'x'.repeat(420)}`);
    h.rt.queued = [
      { id: 'queued-1', text: 'first' },
      { id: 'queued-2', text: 'second' },
      { id: 'queued-3', text: 'third' },
    ];
    h.resources.attachmentChips.set([{ name: 'layout.png', bytes: 1024 }]);
    // Resize the visible telemetry rail through the real mouse router. The old implementation reflowed
    // here, before prepareFrame/root allocation had made the new bottom stack authoritative.
    expect(h.tui.emit('\x1b[<0;74;5M')?.consume).toBe(true);
    expect(h.tui.emit('\x1b[<32;60;5M')?.consume).toBe(true);
    await vi.runOnlyPendingTimersAsync();
    composition.root.render(h.term.columns);

    const reflowed = h.tui.overlays.filter((overlay) => !overlay.removed)
      .find((overlay) => overlay.options?.anchor === 'bottom-left');
    expect(reflowed).toBeDefined();
    expect(reflowed).not.toBe(initial);
    expect(reflowed?.options?.width).toBe(55);
    expect(reflowed?.options?.maxHeight).toBe(14);
    expect((reflowed?.options?.margin as { bottom?: number }).bottom).toBe(15);

    const suggestionRecords = h.tui.overlays.filter((overlay) => overlay.options?.anchor === 'bottom-left').length;
    await vi.runOnlyPendingTimersAsync();
    composition.root.render(h.term.columns);
    expect(h.tui.overlays.filter((overlay) => overlay.options?.anchor === 'bottom-left')).toHaveLength(suggestionRecords);
    expect(vi.getTimerCount()).toBe(0);
    composition.dispose();
    composition.stop();
  });

  it('reflows a start-screen suggestion only after a grow-resize allocates the editor', async () => {
    const h = compositionHarness({ columns: 60, rows: 8, turns: 0 });
    const composition = makeComposition(h);
    composition.resume();
    composition.renderForced('test:initial-small');
    await vi.runOnlyPendingTimersAsync();
    composition.root.render(h.term.columns);
    h.tui.emit('/');
    h.resources.editor.setText(`/${'y'.repeat(420)}`);
    await vi.runOnlyPendingTimersAsync();
    composition.root.render(h.term.columns);

    h.term.rows = 30;
    composition.renderForced('test:grow');
    await vi.runOnlyPendingTimersAsync();
    composition.root.render(h.term.columns);

    const active = h.tui.overlays.filter((overlay) => !overlay.removed)
      .find((overlay) => overlay.options?.anchor === 'top-left');
    const { boxWidth } = startScreenBox(h.term.columns);
    const screenRows = h.term.rows - TOP_RULE_ROWS;
    const inputRows = Math.min(h.resources.inputStack.render(boxWidth).length, screenRows - 1);
    const expectedTop = TOP_RULE_ROWS + startScreenInputTop(screenRows, inputRows, 0) + inputRows;
    expect(active).toBeDefined();
    expect((active?.options?.margin as { top?: number }).top).toBe(expectedTop);
    expect(active?.options?.maxHeight).toBe(Math.min(15, h.term.rows - expectedTop));
    composition.dispose();
    composition.stop();
  });

  it('cancels an armed leader and every scheduler/controller timer through rapid composition cycles', () => {
    for (let cycle = 0; cycle < 3; cycle++) {
      const h = compositionHarness({ turns: 2 });
      const composition = makeComposition(h);
      composition.resume();
      h.tui.emit('\x18'); // ctrl+x — arm the default two-second leader window
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      composition.dispose();
      composition.stop();
      expect(vi.getTimerCount()).toBe(0);
      expect(h.tui.listeners.size).toBe(0);
    }
  });
});
