import { beforeAll, describe, expect, it } from 'vitest';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { computeLayoutBudget, constrainFrame } from '../../../src/cli/chat/layoutBudget.js';
import { MainColumn, StartScreen } from '../../../src/cli/chat/startScreen.js';

beforeAll(() => initTheme());

describe('central chat layout budget', () => {
  const sizes = [
    [20, 10], [32, 12], [40, 15], [80, 24], [120, 30], [180, 50],
  ] as const;

  it.each(sizes)('never allocates beyond a %ix%i terminal', (columns, rows) => {
    const budget = computeLayoutBudget({
      columns, rows, hasTranscript: true, telemetryRequested: true,
      desired: { editor: 14, queue: 9, attachments: 2, cards: 18, subagents: 8 },
    });
    expect(budget.rootRows).toBeLessThanOrEqual(rows);
    expect(Object.values(budget.sections).every((value) => value >= 0)).toBe(true);
    expect(budget.chatColumns + budget.telemetryColumns + budget.telemetryGutter).toBeLessThanOrEqual(columns);
    expect(budget.sections.status).toBe(1);
    expect(budget.sections.editor).toBeGreaterThan(0);
  });

  it('uses a compact fallback for 20x10 and keeps every width inside the real terminal', () => {
    const budget = computeLayoutBudget({
      columns: 20, rows: 10, hasTranscript: true, telemetryRequested: true,
      desired: { editor: 7, queue: 4, attachments: 1, cards: 6, subagents: 4 },
    });
    expect(budget.compactFallback).toBe(true);
    expect(budget.chatColumns).toBe(20);
    expect(budget.telemetryColumns).toBe(0);
    expect(budget.rootRows).toBe(10);
    expect(budget.sections.status).toBe(1);
    expect(budget.sections.editor).toBeGreaterThan(0);
  });

  it('uses the compact fallback below the documented 32x12 recommendation', () => {
    const budget = computeLayoutBudget({
      columns: 40, rows: 10, hasTranscript: true, telemetryRequested: false,
      desired: { editor: 7, queue: 4, attachments: 1, cards: 6, subagents: 4 },
    });
    expect(budget.compactFallback).toBe(true);
    expect(budget.sections.cards).toBe(0);
    expect(budget.sections.subagents).toBe(0);
    expect(budget.sections.hints).toBe(0);
  });

  it('shrinks editor and queue, collapses panels, then hides hints before overflowing', () => {
    const budget = computeLayoutBudget({
      columns: 40, rows: 12, hasTranscript: true, telemetryRequested: false,
      desired: { editor: 12, queue: 8, attachments: 1, cards: 12, subagents: 6 },
    });
    expect(budget.sections.editor).toBeLessThanOrEqual(3);
    expect(budget.sections.queue).toBeLessThanOrEqual(1);
    expect(budget.sections.cards).toBeLessThanOrEqual(1);
    expect(budget.sections.subagents).toBeLessThanOrEqual(1);
    expect(budget.sections.hints).toBe(0);
    expect(budget.sections.transcript).toBeGreaterThanOrEqual(1);
    expect(budget.rootRows).toBe(12);
  });

  it('gives a blocking ask dock priority over transcript cards and hints', () => {
    const budget = computeLayoutBudget({
      columns: 80, rows: 24, hasTranscript: true, telemetryRequested: false,
      editorPriority: true,
      desired: { editor: 14, queue: 4, attachments: 1, cards: 6, subagents: 4 },
    });
    expect(budget.sections.editor).toBe(14);
    expect(budget.sections.transcript).toBeGreaterThanOrEqual(1);
    expect(budget.sections.queue).toBe(0);
    expect(budget.sections.cards).toBe(0);
    expect(budget.sections.subagents).toBe(0);
    expect(budget.sections.hints).toBe(0);
    expect(budget.rootRows).toBe(24);
  });

  it('lets a blocking ask dock borrow all but one transcript row at 32x12', () => {
    const budget = computeLayoutBudget({
      columns: 32, rows: 12, hasTranscript: true, telemetryRequested: false,
      editorPriority: true,
      desired: { editor: 14, queue: 4, attachments: 1, cards: 6, subagents: 4 },
    });
    expect(budget.compactFallback).toBe(false);
    expect(budget.sections.editor).toBe(9);
    expect(budget.sections.transcript).toBe(1);
    expect(budget.sections.status).toBe(1);
    expect(budget.rootRows).toBe(12);
  });

  it('lets an explicitly expanded Todo borrow transcript rows without displacing the editor', () => {
    const budget = computeLayoutBudget({
      columns: 80, rows: 24, hasTranscript: true, telemetryRequested: false,
      cardsPriority: true,
      desired: { editor: 3, queue: 0, attachments: 0, cards: 14, subagents: 4 },
    });
    expect(budget.sections.cards).toBe(14);
    expect(budget.sections.editor).toBe(3);
    expect(budget.sections.transcript).toBeGreaterThanOrEqual(1);
    expect(budget.sections.subagents).toBe(0);
    expect(budget.rootRows).toBe(24);
  });

  it('only reserves telemetry when the panel fits beside a usable chat column', () => {
    const narrow = computeLayoutBudget({
      columns: 80, rows: 24, hasTranscript: true, telemetryRequested: true,
      desired: { editor: 3, queue: 0, attachments: 0, cards: 0, subagents: 0 },
    });
    const wide = computeLayoutBudget({
      columns: 120, rows: 30, hasTranscript: true, telemetryRequested: true,
      desired: { editor: 3, queue: 0, attachments: 0, cards: 0, subagents: 0 },
    });
    expect(narrow.telemetryColumns).toBe(0);
    expect(wide.telemetryColumns).toBeGreaterThan(0);
    expect(wide.chatColumns).toBeGreaterThanOrEqual(32);
  });

  it.each([[104, 12, 11], [104, 24, 23]] as const)(
    'allocates one exact telemetry overlay row budget at %ix%i',
    (columns, terminalRows, telemetryRows) => {
      const budget = computeLayoutBudget({
        columns, rows: terminalRows, hasTranscript: true, telemetryRequested: true,
        desired: { editor: 3, queue: 0, attachments: 0, cards: 0, subagents: 0 },
      });

      expect(budget).toMatchObject({ telemetryColumns: 46, telemetryRows });
      expect(budget.rootRows).toBe(terminalRows);
    },
  );

  it('does not reserve a decorative rail below the minimum terminal height', () => {
    const budget = computeLayoutBudget({
      columns: 104, rows: 11, hasTranscript: true, telemetryRequested: true,
      desired: { editor: 3, queue: 0, attachments: 0, cards: 0, subagents: 0 },
    });

    expect(budget).toMatchObject({ telemetryColumns: 0, telemetryGutter: 0, telemetryRows: 0 });
  });

  it('allocates at most six editor content rows plus its two rules on a normal terminal', () => {
    const budget = computeLayoutBudget({
      columns: 120, rows: 40, hasTranscript: true, telemetryRequested: false,
      desired: { editor: 40, queue: 0, attachments: 0, cards: 0, subagents: 0 },
    });
    expect(budget.sections.editor).toBe(8);
    expect(budget.rootRows).toBe(40);
  });
});

describe('small-terminal regression', () => {
  it.each([[20, 10], [32, 12], [80, 24], [180, 50]] as const)(
    'clips and pads the final root frame to exactly %ix%i',
    (columns, rows) => {
      const raw = [
        'x'.repeat(columns + 30),
        ...Array.from({ length: rows + 5 }, (_, index) => `row ${index}`),
      ];
      const frame = constrainFrame(raw, columns, rows);
      expect(frame).toHaveLength(rows);
      expect(frame.every((line) => visibleWidth(line) === columns)).toBe(true);
    },
  );

  it('start screen never returns a line wider than its render width', () => {
    const input = { invalidate: (): void => {}, render: (width: number): string[] => [`input width ${width}`] };
    const screen = new StartScreen(input, () => 9, () => ({
      modelLine: 'Build · mock/provider-model',
      hints: 'enter send · slash commands · telemetry',
      tip: 'Tip ask anything', notice: '',
      statusLeft: '~/very/long/project/path · feature/very-long-branch',
      version: '0.26.0',
    }));
    const rendered = screen.render(20);
    expect(rendered).toHaveLength(9);
    expect(Math.max(...rendered.map(visibleWidth))).toBeLessThanOrEqual(20);
  });

  it('main column never invents a 24-column child inside a narrower terminal', () => {
    const child = { invalidate: (): void => {}, render: (width: number): string[] => [`child:${width}`] };
    const main = new MainColumn(() => 0, () => [child]);
    const rendered = main.render(20);
    expect(rendered.every((line) => visibleWidth(line) <= 20)).toBe(true);
    expect(rendered.join('\n')).toContain('child:20');
  });

  it('keeps an already exact 180x50 ANSI frame on the root fast path', () => {
    const styledChunk = `\x1b[38;2;255;82;54m${'x'.repeat(20)}\x1b[39m${' '.repeat(20)}`;
    const styled = styledChunk.repeat(4);
    const line = `${styled}${'x'.repeat(180 - visibleWidth(styled))}`;
    const frame = Array.from({ length: 50 }, () => line);
    constrainFrame(frame, 180, 50); // warm segmenter/JIT before measuring the repeated hot path
    const startedAt = performance.now();
    for (let index = 0; index < 10; index++) constrainFrame(frame, 180, 50);
    const elapsed = performance.now() - startedAt;
    expect(elapsed).toBeLessThan(100);
  });
});
