import { describe, expect, it, vi } from 'vitest';
import { openStatsOverlay, type StatsOverlaySession } from '../../../src/cli/chat/statsOverlay.js';
import type { BrainUsageView, ModelUsageView } from '../../../src/cli/chat/brainClient.js';
import type { BrainContextBreakdown } from '../../../src/shared/wireContract.js';

interface Overlay { render(width: number): string[]; handleInput(data: string): void }

/** Open the overlay on `section` and return its rendered lines, stripped of styling. */
function renderOverlay(o: {
  models?: ModelUsageView[];
  context?: BrainContextBreakdown | null;
  usage?: Partial<BrainUsageView>;
  section?: 'conversation' | 'models' | 'context';
  keys?: string[];
  /** Terminal height the overlay sizes itself against; `null` models a terminal that reports none. */
  rows?: number | null;
  session?: Partial<StatsOverlaySession>;
}): string[] {
  const shown: Overlay[] = [];
  const tui = {
    terminal: { columns: 120, ...(o.rows === null ? {} : { rows: o.rows ?? 40 }) },
    setFocus: vi.fn(),
    requestRender: vi.fn(),
    showOverlay: vi.fn((c: Overlay) => { shown.push(c); return { hide: vi.fn(), focus: vi.fn() }; }),
  };
  const usage: BrainUsageView | null = o.usage
    ? { tokens: null, contextWindow: 0, percent: null, totalTokens: 0, cost: 0, ...o.usage }
    : null;
  openStatsOverlay({
    tui: tui as never,
    editor: {} as never,
    section: o.section,
    data: {
      model: 'm',
      usage,
      models: o.models ?? [],
      context: o.context ?? null,
      session: { mode: 'Build', cwd: '~/proj', ...o.session },
    },
  });
  const overlay = shown[0];
  if (!overlay) throw new Error('the overlay was never shown');
  for (const key of o.keys ?? []) overlay.handleInput(key);
  return overlay.render(100).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
}

/** Render the Models section of the overlay and return its Σ row, stripped of styling. */
function sigmaRow(models: ModelUsageView[]): string {
  const lines = renderOverlay({ models, keys: ['\x1b[C'] }); // ←/→ cycles Conversation → Models
  return lines.find((l) => l.includes('Σ')) ?? '';
}

const model = (exec: string, usage: Partial<ModelUsageView['usage']>): ModelUsageView => ({
  exec,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costUsd: null, ...usage },
});

describe('stats overlay — Σ speed', () => {
  it('weights the average by each model MEASURED output, not its total output', () => {
    // x timed only 10k of its 1.01M output (200 s → 50 tok/s); y timed all 20k (200 s → 100 tok/s).
    // Duration-weighted: 30k over 400 s = 75 tok/s. Weighting by TOTAL output would yield ~50.
    expect(sigmaRow([
      model('elowen:x', { output: 1_010_000, total: 1_010_000, outputTps: 50, measuredOutput: 10_000 }),
      model('elowen:y', { output: 20_000, total: 20_000, outputTps: 100, measuredOutput: 20_000 }),
    ])).toMatch(/\s75\s/);
  });

  it('dashes the average when no model carries the measured pair (older daemon)', () => {
    // Costed, so the only dash the row can show is the unweightable speed.
    const row = sigmaRow([model('elowen:x', { output: 100, total: 100, costUsd: 1.5, outputTps: 40 })]);
    expect(row).toContain('—');
    expect(row).not.toMatch(/\s40\s/);
  });
});

describe('stats overlay — scrolling', () => {
  const DOWN = '\x1b[B', UP = '\x1b[A', RIGHT = '\x1b[C';
  // Eight models on a 20-row terminal: more rows than the viewport can hold, so the tail is off-screen
  // until it is scrolled to. Before this was scrollable the overflow was simply clipped and unreachable.
  const many = Array.from({ length: 8 }, (_, i) => model(`elowen:m${i}`, { total: (8 - i) * 1000 }));
  const models = (keys: string[]): string => renderOverlay({ models: many, rows: 20, keys: [RIGHT, ...keys] }).join('\n');

  it('reveals content below the fold when the down arrow is pressed', () => {
    const top = models([]);
    expect(top).toContain('elowen:m0');
    expect(top).not.toContain('elowen:m7'); // the tail does not fit

    const scrolled = models(Array(6).fill(DOWN));
    expect(scrolled).toContain('elowen:m7'); // ...and the arrow brings it into view
    expect(scrolled).not.toContain('elowen:m0'); // the window really moved, not just grew
  });

  it('stops at the end instead of scrolling past the last row', () => {
    const far = models(Array(50).fill(DOWN));
    expect(far).toContain('Σ'); // the total row is the last thing there is
    const once = models(Array(51).fill(DOWN));
    expect(once).toBe(far);
  });

  it('comes back to the top with the up arrow and never scrolls above it', () => {
    expect(models([...Array(4).fill(DOWN), ...Array(20).fill(UP)])).toBe(models([]));
  });

  it('announces the position only while there is something to scroll to', () => {
    expect(models([])).toMatch(/↑ ↓ scroll/);
    // One model fits, so the hint stays a plain legend with no position counter.
    const short = renderOverlay({ models: [model('elowen:only', { total: 1 })], rows: 20, keys: [RIGHT] }).join('\n');
    expect(short).not.toMatch(/↑ ↓ scroll/);
  });

  it('resets the offset when switching sections, so a shorter one is not shown mid-air', () => {
    // Scroll the long Models section, then cycle round to Conversation and back.
    const cycled = models([...Array(6).fill(DOWN), RIGHT, RIGHT, RIGHT]);
    expect(cycled).toContain('elowen:m0');
  });

  it('still renders a usable modal when the terminal reports no height', () => {
    // NaN arithmetic would slice the body to nothing — a blank panel is worse than a clipped one.
    const lines = renderOverlay({ models: many, rows: null, keys: [RIGHT] });
    expect(lines.join('\n')).toContain('elowen:m0');
    expect(lines.length).toBeGreaterThan(8);
  });
});

describe('stats overlay — cache hit', () => {
  const cacheLine = (usage: Partial<BrainUsageView>): string =>
    renderOverlay({ usage }).find((l) => l.includes('cache hit')) ?? '';

  it('counts cacheWrite as a miss in the denominator, not just cacheRead + input', () => {
    // 255660 read, 3957 written (a miss — it was NOT in the cache, it had to be written), 2 fresh.
    // Correct: 255660 / (255660 + 3957 + 2) = 98.48%. The old cacheRead/(cacheRead+input) gave ~100%.
    expect(cacheLine({ cacheRead: 255660, cacheWrite: 3957, input: 2 })).toContain('98.48%');
  });

  it('shows two decimals rather than rounding a near-full rate up to 100%', () => {
    expect(cacheLine({ cacheRead: 9955, cacheWrite: 0, input: 45 })).toContain('99.55%');
  });

  it('omits the line entirely when there is no input to measure', () => {
    expect(cacheLine({ cacheRead: 0, cacheWrite: 0, input: 0 })).toBe('');
  });
});

const breakdown = (over: Partial<BrainContextBreakdown> = {}): BrainContextBreakdown => ({
  model: 'test-model',
  contextWindow: 200_000,
  reportedTokens: 96_000,
  estimatedTokens: 90_000,
  percent: 45,
  categories: [
    { id: 'system', tokens: 12_000, percent: 6 },
    { id: 'toolResults', tokens: 78_000, percent: 39 },
  ],
  free: { tokens: 110_000, percent: 55 },
  tools: [{ name: 'Bash', schemaTokens: 1_000, callTokens: 2_000, resultTokens: 75_000, tokens: 78_000, percent: 39, active: true }],
  compactAtTokens: 160_000,
  ...over,
});

// `/status` is gone; its session rows moved into this section, which is now the only place the CLI
// reports the model/reasoning/mode/project/goal of the conversation.
describe('stats overlay — session rows (the retired /status)', () => {
  it('reports reasoning, mode, project and the active goal', () => {
    const text = renderOverlay({
      usage: { totalTokens: 10 },
      session: {
        title: 'Katalog', reasoning: 'High', mode: 'Plan', cwd: '~/proj', branch: 'main',
        goal: { status: 'active', turnsUsed: 3, turnBudget: 12, pausedReason: 'needs review' },
      },
    }).join('\n');
    expect(text).toContain('Katalog');
    expect(text).toContain('High');
    expect(text).toContain('Plan');
    expect(text).toContain('main');
    expect(text).toContain('3/12 turns');
    expect(text).toContain('needs review');
  });

  it('omits the fast row when the model/account never offered priority processing', () => {
    const off = renderOverlay({ usage: { totalTokens: 10 }, session: { fast: false } }).join('\n');
    expect(off).toContain('fast');
    expect(renderOverlay({ usage: { totalTokens: 10 } }).join('\n')).not.toContain('fast');
  });

  it('still shows the session rows when the conversation has no usage yet', () => {
    const text = renderOverlay({ session: { reasoning: 'Low' } }).join('\n');
    expect(text).toContain('Low');
    expect(text).toContain('no conversation usage data');
  });
});

describe('stats overlay — context section', () => {
  it('opens straight on the breakdown when asked, naming the categories and the heaviest tools', () => {
    const lines = renderOverlay({ context: breakdown(), section: 'context' });
    const text = lines.join('\n');
    expect(text).toContain('● Context');
    expect(text).toContain('tool output');
    expect(text).toContain('Bash');
    expect(text).toContain('compacts at 160k');
    // The provider's own count is shown as such, never merged into the estimated rows.
    expect(text).toContain('reported');
  });

  it('renders a bar only for the categories that carry tokens', () => {
    const lines = renderOverlay({ context: breakdown(), section: 'context' });
    expect(lines.filter((l) => l.includes('▰') || l.includes('▱'))).toHaveLength(2);
    expect(lines.join('\n')).not.toContain('assistant');
  });

  it('says so plainly when there is no live session to measure', () => {
    const lines = renderOverlay({ context: null, section: 'context' });
    expect(lines.join('\n')).toContain('no live session to measure');
  });
});
