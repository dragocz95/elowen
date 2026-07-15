import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';
import { MASCOT_ART } from './mascot.js';
import { FLOAT_BAND } from './mascotFloat.js';
import { ProcessPanel, SubagentPanel } from './components.js';
import type { SubagentPanelEntry } from './components.js';
import { chatTheme, color, paintRow } from './theme.js';
import type { BrainRateLimits, BrainRateLimitWindow, BrainUsageView, GoalView, McpServerView } from './brainClient.js';
import type { ProcessInfo } from '../../brain/processRegistry.js';
import { formatDuration, formatK, terminalInlineText } from '../ui/text.js';
import { goalElapsedSeconds } from './goalState.js';

const inlineText = terminalInlineText;
export interface TelemetryState {
  usage: BrainUsageView | null;
  cwd: string;
  branch: string;
  /** MCP servers from the daemon; null when unavailable (plugin off, non-admin) → section hidden. */
  mcp: Pick<McpServerView, 'name' | 'status'>[] | null;
  /** Live LSP diagnostics state; null when the daemon doesn't report it → line hidden. */
  lspEnabled: boolean | null;
  /** Owner-scoped background commands. They live in the right rail so they no longer consume transcript
   *  height; the rail keeps the existing collapse + click-to-kill ProcessPanel behavior. */
  processes?: ProcessInfo[];
  /** Running delegated sessions. Settled agents stay in the transcript; only live work appears here. */
  subagents?: readonly SubagentPanelEntry[];
  /** OpenAI OAuth subscription usage. Null on other providers/accounts, which hides the whole section. */
  rateLimits?: BrainRateLimits | null;
  /** Active persistent goal. Terminal states disappear; durable history remains in the conversation. */
  goal?: GoalView | null;
  /** Eased vertical drift of the flame (in panel rows) while the transcript is being scrolled; 0 at
   *  rest. The flame floats within a reserved ±{@link FLOAT_BAND} band so the Context section never moves. */
  floatOffset: number;
}

const PANEL_BAR_MARGIN = 2;
const MCP_NAMES_SHOWN = 4;
const PROCESS_ROWS_SHOWN = 5;
const SUBAGENT_ROWS_SHOWN = 5;

type TelemetrySectionId = 'context' | 'goal' | 'limits' | 'subagents' | 'processes' | 'project' | 'mcp' | 'lsp';

interface TelemetrySection {
  id: TelemetrySectionId;
  rows: string[];
  /** Smallest useful form of an optional section. Core sections are selected explicitly in full. */
  minimumRows: number;
}

interface TelemetryRows {
  rows: string[];
  processTop: number;
  subagentTop: number;
}

export class TelemetryPanel implements Component {
  private readonly processPanel = new ProcessPanel();
  private readonly subagentPanel = new SubagentPanel();
  private processTop = -1;
  private subagentTop = -1;
  private maxRows: number | null = null;
  constructor(private getState: () => TelemetryState) {}
  invalidate(): void { /* state driven */ }
  /** PI's overlay `maxHeight` clips from the top after render. Accept the same central budget here so
   * functional sections are selected before PI ever sees the frame instead of relying on that clip. */
  setMaxRows(rows: number | null): void {
    this.maxRows = rows == null ? null : Math.max(0, Math.floor(Number.isFinite(rows) ? rows : 0));
  }
  /** Cheap panel-local capability check used by the animation owner. Decorative movement is allowed
   * only when the complete current functional rail and the full fixed mascot band both fit. */
  canRenderMascot(width: number): boolean {
    if (this.maxRows === 0) return false;
    const functional = this.composeSections(this.sections(this.getState(), width));
    return this.maxRows == null || panelLogo(width).length + 2 + functional.rows.length <= this.maxRows;
  }
  isProcessHeaderRow(row: number): boolean {
    return this.processTop >= 0 && this.processPanel.isHeaderRow(row - this.processTop);
  }
  toggleProcesses(): void { this.processPanel.toggleCollapsed(); }
  processKillAt(row: number, x: number): string | null {
    return this.processTop >= 0 ? this.processPanel.killAt(row - this.processTop, x) : null;
  }
  isSubagentHeaderRow(row: number): boolean {
    return this.subagentTop >= 0 && this.subagentPanel.isHeaderRow(row - this.subagentTop);
  }
  toggleSubagents(): void { this.subagentPanel.toggleCollapsed(); }
  subagentAt(row: number): string | null {
    return this.subagentTop >= 0 ? this.subagentPanel.targetAt(row - this.subagentTop) : null;
  }
  canScrollSubagents(): boolean { return this.subagentPanel.canScroll(); }
  scrollSubagents(delta: number): boolean { return this.subagentPanel.scroll(delta); }
  render(width: number): string[] {
    const st = this.getState();
    const sections = this.sections(st, width);
    const full = this.composeSections(sections);
    const mascotRows = ['', ...panelLogo(width, st.floatOffset), ''];
    const showMascot = this.maxRows == null || mascotRows.length + full.rows.length <= this.maxRows;
    const functional = showMascot ? full : this.compactSections(sections, this.maxRows ?? full.rows.length, width);
    const rows = showMascot ? [...mascotRows, ...functional.rows] : [...functional.rows];
    this.processTop = functional.processTop < 0
      ? -1
      : functional.processTop + (showMascot ? mascotRows.length : 0);
    this.subagentTop = functional.subagentTop < 0
      ? -1
      : functional.subagentTop + (showMascot ? mascotRows.length : 0);
    if (this.maxRows != null) {
      rows.splice(this.maxRows);
      while (rows.length < this.maxRows) rows.push('');
    }
    return rows.map((r) => paintRow(chatTheme().panelBg, r, width));
  }

  /** Build complete semantic sections with no separator rows. Keeping those boundaries explicit lets
   * compact rendering preserve Context and Project, then add every enabled useful section before any
   * extra detail. */
  private sections(st: TelemetryState, width: number): TelemetrySection[] {
    const usage = st.usage;
    const pct = usage?.percent != null ? `${Math.round(usage.percent)}%` : '—';
    const tokens = usage ? `${formatK(usage.tokens ?? 0)} / ${formatK(usage.contextWindow)}` : '—';
    this.processPanel.set(st.processes ?? []);
    this.processPanel.setMaxRows(PROCESS_ROWS_SHOWN);
    const processRows = this.processPanel.render(width);
    this.subagentPanel.set(st.subagents ?? []);
    this.subagentPanel.setMaxRows(SUBAGENT_ROWS_SHOWN);
    const subagentRows = this.subagentPanel.render(width);
    const sections: TelemetrySection[] = [
      {
        id: 'context', minimumRows: 3,
        rows: [
          `  ${color.bold(color.text('Context'))}`,
          `  ${color.text(tokens)} ${color.faint('tokens')} ${color.faint(`· ${pct}`)}${usage ? ` ${color.faint(`· $${usage.cost.toFixed(2)}`)}` : ''}`,
          `${' '.repeat(PANEL_BAR_MARGIN)}${this.contextBar(usage?.percent ?? 0, width)}`,
        ],
      },
    ];
    const limitRows = this.rateLimitRows(st.rateLimits ?? null, width);
    const goalRows = this.goalRows(st.goal ?? null, width);
    if (goalRows.length > 0) {
      sections.push({ id: 'goal', rows: goalRows, minimumRows: Math.min(2, goalRows.length) });
    }
    if (limitRows.length > 0) {
      sections.push({ id: 'limits', rows: limitRows, minimumRows: limitRows.length });
    }
    if (subagentRows.length > 0) {
      sections.push({ id: 'subagents', rows: subagentRows, minimumRows: Math.min(2, subagentRows.length) });
    }
    if (processRows.length > 0) {
      sections.push({ id: 'processes', rows: processRows, minimumRows: 1 });
    }
    sections.push({
      id: 'project', minimumRows: 3,
      rows: [
        `  ${color.bold(color.text('Project'))}`,
        `  ${color.text(truncateToWidth(inlineText(st.cwd), Math.max(1, width - 4), '…'))}`,
        `  ${color.faint('branch')} ${color.accent(inlineText(st.branch || 'unknown'))}`,
      ],
    });
    const mcpRows = this.mcpRows(st.mcp, width);
    if (mcpRows.length > 0) sections.push({ id: 'mcp', rows: mcpRows, minimumRows: 1 });
    const lspRows = this.lspRows(st.lspEnabled);
    if (lspRows.length > 0) sections.push({ id: 'lsp', rows: lspRows, minimumRows: lspRows.length });
    return sections;
  }

  private composeSections(sections: TelemetrySection[], rowCounts?: Map<TelemetrySectionId, number>): TelemetryRows {
    const rows: string[] = [];
    let processTop = -1;
    let subagentTop = -1;
    for (const section of sections) {
      const count = rowCounts ? (rowCounts.get(section.id) ?? 0) : section.rows.length;
      if (count <= 0) continue;
      if (rows.length > 0) rows.push('');
      if (section.id === 'processes') processTop = rows.length;
      if (section.id === 'subagents') subagentTop = rows.length;
      rows.push(...section.rows.slice(0, count));
    }
    return { rows, processTop, subagentTop };
  }

  /** Protect the two core sections first. Optional sections then receive a useful minimum in priority
   * order; remaining rows expand their details. The returned rows already fit, so PI never decides which
   * semantic tail to discard. */
  private compactSections(sections: TelemetrySection[], maxRows: number, width: number): TelemetryRows {
    const budget = Math.max(0, Math.floor(maxRows));
    if (budget === 0) {
      this.subagentPanel.setMaxRows(0);
      return { rows: [], processTop: -1, subagentTop: -1 };
    }
    const counts = new Map<TelemetrySectionId, number>();
    let used = 0;
    const select = (section: TelemetrySection, count: number): boolean => {
      const separator = counts.size > 0 ? 1 : 0;
      if (used + separator + count > budget) return false;
      counts.set(section.id, count);
      used += separator + count;
      return true;
    };

    for (const id of ['context', 'project'] as const) {
      const section = sections.find((candidate) => candidate.id === id);
      if (section) select(section, section.rows.length);
    }
    for (const id of ['goal', 'subagents', 'limits', 'processes', 'mcp', 'lsp'] as const) {
      const section = sections.find((candidate) => candidate.id === id);
      if (section) select(section, section.minimumRows);
    }
    for (const id of ['goal', 'subagents', 'limits', 'processes', 'mcp', 'lsp'] as const) {
      const section = sections.find((candidate) => candidate.id === id);
      const current = section ? counts.get(id) : undefined;
      if (!section || current == null || current >= section.rows.length) continue;
      const extra = Math.min(section.rows.length - current, budget - used);
      counts.set(id, current + extra);
      used += extra;
    }

    // A caller outside the central layout should still get deterministic bounded output at an absurdly
    // small height. Production hides the rail before this path because both core sections cannot fit.
    if (counts.size === 0) {
      const context = sections.find((section) => section.id === 'context');
      if (context) counts.set('context', Math.min(budget, context.rows.length));
    }
    // The sub-agent range and hit map must describe the rows the compact allocator actually granted,
    // not the section's preferred five-row window built during the first semantic pass.
    const subagents = sections.find((section) => section.id === 'subagents');
    if (subagents) {
      this.subagentPanel.setMaxRows(counts.get('subagents') ?? 0);
      subagents.rows = this.subagentPanel.render(width);
    }
    return this.composeSections(sections, counts);
  }

  /** Two deliberately one-line subscription meters: enough to spot the 5h/weekly pressure and reset
   *  without turning the telemetry rail into a dashboard. Missing windows disappear independently. */
  private rateLimitRows(limits: BrainRateLimits | null, width: number): string[] {
    if (!limits) return [];
    const meta = [limits.planType, limits.stale ? 'stale' : ''].filter(Boolean).map((value) => inlineText(String(value))).join(' · ');
    const rows = [`  ${color.bold(color.text('Limits'))}${meta ? ` ${color.faint(meta)}` : ''}`];
    if (limits.primary) rows.push(this.rateLimitWindowRow(limits.primary, width));
    if (limits.secondary) rows.push(this.rateLimitWindowRow(limits.secondary, width));
    return rows.length > 1 ? rows : [];
  }

  private goalRows(goal: GoalView | null, width: number): string[] {
    if (goal?.status !== 'active') return [];
    const budget = goal.turn_budget > 0 ? `${goal.turns_used}/${goal.turn_budget} turns` : `${goal.turns_used} turns`;
    const title = truncateToWidth(inlineText(goal.goal), Math.max(1, width - 4), '…');
    const rows = [
      `  ${color.bold(color.text('Goal'))} ${color.faint(budget)}`,
      `  ${color.accent('◆')} ${color.text('Active')} ${color.faint(`· ${formatDuration(goalElapsedSeconds(goal))}`)}`,
    ];
    if (title) rows.push(`  ${color.dim(title)}`);
    try {
      const subgoals = JSON.parse(goal.subgoals) as { done?: boolean }[];
      if (Array.isArray(subgoals) && subgoals.length > 0) {
        rows.push(`  ${color.faint(`Subgoals ${subgoals.filter((subgoal) => subgoal?.done).length}/${subgoals.length}`)}`);
      }
    } catch { /* malformed legacy subgoals are omitted */ }
    return rows;
  }

  private rateLimitWindowRow(window: BrainRateLimitWindow, width: number): string {
    const labelWidth = 7;
    const label = this.rateLimitDuration(window.windowMinutes).padEnd(labelWidth);
    const pctValue = Math.max(0, Math.min(100, window.usedPercent));
    const pct = `${Math.round(pctValue)}%`.padStart(4);
    const reset = this.rateLimitReset(window.resetsAt, window.windowMinutes);
    // `  label` + bar + ` pct reset`; at the supported 36-col rail minimum this still leaves >=9 cells.
    const cells = Math.max(4, width - 15 - visibleWidth(reset));
    const bar = this.progressBar(pctValue, cells);
    return `  ${color.faint(label)}${bar} ${color.text(pct)} ${color.faint(reset)}`;
  }

  private rateLimitDuration(minutes: number | null): string {
    if (minutes === 10_080) return 'weekly';
    if (minutes == null || minutes <= 0) return 'window';
    if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
    if (minutes % 60 === 0) return `${minutes / 60}h`;
    return `${Math.round(minutes)}m`;
  }

  private rateLimitReset(seconds: number | null, minutes: number | null): string {
    if (seconds == null || !Number.isFinite(seconds)) return '↻ —';
    const at = new Date(seconds * 1_000);
    if (Number.isNaN(at.getTime())) return '↻ —';
    const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if ((minutes ?? 0) < 1_440) return `↻ ${time}`;
    const weekday = at.toLocaleDateString(undefined, { weekday: 'short' });
    return `↻ ${weekday} ${time}`;
  }

  /** The context meter spans the panel minus an equal margin on both edges and shares the exact same
   * block vocabulary as the OAuth limit windows at every responsive panel width. */
  private contextBar(percent: number, width: number): string {
    const cells = Math.max(8, width - PANEL_BAR_MARGIN * 2);
    return this.progressBar(percent, cells);
  }

  private progressBar(percent: number, cells: number): string {
    const value = Math.max(0, Math.min(100, percent));
    const filled = Math.max(0, Math.min(cells, Math.round((value / 100) * cells)));
    return `${color.accent('█'.repeat(filled))}${color.faint('░'.repeat(cells - filled))}`;
  }

  /** Active (connected) MCP servers by name plus a connected/total count; hidden when unavailable
   *  AND when nothing is connected — an all-idle section is just panel noise. */
  private mcpRows(mcp: TelemetryState['mcp'], width: number): string[] {
    if (!mcp) return [];
    const connected = mcp.filter((s) => s.status === 'connected');
    if (connected.length === 0) return [];
    const rows = [`  ${color.bold(color.text('MCP'))} ${color.faint(`${connected.length}/${mcp.length} active`)}`];
    for (const server of connected.slice(0, MCP_NAMES_SHOWN)) {
      rows.push(`  ${color.success('●')} ${color.text(truncateToWidth(inlineText(server.name), Math.max(1, width - 6), '…'))}`);
    }
    if (connected.length > MCP_NAMES_SHOWN) rows.push(`  ${color.faint(`… +${connected.length - MCP_NAMES_SHOWN} more`)}`);
    return rows;
  }

  private lspRows(lspEnabled: boolean | null): string[] {
    if (lspEnabled == null) return [];
    return [
      `  ${color.bold(color.text('LSP'))}`,
      `  ${lspEnabled ? color.success('●') : color.faint('○')} ${color.text(lspEnabled ? 'Active' : 'Inactive')} ${color.faint('· /lsp toggles')}`,
    ];
  }
}

function panelLogo(width: number, offset = 0): string[] {
  // The flame mascot, centered in the panel. Its truecolor lines already carry their own colors, so
  // the panel just pads them; wider than the panel (never, at the 36-col minimum) it clips gracefully.
  const art = MASCOT_ART.map((line) => {
    const pad = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
    return `${' '.repeat(pad)}${line}`;
  });
  // Reserve a fixed band of blank rows above AND below the flame and slide it within that band by whole
  // rows — a positive drift lifts the flame (fewer rows above). The band's total height is constant, so
  // the Context section below never reflows however far the flame drifts.
  const shift = Math.max(-FLOAT_BAND, Math.min(FLOAT_BAND, Math.round(offset)));
  const above = FLOAT_BAND - shift;
  const below = FLOAT_BAND + shift;
  return [
    ...Array.from({ length: above }, () => ''),
    ...art,
    ...Array.from({ length: below }, () => ''),
  ];
}
