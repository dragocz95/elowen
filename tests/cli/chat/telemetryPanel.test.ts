import { describe, it, expect } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { TelemetryPanel, type TelemetryState } from '../../../src/cli/chat/telemetryPanel.js';
import { TELEMETRY_MAX_COLUMNS, TELEMETRY_MIN_COLUMNS } from '../../../src/cli/chat/layoutBudget.js';
import type { BrainGoalState } from '../../../src/brain/events.js';
import type { ProcessInfo } from '../../../src/brain/processRegistry.js';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
/** The rail paints every row to the full panel width with the background colour, so the trailing padding
 *  is literal spaces. Trim them off to recover where the row's actual CONTENT ends. */
const contentExtent = (row: string): number => visibleWidth(strip(row).replace(/\s+$/u, ''));

/** Plain-text rows with the background padding removed, so a row can be compared as written text. */
const railRows = (panel: TelemetryPanel, width: number): string[] =>
  panel.render(width).map((row) => strip(row).replace(/\s+$/u, ''));
/** The Context section's header row, and the summary line that always follows it when expanded. */
const contextHeader = (rows: string[]): string => rows.find((row) => row.includes('Context'))!;
const contextSummary = (rows: string[]): string => rows[rows.findIndex((row) => row.includes('Context')) + 1]!.trimStart();

/** PANEL_BAR_MARGIN in telemetryPanel.ts. Kept in sync by the assertion below: content must end at least
 *  this many columns before the right edge, so a two-space gutter mirrors the two-space left indent. */
const PANEL_BAR_MARGIN = 2;

const resetsAt = Math.floor(Date.now() / 1000) + 3_600;

const goal: BrainGoalState = {
  session_id: 's', user_id: 1, status: 'active',
  goal: 'Ship the telemetry rail margin fix with a really long goal title that would overflow the rail',
  draft: '', subgoals: '[]', turns_used: 3, turn_budget: 40,
  last_verdict: '', last_evidence: '', paused_reason: '', created_at: '', updated_at: '',
};

/** A rail state that lights up EVERY section (context, goal, limits, workflow, sub-agents, processes,
 *  project, mcp, lsp) with content long enough to overflow a narrow panel — so a reverted width
 *  calculation shows up as a row that reaches the edge. */
const fullState = (): TelemetryState => ({
  usage: { tokens: 199_999, contextWindow: 200_000, percent: 99.9, totalTokens: 199_999, cost: 888.46 },
  cwd: '~/projects/some/really/deeply/nested/directory/path/that/overflows/the/rail',
  branch: 'feature/really-long-branch-name-here',
  mcp: [{ name: 'chrome-devtools', status: 'connected' }, { name: 'github', status: 'connected' }],
  lspEnabled: true,
  processes: [{
    id: 'p1', command: 'npm run dev --workspace some-really-long-package-name',
    startedAt: new Date().toISOString(), running: true, completionMode: 'background',
  } as ProcessInfo],
  subagents: [{ sessionId: 's1', task: 'a really long sub-agent task description that would overflow the panel', status: 'running', tools: 3, seconds: 42 }],
  workflows: [{ id: 'w1', title: 'A workflow with a long title that overflows', status: 'running', nodes: [] } as never],
  rateLimits: {
    provider: 'openai', planType: 'pro-max-enterprise-subscription-tier', stale: true, fetchedAt: 0,
    windows: [
      { usedPercent: 80, windowMinutes: 300, resetsAt },
      { usedPercent: 55, windowMinutes: 10_080, resetsAt },
    ],
  },
  goal,
  floatOffset: 0,
});

describe('the telemetry rail keeps a right gutter', () => {
  it('never lets a rendered content row reach past width - PANEL_BAR_MARGIN, at any width', () => {
    // 36 is the rail's documented minimum width; go up from there. One parametrised pass covers every
    // section, so a reverted width computation on any of them surfaces as a row that touches the edge.
    for (const width of [36, 40, 46, 60, 80]) {
      const rows = new TelemetryPanel(fullState).render(width);
      for (const [index, row] of rows.entries()) {
        expect(contentExtent(row), `row ${index} @ width ${width}: "${strip(row).replace(/\s+$/u, '')}"`)
          .toBeLessThanOrEqual(width - PANEL_BAR_MARGIN);
      }
    }
  });

  it('hides the flame and disarms its animation when /maskot is off', () => {
    const shown = new TelemetryPanel(() => ({ ...fullState(), showMascot: true }));
    const hidden = new TelemetryPanel(() => ({ ...fullState(), showMascot: false }));
    // The rail art is truecolor half-blocks (▀ / ▄); present when shown, gone when hidden.
    expect(shown.render(60).join('\n')).toContain('▀');
    expect(hidden.render(60).join('\n')).not.toContain('▀');
    // canRenderMascot gates the animation timer (see AnimationController.canAnimateMascot); a hidden
    // mascot must never let it arm and tick against nothing.
    expect(shown.canRenderMascot(60)).toBe(true);
    expect(hidden.canRenderMascot(60)).toBe(false);
    // The functional sections still render regardless of the mascot toggle.
    expect(hidden.render(60).join('\n')).toContain('Context');
  });

  it('still fills every section (the gutter check is not vacuously passing on an empty rail)', () => {
    const text = new TelemetryPanel(fullState).render(60).map(strip).join('\n');
    for (const label of ['Context', 'Goal', 'Limits', 'Workflow', 'Sub-agents', 'Processes', 'Project', 'MCP', 'LSP']) {
      expect(text, label).toContain(label);
    }
    // The price is the row the bug report called out — it must be present and inside the gutter.
    expect(text).toContain('$888.46');
  });
});

describe('the context section never drops the price', () => {
  it('keeps $888.46 even at the rail\'s documented 36-column minimum, not just a roomy width', () => {
    // This is the direct regression test for the reported bug: at width 60 the price already survived
    // (covered above), but the single tail-truncation this replaced ate exactly the price at 36.
    const text = new TelemetryPanel(fullState).render(TELEMETRY_MIN_COLUMNS).map(strip).join('\n');
    expect(text).toContain('$888.46');
  });

  it('keeps the percentage last of all once even the token count cannot fit beside it', () => {
    // Below TELEMETRY_MIN_COLUMNS no rail width can hold `tokens · %`; the percentage is what survives,
    // and the price is still safe in the header rather than truncated into the line.
    const rows = railRows(new TelemetryPanel(fullState), 24);
    expect(contextSummary(rows)).toBe('100%');
    expect(contextHeader(rows)).toContain('$888.46');
  });

  it('falls back to the plain "—" percentage when there is no usage at all, unaffected by the price logic', () => {
    const noUsage: TelemetryState = { ...fullState(), usage: null };
    const text = new TelemetryPanel(() => noUsage).render(60).map(strip).join('\n');
    expect(text).toContain('—');
    expect(text).not.toContain('$');
  });
});

describe('the session cost moves into the Context header when the rail is too narrow for the line', () => {
  it('renders the untouched `tokens · % · $` line, with an empty header meta, while it fits', () => {
    const rows = railRows(new TelemetryPanel(fullState), 80);
    expect(contextSummary(rows)).toBe('200k / 200k tokens · 100% · $888.46');
    // Nothing is added to the header at a comfortable width: it stays chevron + label.
    expect(contextHeader(rows).trim()).toBe('▾ Context');
  });

  it('moves the cost to the header meta and keeps `tokens · %` in the line at the rail minimum', () => {
    const rows = railRows(new TelemetryPanel(fullState), TELEMETRY_MIN_COLUMNS);
    expect(contextHeader(rows).trim()).toBe('▾ Context $888.46');
    expect(contextSummary(rows)).toBe('200k / 200k tokens · 100%');
    expect(contextSummary(rows)).not.toContain('$');
  });

  it('shows the cost exactly once, never truncated, at every width the rail can be dragged to', () => {
    const panel = new TelemetryPanel(fullState);
    for (let width = TELEMETRY_MIN_COLUMNS; width <= TELEMETRY_MAX_COLUMNS; width += 1) {
      const rendered = railRows(panel, width).join('\n');
      expect(rendered.match(/\$888\.46/gu)?.length ?? 0, `width ${width}`).toBe(1);
      expect(rendered, `width ${width}`).toContain('100%');
    }
  });
});

// The old `naturalWidth` auto-fit measurement is gone: the rail now starts at `contextRequiredWidth()`
// (see chatComposition.ts), whose contract lives in the block below and end-to-end in applicationShell.test.ts.

describe('contextRequiredWidth is the floor a manual drag may not cross', () => {
  const shortState = (): TelemetryState => ({
    usage: null, cwd: '~/x', branch: 'main', mcp: null, lspEnabled: null, floatOffset: 0,
  });

  it('measures the token/percent line WITHOUT the cost, plus the panel gutter', () => {
    // Long enough that `tokens · %` alone still outgrows the rail minimum, so the floor is content-driven
    // rather than clamped — which is what makes the "without the cost" part of the claim observable.
    const state: TelemetryState = {
      ...shortState(),
      usage: { tokens: 999_999_999, contextWindow: 999_999_999, percent: 100, totalTokens: 999_999_999, cost: 123_456.78 },
    };
    const panel = new TelemetryPanel(() => state);
    const required = panel.contextRequiredWidth();
    const rows = railRows(panel, required);
    expect(contextSummary(rows)).toBe('1000.0M / 1000.0M tokens · 100%');
    // Row = two-space indent + the line; the rail then keeps PANEL_BAR_MARGIN on each edge.
    expect(required).toBe(visibleWidth(contextSummary(rows)) + PANEL_BAR_MARGIN * 3);
    // The cost is not in the measured line because it is in the header — and it fits there.
    expect(contextHeader(rows).trim()).toBe('▾ Context $123456.78');
  });

  it('lets a drag reach the rail minimum for a realistic long-usage context', () => {
    // The old floor measured the full "200k / 200k tokens · 100% · $888.46" line and so refused to shrink
    // past ~39 columns. The cost now relocates instead, and the rail is free down to its own minimum.
    const panel = new TelemetryPanel(fullState);
    expect(panel.contextRequiredWidth()).toBeLessThanOrEqual(TELEMETRY_MIN_COLUMNS);
  });

  it('keeps every segment at the floor and at every width above it', () => {
    const panel = new TelemetryPanel(fullState);
    for (let width = panel.contextRequiredWidth(); width <= TELEMETRY_MAX_COLUMNS; width += 1) {
      const rendered = railRows(panel, width).join('\n');
      expect(rendered, `width ${width}`).toContain('200k / 200k');
      expect(rendered, `width ${width}`).toContain('100%');
      expect(rendered, `width ${width}`).toContain('$888.46');
    }
  });

  it('falls back to TELEMETRY_MIN_COLUMNS when the context content is short or absent', () => {
    expect(new TelemetryPanel(shortState).contextRequiredWidth()).toBe(TELEMETRY_MIN_COLUMNS);
  });

  it('never exceeds the rail\'s own maximum width', () => {
    const huge: TelemetryState = {
      ...shortState(),
      usage: { tokens: 999_999_999, contextWindow: 999_999_999, percent: 100, totalTokens: 999_999_999, cost: 123_456.78 },
    };
    const required = new TelemetryPanel(() => huge).contextRequiredWidth();
    expect(required).toBeLessThanOrEqual(TELEMETRY_MAX_COLUMNS);
  });

  it('drops to the header alone once the user folds the Context section', () => {
    // A context long enough that the expanded floor genuinely exceeds the rail minimum, so folding is
    // observably what lowers it.
    const panel = new TelemetryPanel(() => ({
      ...fullState(),
      usage: { tokens: 999_999_999, contextWindow: 999_999_999, percent: 100, totalTokens: 999_999_999, cost: 123_456.78 },
    }));
    expect(panel.contextRequiredWidth()).toBeGreaterThan(TELEMETRY_MIN_COLUMNS);
    panel.toggleSection('context');
    // A folded section shows no summary line, so it has nothing left to protect.
    expect(panel.contextRequiredWidth()).toBe(TELEMETRY_MIN_COLUMNS);
  });
});
