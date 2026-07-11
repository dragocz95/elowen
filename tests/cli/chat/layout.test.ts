import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getMarkdownTheme, initTheme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { beginAssistant, emptyView, fromHistory, pushUser, reduce } from '../../../src/brain/transcript.js';
import { CHAT_VIEWPORT_ROW_CACHE_LIMIT, ChatViewport, mouseWheel, SlashOverlay, StartScreen, TelemetryPanel, TOOL_INDENT, type TelemetryState } from '../../../src/cli/chat/layout.js';

afterEach(() => { vi.useRealTimers(); });

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
    expect(bottom).toHaveLength(6); // the viewport now obeys its exact shell allocation (no old 8-row floor)
    expect(bottom.every((line) => visibleWidth(line) === 60)).toBe(true);
    viewport.scroll(3);
    expect(viewport.render(60).join('\n')).toContain('History');
  });

  it('does not reverse-video the first padding row when no drag selection exists', () => {
    const viewport = new ChatViewport(
      {
        view: fromHistory([
          { role: 'user', text: 'short question' },
          { role: 'assistant', text: 'short answer' },
        ]),
        notice: '', modelName: 'kimi', thinkingSeconds: 0,
      },
      getMarkdownTheme(),
      () => 20,
      () => 1,
      () => 60,
    );

    const rendered = viewport.render(60).join('\n');
    expect(rendered).not.toContain('\x1b[7m');
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

  it('encodes live tool progress before it reaches terminal layout', () => {
    let view = beginAssistant(pushUser(emptyView(), 'run it'));
    view = reduce(view, { type: 'tool', id: 'cmd-1', name: 'run_command', detail: 'du -xhd2', command: 'du -xhd2' });
    view = reduce(view, { type: 'tool_progress', id: 'cmd-1', text: '984M\t/var/www/.local\x1b[2J\rupdated' });
    const viewport = new ChatViewport(
      { view, notice: '', modelName: 'kimi', thinkingSeconds: 0 },
      getMarkdownTheme(), () => 20, () => 1, () => 72,
    );

    const rendered = viewport.render(72).join('\n');
    expect(rendered).not.toContain('\t');
    expect(rendered).not.toContain('\r');
    expect(rendered).not.toContain('\x1b[2J');
    expect(rendered).toContain('/var/www/.local');
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
    // The console block drops its "console output" label (bare `<` connector) — the `$ npm test` echo
    // right below already identifies it.
    expect(rendered).not.toContain('console output');
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

  it('collapses a run of the same bare tool into one indented row with a ×N counter', () => {
    let view = beginAssistant(pushUser(emptyView(), 'read them'));
    view = reduce(view, { type: 'tool', name: 'read_file', detail: 'a.ts' });
    view = reduce(view, { type: 'tool', name: 'read_file', detail: 'a.ts' });
    view = reduce(view, { type: 'tool', name: 'read_file', detail: 'b.ts' });
    view = reduce(view, { type: 'idle' });
    const viewport = new ChatViewport(
      { view, notice: '', modelName: 'kimi', thinkingSeconds: 0 },
      getMarkdownTheme(),
      () => 12,
      () => 1,
      () => 72,
    );
    const lines = viewport.render(72).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
    const toolRows = lines.filter((l) => l.includes('Read '));
    expect(toolRows).toHaveLength(1); // three reads folded into ONE row
    expect(toolRows[0]).toContain('Read b.ts'); // latest detail shown
    expect(toolRows[0]).toContain('×3');
    // Tool rows sit deeper than the 2-space assistant prose (TOOL_INDENT = 4 spaces).
    expect(TOOL_INDENT).toBe('    ');
    expect(toolRows[0]!.startsWith(TOOL_INDENT)).toBe(true);
    expect(toolRows[0]![2]).toBe(' '); // still blank at column 2 where prose would start
  });

  it('does not collapse a tool that carries an output block (it renders its own block, not a ×N row)', () => {
    let view = beginAssistant(emptyView());
    view = reduce(view, { type: 'tool', id: 't1', name: 'read_file', detail: 'a.ts' });
    view = reduce(view, { type: 'tool_output', id: 't1', output: { title: 'tool result', kind: 'result', text: 'file body', tone: 'normal' } });
    view = reduce(view, { type: 'tool', name: 'read_file', detail: 'b.ts' });
    view = reduce(view, { type: 'idle' });
    const rendered = new ChatViewport(
      { view, notice: '', modelName: 'kimi', thinkingSeconds: 0 },
      getMarkdownTheme(),
      () => 12,
      () => 1,
      () => 72,
    ).render(72).map((line) => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
    expect(rendered).not.toContain('×'); // the output-bearing read broke the run → nothing folded
    expect(rendered).toContain('tool result');
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
    cwd: '~/elowen',
    branch: 'main',
    mcp: null,
    lspEnabled: null,
    processes: [],
    rateLimits: null,
    floatOffset: 0,
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

  it('floats the flame within a fixed band: constant panel height, whole-row drift, no reflow', () => {
    const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
    const render = (floatOffset: number): string[] =>
      new TelemetryPanel(() => telemetryState({ floatOffset })).render(46).map(strip);
    // The flame's own rows are the only ones carrying half-block glyphs; the band above/below is blank.
    const firstFlameRow = (floatOffset: number): number => render(floatOffset).findIndex((l) => /[▀▄]/.test(l));
    const height = (floatOffset: number): number => render(floatOffset).length;

    const band = [-2, -1, 0, 1, 2];
    // Panel height stays identical across the whole band → the Context section below never reflows.
    expect(new Set(band.map(height)).size).toBe(1);
    // A more-positive drift lifts the flame (fewer blank rows above it); each unit shifts exactly one row.
    expect(firstFlameRow(0) - firstFlameRow(1)).toBe(1);
    expect(firstFlameRow(-1) - firstFlameRow(0)).toBe(1);
    expect(firstFlameRow(2)).toBeLessThan(firstFlameRow(-2));
    // Fractional drift rounds to whole rows; drift beyond the band clamps at the edge.
    expect(firstFlameRow(0.4)).toBe(firstFlameRow(0));
    expect(firstFlameRow(0.6)).toBe(firstFlameRow(1));
    expect(firstFlameRow(9)).toBe(firstFlameRow(2));
    expect(firstFlameRow(-9)).toBe(firstFlameRow(-2));
    // Every rendered row (blank band rows included) is still padded to the panel width.
    expect(render(1).every((line) => visibleWidth(line) === 46)).toBe(true);
  });

  it('scales the context bar with the panel width, keeping equal edge margins', () => {
    const cells = (width: number): number => {
      const panel = new TelemetryPanel(() => telemetryState());
      // The empty-cell glyphs identify the meter row (the panel logo uses ▀▄ half-blocks, not these).
      const bar = panel.render(width).find((line) => /[▱░]/.test(line))!;
      return bar.match(/[▰▱█░]/g)!.length;
    };
    // Bar spans the panel minus a 2-column margin on each side, at any drag-resized width.
    expect(cells(36)).toBe(32);
    expect(cells(68)).toBe(64);
  });

  it('uses the same block meter glyphs for Context and OAuth limits at every panel width', () => {
    const panel = new TelemetryPanel(() => telemetryState({ usage: { tokens: 50, contextWindow: 100, percent: 50, totalTokens: 50, cost: 0 } }));
    for (const width of [36, 40, 60]) {
      const rendered = panel.render(width).join('\n');
      expect(rendered).toContain('█');
      expect(rendered).toContain('░');
      expect(rendered).not.toContain('▰');
      expect(rendered).not.toContain('▱');
    }
  });

  it('shows compact 5h and weekly subscription meters, and hides them when unavailable', () => {
    const hidden = new TelemetryPanel(() => telemetryState());
    expect(hidden.render(46).join('\n')).not.toContain('Limits');

    const panel = new TelemetryPanel(() => telemetryState({
      rateLimits: {
        provider: 'openai-codex', planType: 'team', fetchedAt: 123, stale: false,
        primary: { usedPercent: 25, windowMinutes: 300, resetsAt: 1_900_000_000 },
        secondary: { usedPercent: 80, windowMinutes: 10_080, resetsAt: 1_900_500_000 },
      },
    }));
    const rendered = panel.render(46).map((line) => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
    expect(rendered).toContain('Limits team');
    expect(rendered).toContain('5h');
    expect(rendered).toContain('weekly');
    expect(rendered).toContain('25%');
    expect(rendered).toContain('80%');
    expect(rendered).toContain('↻');
  });

  it('renders running Processes in the telemetry rail with working kill hit zones', () => {
    const panel = new TelemetryPanel(() => telemetryState({
      processes: [{
        id: 'p-right', command: 'npm run build', cwd: '/x',
        startedAt: new Date(Date.now() - 5_000).toISOString(), running: true, exitCode: null,
      }],
    }));
    const rows = panel.render(46);
    const plain = rows.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
    const processRow = plain.findIndex((line) => line.includes('npm run build'));
    expect(processRow).toBeGreaterThan(0);
    expect(plain.join('\n')).toContain('Processes');
    const killColumn = plain[processRow]!.indexOf('✕') + 1;
    expect(panel.processKillAt(processRow, killColumn)).toBe('p-right');
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
      statusLeft: '~/elowen · main',
      version: '1.8.7',
    }));
    const rows = screen.render(90);
    expect(rows).toHaveLength(24);
    const rendered = rows.join('\n');
    expect(rendered).toContain('▀'); // the flame mascot logo (truecolor half-block art)
    expect(rendered).toContain('Build · kimi-k2 moonshot');
    expect(rendered).toContain('⏎ send · / commands');
    expect(rendered).toContain('Tip ask anything');
    const inputRow = rows.find((line) => line.includes('[input'))!;
    // The input renders at a narrowed box width and sits centered (left padding ≈ (90 - box) / 2).
    expect(inputRow).toContain('[input 72]');
    expect(inputRow.indexOf('[')).toBe(9);
    const last = rows[rows.length - 1]!;
    expect(last).toContain('~/elowen · main');
    expect(last).toContain('elowen v1.8.7');
    expect(last.indexOf('elowen v1.8.7')).toBeGreaterThan(last.indexOf('~/elowen · main'));
  });

  it('keeps the compact start screen inside a very short terminal allocation', () => {
    const input = { invalidate: (): void => {}, render: (): string[] => ['input one', 'input two', 'input three'] };
    const screen = new StartScreen(input, () => 6, () => ({
      modelLine: 'Build · model', hints: 'enter send', tip: 'tip', notice: '',
      statusLeft: '~/elowen', version: '1.0.0',
    }));
    const rows = screen.render(60);
    expect(rows).toHaveLength(6);
    expect(rows.join('\n')).toContain('input three');
    expect(rows.at(-1)).toContain('elowen v1.0.0');
    expect(rows.join('\n')).not.toContain('▀'); // decorative mascot yields to the composer on short screens
  });

  it('surfaces transient notices on the start screen', () => {
    const input = { invalidate: (): void => { /* stateless */ }, render: (): string[] => ['[input]'] };
    const screen = new StartScreen(input, () => 20, () => ({
      modelLine: 'Build · kimi',
      hints: 'hints',
      tip: 'tip',
      notice: 'error: daemon unreachable',
      statusLeft: '~/elowen',
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
    view.turns = [{ role: 'elowen', segments: [{ kind: 'reasoning', text: 'secret chain' }, { kind: 'text', text: 'answer' }], streaming: false }];
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
  it('reuses settled turn rows while no owning turn is invalidated', () => {
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
    if (turn.role === 'elowen' && turn.segments[0]?.kind === 'text') turn.segments[0].text = 'MUTATED answer';
    expect(viewport.render(60).join('\n')).toBe(first);
    viewport.toggleThought(-999); // no interactive row → no invalidation
    expect(viewport.render(60).join('\n')).toBe(first);
  });
});

describe('progressive history layout', () => {
  const largeHistory = (pairs = 100) => fromHistory(Array.from({ length: pairs }, (_, i) => [
    { role: 'user', text: `question ${i}` },
    { role: 'assistant', text: `## answer ${i}\n\n- evidence one\n- evidence two\n\nNewest marker ${i}` },
  ]).flat());

  it('paints only the exact tail and leaves untouched history cold until the user scrolls', async () => {
    vi.useFakeTimers();
    const view = largeHistory();
    const viewport = new ChatViewport(
      { view, notice: '', modelName: 'kimi', thinkingSeconds: 0 },
      getMarkdownTheme(), () => 6, () => 1, () => 60,
    );

    const first = viewport.render(60).join('\n');
    expect(first).toContain('Newest marker 99');
    expect(viewport.indexedHistoryTurns()).toBeLessThan(20);
    expect(viewport.indexedHistoryTurns()).toBeLessThan(view.turns.length);
    expect(viewport.isHistoryIndexComplete()).toBe(false);
    expect(viewport.isScrollbarHit(60, 3)).toBe(false); // no approximate thumb/hit target
    expect(first).toContain('█'); // approximate visual thumb stays visible while exact drag remains disabled

    const afterFirstPaint = viewport.indexedHistoryTurns();
    await vi.runAllTimersAsync();
    expect(viewport.indexedHistoryTurns()).toBe(afterFirstPaint); // no idle full-history CPU pass
    expect(viewport.isHistoryIndexComplete()).toBe(false);
    viewport.scroll(30);
    expect(viewport.indexedHistoryTurns()).toBeGreaterThan(afterFirstPaint);
    expect(viewport.cachedHistoryRows()).toBeLessThanOrEqual(CHAT_VIEWPORT_ROW_CACHE_LIMIT);
  });

  it('PageUp indexes just enough older turns and keeps an exact bottom-relative offset', () => {
    vi.useFakeTimers();
    const viewport = new ChatViewport(
      { view: largeHistory(), notice: '', modelName: 'kimi', thinkingSeconds: 0 },
      getMarkdownTheme(), () => 6, () => 1, () => 60,
    );
    viewport.render(60);
    const initiallyIndexed = viewport.indexedHistoryTurns();
    viewport.scroll(30);
    expect(viewport.indexedHistoryTurns()).toBeGreaterThan(initiallyIndexed);
    expect(viewport.isHistoryIndexComplete()).toBe(false);
    const beforeDrag = viewport.render(60).map((line) => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
    expect(beforeDrag).toContain('History +30 lines');
    viewport.setScrollFromRow(1); // incomplete total: scrollbar drag is a strict no-op
    const afterDrag = viewport.render(60).map((line) => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
    expect(afterDrag).toContain('History +30 lines');
  });

  it('invalidates only the turn that owns an expanded Thought', () => {
    const view = fromHistory([
      { role: 'assistant', text: 'ORIGINAL settled answer' },
      { role: 'assistant', text: 'placeholder' },
    ]);
    view.turns[1] = {
      role: 'elowen', streaming: false,
      segments: [{ kind: 'reasoning', text: 'summary words followed by the hidden expanded detail' }],
    };
    const viewport = new ChatViewport(
      { view, notice: '', modelName: 'kimi', thinkingSeconds: 0 },
      getMarkdownTheme(), () => 20, () => 1, () => 72,
    );
    const first = viewport.render(72);
    const thoughtRow = first.findIndex((line) => line.includes('Thought'));
    expect(thoughtRow).toBeGreaterThanOrEqual(0);
    const oldTurn = view.turns[0]!;
    if (oldTurn.role === 'elowen' && oldTurn.segments[0]?.kind === 'text') oldTurn.segments[0].text = 'MUTATED off-screen cache';

    viewport.toggleThought(thoughtRow + 1);
    const expanded = viewport.render(72).join('\n');
    expect(expanded).toContain('ORIGINAL settled answer');
    expect(expanded).not.toContain('MUTATED off-screen cache');
    expect(expanded).toContain('hidden expanded detail');
  });

  it('a width change discards exact heights but still re-paints only the newest tail', () => {
    vi.useFakeTimers();
    const view = largeHistory();
    let width = 60;
    const viewport = new ChatViewport(
      { view, notice: '', modelName: 'kimi', thinkingSeconds: 0 },
      getMarkdownTheme(), () => 6, () => 1, () => width,
    );
    viewport.render(width);
    width = 72;
    const resized = viewport.render(width).join('\n');
    expect(resized).toContain('Newest marker 99');
    expect(viewport.isHistoryIndexComplete()).toBe(false);
    expect(viewport.indexedHistoryTurns()).toBeLessThan(20);
  });

  it('reports viewport-sized work and renders no settled Markdown again during cached scroll', () => {
    const viewport = new ChatViewport(
      { view: largeHistory(1_000), notice: '', modelName: 'kimi', thinkingSeconds: 0 },
      getMarkdownTheme(), () => 18, () => 1, () => 80,
    );
    viewport.render(80);
    const first = viewport.metrics();
    expect(first.visibleRows).toBe(18);
    expect(first.renderedTurns).toBeLessThan(20);

    viewport.scroll(3);
    viewport.render(80);
    const scrolled = viewport.metrics();
    expect(scrolled.visibleRows).toBe(18);
    expect(scrolled.renderedTurns).toBe(0);
    expect(scrolled.cachedRows).toBeLessThanOrEqual(CHAT_VIEWPORT_ROW_CACHE_LIMIT);
  });

  it('reconciles only the streaming tail instead of comparing every settled turn', () => {
    let view = largeHistory(1_000);
    const viewport = new ChatViewport(
      { view, notice: '', modelName: 'kimi', thinkingSeconds: 0 },
      getMarkdownTheme(), () => 18, () => 1, () => 80,
    );
    viewport.render(80);
    view = beginAssistant(view);
    viewport.setState({ view, notice: '', modelName: 'kimi', thinkingSeconds: 0 });
    viewport.render(80);
    view = reduce(view, { type: 'text', delta: 'one streaming token' });
    viewport.setState({ view, notice: '', modelName: 'kimi', thinkingSeconds: 0 });
    viewport.render(80);
    expect(viewport.metrics().reconciledTurns).toBeLessThanOrEqual(1);
    expect(viewport.metrics().renderedTurns).toBeLessThanOrEqual(1);
  });
});
