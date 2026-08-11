import { describe, it, expect, vi } from 'vitest';
import { Container, visibleWidth } from '@earendil-works/pi-tui';
import type { Component, Editor, TUI } from '@earendil-works/pi-tui';
import { AskChoiceDock, runAskFlow } from '../../../src/cli/chat/askFlow.js';
import type { AskQuestion } from '../../../src/brain/events.js';

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

const question = (multiSelect = true): AskQuestion => ({
  question: 'What should Elowen do next?',
  header: 'Next',
  multiSelect,
  options: [
    { label: 'Run focused tests', description: 'chat UI and ask flow' },
    { label: 'Run typecheck', description: 'catch TypeScript drift' },
    { label: 'Smoke terminal', description: 'manual TTY pass' },
  ],
});

const fakeTui = (): TUI => ({
  requestRender: vi.fn(),
  setFocus: vi.fn(),
}) as unknown as TUI;

describe('AskChoiceDock', () => {
  it('renders every row within the requested width and shows selected answers at the bottom', () => {
    const dock = new AskChoiceDock({
      tui: fakeTui(),
      question: question(),
      index: 0,
      total: 1,
      agentName: 'Elowen',
      selected: ['Run focused tests'],
      onSubmit: vi.fn(),
      onOther: vi.fn(),
      onCancel: vi.fn(),
    });
    const lines = dock.render(72);
    expect(lines.every((line) => visibleWidth(line) <= 72)).toBe(true);
    expect(stripAnsi(lines.join('\n'))).toContain('✓ Run focused tests');
  });

  it('wraps a long question across rows instead of truncating it', () => {
    const long = 'Should Elowen deploy the new build to production now, or wait for the remaining review agents to finish and merge their branches first?';
    const dock = new AskChoiceDock({
      tui: fakeTui(),
      question: { ...question(), question: long },
      index: 0,
      total: 1,
      agentName: 'Elowen',
      onSubmit: vi.fn(),
      onOther: vi.fn(),
      onCancel: vi.fn(),
    });
    const text = stripAnsi(dock.render(60).join('\n')).replace(/│/g, '').replace(/\s+/g, ' ');
    expect(text).toContain('merge their branches first?'); // the tail survives wrapping
  });

  it('wraps a long option label across rows instead of truncating it', () => {
    const longLabel = 'Ano, smazat vše v /tmp kromě /tmp/opencode a systémových adresářů';
    const dock = new AskChoiceDock({
      tui: fakeTui(),
      question: { ...question(), options: [{ label: longLabel }] },
      index: 0,
      total: 1,
      agentName: 'Elowen',
      onSubmit: vi.fn(),
      onOther: vi.fn(),
      onCancel: vi.fn(),
    });
    const text = stripAnsi(dock.render(50).join('\n')).replace(/│/g, '').replace(/\s+/g, ' ');
    expect(text).toContain('systémových adresářů'); // the tail survives wrapping, not truncated to "…"
  });

  it('projects question headers, prompts, option labels, and descriptions', () => {
    const dangerous = 'visible\ttext\x1b[2J\x1b]0;forged\x07';
    const dock = new AskChoiceDock({
      tui: fakeTui(),
      question: {
        header: dangerous,
        question: dangerous,
        options: [{ label: dangerous, description: dangerous }],
      },
      index: 0,
      total: 1,
      agentName: 'Elowen',
      onSubmit: vi.fn(),
      onOther: vi.fn(),
      onCancel: vi.fn(),
    });
    const rendered = dock.render(72).join('\n');
    expect(rendered).toContain('visible');
    expect(rendered).not.toContain('\t');
    expect(rendered).not.toContain('\x1b[2J');
    expect(rendered).not.toContain('\x1b]0;');
  });

  it('uses space to toggle multiple answers and enter to submit them', () => {
    const onSubmit = vi.fn();
    const dock = new AskChoiceDock({
      tui: fakeTui(),
      question: question(),
      index: 0,
      total: 1,
      agentName: 'Elowen',
      onSubmit,
      onOther: vi.fn(),
      onCancel: vi.fn(),
    });
    dock.handleInput(' ');
    dock.handleInput('\x1b[B');
    dock.handleInput(' ');
    dock.handleInput('\r');
    expect(onSubmit).toHaveBeenCalledWith(['Run focused tests', 'Run typecheck']);
  });

  it('keeps chrome and the highlighted option visible inside a constrained row budget', () => {
    const dock = new AskChoiceDock({
      tui: fakeTui(),
      question: {
        ...question(),
        options: Array.from({ length: 12 }, (_, i) => ({
          label: `Choice ${i + 1}`,
          description: `Detailed explanation ${i + 1}`,
        })),
      },
      index: 0,
      total: 1,
      agentName: 'Elowen',
      onSubmit: vi.fn(),
      onOther: vi.fn(),
      onCancel: vi.fn(),
    });
    dock.setMaxRows(10);
    for (let i = 0; i < 10; i++) dock.handleInput('\x1b[B');
    const rendered = stripAnsi(dock.render(72).join('\n'));
    expect(dock.render(72).length).toBeLessThanOrEqual(10);
    expect(rendered).toContain('Elowen needs a decision');
    expect(rendered).toContain('Choice 11');
    expect(rendered).toContain('enter send');
    expect(rendered).toContain('╭');
    expect(rendered).toContain('╰');
  });

  it('keeps every action readable in the 32-column priority-editor budget', () => {
    const dock = new AskChoiceDock({
      tui: fakeTui(),
      question: {
        ...question(),
        options: Array.from({ length: 12 }, (_, i) => ({
          label: `Choice ${i + 1}`,
          description: `Detailed explanation ${i + 1}`,
        })),
      },
      index: 0,
      total: 1,
      agentName: 'Elowen',
      onSubmit: vi.fn(),
      onOther: vi.fn(),
      onCancel: vi.fn(),
    });
    dock.setMaxRows(9);
    for (let i = 0; i < 10; i++) dock.handleInput('\x1b[B');

    const lines = dock.render(32);
    const rendered = stripAnsi(lines.join('\n'));
    expect(lines.length).toBeLessThanOrEqual(9);
    expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
    expect(rendered).toContain('Choice 11');
    expect(rendered).toMatch(/space toggle[\s\S]*enter send[\s\S]*esc cancel/u);
    expect(rendered).toContain('╭');
    expect(rendered).toContain('╰');
  });

  it('submits the highlighted row on enter for single-select questions', () => {
    const onSubmit = vi.fn();
    const dock = new AskChoiceDock({
      tui: fakeTui(),
      question: question(false),
      index: 0,
      total: 1,
      agentName: 'Elowen',
      onSubmit,
      onOther: vi.fn(),
      onCancel: vi.fn(),
    });
    dock.handleInput('\x1b[B');
    dock.handleInput('\r');
    expect(onSubmit).toHaveBeenCalledWith(['Run typecheck']);
  });
});

// A `preview` lets the user SEE a choice (an ASCII mockup, a code shape) instead of reading about it. The
// dock then splits into two columns: the option list, and the FOCUSED option's preview.
describe('AskChoiceDock — option previews', () => {
  const previewQuestion = (): AskQuestion => ({
    question: 'Which dashboard layout?',
    header: 'Layout',
    multiSelect: false,
    options: [
      { label: 'Grid', description: 'cards in a grid', preview: 'GRID-AAA\nGRID-BBB' },
      { label: 'List', description: 'rows stacked', preview: 'LIST-AAA\nLIST-BBB' },
    ],
  });

  const dockFor = (question: AskQuestion): AskChoiceDock => new AskChoiceDock({
    tui: fakeTui(), question, index: 0, total: 1, agentName: 'Elowen',
    onSubmit: vi.fn(), onOther: vi.fn(), onCancel: vi.fn(),
  });

  it('shows the focused option\'s preview beside the list, and follows the selection', () => {
    const dock = dockFor(previewQuestion());
    const first = dock.render(90).map(stripAnsi);

    // The list and the first option's preview share the same rows — that is what "side by side" means.
    const gridRow = first.find((line) => line.includes('Grid'));
    expect(gridRow).toBeTruthy();
    expect(gridRow).toContain('GRID-AAA');
    expect(first.join('\n')).toContain('GRID-BBB');
    expect(first.join('\n')).not.toContain('LIST-AAA'); // only the focused option is previewed

    dock.handleInput('\x1b[B'); // move down to "List"
    const second = dock.render(90).map(stripAnsi).join('\n');
    expect(second).toContain('LIST-AAA');
    expect(second).toContain('LIST-BBB');
    expect(second).not.toContain('GRID-AAA');
  });

  it('keeps every row inside the requested width', () => {
    const dock = dockFor(previewQuestion());
    for (const line of dock.render(90)) expect(visibleWidth(line)).toBe(90);
  });

  it('clips a preview line that is wider than its column instead of breaking the layout', () => {
    const wide: AskQuestion = {
      ...previewQuestion(),
      options: [{ label: 'Grid', preview: 'X'.repeat(500) }, { label: 'List', preview: 'short' }],
    };
    const dock = dockFor(wide);
    for (const line of dock.render(90)) expect(visibleWidth(line)).toBe(90);
  });

  it('falls back to the stacked layout on a narrow terminal — the options matter, the preview does not', () => {
    const dock = dockFor(previewQuestion());
    const narrow = dock.render(40).map(stripAnsi);
    for (const line of dock.render(40)) expect(visibleWidth(line)).toBe(40);
    expect(narrow.join('\n')).toContain('Grid');
    expect(narrow.join('\n')).not.toContain('GRID-AAA'); // no room for a second column
  });

  it('stays stacked when no option carries a preview (nothing changes for existing questions)', () => {
    const dock = dockFor({ ...previewQuestion(), options: [{ label: 'Grid' }, { label: 'List' }] });
    const lines = dock.render(90).map(stripAnsi).join('\n');
    expect(lines).toContain('Grid');
    expect(lines).toContain('List');
    expect(lines).not.toContain('│ '.repeat(2)); // no second column divider
  });

  it('shows no preview pane while the free-text "Other…" row is focused', () => {
    const dock = dockFor({ ...previewQuestion(), custom: true });
    dock.handleInput('\x1b[B'); // List
    dock.handleInput('\x1b[B'); // Other…
    const lines = dock.render(90).map(stripAnsi).join('\n');
    expect(lines).toContain('Other...');
    expect(lines).not.toContain('GRID-AAA');
    expect(lines).not.toContain('LIST-AAA');
  });

  it('drops the preview rather than the options when the row budget is tight', () => {
    const dock = dockFor({
      ...previewQuestion(),
      options: [
        { label: 'Grid', preview: Array.from({ length: 30 }, (_, i) => `GRID-${i}`).join('\n') },
        { label: 'List', preview: 'LIST' },
      ],
    });
    dock.setMaxRows(12);
    const lines = dock.render(90);
    expect(lines.length).toBeLessThanOrEqual(12);
    for (const line of lines) expect(visibleWidth(line)).toBe(90);
    expect(lines.map(stripAnsi).join('\n')).toContain('Grid'); // the choice survives the squeeze
  });
});

describe('runAskFlow', () => {
  it('borrows the editor slot for the ask dock, then restores the editor on completion', () => {
    const tui = fakeTui();
    const slot = new Container();
    const editor = { render: () => ['editor'] } as Component as Editor;
    slot.addChild(editor);
    const onComplete = vi.fn();
    runAskFlow({
      tui,
      slot,
      editor,
      questions: [question()],
      agentName: 'Elowen',
      onComplete,
      onCancel: vi.fn(),
    });
    expect(slot.children[0]).toBeInstanceOf(AskChoiceDock);
    slot.children[0]!.handleInput?.(' ');
    slot.children[0]!.handleInput?.('\r');
    expect(onComplete).toHaveBeenCalledWith([{ header: 'Next', selected: ['Run focused tests'] }]);
    expect(slot.children[0]).toBe(editor);
  });
});
