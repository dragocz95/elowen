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

  it('drops the absolute token count before the percentage or the price, as width tightens', () => {
    const wide = new TelemetryPanel(fullState).render(80).map(strip).join('\n');
    expect(wide).toContain('200k'); // tokens present with plenty of room
    expect(wide).toContain('100%');
    expect(wide).toContain('$888.46');

    const narrow = new TelemetryPanel(fullState).render(TELEMETRY_MIN_COLUMNS).map(strip).join('\n');
    // The token count is the widest, least essential segment — the first one sacrificed.
    expect(narrow).not.toContain('200k');
    expect(narrow).toContain('100%');
    expect(narrow).toContain('$888.46');
  });

  it('falls back to the plain "—" percentage when there is no usage at all, unaffected by the price logic', () => {
    const noUsage: TelemetryState = { ...fullState(), usage: null };
    const text = new TelemetryPanel(() => noUsage).render(60).map(strip).join('\n');
    expect(text).toContain('—');
    expect(text).not.toContain('$');
  });
});

describe('the telemetry rail auto-fits its width to its content', () => {
  const shortState = (): TelemetryState => ({
    usage: null, cwd: '~/x', branch: 'main', mcp: null, lspEnabled: null, floatOffset: 0,
  });

  it('shrinks a short, mostly-empty state close to the documented minimum', () => {
    const width = new TelemetryPanel(shortState).naturalWidth(TELEMETRY_MAX_COLUMNS);
    expect(width).toBeGreaterThanOrEqual(TELEMETRY_MIN_COLUMNS);
    expect(width).toBeLessThan(46); // well under the old fixed default
  });

  it('reports something close to the token/cost line\'s real length for a context-only state', () => {
    const state: TelemetryState = { ...shortState(), usage: { tokens: 199_999, contextWindow: 200_000, percent: 99.9, totalTokens: 199_999, cost: 888.46 } };
    const width = new TelemetryPanel(() => state).naturalWidth(TELEMETRY_MAX_COLUMNS);
    // Driven by the content ("200k / 200k tokens · 100% · $888.46" plus the two-space gutter on each
    // side), not by the cap — well under TELEMETRY_MAX_COLUMNS, but past the bare minimum.
    expect(width).toBeGreaterThan(TELEMETRY_MIN_COLUMNS);
    expect(width).toBeLessThan(TELEMETRY_MAX_COLUMNS - 10);
  });

  it('caps at TELEMETRY_MAX_COLUMNS when every section is long enough to need it', () => {
    // fullState() is deliberately built with overflowing content in every section.
    const width = new TelemetryPanel(fullState).naturalWidth(TELEMETRY_MAX_COLUMNS);
    expect(width).toBe(TELEMETRY_MAX_COLUMNS);
  });
});
