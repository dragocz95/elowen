import { describe, it, expect } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { sectionHeaderContent, sectionHeaderRow, ProcessPanel, SubagentPanel, WorkflowPanel } from '../../../src/cli/chat/components.js';
import { TelemetryPanel, type TelemetryState } from '../../../src/cli/chat/telemetryPanel.js';
import type { ProcessInfo } from '../../../src/brain/processRegistry.js';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('sectionHeaderRow', () => {
  it('renders a chevron, bold label and faint meta with no rule', () => {
    const row = sectionHeaderRow(sectionHeaderContent('▾', 'Context', '· 47%'), 36);
    expect(strip(row)).toBe('▾ Context · 47%');
    expect(strip(row)).not.toContain('─');
  });

  it('omits the meta segment when it is empty', () => {
    expect(strip(sectionHeaderRow(sectionHeaderContent('▸', 'LSP'), 20))).toBe('▸ LSP');
  });

  it('truncates over-wide content instead of overflowing', () => {
    const row = sectionHeaderRow(sectionHeaderContent('▾', 'a'.repeat(60)), 36);
    expect(visibleWidth(strip(row))).toBeLessThanOrEqual(36);
    expect(strip(row)).toContain('…');
  });
});

const telemetryState = (over: Partial<TelemetryState> = {}): TelemetryState => ({
  usage: { tokens: 10, contextWindow: 100, percent: 10, totalTokens: 20, cost: 0 },
  cwd: '~/elowen',
  branch: 'main',
  mcp: [{ name: 'chrome-devtools', status: 'connected' }],
  lspEnabled: true,
  processes: [],
  subagents: [],
  rateLimits: null,
  goal: null,
  floatOffset: 0,
  ...over,
});

describe('lighter section headers in the telemetry rail', () => {
  it('renders Context, Project, MCP and LSP as chevron headers without a rule', () => {
    const rows = new TelemetryPanel(() => telemetryState()).render(46).map(strip);
    for (const label of ['Context', 'Project', 'MCP', 'LSP']) {
      const header = rows.find((line) => line.startsWith('▾ ') && line.includes(label));
      expect(header, label).toBeDefined();
      expect(header).not.toContain('─');
    }
  });

  it('keeps section meta (counts) in the chevron header row', () => {
    const rows = new TelemetryPanel(() => telemetryState()).render(46).map(strip).join('\n');
    expect(rows).toContain('▾ MCP 1/1 active');
  });
});

describe('folding plain rail sections', () => {
  it('reports the section a header row belongs to and folds it to a single row', () => {
    const panel = new TelemetryPanel(() => telemetryState());
    const rows = panel.render(46).map(strip);
    const mcpRow = rows.findIndex((line) => line.startsWith('▾ MCP'));
    expect(mcpRow).toBeGreaterThanOrEqual(0);
    expect(panel.sectionHeaderAt(mcpRow)).toBe('mcp');

    panel.toggleSection('mcp');
    const folded = panel.render(46).map(strip);
    expect(folded.some((line) => line.startsWith('▸ MCP'))).toBe(true);
    expect(folded.some((line) => line.includes('chrome-devtools'))).toBe(false);
  });

  it('never claims a live-panel header row as a plain section', () => {
    const proc: ProcessInfo = {
      id: 'p1', command: 'npm run dev', startedAt: new Date().toISOString(),
      running: true, completionMode: 'background',
    } as ProcessInfo;
    const panel = new TelemetryPanel(() => telemetryState({ processes: [proc] }));
    const rows = panel.render(46).map(strip);
    const procRow = rows.findIndex((line) => line.startsWith('▾ Processes'));
    expect(procRow).toBeGreaterThanOrEqual(0);
    expect(panel.sectionHeaderAt(procRow)).toBeNull();
  });
});

describe('lighter headers in the live list panels', () => {
  it('ProcessPanel header keeps counter and click hint with no rule', () => {
    const proc: ProcessInfo = {
      id: 'p1', command: 'npm run dev', startedAt: new Date().toISOString(),
      running: true, completionMode: 'background',
    } as ProcessInfo;
    const panel = new ProcessPanel();
    panel.set([proc]);
    const header = strip(panel.render(46)[0]!);
    expect(header).toBe('▾ Processes 1 running · click ✕');
    expect(header).not.toContain('─');
  });

  it('SubagentPanel and WorkflowPanel headers keep the collapse glyph and count', () => {
    const sub = new SubagentPanel();
    sub.set([{ sessionId: 's1', task: 'do a thing', status: 'running', tools: 1, seconds: 3 }]);
    expect(strip(sub.render(46)[0]!)).toBe('▾ Sub-agents 1 · click');

    const wf = new WorkflowPanel();
    wf.set([{ id: 'w1', title: 'Refactor', status: 'running', nodes: [] } as never]);
    expect(strip(wf.render(46)[0]!)).toBe('▾ Workflow 1 · click');
  });

  it('collapsed panels keep the ▸ glyph in the header', () => {
    const sub = new SubagentPanel();
    sub.set([{ sessionId: 's1', task: 't', status: 'running', tools: 0, seconds: 1 }]);
    sub.toggleCollapsed();
    expect(strip(sub.render(46)[0]!)).toMatch(/^▸ Sub-agents/);
  });
});
