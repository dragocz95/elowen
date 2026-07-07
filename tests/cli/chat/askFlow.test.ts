import { describe, it, expect, vi } from 'vitest';
import { Container, visibleWidth } from '@earendil-works/pi-tui';
import type { Component, Editor, TUI } from '@earendil-works/pi-tui';
import { AskChoiceDock, runAskFlow } from '../../../src/cli/chat/askFlow.js';
import type { AskQuestion } from '../../../src/brain/events.js';

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

const question = (multiSelect = true): AskQuestion => ({
  question: 'What should Orca do next?',
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
    const long = 'Should Orca deploy the new build to production now, or wait for the remaining review agents to finish and merge their branches first?';
    const dock = new AskChoiceDock({
      tui: fakeTui(),
      question: { ...question(), question: long },
      index: 0,
      total: 1,
      onSubmit: vi.fn(),
      onOther: vi.fn(),
      onCancel: vi.fn(),
    });
    const text = stripAnsi(dock.render(60).join('\n')).replace(/│/g, '').replace(/\s+/g, ' ');
    expect(text).toContain('merge their branches first?'); // the tail survives wrapping
  });

  it('uses space to toggle multiple answers and enter to submit them', () => {
    const onSubmit = vi.fn();
    const dock = new AskChoiceDock({
      tui: fakeTui(),
      question: question(),
      index: 0,
      total: 1,
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

  it('submits the highlighted row on enter for single-select questions', () => {
    const onSubmit = vi.fn();
    const dock = new AskChoiceDock({
      tui: fakeTui(),
      question: question(false),
      index: 0,
      total: 1,
      onSubmit,
      onOther: vi.fn(),
      onCancel: vi.fn(),
    });
    dock.handleInput('\x1b[B');
    dock.handleInput('\r');
    expect(onSubmit).toHaveBeenCalledWith(['Run typecheck']);
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
