import { beforeAll, describe, expect, it } from 'vitest';
import { getMarkdownTheme, initTheme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { beginAssistant, emptyView, pushUser, reduce } from '../../../src/brain/transcript.js';
import { ChatViewport, mouseWheel, SlashOverlay, TelemetryPanel } from '../../../src/cli/chat/layout.js';

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

  it('renders telemetry panel without duplicating the model name', () => {
    const panel = new TelemetryPanel(() => ({
      workMode: 'build',
      usage: { tokens: 10, contextWindow: 100, percent: 10, totalTokens: 20, cost: 0 },
      running: true,
      runSeconds: 12,
      cwd: '~/orca',
      branch: 'main',
    }));
    const rows = panel.render(36);
    expect(rows.every((line) => visibleWidth(line) === 36)).toBe(true);
    expect(rows.join('\n')).not.toContain('kimi');
    expect(rows.join('\n')).toContain('Context');
    expect(rows.join('\n')).toContain('Build');
    expect(rows.join('\n')).toContain('Project');
    expect(rows.join('\n')).not.toContain('reasoning');
    expect(rows.join('\n')).not.toContain('theme');
    expect(rows.join('\n')).not.toContain('Dev');
  });
});
