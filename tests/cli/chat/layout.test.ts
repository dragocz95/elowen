import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getMarkdownTheme, getSelectListTheme, initTheme } from '@earendil-works/pi-coding-agent';
import { CURSOR_MARKER, getCapabilities, setCapabilities, visibleWidth } from '@earendil-works/pi-tui';
import type { TUI } from '@earendil-works/pi-tui';
import type { HistoryMessage } from '../../../src/brain/transcript.js';
import { TranscriptModel, type TranscriptModelOptions } from '../../../src/brain/transcriptModel.js';
import type { BrainEvent } from '../../../src/brain/events.js';
import { CHAT_VIEWPORT_ROW_CACHE_LIMIT, ChatViewport, type ChatViewportState } from '../../../src/cli/chat/chatViewport.js';
import { TOOL_INDENT, TurnRenderer } from '../../../src/cli/chat/turnRenderer.js';
import { mouseWheel } from '../../../src/cli/chat/terminalProtocol.js';
import { StartScreen } from '../../../src/cli/chat/startScreen.js';
import { TelemetryPanel, type TelemetryState } from '../../../src/cli/chat/telemetryPanel.js';
import { MentionOverlay, SlashOverlay, SuggestionOverlay } from '../../../src/cli/chat/suggestionOverlay.js';
import { ChatEditor } from '../../../src/cli/chat/picker.js';

const transcriptState = (
  transcript: TranscriptModel,
  overrides: Partial<Omit<ChatViewportState, 'transcript' | 'transcriptNotice'>> = {},
): ChatViewportState => ({
  transcript,
  transcriptNotice: transcript.notice,
  notice: '',
  modelName: 'kimi',
  thinkingSeconds: 0,
  ...overrides,
});

const viewportState = (
  transcript: TranscriptModel,
  overrides: Partial<Omit<ChatViewportState, 'transcript' | 'transcriptNotice'>> = {},
): ChatViewportState => transcriptState(transcript, overrides);

const transcriptWith = (
  history: HistoryMessage[] = [],
  events: BrainEvent[] = [],
  options: TranscriptModelOptions = {},
): TranscriptModel => {
  const transcript = new TranscriptModel(history, options);
  for (const event of events) transcript.apply(event);
  return transcript;
};

afterEach(() => { vi.useRealTimers(); });

describe('chat layout components', () => {
  it('renders one turn through the focused turn renderer without owning viewport state', () => {
    const renderer = new TurnRenderer(getMarkdownTheme());
    const rows = renderer.render({ role: 'you', text: 'focused module' }, 0, 40, {
      showThoughts: true, thinkingSeconds: 0, expandedThoughts: new Set(), expandedTools: new Set(),
    });
    expect(rows.map((row) => row.line).join('\n')).toContain('focused module');
  });

  beforeAll(() => { initTheme(); });

  it('parses SGR mouse wheel events', () => {
    expect(mouseWheel('\x1b[<64;10;10M')).toBe(3);
    expect(mouseWheel('\x1b[<65;10;10M')).toBe(-3);
    expect(mouseWheel('\x1b[<0;10;10M')).toBe(0);
  });

  it('renders a scrollable chat viewport with a history chip', () => {
    const view = new TranscriptModel();
    for (let i = 0; i < 8; i++) {
      view.apply({ type: 'user', text: `message ${i}` });
      view.apply({ type: 'text', delta: `answer ${i}` });
      view.apply({ type: 'idle' });
    }
    const viewport = new ChatViewport(
      viewportState(view),
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
      viewportState(new TranscriptModel([
          { role: 'user', text: 'short question' },
          { role: 'assistant', text: 'short answer' },
        ])),
      getMarkdownTheme(),
      () => 20,
      () => 1,
      () => 60,
    );

    const rendered = viewport.render(60).join('\n');
    expect(rendered).not.toContain('\x1b[7m');
  });

  it('keeps settled reasoning clickable and does not add a model footer under answers', () => {
    const view = transcriptWith([], [
      { type: 'user', text: 'think?' },
      { type: 'reasoning', delta: 'inspect the code path' },
      { type: 'text', delta: 'done' },
      { type: 'idle' },
    ]);
    const viewport = new ChatViewport(
      viewportState(view),
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
    const view = transcriptWith([], [
      { type: 'user', text: 'go' },
      { type: 'tool', name: 'run_command', detail: 'npm test' },
      { type: 'tool_output', output: { title: 'console output', kind: 'console', text: 'Tests 4 passed', command: 'npm test', status: 'exit 0', tone: 'success' } },
      { type: 'reasoning', delta: 'now decide the next step' },
      { type: 'idle' },
    ]);
    const viewport = new ChatViewport(
      viewportState(view),
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
    const view = transcriptWith([], [
      { type: 'user', text: 'run it' },
      { type: 'tool', id: 'cmd-1', name: 'run_command', detail: 'du -xhd2', command: 'du -xhd2' },
      { type: 'tool_progress', id: 'cmd-1', text: '984M\t/var/www/.local\x1b[2J\rupdated' },
    ]);
    const viewport = new ChatViewport(
      viewportState(view),
      getMarkdownTheme(), () => 20, () => 1, () => 72,
    );

    const rendered = viewport.render(72).join('\n');
    expect(rendered).not.toContain('\t');
    expect(rendered).not.toContain('\r');
    expect(rendered).not.toContain('\x1b[2J');
    expect(rendered).toContain('/var/www/.local');
  });

  it('projects user, assistant, reasoning, and notice text before terminal rendering', () => {
    const view = transcriptWith([], [
      { type: 'user', text: 'hello\x1b[2J user\tcolumn' },
      { type: 'reasoning', delta: 'reason\x1b]0;forged\x07 text' },
      { type: 'text', delta: '**bold answer**\x1b]52;c;Zm9yZ2Vk\x07' },
    ]);
    const viewport = new ChatViewport(
      viewportState(view, { notice: 'notice\x1b[3J' }),
      getMarkdownTheme(), () => 24, () => 1, () => 72,
    );

    const rendered = viewport.render(72).join('\n');
    expect(rendered).toContain('hello');
    expect(rendered).toContain('bold answer');
    expect(rendered).toContain('Thought');
    expect(rendered).not.toContain('**bold answer**'); // Markdown syntax is still parsed, not escaped verbatim.
    expect(rendered).not.toContain('\x1b[2J');
    expect(rendered).not.toContain('\x1b[3J');
    expect(rendered).not.toContain('\x1b]0;');
    expect(rendered).not.toContain('\x1b]52;');
    expect(rendered).not.toContain('\t');
  });

  it('renders framed tool output blocks', () => {
    const view = transcriptWith([], [
      { type: 'tool', name: 'run_command', detail: 'npm test' },
      { type: 'tool_output', output: { title: 'console output', kind: 'console', text: 'Tests 4 passed', command: 'npm test', status: 'exit 0', tone: 'success' } },
    ]);
    const viewport = new ChatViewport(
      viewportState(view),
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
    const view = transcriptWith([], [
      { type: 'user', text: 'go' },
      { type: 'tool', name: 'run_command', command: 'echo one' },
      { type: 'tool', name: 'run_command', command: 'sleep 5' },
    ]);
    const render = (transcript: TranscriptModel): string => new ChatViewport(
      viewportState(transcript),
      getMarkdownTheme(),
      () => 14,
      () => 1,
      () => 72,
    ).render(72).map((line) => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
    const streaming = render(view);
    expect(streaming).toContain('$ echo one · done'); // an earlier tool has settled
    expect(streaming).toContain('$ sleep 5 · running…'); // the newest one is still awaiting approval/output
    expect(streaming).not.toContain('$ sleep 5 · done');
    view.apply({ type: 'idle' });
    const settled = render(view);
    expect(settled).toContain('$ sleep 5 · done');
    expect(settled).not.toContain('running…');
  });

  it('renders expandable tool output previews without a tool-name chip', () => {
    const view = transcriptWith([], [
      { type: 'tool', id: 'cmd-1', name: 'run_command', detail: 'npm test' },
      {
      type: 'tool_output',
      id: 'cmd-1',
      output: { title: 'console output', kind: 'console', text: 'line 9\nline 10', fullText: 'line 1\nline 2\nline 9\nline 10', command: 'npm test' },
      },
    ]);
    const viewport = new ChatViewport(
      viewportState(view),
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
    const view = transcriptWith([], [
      { type: 'user', text: 'read them' },
      { type: 'tool', name: 'read_file', detail: 'a.ts' },
      { type: 'tool', name: 'read_file', detail: 'a.ts' },
      { type: 'tool', name: 'read_file', detail: 'b.ts' },
      { type: 'idle' },
    ]);
    const viewport = new ChatViewport(
      viewportState(view),
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
    const view = transcriptWith([], [
      { type: 'tool', id: 't1', name: 'read_file', detail: 'a.ts' },
      { type: 'tool_output', id: 't1', output: { title: 'tool result', kind: 'result', text: 'file body', tone: 'normal' } },
      { type: 'tool', name: 'read_file', detail: 'b.ts' },
      { type: 'idle' },
    ]);
    const rendered = new ChatViewport(
      viewportState(view),
      getMarkdownTheme(),
      () => 12,
      () => 1,
      () => 72,
    ).render(72).map((line) => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
    expect(rendered).not.toContain('×'); // the output-bearing read broke the run → nothing folded
    expect(rendered).toContain('tool result');
  });

  it('labels edit diffs by action and target instead of rendering the tool name', () => {
    const view = transcriptWith([], [
      { type: 'tool', name: 'edit_file', detail: 'test.php' },
      { type: 'diff', diff: '-  1 old\n+  1 new' },
    ]);
    const viewport = new ChatViewport(
      viewportState(view),
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
    const view = transcriptWith([], [
      { type: 'text', delta: '<proposed_plan>\n# Migration\n- Move prompt into CLI prompts.\n</proposed_plan>' },
      { type: 'idle' },
    ]);
    const viewport = new ChatViewport(
      viewportState(view),
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
    const view = transcriptWith([], [
      { type: 'text', delta: '<proposed_plan>\n# Draft\n- Check tests' },
    ]);
    const viewport = new ChatViewport(
      viewportState(view),
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

  it('shares one suggestion viewport implementation between commands and files', () => {
    const commands = new SuggestionOverlay('commands', Array.from({ length: 10 }, (_, index) => ({
      value: `/command-${index}`, label: `/command-${index}`, description: 'Switch theme',
    })));
    const files = new SuggestionOverlay('files', Array.from({ length: 10 }, (_, index) => ({
      value: `src/file-${index}.ts`, label: `src/file-${index}.ts`, description: 'file',
    })));
    commands.setMaxRows(6);
    files.setMaxRows(6);
    expect(commands.render(48)).toHaveLength(6);
    expect(files.render(48)).toHaveLength(6);
    expect(commands.render(48).join('\n')).toContain('commands');
    expect(files.render(48).join('\n')).toContain('files');
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

  it('fits slash chrome and the active window inside a short-terminal row budget', () => {
    const overlay = new SlashOverlay(Array.from({ length: 20 }, (_, index) => ({
      value: `/command-${String(index + 1).padStart(2, '0')}`,
      label: `/command-${String(index + 1).padStart(2, '0')}`,
      description: `description ${index + 1}`,
    })));
    overlay.setMaxRows(10);
    for (let index = 0; index < 19; index += 1) overlay.moveSelection(1);

    const rows = overlay.render(40);
    expect(rows).toHaveLength(10);
    expect(rows[0]).toContain('╭');
    expect(rows.at(-1)).toContain('╰');
    expect(rows.join('\n')).toContain('esc');
    expect(rows.join('\n')).toContain('/command-20');
  });

  it('applies the same short-terminal budget to file mention suggestions', () => {
    const overlay = new MentionOverlay();
    overlay.setItems(Array.from({ length: 20 }, (_, index) => ({
      value: `src/file-${index + 1}.ts`, label: `src/file-${index + 1}.ts`,
    })));
    overlay.setMaxRows(8);
    for (let index = 0; index < 19; index += 1) overlay.moveSelection(1);
    const rows = overlay.render(40);
    expect(rows).toHaveLength(8);
    expect(rows[0]).toContain('╭');
    expect(rows.at(-1)).toContain('╰');
    expect(rows.join('\n')).toContain('src/file-20.ts');
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
    panel.setMaxRows(23);
    const rows = panel.render(46);
    expect(rows).toHaveLength(23);
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

  it('keeps a 12-line editor cursor on line 1 visible in a six-row compact start screen', () => {
    const tui = { requestRender: () => {}, terminal: { rows: 6, columns: 40 } } as unknown as TUI;
    const editor = new ChatEditor(tui, { borderColor: (value) => value, selectList: getSelectListTheme() }, {});
    editor.focused = true;
    editor.setText(Array.from({ length: 12 }, (_, index) => `draft-${String(index + 1).padStart(2, '0')}`).join('\n'));
    for (let index = 0; index < 11; index++) {
      editor.render(32);
      editor.handleInput('\x1b[A');
    }
    expect(editor.getCursor().line).toBe(0);
    expect(editor.render(32).join('\n')).toContain(CURSOR_MARKER);

    const screen = new StartScreen(editor, () => 6, () => ({
      modelLine: 'Build · model', hints: 'enter send', tip: 'tip', notice: '',
      statusLeft: '~/elowen', version: '1.0.0',
    }));
    const rendered = screen.render(40);
    expect(rendered).toHaveLength(6);
    expect(rendered.join('\n')).toContain('draft-01');
    expect(rendered.join('\n')).toContain(CURSOR_MARKER);
    expect(rendered.at(-1)).toContain('elowen v1.0.0');
  });

  it('retains the wrapped editor cursor when the compact start screen narrows and shrinks', () => {
    const terminal = { rows: 8, columns: 60 };
    const tui = { requestRender: () => {}, terminal } as unknown as TUI;
    const editor = new ChatEditor(tui, { borderColor: (value) => value, selectList: getSelectListTheme() }, {});
    editor.focused = true;
    editor.setText(Array.from({ length: 28 }, (_, index) => `word-${index}`).join(' '));
    let allocatedRows = 8;
    const screen = new StartScreen(editor, () => allocatedRows, () => ({
      modelLine: 'Build · model', hints: 'enter send', tip: 'tip', notice: '',
      statusLeft: '~/elowen', version: '1.0.0',
    }));
    expect(screen.render(60).join('\n')).toContain(CURSOR_MARKER);

    terminal.columns = 24;
    terminal.rows = 6;
    allocatedRows = 6;
    for (let index = 0; index < 8; index++) {
      editor.render(24);
      editor.handleInput('\x1b[A');
    }
    const resized = screen.render(24);
    expect(resized).toHaveLength(6);
    expect(resized.join('\n')).toContain(CURSOR_MARKER);
    expect(resized.every((line) => visibleWidth(line) <= 24)).toBe(true);
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
  beforeAll(() => { initTheme(); });
  const mkViewport = () => {
    const view = new TranscriptModel([
      { role: 'user', text: 'hello there' },
      { role: 'assistant', text: 'line one answer\nline two answer' },
    ]);
    const viewport = new ChatViewport(
      viewportState(view),
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

  it('copies Markdown hyperlinks without OSC 8 metadata', () => {
    const previous = { ...getCapabilities() };
    setCapabilities({ ...previous, hyperlinks: true });
    try {
      const viewport = new ChatViewport(
        viewportState(new TranscriptModel([{ role: 'assistant', text: '[example](https://example.com)\nsecond line' }])),
        getMarkdownTheme(), () => 6, () => 1, () => 60,
      );
      const rendered = viewport.render(60);
      const linkRow = rendered.findIndex((line) => line.includes('example'));
      expect(linkRow).toBeGreaterThanOrEqual(0);
      expect(viewport.beginSelect(5, linkRow + 1)).toBe(true);
      viewport.dragSelect(linkRow + 2);
      const copied = viewport.takeSelection();
      expect(copied).toContain('example');
      expect(copied).not.toContain('\x1b]8;');
      expect(copied).not.toContain('\x07');
    } finally {
      setCapabilities(previous);
    }
  });

  it('reasoning segments disappear when showThoughts is false', () => {
    const view = transcriptWith([], [
      { type: 'reasoning', delta: 'secret chain' },
      { type: 'text', delta: 'answer' },
      { type: 'idle' },
    ]);
    const viewport = new ChatViewport(
      viewportState(view, { showThoughts: false }),
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
    const view = new TranscriptModel([
      { role: 'user', text: 'question' },
      { role: 'assistant', text: 'settled answer' },
    ]);
    const viewport = new ChatViewport(
      viewportState(view),
      getMarkdownTheme(),
      () => 12,
      () => 1,
      () => 60,
    );
    const first = viewport.render(60).join('\n');
    // Sneakily mutate the settled turn IN PLACE — a cached render must not see it...
    const turn = view.turnAt(1)!;
    if (turn.role === 'elowen' && turn.segments[0]?.kind === 'text') turn.segments[0].text = 'MUTATED answer';
    expect(viewport.render(60).join('\n')).toBe(first);
    viewport.toggleThought(-999); // no interactive row → no invalidation
    expect(viewport.render(60).join('\n')).toBe(first);
  });
});

describe('progressive history layout', () => {
  beforeAll(() => initTheme());

  const largeMessages = (pairs = 100): HistoryMessage[] => Array.from({ length: pairs }, (_, i) => [
    { role: 'user', text: `question ${i}` },
    { role: 'assistant', text: `## answer ${i}\n\n- evidence one\n- evidence two\n\nNewest marker ${i}` },
  ]).flat();
  const largeHistory = (pairs = 100, options: TranscriptModelOptions = {}) => new TranscriptModel(largeMessages(pairs), options);

  it.each([
    ['text', { type: 'text', delta: 'first fresh answer' } satisfies BrainEvent, 'first fresh answer'],
    ['reasoning', { type: 'reasoning', delta: 'first fresh thought' } satisfies BrainEvent, 'Thought'],
    ['tool', { type: 'tool', id: 'first-tool', name: 'read_file', detail: 'src/fresh.ts' } satisfies BrainEvent, 'fresh.ts'],
  ])('journals the first fresh %s turn as a bounded append frame', (_name, event, visibleText) => {
    let visits = 0;
    const transcript = largeHistory(2_000, { onTurnVisit: () => { visits++; } });
    const viewport = new ChatViewport(
      transcriptState(transcript),
      getMarkdownTheme(), () => 18, () => 1, () => 80,
    );
    viewport.render(80);
    visits = 0;
    const heightOperationsBefore = viewport.metrics().heightIndexOperations;

    transcript.apply(event);
    viewport.setState(transcriptState(transcript));
    const firstFrame = viewport.render(80).join('\n');

    expect(firstFrame).toContain(visibleText);
    expect(viewport.metrics().reconciledTurns).toBeLessThanOrEqual(1);
    expect(viewport.metrics().renderedTurns).toBeLessThanOrEqual(1);
    expect(viewport.metrics().layoutVisits).toBeLessThanOrEqual(1);
    expect(viewport.metrics().heightIndexOperations - heightOperationsBefore).toBeLessThanOrEqual(512);
    expect(visits).toBeLessThanOrEqual(3);
  });

  it.each([
    ['tool_progress', { type: 'tool_progress', id: 'missing', text: 'late output' } satisfies BrainEvent],
    ['diff', { type: 'diff', id: 'missing', diff: { title: 'late diff', oldText: 'before', newText: 'after' } } satisfies BrainEvent],
    ['tool_output', { type: 'tool_output', id: 'missing', output: { title: 'late result', kind: 'console', text: 'late output' } } satisfies BrainEvent],
  ])('keeps the first unmatched %s lifecycle append frame bounded', (_name, event) => {
    let visits = 0;
    const transcript = largeHistory(2_000, { onTurnVisit: () => { visits++; } });
    const viewport = new ChatViewport(
      transcriptState(transcript),
      getMarkdownTheme(), () => 18, () => 1, () => 80,
    );
    viewport.render(80);
    visits = 0;
    const heightOperationsBefore = viewport.metrics().heightIndexOperations;

    transcript.apply(event);
    viewport.setState(transcriptState(transcript));
    viewport.render(80);

    expect(viewport.metrics().reconciledTurns).toBeLessThanOrEqual(1);
    expect(viewport.metrics().renderedTurns).toBeLessThanOrEqual(1);
    expect(viewport.metrics().layoutVisits).toBeLessThanOrEqual(1);
    expect(viewport.metrics().heightIndexOperations - heightOperationsBefore).toBeLessThanOrEqual(512);
    expect(visits).toBeLessThanOrEqual(3);
  });

  it('restores a deep logical anchor after resize without rendering Markdown to the old row depth', () => {
    let visits = 0;
    const transcript = largeHistory(4_000, { onTurnVisit: () => { visits++; } });
    let width = 80;
    const viewport = new ChatViewport(
      transcriptState(transcript),
      getMarkdownTheme(), () => 18, () => 1, () => width,
    );
    viewport.render(width);
    viewport.scroll(4_000);
    const before = viewport.render(width).join('\n');
    const beforeMarker = Number(before.match(/Newest marker (\d+)/)?.[1]);
    expect(Number.isFinite(beforeMarker)).toBe(true);
    visits = 0;

    width = 62;
    const after = viewport.render(width).join('\n');
    const afterMarker = Number(after.match(/Newest marker (\d+)/)?.[1]);

    expect(Number.isFinite(afterMarker)).toBe(true);
    expect(Math.abs(afterMarker - beforeMarker)).toBeLessThanOrEqual(100);
    expect(viewport.metrics().renderedTurns).toBeLessThanOrEqual(64);
    expect(viewport.metrics().layoutVisits).toBeLessThanOrEqual(64);
    expect(visits).toBeLessThanOrEqual(96);
  });

  it('restores a deep logical anchor after full history replacement with bounded first-frame work', () => {
    let visits = 0;
    const transcript = new TranscriptModel(largeMessages(2_500), { onTurnVisit: () => { visits++; } });
    const viewport = new ChatViewport(
      transcriptState(transcript),
      getMarkdownTheme(), () => 18, () => 1, () => 80,
    );
    viewport.render(80);
    viewport.scroll(4_000);
    const before = viewport.render(80).join('\n');
    const beforeMarker = Number(before.match(/Newest marker (\d+)/)?.[1]);
    expect(Number.isFinite(beforeMarker)).toBe(true);
    visits = 0;

    transcript.replaceHistory(largeMessages(2_500));
    viewport.setState(transcriptState(transcript));
    const after = viewport.render(80).join('\n');
    const afterMarker = Number(after.match(/Newest marker (\d+)/)?.[1]);

    expect(Number.isFinite(afterMarker)).toBe(true);
    expect(Math.abs(afterMarker - beforeMarker)).toBeLessThanOrEqual(100);
    expect(viewport.metrics().renderedTurns).toBeLessThanOrEqual(64);
    expect(viewport.metrics().layoutVisits).toBeLessThanOrEqual(64);
    expect(visits).toBeLessThanOrEqual(96);
  });

  it('drops a deep anchor when a full replacement belongs to a different conversation', () => {
    const transcript = largeHistory(100);
    const sessionState = (conversationKey: string): ChatViewportState => ({
      ...transcriptState(transcript),
      // This semantic key deliberately differs from a transcript revision: compaction replaces the
      // same conversation and must preserve its anchor, while /resume opens another conversation at tail.
      conversationKey,
    });
    const viewport = new ChatViewport(
      sessionState('conversation-a'),
      getMarkdownTheme(), () => 18, () => 1, () => 80,
    );
    viewport.render(80);
    viewport.scroll(80);
    expect(viewport.render(80).join('\n')).toContain('History');
    expect(viewport.metrics().scrollOffset).toBeGreaterThan(0);

    transcript.replaceHistory(largeMessages(100).map((message) => ({
      ...message,
      text: message.text?.replace('Newest marker', 'Conversation B marker'),
    })));
    viewport.setState(sessionState('conversation-b'));
    const resumed = viewport.render(80).join('\n');

    expect(viewport.metrics().scrollOffset).toBe(0);
    expect(resumed).not.toContain('History');
    expect(resumed).toContain('Conversation B marker 99');
  });

  it('stabilizes estimated heterogeneous rows before freezing frame and pointer geometry', () => {
    const shortHistory = Array.from({ length: 1_000 }, (_, index) => ({
      role: 'assistant' as const, text: `marker ${index}`,
    }));
    const transcript = new TranscriptModel(shortHistory);
    let width = 80;
    const viewport = new ChatViewport(
      transcriptState(transcript),
      getMarkdownTheme(), () => 18, () => 1, () => width,
    );
    viewport.render(width);
    viewport.scroll(200);
    viewport.render(width);

    width = 72;
    viewport.render(width); // enter estimated recovery around the current deep anchor
    transcript.replaceHistory(shortHistory.map((message, index) => index === 200 ? {
      ...message,
      text: [`marker ${index}`, ...Array.from({ length: 150 }, (_, line) => `detail ${line}`)].join('\n'),
    } : message));
    viewport.setState(transcriptState(transcript));
    viewport.render(width); // retain estimated mode, with the heterogeneous old turn still cold

    viewport.scroll(1_000_000);
    viewport.scroll(-400); // estimated two-row turns place turn 200 at the top of the viewport
    const first = viewport.render(width);
    const firstMetrics = viewport.metrics();
    const firstThumb = first.map((line, index) => line.includes('█') ? index : -1).filter((index) => index >= 0);
    const firstHits = firstThumb.map((index) => viewport.isScrollbarHit(width, index + 1));
    const firstMarkerRow = first.findIndex((line) => line.includes('marker 200'));
    expect(firstMarkerRow).toBeGreaterThanOrEqual(0);
    expect(viewport.beginSelect(5, firstMarkerRow + 1)).toBe(true);
    viewport.dragSelect(firstMarkerRow + 2);
    const firstCopy = viewport.takeSelection();

    const second = viewport.render(width);
    const secondMetrics = viewport.metrics();
    const secondThumb = second.map((line, index) => line.includes('█') ? index : -1).filter((index) => index >= 0);
    const secondHits = secondThumb.map((index) => viewport.isScrollbarHit(width, index + 1));
    const secondMarkerRow = second.findIndex((line) => line.includes('marker 200'));
    expect(secondMarkerRow).toBe(firstMarkerRow);
    expect(viewport.beginSelect(5, secondMarkerRow + 1)).toBe(true);
    viewport.dragSelect(secondMarkerRow + 2);
    const secondCopy = viewport.takeSelection();

    expect(second).toEqual(first);
    expect(secondMetrics.transcriptRows).toBe(firstMetrics.transcriptRows);
    expect(secondMetrics.scrollOffset).toBe(firstMetrics.scrollOffset);
    expect(secondMetrics.maxScrollOffset).toBe(firstMetrics.maxScrollOffset);
    expect(firstMetrics.renderedTurns).toBeLessThanOrEqual(64);
    expect(secondMetrics.renderedTurns).toBe(0);
    expect(secondThumb).toEqual(firstThumb);
    expect(firstHits.every(Boolean)).toBe(true);
    expect(secondHits).toEqual(firstHits);
    expect(secondCopy).toBe(firstCopy);
    expect(firstCopy).toContain('marker 200');
  });

  it('materializes past a tall estimated anchor so a following short turn cannot mutate a frozen frame', () => {
    const history = (rows: (index: number) => number) => Array.from({ length: 200 }, (_, index) => ({
      role: 'assistant' as const,
      text: [
        `marker ${index}`,
        ...Array.from({ length: Math.max(0, rows(index) - 1) }, (_, row) => `detail ${index}-${row}`),
      ].join('\n'),
    }));
    const transcript = new TranscriptModel(history(() => 80));
    let width = 80;
    const viewport = new ChatViewport(
      transcriptState(transcript),
      getMarkdownTheme(), () => 18, () => 1, () => width,
    );
    viewport.render(width);
    viewport.scroll(1_000_000);
    viewport.render(width);

    // Every original turn is 81 rendered rows. Position the viewport 94% through turn 50, then
    // resize so the next history replacement must recover that logical intra-turn anchor.
    const target = 50;
    const targetTop = 1 + target * 81 + Math.floor(81 * 0.94);
    viewport.scroll(-targetTop);
    viewport.render(width);
    width = 72;
    viewport.render(width);

    transcript.replaceHistory(history((index) => index === target ? 150 : index === target + 1 ? 1 : 80));
    viewport.setState(transcriptState(transcript));

    const capture = () => {
      const frame = viewport.render(width);
      const metrics = viewport.metrics();
      const thumb = frame.map((line, index) => line.includes('█') ? index : -1).filter((index) => index >= 0);
      const hits = thumb.map((index) => viewport.isScrollbarHit(width, index + 1));
      expect(viewport.beginSelect(5, 1)).toBe(true);
      viewport.dragSelect(2);
      return {
        frame,
        geometry: {
          transcriptRows: metrics.transcriptRows,
          visibleRows: metrics.visibleRows,
          scrollOffset: metrics.scrollOffset,
          maxScrollOffset: metrics.maxScrollOffset,
          indexedTurns: metrics.indexedTurns,
        },
        renderedTurns: metrics.renderedTurns,
        layoutVisits: metrics.layoutVisits,
        thumb,
        hits,
        copy: viewport.takeSelection(),
      };
    };

    const first = capture();
    const second = capture();

    expect(first.frame.some((line) => line.includes('detail 50-'))).toBe(true);
    expect(second.frame).toEqual(first.frame);
    expect(second.geometry).toEqual(first.geometry);
    expect(second.thumb).toEqual(first.thumb);
    expect(first.hits.every(Boolean)).toBe(true);
    expect(second.hits).toEqual(first.hits);
    expect(second.copy).toBe(first.copy);
    expect(first.copy).toContain('detail 50-');
    expect(first.renderedTurns).toBeLessThanOrEqual(64);
    expect(first.layoutVisits).toBeLessThanOrEqual(64);
    expect(second.renderedTurns).toBe(0);
  });

  it('bounds a viewport spanning more than 64 estimated turns by visible rows, not history depth', () => {
    const transcript = new TranscriptModel(Array.from({ length: 40_000 }, (_, index) => ({
      role: 'assistant' as const,
      text: `marker ${index}`,
    })));
    let width = 80;
    const height = 160;
    const visibleWorkBound = height + 8 + 1;
    const viewport = new ChatViewport(
      transcriptState(transcript),
      getMarkdownTheme(), () => height, () => 1, () => width,
    );
    viewport.render(width);
    viewport.scroll(500);
    viewport.render(width);

    // The deep viewport spans eighty two-row turns. Resizing cold-resets a 40k history, but the
    // Markdown work must depend only on the 160 visible rows plus overscan.
    width = 72;

    const first = viewport.render(width);
    const firstMetrics = viewport.metrics();
    const second = viewport.render(width);
    const secondMetrics = viewport.metrics();

    expect(first.some((line) => line.includes('marker'))).toBe(true);
    expect(second).toEqual(first);
    expect(secondMetrics.transcriptRows).toBe(firstMetrics.transcriptRows);
    expect(secondMetrics.scrollOffset).toBe(firstMetrics.scrollOffset);
    expect(secondMetrics.maxScrollOffset).toBe(firstMetrics.maxScrollOffset);
    expect(firstMetrics.renderedTurns).toBeLessThanOrEqual(visibleWorkBound);
    expect(firstMetrics.layoutVisits).toBeLessThanOrEqual(visibleWorkBound);
    expect(secondMetrics.renderedTurns).toBe(0);
    expect(secondMetrics.layoutVisits).toBeLessThanOrEqual(visibleWorkBound);
  });

  it('reads turns and sparse revisions directly from TranscriptModel', () => {
    const transcript = largeHistory(20);
    const viewport = new ChatViewport(
      { transcript, transcriptNotice: transcript.notice, notice: '', modelName: 'kimi', thinkingSeconds: 0 },
      getMarkdownTheme(), () => 8, () => 1, () => 60,
    );

    expect(viewport.render(60).join('\n')).toContain('Newest marker 19');
    transcript.apply({ type: 'user', text: 'revision handoff' });
    viewport.setState({
      transcript,
      transcriptNotice: transcript.notice,
      notice: '', modelName: 'kimi', thinkingSeconds: 0,
    });
    expect(viewport.render(60).join('\n')).toContain('revision handoff');
    expect(viewport.metrics().reconciledTurns).toBeLessThanOrEqual(1);
  });

  it('paints only the exact tail and leaves untouched history cold until the user scrolls', async () => {
    vi.useFakeTimers();
    const view = largeHistory();
    const viewport = new ChatViewport(
      viewportState(view),
      getMarkdownTheme(), () => 6, () => 1, () => 60,
    );

    const first = viewport.render(60).join('\n');
    expect(first).toContain('Newest marker 99');
    expect(viewport.metrics().indexedTurns).toBeLessThan(20);
    expect(viewport.metrics().indexedTurns).toBeLessThan(view.turnCount);
    expect(viewport.metrics().transcriptRowsExact).toBe(false);
    const thumbRow = viewport.render(60).findIndex((line) => line.includes('█')) + 1;
    expect(thumbRow).toBeGreaterThan(0);
    expect(viewport.isScrollbarHit(60, thumbRow)).toBe(true);
    expect(first).toContain('█');

    const afterFirstPaint = viewport.metrics().indexedTurns;
    await vi.runAllTimersAsync();
    expect(viewport.metrics().indexedTurns).toBe(afterFirstPaint); // no idle full-history CPU pass
    expect(viewport.metrics().transcriptRowsExact).toBe(false);
    viewport.scroll(30);
    expect(viewport.metrics().indexedTurns).toBeGreaterThan(afterFirstPaint);
    expect(viewport.metrics().cachedRows).toBeLessThanOrEqual(CHAT_VIEWPORT_ROW_CACHE_LIMIT);
  });

  it('PageUp indexes just enough older turns and keeps an exact bottom-relative offset', () => {
    vi.useFakeTimers();
    const viewport = new ChatViewport(
      viewportState(largeHistory()),
      getMarkdownTheme(), () => 6, () => 1, () => 60,
    );
    viewport.render(60);
    const initiallyIndexed = viewport.metrics().indexedTurns;
    viewport.scroll(30);
    expect(viewport.metrics().indexedTurns).toBeGreaterThan(initiallyIndexed);
    expect(viewport.metrics().transcriptRowsExact).toBe(false);
    const beforeDrag = viewport.render(60).map((line) => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
    expect(beforeDrag).toContain('History +30 lines');
    const beforeDragIndexed = viewport.metrics().indexedTurns;
    const thumbRow = viewport.render(60).findIndex((line) => line.includes('█')) + 1;
    viewport.beginScrollbarDrag(thumbRow);
    viewport.updateScrollbarDrag(1);
    viewport.endScrollbarDrag();
    const afterDrag = viewport.render(60).map((line) => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
    expect(viewport.metrics().indexedTurns).toBeGreaterThan(beforeDragIndexed);
    expect(afterDrag).toMatch(/History \+([3-9]\d|\d{3,}) lines/);
  });

  it('finishes a normal history index on grab so the thumb becomes exact', () => {
    const viewport = new ChatViewport(
      viewportState(largeHistory(12)),
      getMarkdownTheme(), () => 6, () => 1, () => 60,
    );
    viewport.render(60);
    expect(viewport.metrics().transcriptRowsExact).toBe(false);
    const thumbRow = viewport.render(60).findIndex((line) => line.includes('█')) + 1;
    viewport.beginScrollbarDrag(thumbRow);
    viewport.updateScrollbarDrag(1);
    viewport.endScrollbarDrag();
    expect(viewport.metrics().transcriptRowsExact).toBe(true);
    expect(viewport.render(60).join('\n')).toMatch(/History.*\+\d+ lines/);
  });

  it('bounds progressive indexing for a huge history on each drag sample', () => {
    const view = largeHistory(5_000);
    const viewport = new ChatViewport(
      viewportState(view),
      getMarkdownTheme(), () => 12, () => 1, () => 80,
    );
    viewport.render(80);
    const before = viewport.metrics().indexedTurns;
    const thumbRow = viewport.render(80).findIndex((line) => line.includes('█')) + 1;
    viewport.beginScrollbarDrag(thumbRow);
    viewport.updateScrollbarDrag(1);
    viewport.endScrollbarDrag();
    expect(viewport.metrics().indexedTurns).toBeGreaterThan(before);
    expect(viewport.metrics().indexedTurns).toBeLessThan(view.turnCount);
    expect(viewport.render(80).join('\n')).toMatch(/History.*\+\d+ lines/);
  });

  it('preserves the pointer offset when grabbing a multi-row scrollbar thumb', () => {
    const viewport = new ChatViewport(
      viewportState(largeHistory(24)),
      getMarkdownTheme(), () => 24, () => 1, () => 80,
    );
    viewport.render(80);
    viewport.scroll(1_000_000);
    viewport.render(80);
    viewport.scroll(-Math.floor(viewport.metrics().transcriptRows / 2));
    const before = viewport.render(80);
    const thumbRows = before
      .map((line, index) => line.includes('█') ? index + 1 : 0)
      .filter(Boolean);
    expect(thumbRows.length).toBeGreaterThan(1);
    const grabbedRow = thumbRows.at(-1)!;
    const beforeOffset = viewport.metrics().scrollOffset;

    expect(viewport.beginScrollbarDrag(grabbedRow)).toBe(false);
    viewport.updateScrollbarDrag(grabbedRow);

    expect(viewport.metrics().scrollOffset).toBe(beforeOffset);
    viewport.endScrollbarDrag();
  });

  it('continues a bounded drag toward old history without another pointer event', () => {
    const view = largeHistory(5_000);
    const viewport = new ChatViewport(
      viewportState(view),
      getMarkdownTheme(), () => 12, () => 1, () => 80,
    );
    const first = viewport.render(80);
    const thumbRow = first.findIndex((line) => line.includes('█')) + 1;
    expect(thumbRow).toBeGreaterThan(0);
    expect(viewport.beginScrollbarDrag(thumbRow)).toBe(false);
    let pending = viewport.updateScrollbarDrag(1);
    const afterPointerEvent = viewport.metrics().indexedTurns;
    expect(pending).toBe(true);
    expect(afterPointerEvent).toBeLessThan(view.turnCount);

    let continuations = 0;
    while (pending && continuations < 200) {
      pending = viewport.continueScrollbarDrag();
      continuations++;
    }

    expect(pending).toBe(false);
    expect(continuations).toBeGreaterThan(1);
    expect(viewport.metrics().transcriptRowsExact).toBe(true);
    expect(viewport.metrics().scrollOffset).toBe(viewport.metrics().maxScrollOffset);
    viewport.endScrollbarDrag();
  });

  it('invalidates only the turn that owns an expanded Thought', () => {
    const view = transcriptWith(
      [{ role: 'assistant', text: 'ORIGINAL settled answer' }],
      [
        { type: 'reasoning', delta: 'summary words followed by the hidden expanded detail' },
        { type: 'idle' },
      ],
    );
    const viewport = new ChatViewport(
      viewportState(view),
      getMarkdownTheme(), () => 20, () => 1, () => 72,
    );
    const first = viewport.render(72);
    const thoughtRow = first.findIndex((line) => line.includes('Thought'));
    expect(thoughtRow).toBeGreaterThanOrEqual(0);
    const oldTurn = view.turnAt(0)!;
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
      viewportState(view),
      getMarkdownTheme(), () => 6, () => 1, () => width,
    );
    viewport.render(width);
    width = 72;
    const resized = viewport.render(width).join('\n');
    expect(resized).toContain('Newest marker 99');
    expect(viewport.metrics().transcriptRowsExact).toBe(false);
    expect(viewport.metrics().indexedTurns).toBeLessThan(20);
  });

  it('reports viewport-sized work and renders no settled Markdown again during cached scroll', () => {
    const viewport = new ChatViewport(
      viewportState(largeHistory(1_000)),
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
    const transcript = largeHistory(1_000);
    const viewport = new ChatViewport(
      transcriptState(transcript),
      getMarkdownTheme(), () => 18, () => 1, () => 80,
    );
    viewport.render(80);
    transcript.apply({ type: 'text', delta: '' });
    viewport.setState(transcriptState(transcript));
    viewport.render(80);
    transcript.apply({ type: 'text', delta: 'one streaming token' });
    viewport.setState(transcriptState(transcript));
    viewport.render(80);
    expect(viewport.metrics().reconciledTurns).toBeLessThanOrEqual(1);
    expect(viewport.metrics().renderedTurns).toBeLessThanOrEqual(1);
  });

  it('accumulates a coalesced user and assistant burst without scanning settled history', () => {
    const transcript = largeHistory(5_000);
    const viewport = new ChatViewport(
      transcriptState(transcript),
      getMarkdownTheme(), () => 18, () => 1, () => 80,
    );
    viewport.render(80);

    // The frame scheduler may fold this whole event sequence into one paint. Change metadata must retain
    // the append even though the final event itself only mutates the new assistant tail.
    transcript.apply({ type: 'user', text: 'coalesced question' });
    transcript.apply({ type: 'text', delta: 'first token' });
    transcript.apply({ type: 'tool', id: 't-coalesced', name: 'read_file', detail: 'src/index.ts' });
    viewport.setState(transcriptState(transcript));
    viewport.render(80);

    expect(viewport.metrics().reconciledTurns).toBeLessThanOrEqual(2);
    expect(viewport.metrics().renderedTurns).toBeLessThanOrEqual(2);
  });

  it('updates a fully indexed 10k-turn streaming tail without walking settled heights', () => {
    const transcript = largeHistory(5_000);
    const viewport = new ChatViewport(
      transcriptState(transcript),
      getMarkdownTheme(), () => 18, () => 1, () => 80,
    );
    viewport.render(80);
    viewport.scroll(1_000_000);
    viewport.render(80);
    expect(viewport.metrics().transcriptRowsExact).toBe(true);

    transcript.apply({ type: 'text', delta: '' });
    viewport.setState(transcriptState(transcript));
    viewport.render(80);
    transcript.apply({ type: 'text', delta: 'streaming after full index' });
    viewport.setState(transcriptState(transcript));
    viewport.render(80);

    expect(viewport.metrics().layoutVisits).toBeLessThan(20);
    expect(viewport.metrics().renderedTurns).toBeLessThanOrEqual(1);
  });

  it('patches old sub-agent progress without rebuilding the later 5k-turn suffix', () => {
    const history = [
      { role: 'assistant', text: '', segments: [{ kind: 'tool' as const, id: 'delegate-old', name: 'delegate', detail: 'old child' }] },
      ...Array.from({ length: 4_999 }, (_, index) => ({ role: 'assistant', text: `settled answer ${index}` })),
    ];
    const transcript = new TranscriptModel(history);
    const viewport = new ChatViewport(
      transcriptState(transcript),
      getMarkdownTheme(), () => 18, () => 1, () => 80,
    );
    viewport.render(80);
    viewport.scroll(1_000_000);
    viewport.render(80);
    expect(viewport.metrics().transcriptRowsExact).toBe(true);
    viewport.scroll(-1_000_000);
    viewport.render(80);
    const bottomBefore = [...(viewport as unknown as { lastPlainRows: string[] }).lastPlainRows];

    transcript.apply({
      type: 'subagent', id: 'delegate-old', sessionId: 'child-old', status: 'running',
      task: 'old child', detail: 'still checking', tools: 3, seconds: 9,
    });
    viewport.setState(transcriptState(transcript));
    viewport.render(80);
    const bottomAfter = (viewport as unknown as { lastPlainRows: string[] }).lastPlainRows;

    expect(viewport.metrics().reconciledTurns).toBeLessThanOrEqual(1);
    expect(viewport.metrics().renderedTurns).toBeLessThanOrEqual(1);
    expect(viewport.metrics().layoutVisits).toBeLessThanOrEqual(1);
    expect(bottomAfter).toEqual(bottomBefore);
  });

  it('keeps 1,200 old-turn height replacements and viewport offset lookups logarithmic', () => {
    const updates = 1_200;
    const history = [
      ...Array.from({ length: updates }, (_, index) => ({
        role: 'assistant' as const,
        text: '',
        segments: [{ kind: 'tool' as const, id: `delegate-${index}`, name: 'delegate', detail: `child ${index}` }],
      })),
      ...Array.from({ length: 200 }, (_, index) => ({ role: 'assistant' as const, text: `tail ${index}` })),
    ];
    const transcript = new TranscriptModel(history);
    const viewport = new ChatViewport(
      transcriptState(transcript),
      getMarkdownTheme(), () => 18, () => 1, () => 80,
    );
    viewport.render(80);
    viewport.scroll(1_000_000);
    viewport.render(80);
    expect(viewport.metrics().transcriptRowsExact).toBe(true);
    viewport.scroll(-1_000_000);
    viewport.render(80);
    const heightOperationsBefore = viewport.metrics().heightIndexOperations;

    for (let index = 0; index < updates; index += 1) {
      transcript.apply({
        type: 'subagent', id: `delegate-${index}`, sessionId: `child-${index}`, status: 'running',
        task: `child ${index}`, detail: 'checking', tools: 1, seconds: index,
      });
      viewport.setState(transcriptState(transcript));
      viewport.render(80);
    }

    const logarithmicFrameBound = updates * 12 * (Math.ceil(Math.log2(transcript.turnCount)) + 1);
    const heightOperations = viewport.metrics().heightIndexOperations - heightOperationsBefore;
    expect(heightOperations).toBeGreaterThan(updates);
    expect(heightOperations).toBeLessThanOrEqual(logarithmicFrameBound);
  });

  it('keeps height-index operation evidence monotonic across a full layout replacement', () => {
    const turnCount = 2_500;
    const messages = Array.from({ length: turnCount }, (_, index) => ({
      role: 'assistant' as const,
      text: `before replacement ${index}`,
    }));
    const transcript = new TranscriptModel(messages);
    const viewport = new ChatViewport(
      transcriptState(transcript),
      getMarkdownTheme(), () => 18, () => 1, () => 80,
    );
    viewport.render(80);
    viewport.scroll(1_000_000);
    viewport.render(80);
    const before = viewport.metrics();

    transcript.replaceHistory(messages.map((message, index) => ({
      ...message,
      text: `after replacement ${index}`,
    })));
    viewport.setState(transcriptState(transcript));
    viewport.render(80);
    const after = viewport.metrics();

    expect(after.heightIndexOperations).toBeGreaterThan(before.heightIndexOperations);
    expect(after.heightIndexOperations - before.heightIndexOperations).toBeGreaterThanOrEqual(turnCount);
    expect(after.frameHeightIndexOperations).toBeGreaterThanOrEqual(turnCount);
  });

  it('charges pre-render scroll and drag indexing to the next frame exactly once', () => {
    const transcript = new TranscriptModel(Array.from({ length: 40_000 }, (_, index) => ({
      role: 'assistant' as const,
      text: `scroll evidence ${index}`,
    })));
    const viewport = new ChatViewport(
      transcriptState(transcript),
      getMarkdownTheme(), () => 18, () => 1, () => 80,
    );
    const first = viewport.render(80);
    const beforeScroll = viewport.metrics().heightIndexOperations;

    viewport.scroll(200);
    const afterSynchronousScroll = viewport.metrics().heightIndexOperations;
    expect(afterSynchronousScroll).toBeGreaterThan(beforeScroll);
    viewport.render(80);
    const afterScrollFrame = viewport.metrics();
    expect(afterScrollFrame.frameHeightIndexOperations)
      .toBe(afterScrollFrame.heightIndexOperations - beforeScroll);

    const beforeRepeat = afterScrollFrame.heightIndexOperations;
    viewport.render(80);
    const repeated = viewport.metrics();
    expect(repeated.frameHeightIndexOperations).toBe(repeated.heightIndexOperations - beforeRepeat);
    expect(repeated.frameHeightIndexOperations).toBeLessThan(afterScrollFrame.frameHeightIndexOperations);

    const thumbRow = first.findIndex((line) => line.includes('█')) + 1;
    expect(thumbRow).toBeGreaterThan(0);
    const beforeDrag = repeated.heightIndexOperations;
    viewport.beginScrollbarDrag(thumbRow);
    const pending = viewport.updateScrollbarDrag(1);
    expect(viewport.metrics().heightIndexOperations).toBeGreaterThan(beforeDrag);
    viewport.render(80);
    const afterDragFrame = viewport.metrics();
    expect(afterDragFrame.frameHeightIndexOperations)
      .toBe(afterDragFrame.heightIndexOperations - beforeDrag);

    if (pending) {
      const beforeContinuation = afterDragFrame.heightIndexOperations;
      viewport.continueScrollbarDrag();
      viewport.render(80);
      const continued = viewport.metrics();
      expect(continued.frameHeightIndexOperations)
        .toBe(continued.heightIndexOperations - beforeContinuation);
    }
    viewport.endScrollbarDrag();
  });
});
