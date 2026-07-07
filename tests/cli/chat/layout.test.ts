import { beforeAll, describe, expect, it } from 'vitest';
import { getMarkdownTheme, initTheme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { beginAssistant, emptyView, fromHistory, pushUser, reduce } from '../../../src/brain/transcript.js';
import { ChatViewport, mouseWheel, SlashOverlay, StartScreen, TelemetryPanel, type TelemetryState } from '../../../src/cli/chat/layout.js';

describe('chat layout components', () => {
  beforeAll(() => { initTheme(); });

  it('parses SGR mouse wheel events', () => {
    expect(mouseWheel('\x1b[<64;10;10M')).toBe(3);
    expect(mouseWheel('\x1b[<65;10;10M')).toBe(-3);
    expect(mouseWheel('\x1b[<0;10;10M')).toBe(0);
  });

  it('renders a scrollable chat viewport with a history chip', () => {
    let view = emptyView();
    for (let i = 0; i < 8; i++) {
      view = pushUser(view, `message ${i}`);
      view = reduce(beginAssistant(view), { type: 'text', delta: `answer ${i}` });
      view = reduce(view, { type: 'idle' });
    }
    const viewport = new ChatViewport(
      { view, notice: '', modelName: 'kimi', thinkingSeconds: 0 },
      getMarkdownTheme(),
      () => 6,
      () => 1,
      () => 60,
    );
    const bottom = viewport.render(60);
    expect(bottom).toHaveLength(8);
    expect(bottom.every((line) => visibleWidth(line) === 60)).toBe(true);
    viewport.scroll(3);
    expect(viewport.render(60).join('\n')).toContain('History');
  });

  it('keeps settled reasoning clickable and does not add a model footer under answers', () => {
    let view = beginAssistant(pushUser(emptyView(), 'think?'));
    view = reduce(view, { type: 'reasoning', delta: 'inspect the code path' });
    view = reduce(view, { type: 'text', delta: 'done' });
    view = reduce(view, { type: 'idle' });
    const viewport = new ChatViewport(
      { view, notice: '', modelName: 'kimi', thinkingSeconds: 0 },
      getMarkdownTheme(),
      () => 12,
      () => 1,
      () => 72,
    );
    const rendered = viewport.render(72).join('\n');
    expect(rendered).toContain('Thought');
    expect(rendered).toContain('click');
    expect(rendered).toContain('done');
    expect(rendered).not.toContain('▪');
  });

  it('separates a Thought row from the preceding tool block with a blank line', () => {
    let view = beginAssistant(pushUser(emptyView(), 'go'));
    view = reduce(view, { type: 'tool', name: 'run_command', detail: 'npm test' });
    view = reduce(view, { type: 'tool_output', output: { title: 'console output', kind: 'console', text: 'Tests 4 passed', command: 'npm test', status: 'exit 0', tone: 'success' } });
    view = reduce(view, { type: 'reasoning', delta: 'now decide the next step' });
    view = reduce(view, { type: 'idle' });
    const viewport = new ChatViewport(
      { view, notice: '', modelName: 'kimi', thinkingSeconds: 0 },
      getMarkdownTheme(),
      () => 30,
      () => 1,
      () => 72,
    );
    const lines = viewport.render(72).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
    const thought = lines.findIndex((line) => line.includes('Thought'));
    expect(thought).toBeGreaterThan(0);
    expect(lines[thought - 1]!.replace(/[│\s]/g, '')).toBe(''); // blank spacer row above
  });

  it('renders framed tool output blocks', () => {
    let view = beginAssistant(emptyView());
    view = reduce(view, { type: 'tool', name: 'run_command', detail: 'npm test' });
    view = reduce(view, { type: 'tool_output', output: { title: 'console output', kind: 'console', text: 'Tests 4 passed', command: 'npm test', status: 'exit 0', tone: 'success' } });
    const viewport = new ChatViewport(
      { view, notice: '', modelName: 'kimi', thinkingSeconds: 0 },
      getMarkdownTheme(),
      () => 12,
      () => 1,
      () => 72,
    );
    const rendered = viewport.render(72).join('\n');
    expect(rendered).toContain('console output');
    expect(rendered).toContain('npm test');
    expect(rendered).toContain('Tests 4 passed');
    expect(rendered).not.toContain('run_command');
  });

  it('marks the last silent command row · running… while streaming and · done once settled', () => {
    let view = beginAssistant(pushUser(emptyView(), 'go'));
    view = reduce(view, { type: 'tool', name: 'run_command', command: 'echo one' });
    view = reduce(view, { type: 'tool', name: 'run_command', command: 'sleep 5' });
    const render = (v: typeof view): string => new ChatViewport(
      { view: v, notice: '', modelName: 'kimi', thinkingSeconds: 0 },
      getMarkdownTheme(),
      () => 14,
      () => 1,
      () => 72,
    ).render(72).map((line) => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
    const streaming = render(view);
    expect(streaming).toContain('$ echo one · done'); // an earlier tool has settled
    expect(streaming).toContain('$ sleep 5 · running…'); // the newest one is still awaiting approval/output
    expect(streaming).not.toContain('$ sleep 5 · done');
    const settled = render(reduce(view, { type: 'idle' }));
    expect(settled).toContain('$ sleep 5 · done');
    expect(settled).not.toContain('running…');
  });

  it('renders expandable tool output previews without a tool-name chip', () => {
    let view = beginAssistant(emptyView());
    view = reduce(view, { type: 'tool', id: 'cmd-1', name: 'run_command', detail: 'npm test' });
    view = reduce(view, {
      type: 'tool_output',
      id: 'cmd-1',
      output: { title: 'console output', kind: 'console', text: 'line 9\nline 10', fullText: 'line 1\nline 2\nline 9\nline 10', command: 'npm test' },
    });
    const viewport = new ChatViewport(
      { view, notice: '', modelName: 'kimi', thinkingSeconds: 0 },
      getMarkdownTheme(),
      () => 14,
      () => 1,
      () => 78,
    );
    const rendered = viewport.render(78).join('\n');
    expect(rendered).toContain('Click to expand');
    expect(rendered).toContain('line 10');
    expect(rendered).not.toContain('line 2');
    expect(rendered).not.toContain('run_command');
  });

  it('labels edit diffs by action and target instead of rendering the tool name', () => {
    let view = beginAssistant(emptyView());
    view = reduce(view, { type: 'tool', name: 'edit_file', detail: 'test.php' });
    view = reduce(view, { type: 'diff', diff: '-  1 old\n+  1 new' });
    const viewport = new ChatViewport(
      { view, notice: '', modelName: 'kimi', thinkingSeconds: 0 },
      getMarkdownTheme(),
      () => 12,
      () => 1,
      () => 72,
    );
    const rendered = viewport.render(72).join('\n');
    expect(rendered).toContain('Edit test.php');
    expect(rendered).not.toContain('edit_file');
  });

  it('renders proposed plan tags as a nested plan block', () => {
    let view = beginAssistant(emptyView());
    view = reduce(view, { type: 'text', delta: '<proposed_plan>\n# Migration\n- Move prompt into CLI prompts.\n</proposed_plan>' });
    view = reduce(view, { type: 'idle' });
    const viewport = new ChatViewport(
      { view, notice: '', modelName: 'kimi', thinkingSeconds: 0 },
      getMarkdownTheme(),
      () => 12,
      () => 1,
      () => 80,
    );
    const rendered = viewport.render(80).join('\n');
    expect(rendered).toContain('Proposed plan');
    expect(rendered).toContain('Migration');
    expect(rendered).not.toContain('<proposed_plan>');
  });

  it('renders a streaming proposed plan block before the closing tag arrives', () => {
    let view = beginAssistant(emptyView());
    view = reduce(view, { type: 'text', delta: '<proposed_plan>\n# Draft\n- Check tests' });
    const viewport = new ChatViewport(
      { view, notice: '', modelName: 'kimi', thinkingSeconds: 0 },
      getMarkdownTheme(),
      () => 12,
      () => 1,
      () => 80,
    );
    const rendered = viewport.render(80).join('\n');
    expect(rendered).toContain('Proposed plan');
    expect(rendered).toContain('Draft');
    expect(rendered).not.toContain('<proposed_plan>');
  });

  it('renders slash overlay rows to the full requested width', () => {
    const overlay = new SlashOverlay([{ value: '/theme', label: '/theme', description: 'Switch theme' }]);
    const rows = overlay.render(48);
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.every((line) => visibleWidth(line) === 48)).toBe(true);
  });

  it('filters slash commands from the editor text by description as well as the command name', () => {
    const overlay = new SlashOverlay([
      { value: '/theme', label: '/theme', description: 'Switch theme' },
      { value: '/compact', label: '/compact', description: 'Summarize conversation context' },
    ]);
    overlay.setFilter('/sum');
    const rendered = overlay.render(56).join('\n');
    expect(rendered).toContain('/compact');
    expect(rendered).not.toContain('/theme');
  });

  it('moves the highlight with wrap-around and reports the selected command', () => {
    const overlay = new SlashOverlay([
      { value: '/build', label: '/build' },
      { value: '/compact', label: '/compact' },
      { value: '/theme', label: '/theme' },
    ]);
    overlay.setFilter('/');
    expect(overlay.selectedValue()).toBe('/build');
    overlay.moveSelection(1);
    expect(overlay.selectedValue()).toBe('/compact');
    overlay.moveSelection(-1);
    overlay.moveSelection(-1); // wraps to the end
    expect(overlay.selectedValue()).toBe('/theme');
  });

  it('resets the highlight when the filter narrows and reports null with no matches', () => {
    const overlay = new SlashOverlay([
      { value: '/build', label: '/build' },
      { value: '/compact', label: '/compact' },
    ]);
    overlay.setFilter('/');
    overlay.moveSelection(1);
    overlay.setFilter('/c');
    expect(overlay.selectedValue()).toBe('/compact');
    overlay.setFilter('/xyzq');
    expect(overlay.selectedValue()).toBeNull();
    expect(overlay.render(48).join('\n')).toContain('No matching commands');
  });

  const telemetryState = (over: Partial<TelemetryState> = {}): TelemetryState => ({
    usage: { tokens: 10, contextWindow: 100, percent: 10, totalTokens: 20, cost: 0 },
    cwd: '~/orca',
    branch: 'main',
    mcp: null,
    lspEnabled: null,
    ...over,
  });

  it('renders telemetry panel without duplicating the model name', () => {
    const panel = new TelemetryPanel(() => telemetryState());
    const rows = panel.render(36);
    expect(rows.every((line) => visibleWidth(line) === 36)).toBe(true);
    expect(rows.join('\n')).not.toContain('kimi');
    expect(rows.join('\n')).toContain('Context');
    expect(rows.join('\n')).toContain('Project');
    // The Run section is gone — the elapsed time lives in the prompt meta line instead.
    expect(rows.join('\n')).not.toContain('Run');
    expect(rows.join('\n')).not.toContain('reasoning');
    expect(rows.join('\n')).not.toContain('theme');
    expect(rows.join('\n')).not.toContain('Dev');
  });

  it('scales the context bar with the panel width, keeping equal edge margins', () => {
    const cells = (width: number): number => {
      const panel = new TelemetryPanel(() => telemetryState());
      // The empty-cell glyphs identify the meter row (the panel logo also uses █).
      const bar = panel.render(width).find((line) => /[▱░]/.test(line))!;
      return bar.match(/[▰▱█░]/g)!.length;
    };
    // Bar spans the panel minus a 2-column margin on each side, at any drag-resized width.
    expect(cells(36)).toBe(32);
    expect(cells(68)).toBe(64);
  });

  it('uses heavier bar glyphs on a wide panel', () => {
    const panel = new TelemetryPanel(() => telemetryState({ usage: { tokens: 50, contextWindow: 100, percent: 50, totalTokens: 50, cost: 0 } }));
    expect(panel.render(40).join('\n')).toContain('▰');
    const wide = panel.render(60).join('\n');
    expect(wide).toContain('█');
    expect(wide).not.toContain('▰');
  });

  it('lists connected MCP servers with a count and shows the LSP state', () => {
    const panel = new TelemetryPanel(() => telemetryState({
      mcp: [
        { name: 'github', status: 'connected' },
        { name: 'chrome-devtools', status: 'connected' },
        { name: 'flaky', status: 'error' },
      ],
      lspEnabled: true,
    }));
    const rendered = panel.render(46).join('\n');
    expect(rendered).toContain('MCP');
    expect(rendered).toContain('2/3 active');
    expect(rendered).toContain('github');
    expect(rendered).toContain('chrome-devtools');
    expect(rendered).not.toContain('flaky');
    expect(rendered).toContain('LSP');
    expect(rendered).toContain('Active');
  });

  it('shows LSP as inactive and hides MCP/LSP sections when unreported', () => {
    const off = new TelemetryPanel(() => telemetryState({ mcp: [], lspEnabled: false }));
    const offRendered = off.render(46).join('\n');
    // With nothing connected the MCP section hides entirely (idle noise), LSP still reports.
    expect(offRendered).not.toContain('MCP');
    expect(offRendered).toContain('Inactive');
    const hidden = new TelemetryPanel(() => telemetryState());
    const hiddenRendered = hidden.render(46).join('\n');
    expect(hiddenRendered).not.toContain('MCP');
    expect(hiddenRendered).not.toContain('LSP');
  });

  it('renders the start screen: logo, centered input, hints, tip and the version bottom-right', () => {
    const input = { invalidate: (): void => { /* stateless */ }, render: (width: number): string[] => [`[input ${width}]`] };
    const screen = new StartScreen(input, () => 24, () => ({
      modelLine: 'Build · kimi-k2 moonshot',
      hints: '⏎ send · / commands',
      tip: 'Tip ask anything',
      notice: '',
      statusLeft: '~/orca · main',
      version: '1.8.7',
    }));
    const rows = screen.render(90);
    expect(rows).toHaveLength(24);
    const rendered = rows.join('\n');
    expect(rendered).toContain('█████'); // the ORCA wordmark
    expect(rendered).toContain('Build · kimi-k2 moonshot');
    expect(rendered).toContain('⏎ send · / commands');
    expect(rendered).toContain('Tip ask anything');
    const inputRow = rows.find((line) => line.includes('[input'))!;
    // The input renders at a narrowed box width and sits centered (left padding ≈ (90 - box) / 2).
    expect(inputRow).toContain('[input 72]');
    expect(inputRow.indexOf('[')).toBe(9);
    const last = rows[rows.length - 1]!;
    expect(last).toContain('~/orca · main');
    expect(last).toContain('orca v1.8.7');
    expect(last.indexOf('orca v1.8.7')).toBeGreaterThan(last.indexOf('~/orca · main'));
  });

  it('surfaces transient notices on the start screen', () => {
    const input = { invalidate: (): void => { /* stateless */ }, render: (): string[] => ['[input]'] };
    const screen = new StartScreen(input, () => 20, () => ({
      modelLine: 'Build · kimi',
      hints: 'hints',
      tip: 'tip',
      notice: 'error: daemon unreachable',
      statusLeft: '~/orca',
      version: '1.8.7',
    }));
    expect(screen.render(80).join('\n')).toContain('error: daemon unreachable');
  });
});

describe('drag-to-copy selection', () => {
  const mkViewport = () => {
    const view = fromHistory([
      { role: 'user', text: 'hello there' },
      { role: 'assistant', text: 'line one answer\nline two answer' },
    ]);
    const viewport = new ChatViewport(
      { view, notice: '', modelName: 'kimi', thinkingSeconds: 0 },
      getMarkdownTheme(),
      () => 12,
      () => 1,
      () => 60,
    );
    viewport.render(60); // populate the row cache + geometry
    return viewport;
  };

  it('drag selects lines and takeSelection returns plain right-trimmed text', () => {
    const viewport = mkViewport();
    expect(viewport.beginSelect(5, 2)).toBe(true);
    viewport.dragSelect(6);
    expect(viewport.hasSelection()).toBe(true);
    const text = viewport.takeSelection();
    expect(text).toBeTruthy();
    expect(text).not.toMatch(/\x1b\[/); // ANSI stripped
    expect(text).toContain('hello there');
    expect(viewport.hasSelection()).toBe(false);
  });

  it('a click without movement yields no text (and clears)', () => {
    const viewport = mkViewport();
    expect(viewport.beginSelect(5, 3)).toBe(true);
    expect(viewport.takeSelection()).toBeNull();
    expect(viewport.hasSelection()).toBe(false);
  });

  it('a press on the scrollbar column does not start a selection', () => {
    const viewport = mkViewport();
    expect(viewport.beginSelect(60, 3)).toBe(false);
  });

  it('reasoning segments disappear when showThoughts is false', () => {
    const view = fromHistory([{ role: 'assistant', text: 'answer' }]);
    view.turns = [{ role: 'orca', segments: [{ kind: 'reasoning', text: 'secret chain' }, { kind: 'text', text: 'answer' }], streaming: false }];
    const viewport = new ChatViewport(
      { view, notice: '', modelName: 'kimi', thinkingSeconds: 0, showThoughts: false },
      getMarkdownTheme(),
      () => 12,
      () => 1,
      () => 60,
    );
    const out = viewport.render(60).join('\n');
    expect(out).not.toContain('Thought');
    expect(out).toContain('answer');
  });
});

describe('per-turn render cache', () => {
  it('reuses settled turn rows until the epoch changes (typing must not re-render history)', () => {
    const view = fromHistory([
      { role: 'user', text: 'question' },
      { role: 'assistant', text: 'settled answer' },
    ]);
    const viewport = new ChatViewport(
      { view, notice: '', modelName: 'kimi', thinkingSeconds: 0 },
      getMarkdownTheme(),
      () => 12,
      () => 1,
      () => 60,
    );
    const first = viewport.render(60).join('\n');
    // Sneakily mutate the settled turn IN PLACE — a cached render must not see it...
    const turn = view.turns[1]!;
    if (turn.role === 'orca' && turn.segments[0]?.kind === 'text') turn.segments[0].text = 'MUTATED answer';
    expect(viewport.render(60).join('\n')).toBe(first);
    // ...until the cache epoch changes (an expand toggle invalidates everything).
    viewport.toggleThought(-999); // no-op key → no epoch bump
    expect(viewport.render(60).join('\n')).toBe(first);
  });
});
