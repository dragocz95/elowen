import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { Component, OverlayHandle, OverlayOptions, TUI } from '@earendil-works/pi-tui';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { AnimationController } from '../../../src/cli/chat/animationController.js';
import { InputRouter } from '../../../src/cli/chat/inputRouter.js';
import type { ChatInputContext } from '../../../src/cli/chat/inputRouter.js';
import { OverlayController } from '../../../src/cli/chat/overlayController.js';
import { RenderShell } from '../../../src/cli/chat/renderShell.js';
import { ChatApplication } from '../../../src/cli/chat/chatApplication.js';
import { createShell } from '../../../src/cli/chat/shell.js';
import { startScreenBox, startScreenInputTop, TOP_RULE_ROWS } from '../../../src/cli/chat/startScreen.js';
import { terminalPlainText } from '../../../src/cli/ui/text.js';
import { applicationHarness } from './chatApplicationHarness.js';

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
        return nativeOverlayHandle();
      }),
    } as unknown as TUI;
    const setMaxRows = vi.fn();
    const overlay = { invalidate: () => {}, render: () => [], setMaxRows };
    const controller = new OverlayController(tui, vi.fn());
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
    const stable = tui.showOverlay({ invalidate: () => {}, render: () => ['generic'] }, {
      anchor: 'center', width: 70, maxHeight: 20, margin: 2,
    });
    terminal.columns = 30;
    terminal.rows = 9;
    (controller as OverlayController & { reflow(): void }).reflow();

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
    expect(prepare).toHaveBeenCalledOnce();
    expect(nativeRequest).toHaveBeenCalledOnce();
    expect(render.takeFrame()?.reasons).toEqual(new Set(['stream:text', 'state:queue']));

    render.scheduleForcedRender('resize');
    await vi.runOnlyPendingTimersAsync();
    expect(nativeRequest).toHaveBeenLastCalledWith(true);
    render.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('RenderShell reports a real dimension transition once before preparing the resized frame', async () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const term = { columns: 80, rows: 24 };
    const onResize = vi.fn();
    const render = new RenderShell({ tui, term, prepare: vi.fn(), onResize });
    render.scheduleForcedRender('initial');
    await vi.runOnlyPendingTimersAsync();
    term.columns = 44;
    term.rows = 13;
    render.scheduleRender('pi-tui:resize');
    await vi.runOnlyPendingTimersAsync();
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

  it('ChatApplication itself constructs and mounts the production composition graph', () => {
    const h = applicationHarness({ turns: 4 });
    const app = new ChatApplication({ rt: h.rt, stream: h.stream, mdTheme: h.mdTheme, diagnostics: h.diagnostics });
    expect(h.tui.children).toHaveLength(1);
    expect(h.rt.terminalLifecycle).toBe(app.terminalLifecycle);
    app.terminalLifecycle.stop();
  });

  it('real createShell mounts one bounded root with exactly one footer and one input listener', async () => {
    const h = applicationHarness({ columns: 80, rows: 24, turns: 40 });
    const app = createShell(h.rt, h.stream, h.mdTheme, h.diagnostics);
    h.rt.render = app.render;
    h.rt.renderForced = app.renderForced;
    app.attachInput({
      cycleThinkingLevel: vi.fn(), openHelpModal: vi.fn(), openThemePicker: vi.fn(),
      openModelPicker: vi.fn(), openSessionsModal: vi.fn(),
    });
    app.renderForced('test:initial');
    await vi.runOnlyPendingTimersAsync();

    expect(h.tui.children).toHaveLength(1);
    expect(h.tui.listeners.size).toBe(1);
    const frame = h.tui.children[0]!.render(h.term.columns);
    expect(frame).toHaveLength(h.term.rows);
    expect(frame.every((line) => visibleWidth(line) === h.term.columns)).toBe(true);
    const plain = frame.map(terminalPlainText);
    expect(plain.filter((line) => line.includes('Build')).length).toBe(1);
    app.terminalLifecycle.start();
    app.terminalLifecycle.stop();
    expect(h.tui.listeners.size).toBe(0);
    expect(h.tui.children).toHaveLength(1);
  });

  it('resets a prior chat allocation before rendering the same editor on the roomy start screen', async () => {
    const h = applicationHarness({ columns: 80, rows: 24, turns: 0 });
    h.rt.editor.setMaxRows(3);
    h.rt.editor.setText(Array.from({ length: 6 }, (_, index) => `session-draft-${index + 1}`).join('\n'));
    const app = createShell(h.rt, h.stream, h.mdTheme, h.diagnostics);
    app.renderForced('test:start-screen');
    await vi.runOnlyPendingTimersAsync();
    const frame = h.tui.children[0]!.render(h.term.columns).map(terminalPlainText).join('\n');
    expect(frame).toContain('session-draft-1');
    expect(frame).toContain('session-draft-6');
    app.terminalLifecycle.stop();
  });

  it('real createShell routes a mouse drag through the rendered transcript scrollbar', async () => {
    const h = applicationHarness({ columns: 80, rows: 24, turns: 80 });
    const app = createShell(h.rt, h.stream, h.mdTheme, h.diagnostics);
    app.attachInput({
      cycleThinkingLevel: vi.fn(), openHelpModal: vi.fn(), openThemePicker: vi.fn(),
      openModelPicker: vi.fn(), openSessionsModal: vi.fn(),
    });
    app.renderForced('test:initial');
    await vi.runOnlyPendingTimersAsync();
    const frame = h.tui.children[0]!.render(h.term.columns).map(terminalPlainText);
    const thumbRow = frame.findIndex((line) => line.includes('█'));
    expect(thumbRow).toBeGreaterThan(0);
    const x = frame[thumbRow]!.lastIndexOf('█') + 1;
    const y = thumbRow + 1;
    expect(h.tui.emit(`\x1b[<0;${x};${y}M`)?.consume).toBe(true);
    expect(h.tui.emit(`\x1b[<32;${x};${Math.max(2, y - 5)}M`)?.consume).toBe(true);
    expect(h.tui.emit(`\x1b[<0;${x};${Math.max(2, y - 5)}m`)?.consume).toBe(true);
    await vi.runOnlyPendingTimersAsync();
    expect(h.tui.children[0]!.render(h.term.columns).map(terminalPlainText).join('\n')).toContain('History');
    app.terminalLifecycle.stop();
  });

  it('real createShell reflows generic and named overlays on resize and hides every native handle on stop', async () => {
    const h = applicationHarness({ columns: 120, rows: 30, turns: 8 });
    const app = createShell(h.rt, h.stream, h.mdTheme, h.diagnostics);
    app.renderForced('test:initial');
    await vi.runOnlyPendingTimersAsync();
    h.tui.children[0]!.render(h.term.columns);
    h.rt.tui.showOverlay({ invalidate: () => {}, render: () => ['generic modal'] }, {
      anchor: 'center', width: 90, maxHeight: 24, margin: 2,
    });
    await vi.runOnlyPendingTimersAsync();
    const beforeResize = [...h.tui.overlays];
    h.term.columns = 42;
    h.term.rows = 12;
    app.renderForced('test:resize');
    await vi.runOnlyPendingTimersAsync();
    h.tui.children[0]!.render(h.term.columns);

    expect(h.tui.overlays.length).toBeGreaterThan(beforeResize.length);
    expect(beforeResize.every((overlay) => overlay.removed)).toBe(true);
    const current = h.tui.overlays.filter((overlay) => !overlay.removed);
    expect(current.length).toBeGreaterThanOrEqual(2);
    expect(current.every((overlay) => typeof overlay.options?.width !== 'number' || overlay.options.width <= 42)).toBe(true);
    app.terminalLifecycle.stop();
    expect(h.tui.overlays.every((overlay) => overlay.removed)).toBe(true);
  });

  it.each([
    ['slash', '/'],
    ['mention', '@'],
  ] as const)('reflows the active %s suggestion overlay from live geometry', async (_name, input) => {
    const h = applicationHarness({ columns: 120, rows: 30, turns: 8 });
    const app = createShell(h.rt, h.stream, h.mdTheme, h.diagnostics);
    app.attachInput({
      cycleThinkingLevel: vi.fn(), openHelpModal: vi.fn(), openThemePicker: vi.fn(),
      openModelPicker: vi.fn(), openSessionsModal: vi.fn(),
    });
    app.renderForced('test:initial');
    await vi.runOnlyPendingTimersAsync();
    h.tui.children[0]!.render(h.term.columns);
    h.tui.emit(input);
    await vi.runOnlyPendingTimersAsync();
    const before = h.tui.overlays.filter((overlay) => !overlay.removed);
    const suggestion = before.find((overlay) => overlay.options?.anchor === 'bottom-left');
    expect(suggestion).toBeDefined();

    h.term.columns = 50;
    h.term.rows = 14;
    app.renderForced('test:resize');
    await vi.runOnlyPendingTimersAsync();
    h.tui.children[0]!.render(h.term.columns);
    expect(before.every((overlay) => overlay.removed)).toBe(true);
    const reflowed = h.tui.overlays.filter((overlay) => !overlay.removed)
      .find((overlay) => overlay.options?.anchor === 'bottom-left');
    expect(reflowed).toBeDefined();
    expect(reflowed?.options?.width).toBeLessThanOrEqual(50);
    expect(reflowed?.options?.maxHeight).toBeLessThanOrEqual(14);
    app.terminalLifecycle.stop();
  });

  it('reflows an active suggestion from the prepared editor, queue, attachment, and panel budget exactly once', async () => {
    const h = applicationHarness({ columns: 120, rows: 30, turns: 8 });
    const app = createShell(h.rt, h.stream, h.mdTheme, h.diagnostics);
    h.rt.render = app.render;
    h.rt.renderForced = app.renderForced;
    app.attachInput({
      cycleThinkingLevel: vi.fn(), openHelpModal: vi.fn(), openThemePicker: vi.fn(),
      openModelPicker: vi.fn(), openSessionsModal: vi.fn(),
    });
    app.renderForced('test:initial');
    await vi.runOnlyPendingTimersAsync();
    h.tui.children[0]!.render(h.term.columns);
    h.tui.emit('/');
    await vi.runOnlyPendingTimersAsync();
    h.tui.children[0]!.render(h.term.columns);

    const initial = h.tui.overlays.filter((overlay) => !overlay.removed)
      .find((overlay) => overlay.options?.anchor === 'bottom-left');
    expect(initial).toBeDefined();
    expect(typeof initial?.options?.margin).toBe('object');
    expect((initial?.options?.margin as { bottom?: number }).bottom).toBe(5);

    h.rt.editor.setText(`/${'x'.repeat(420)}`);
    h.rt.queued = [
      { id: 'queued-1', text: 'first' },
      { id: 'queued-2', text: 'second' },
      { id: 'queued-3', text: 'third' },
    ];
    h.rt.attachmentChips.set([{ name: 'layout.png', bytes: 1024 }]);
    // Resize the visible telemetry rail through the real mouse router. The old implementation reflowed
    // here, before prepareFrame/root allocation had made the new bottom stack authoritative.
    expect(h.tui.emit('\x1b[<0;74;5M')?.consume).toBe(true);
    expect(h.tui.emit('\x1b[<32;60;5M')?.consume).toBe(true);
    await vi.runOnlyPendingTimersAsync();
    h.tui.children[0]!.render(h.term.columns);

    const reflowed = h.tui.overlays.filter((overlay) => !overlay.removed)
      .find((overlay) => overlay.options?.anchor === 'bottom-left');
    expect(reflowed).toBeDefined();
    expect(reflowed).not.toBe(initial);
    expect(reflowed?.options?.width).toBe(55);
    expect(reflowed?.options?.maxHeight).toBe(14);
    expect((reflowed?.options?.margin as { bottom?: number }).bottom).toBe(15);

    const suggestionRecords = h.tui.overlays.filter((overlay) => overlay.options?.anchor === 'bottom-left').length;
    await vi.runOnlyPendingTimersAsync();
    h.tui.children[0]!.render(h.term.columns);
    expect(h.tui.overlays.filter((overlay) => overlay.options?.anchor === 'bottom-left')).toHaveLength(suggestionRecords);
    expect(vi.getTimerCount()).toBe(0);
    app.terminalLifecycle.stop();
  });

  it('reflows a start-screen suggestion only after a grow-resize allocates the editor', async () => {
    const h = applicationHarness({ columns: 60, rows: 8, turns: 0 });
    const app = createShell(h.rt, h.stream, h.mdTheme, h.diagnostics);
    h.rt.render = app.render;
    h.rt.renderForced = app.renderForced;
    app.attachInput({
      cycleThinkingLevel: vi.fn(), openHelpModal: vi.fn(), openThemePicker: vi.fn(),
      openModelPicker: vi.fn(), openSessionsModal: vi.fn(),
    });
    app.renderForced('test:initial-small');
    await vi.runOnlyPendingTimersAsync();
    h.tui.children[0]!.render(h.term.columns);
    h.tui.emit('/');
    h.rt.editor.setText(`/${'y'.repeat(420)}`);
    await vi.runOnlyPendingTimersAsync();
    h.tui.children[0]!.render(h.term.columns);

    h.term.rows = 30;
    app.renderForced('test:grow');
    await vi.runOnlyPendingTimersAsync();
    h.tui.children[0]!.render(h.term.columns);

    const active = h.tui.overlays.filter((overlay) => !overlay.removed)
      .find((overlay) => overlay.options?.anchor === 'top-left');
    const { boxWidth } = startScreenBox(h.term.columns);
    const screenRows = h.term.rows - TOP_RULE_ROWS;
    const inputRows = Math.min(h.rt.inputStack.render(boxWidth).length, screenRows - 1);
    const expectedTop = TOP_RULE_ROWS + startScreenInputTop(screenRows, inputRows, 0) + inputRows;
    expect(active).toBeDefined();
    expect((active?.options?.margin as { top?: number }).top).toBe(expectedTop);
    expect(active?.options?.maxHeight).toBe(Math.min(15, h.term.rows - expectedTop));
    app.terminalLifecycle.stop();
  });

  it('cancels an armed leader and every scheduler/controller timer through rapid application cycles', () => {
    for (let cycle = 0; cycle < 3; cycle++) {
      const h = applicationHarness({ turns: 2 });
      const app = createShell(h.rt, h.stream, h.mdTheme, h.diagnostics);
      app.attachInput({
        cycleThinkingLevel: vi.fn(), openHelpModal: vi.fn(), openThemePicker: vi.fn(),
        openModelPicker: vi.fn(), openSessionsModal: vi.fn(),
      });
      h.tui.emit('\x18'); // ctrl+x — arm the default two-second leader window
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      app.terminalLifecycle.stop();
      expect(vi.getTimerCount()).toBe(0);
      expect(h.tui.listeners.size).toBe(0);
    }
  });
});
