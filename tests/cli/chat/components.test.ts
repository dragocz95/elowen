import { describe, it, expect, beforeAll } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { UserBlock, StatusBar, CardPanel, SubagentPanel, ProcessPanel, QueuedMessages, ApprovalDock, diffBlock, cardBlock, toolOutputBlock } from '../../../src/cli/chat/components.js';

describe('chat components', () => {
  beforeAll(() => { initTheme(); }); // renderDiff needs the pi theme
  it('UserBlock renders full-width rows with a left rail and padding', () => {
    const lines = new UserBlock('ahoj').render(20);
    // blank top, one text row, blank bottom
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(visibleWidth(l)).toBe(20); // every row fills the width
    expect(lines[1]).toContain('ahoj');
  });

  it('projects untrusted user, queue, card, sub-agent, and approval text', () => {
    const dangerous = 'visible\ttext\x1b[2J\x1b]52;c;Zm9yZ2Vk\x07';
    const user = new UserBlock(dangerous).render(40).join('\n');
    const queue = new QueuedMessages();
    queue.set([{ id: 'q', text: dangerous }], dangerous);
    const card = cardBlock({ id: 'c', title: dangerous, pinned: true, items: [{ text: dangerous, status: 'pending' }] }).join('\n');
    const agents = new SubagentPanel();
    agents.set([{ sessionId: 's', task: dangerous, detail: dangerous, status: 'running', tools: 1, seconds: 1 }]);
    const approval = new ApprovalDock({
      tui: { requestRender: (): void => {} } as never,
      question: { header: dangerous, question: dangerous, options: [{ label: dangerous, description: dangerous }] },
      onPick: (): void => {},
    }).render(72).join('\n');
    const rendered = [user, queue.render(72).join('\n'), card, agents.render(72).join('\n'), approval].join('\n');

    expect(rendered).toContain('visible');
    expect(rendered).not.toContain('\t');
    expect(rendered).not.toContain('\x1b[2J');
    expect(rendered).not.toContain('\x1b]52;');
  });

  it('QueuedMessages renders nothing while empty, then a QUEUED pill line per pending item + a hint', () => {
    const q = new QueuedMessages();
    expect(q.render(40)).toEqual([]); // empty → zero rows at rest
    q.set([{ id: 'a', text: 'check the logs' }, { id: 'b', text: 'and the metrics' }], 'ctrl+x x removes the last queued message');
    const lines = q.render(60);
    expect(lines).toHaveLength(3); // two pending lines + the remove hint
    expect(lines[0]).toContain('QUEUED');
    expect(lines[0]).toContain('check the logs');
    expect(lines[1]).toContain('and the metrics');
    expect(lines[2]).toContain('removes the last');
  });

  it('QueuedMessages truncates a long pending message to the width and drops the hint when unset', () => {
    const q = new QueuedMessages();
    q.set([{ id: 'a', text: 'x'.repeat(400) }]); // no hint
    const lines = q.render(30);
    expect(lines).toHaveLength(1); // just the one line, no hint row
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(30);
    expect(lines[0]).toContain('…'); // truncated
  });

  it('QueuedMessages reports its uncapped desired rows until the central layout assigns a cap', () => {
    const q = new QueuedMessages();
    q.set(Array.from({ length: 9 }, (_, i) => ({ id: String(i), text: `msg ${i}` })));
    const lines = q.render(40);
    expect(lines).toHaveLength(9);
    expect(lines.at(-1)).toContain('msg 8');
  });

  it('QueuedMessages obeys the shell hard cap even when the queue and hint are large', () => {
    const q = new QueuedMessages();
    q.setMaxRows(2);
    q.set(Array.from({ length: 9 }, (_, i) => ({ id: String(i), text: `msg ${i}` })), 'remove hint');
    const lines = q.render(40);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('more queued');
  });

  it('StatusBar justifies left and right to the edges', () => {
    const [line] = new StatusBar('L', 'R').render(10);
    expect(visibleWidth(line!)).toBe(10);
    expect(line!.startsWith('L')).toBe(true);
    expect(line!.endsWith('R')).toBe(true);
  });

  it('diffBlock renders the pi format via renderDiff and the legacy format with row colors', () => {
    const pi = diffBlock('-    2 line two\n+    2 line 2');
    expect(pi.join('\n')).toContain('line two');
    expect(pi.join('\n')).toContain('line 2');
    const legacy = diffBlock('   2 - old\n   2 + new');
    expect(legacy[0]).toContain('old');
    expect(legacy[1]).toContain('new');
  });

  it('diffBlock keeps add/delete colouring active across the whole row', () => {
    const [line] = diffBlock('+    6 $number = 2026;', 60, 40);
    const beforeText = line!.slice(0, line!.indexOf('$number'));
    expect(beforeText).not.toContain('\x1b[0m');
  });

  it('diffBlock caps long diffs with a more-lines note', () => {
    const diff = Array.from({ length: 70 }, (_, i) => `+ ${String(i + 1).padStart(4)} row`).join('\n');
    const out = diffBlock(diff);
    expect(out).toHaveLength(61);
    expect(out[60]).toContain('+10 more lines');
  });

  it('encodes persisted tool output as terminal-safe printable rows', () => {
    const lines = toolOutputBlock({
      title: 'console output',
      kind: 'console',
      command: 'du\t-xhd2',
      status: 'exit 0',
      text: '984M\t/var/www/.local\rupdated\x1b[31mRED\x1b[0m\x1b]52;c;bad\x07\nnext\b!',
    }, 60);
    const rendered = lines.join('\n');
    const plain = rendered.replace(/\x1b\[[0-9;]*m/g, '');

    expect(rendered).not.toContain('\t');
    expect(rendered).not.toContain('\r');
    expect(rendered).not.toContain('\x1b]52;');
    expect(plain).toContain('984M');
    expect(plain).toContain('/var/www/.local');
    expect(plain).not.toContain('exit 0');
    expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
  });

  it('keeps a non-zero tool exit visible', () => {
    const rendered = toolOutputBlock({
      title: 'console output', kind: 'console', text: 'failed', status: '[exit 2]', tone: 'danger',
    }, 60).join('\n');
    expect(rendered).toContain('[exit 2]');
  });

  it('keeps already fitted styled tool rows on the nested-block fast path', () => {
    const output = {
      title: 'console output',
      kind: 'console' as const,
      text: Array.from({ length: 7 }, (_, index) => `result ${index} ${'x'.repeat(130)}`).join('\n'),
    };
    toolOutputBlock(output, 180); // warm theme/segmenter/JIT
    const startedAt = performance.now();
    for (let index = 0; index < 20; index++) toolOutputBlock(output, 180);
    expect(performance.now() - startedAt).toBeLessThan(40);
  });

  it('still truncates an overflowing nested tool row inside the terminal width', () => {
    const lines = toolOutputBlock({
      title: 'tool result', kind: 'text', text: `prefix-${'界'.repeat(200)}-unsafe-tail`,
    }, 40);
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    expect(lines.join('\n')).not.toContain('unsafe-tail');
  });

  it('CardPanel renders pinned cards as real rows and collapses an all-done checklist / non-pinned cards', () => {
    const panel = new CardPanel();
    expect(panel.render(80)).toEqual([]); // no cards → the panel disappears from the fixed stack
    panel.set([{ id: 'todos', title: 'Todos', pinned: true, items: [{ text: 'One', status: 'pending' }, { text: 'Two', status: 'completed' }] }]);
    const lines = panel.render(80);
    expect(lines.length).toBe(3); // header + 2 rows, as separate lines (not one \n-joined string)
    expect(lines.every((l) => !l.includes('\n'))).toBe(true);
    // A non-pinned card never enters the fixed panel.
    panel.set([{ id: 'x', pinned: false, items: [{ text: 'One', status: 'pending' }] }]);
    expect(panel.render(80)).toEqual([]);
    // Everything completed → the work is done, so the checklist card collapses.
    panel.set([{ id: 'todos', title: 'Todos', pinned: true, items: [{ text: 'One', status: 'completed' }] }]);
    expect(panel.render(80)).toEqual([]);
  });

  it('CardPanel clips a large Todo card to its assigned row budget', () => {
    const panel = new CardPanel();
    panel.setMaxRows(3);
    panel.set([{
      id: 'todos', title: 'Todos', pinned: true,
      items: Array.from({ length: 20 }, (_, i) => ({ text: `Task ${i}`, status: 'pending' as const })),
    }]);
    const lines = panel.render(80);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('more');
    expect(lines[2]).toContain('\x1b[4m');
    expect(panel.isHeaderRow(0)).toBe(true);
    expect(panel.isMoreRow(2)).toBe(true);
    panel.toggleExpanded();
    expect(panel.isExpanded()).toBe(true);
    panel.setMaxRows(30);
    expect(panel.render(80).join('\n')).toContain('Task 19');
  });

  it('cardBlock renders a compact todo checklist plus optional body', () => {
    const out = cardBlock({
      id: 'todos', title: 'Todos',
      items: [
        { text: 'Alpha', status: 'completed' },
        { text: 'Beta', status: 'in_progress' },
        { text: 'Gamma', status: 'pending' },
      ],
      body: 'note line',
    });
    expect(out[0]).toContain('Todos');
    const body = out.join('\n');
    expect(body).toContain('[x]'); // completed
    expect(body).toContain('[•]'); // in-progress
    expect(body).toContain('[ ]'); // pending
    expect(body).toContain('Alpha');
    expect(body).toContain('note line');
  });
});

describe('SubagentPanel', () => {
  const running = { sessionId: 'brain-ch-subagent-a', task: 'research the config layer', status: 'running' as const, detail: 'read_file src/a.ts', tools: 2, tokens: 12000, seconds: 8 };

  it('renders nothing when no sub-agent runs (settled entries are dropped)', () => {
    const p = new SubagentPanel();
    p.set([{ ...running, status: 'done' }]);
    expect(p.render(80)).toEqual([]);
  });

  it('lists running agents with task + live counters, and maps rows to their session', () => {
    const p = new SubagentPanel();
    p.set([running]);
    const lines = p.render(80).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    expect(lines[0]).toContain('Sub-agents');
    expect(lines[0]).toContain('1 running');
    expect(lines[1]).toContain('research the config layer');
    expect(lines[1]).toContain('8s');
    expect(lines[1]).toContain('12k tok');
    expect(p.targetAt(1)).toBe('brain-ch-subagent-a');
    expect(p.targetAt(0)).toBeNull();
  });

  it('caps running sub-agents and exposes click targets only for rendered rows', () => {
    const p = new SubagentPanel();
    p.setMaxRows(3);
    p.set(Array.from({ length: 8 }, (_, i) => ({ ...running, sessionId: `child-${i}`, task: `task ${i}` })));
    expect(p.render(80)).toHaveLength(3);
    expect(p.targetAt(1)).toBe('child-0');
    expect(p.targetAt(2)).toBe('child-1');
    expect(p.targetAt(3)).toBeNull();
    p.setMaxRows(0);
    expect(p.render(80)).toEqual([]);
    expect(p.isHeaderRow(0)).toBe(false);
  });
});

describe('ProcessPanel', () => {
  const now = 100_000;
  const proc = (over: Partial<{ id: string; command: string; running: boolean; startedAt: string }> = {}) => ({
    id: 'p1', command: 'npm run build', cwd: '/var/www/elowen', exitCode: null,
    startedAt: new Date(now - 8_000).toISOString(), running: true, ...over,
  });

  it('renders nothing when no process is running (exited ones are dropped)', () => {
    const p = new ProcessPanel();
    p.set([proc({ running: false })]);
    expect(p.render(80, now)).toEqual([]);
  });

  it('lists running processes with command + runtime and a clickable ✕, mapping the ✕ column to a kill', () => {
    const p = new ProcessPanel();
    p.set([proc()]);
    const raw = p.render(80, now).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    expect(raw[0]).toContain('Processes');
    expect(raw[0]).toContain('1 running');
    expect(raw[1]).toContain('npm run build');
    expect(raw[1]).toContain('8s');
    expect(raw[1]).toContain('✕');
    // The ✕ is the last visible glyph — a click on its column kills p1, a click elsewhere does not.
    const killCol = visibleWidth(p.render(80, now)[1]!);
    expect(p.killAt(1, killCol)).toBe('p1');
    expect(p.killAt(1, 4)).toBeNull(); // the command area is not a kill target
    expect(p.killAt(0, killCol)).toBeNull(); // the header row carries no ✕
  });

  it('collapses to just the header (no rows, no kill zones) when toggled', () => {
    const p = new ProcessPanel();
    p.set([proc()]);
    p.toggleCollapsed();
    const lines = p.render(80, now);
    expect(lines).toHaveLength(1);
    expect(p.isHeaderRow(0)).toBe(true);
    expect(p.killAt(1, 79)).toBeNull();
  });

  it('caps a large process list and never leaves kill zones for clipped rows', () => {
    const p = new ProcessPanel();
    p.setMaxRows(3);
    p.set(Array.from({ length: 8 }, (_, i) => proc({ id: `p${i}`, command: `job ${i}` })));
    const lines = p.render(50, now);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('more running');
    expect(p.killAt(3, 50)).toBeNull();
  });
});
