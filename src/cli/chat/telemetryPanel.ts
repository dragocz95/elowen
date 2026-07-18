import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';
import { MASCOT_ART } from './mascot.js';
import { FLOAT_BAND } from './mascotFloat.js';
import { ProcessPanel, SubagentPanel, WorkflowPanel, sectionHeaderContent, sectionHeaderRow } from './components.js';
import type { SubagentPanelEntry } from './components.js';
import type { WorkflowState } from '../../brain/transcript.js';
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
  /** The sub-agent the user is switched into, so the rail says WHICH agent the Context section describes.
   *  Null on the parent. Optional: the panel renders identically without it. */
  focusedSubagent?: string | null;
  /** Running sub-agent workflows (DAGs). Each row opens the navigable workflow modal. */
  workflows?: readonly WorkflowState[];
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
const WORKFLOW_ROWS_SHOWN = 4;

type TelemetrySectionId = 'context' | 'goal' | 'limits' | 'workflow' | 'subagents' | 'processes' | 'project' | 'mcp' | 'lsp';

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
  workflowTop: number;
  /** First row of every rendered section — the click target that folds the plain (non-panel) sections. */
  tops: Map<TelemetrySectionId, number>;
}

export class TelemetryPanel implements Component {
  private readonly processPanel = new ProcessPanel();
  private readonly subagentPanel = new SubagentPanel();
  private readonly workflowPanel = new WorkflowPanel();
  private processTop = -1;
  private subagentTop = -1;
  private workflowTop = -1;
  /** Plain (non-panel) sections the user folded via their header row; the state lives for the session. */
  private readonly collapsedSections = new Set<TelemetrySectionId>();
  private sectionTops = new Map<TelemetrySectionId, number>();
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
  isWorkflowHeaderRow(row: number): boolean {
    return this.workflowTop >= 0 && this.workflowPanel.isHeaderRow(row - this.workflowTop);
  }
  toggleWorkflows(): void { this.workflowPanel.toggleCollapsed(); }
  workflowAt(row: number): string | null {
    return this.workflowTop >= 0 ? this.workflowPanel.targetAt(row - this.workflowTop) : null;
  }
  canScrollWorkflows(): boolean { return this.workflowPanel.canScroll(); }
  scrollWorkflows(delta: number): boolean { return this.workflowPanel.scroll(delta); }
  /** The plain section whose header occupies this row, or null. Panel headers keep their own toggles,
   *  so their ids never surface here even though their top rows are tracked the same way. */
  sectionHeaderAt(row: number): TelemetrySectionId | null {
    for (const [id, top] of this.sectionTops) {
      if (top !== row || id === 'subagents' || id === 'processes' || id === 'workflow') continue;
      return id;
    }
    return null;
  }
  toggleSection(id: TelemetrySectionId): void {
    if (this.collapsedSections.has(id)) this.collapsedSections.delete(id);
    else this.collapsedSections.add(id);
  }
  private chevron(id: TelemetrySectionId): string {
    return this.collapsedSections.has(id) ? '▸' : '▾';
  }
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
    this.workflowTop = functional.workflowTop < 0
      ? -1
      : functional.workflowTop + (showMascot ? mascotRows.length : 0);
    const topOffset = showMascot ? mascotRows.length : 0;
    this.sectionTops = new Map([...functional.tops].map(([id, top]) => [id, top + topOffset]));
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
    this.subagentPanel.setSelected(st.focusedSubagent ?? null);
    this.subagentPanel.setMaxRows(SUBAGENT_ROWS_SHOWN);
    const subagentRows = this.subagentPanel.render(width);
    this.workflowPanel.set(st.workflows ?? []);
    this.workflowPanel.setMaxRows(WORKFLOW_ROWS_SHOWN);
    const workflowRows = this.workflowPanel.render(width);
    // A folded section keeps just its header; the chevron mirrors the Sub-agents/Processes panels and
    // a one-value meta (context %, branch, LSP state) keeps the folded row informative.
    const contextCollapsed = this.collapsedSections.has('context');
    const contextHeader = sectionHeaderRow(
      sectionHeaderContent(this.chevron('context'), 'Context', contextCollapsed ? `· ${pct}` : ''),
      width,
    );
    const sections: TelemetrySection[] = [
      {
        id: 'context', minimumRows: 3,
        rows: contextCollapsed ? [contextHeader] : [
          contextHeader,
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
    if (workflowRows.length > 0) {
      sections.push({ id: 'workflow', rows: workflowRows, minimumRows: Math.min(2, workflowRows.length) });
    }
    if (subagentRows.length > 0) {
      sections.push({ id: 'subagents', rows: subagentRows, minimumRows: Math.min(2, subagentRows.length) });
    }
    if (processRows.length > 0) {
      sections.push({ id: 'processes', rows: processRows, minimumRows: 1 });
    }
    const projectCollapsed = this.collapsedSections.has('project');
    const projectHeader = sectionHeaderRow(
      sectionHeaderContent(this.chevron('project'), 'Project', projectCollapsed ? `· ${inlineText(st.branch || 'unknown')}` : ''),
      width,
    );
    sections.push({
      id: 'project', minimumRows: 3,
      rows: projectCollapsed ? [projectHeader] : [
        projectHeader,
        `  ${color.text(truncateToWidth(inlineText(st.cwd), Math.max(1, width - 4), '…'))}`,
        `  ${color.faint('branch')} ${color.accent(inlineText(st.branch || 'unknown'))}`,
      ],
    });
    const mcpRows = this.mcpRows(st.mcp, width);
    if (mcpRows.length > 0) sections.push({ id: 'mcp', rows: mcpRows, minimumRows: 1 });
    const lspRows = this.lspRows(st.lspEnabled, width);
    if (lspRows.length > 0) sections.push({ id: 'lsp', rows: lspRows, minimumRows: lspRows.length });
    return sections;
  }

  private composeSections(sections: TelemetrySection[], rowCounts?: Map<TelemetrySectionId, number>): TelemetryRows {
    const rows: string[] = [];
    let processTop = -1;
    let subagentTop = -1;
    let workflowTop = -1;
    const tops = new Map<TelemetrySectionId, number>();
    for (const section of sections) {
      const count = rowCounts ? (rowCounts.get(section.id) ?? 0) : section.rows.length;
      if (count <= 0) continue;
      if (rows.length > 0) rows.push('');
      tops.set(section.id, rows.length);
      if (section.id === 'processes') processTop = rows.length;
      if (section.id === 'subagents') subagentTop = rows.length;
      if (section.id === 'workflow') workflowTop = rows.length;
      rows.push(...section.rows.slice(0, count));
    }
    return { rows, processTop, subagentTop, workflowTop, tops };
  }

  /** Protect the two core sections first. Optional sections then receive a useful minimum in priority
   * order; remaining rows expand their details. The returned rows already fit, so PI never decides which
   * semantic tail to discard. */
  private compactSections(sections: TelemetrySection[], maxRows: number, width: number): TelemetryRows {
    const budget = Math.max(0, Math.floor(maxRows));
    if (budget === 0) {
      this.subagentPanel.setMaxRows(0);
      this.workflowPanel.setMaxRows(0);
      return { rows: [], processTop: -1, subagentTop: -1, workflowTop: -1, tops: new Map() };
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
    for (const id of ['goal', 'workflow', 'subagents', 'limits', 'processes', 'mcp', 'lsp'] as const) {
      const section = sections.find((candidate) => candidate.id === id);
      if (section) select(section, section.minimumRows);
    }
    for (const id of ['goal', 'workflow', 'subagents', 'limits', 'processes', 'mcp', 'lsp'] as const) {
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
    const workflow = sections.find((section) => section.id === 'workflow');
    if (workflow) {
      this.workflowPanel.setMaxRows(counts.get('workflow') ?? 0);
      workflow.rows = this.workflowPanel.render(width);
    }
    return this.composeSections(sections, counts);
  }

  /** Two deliberately one-line subscription meters: enough to spot the 5h/weekly pressure and reset
   *  without turning the telemetry rail into a dashboard. Missing windows disappear independently. */
  private rateLimitRows(limits: BrainRateLimits | null, width: number): string[] {
    if (!limits || limits.windows.length === 0) return [];
    const meta = [limits.planType, limits.stale ? 'stale' : ''].filter(Boolean).map((value) => inlineText(String(value))).join(' · ');
    const header = sectionHeaderRow(sectionHeaderContent(this.chevron('limits'), 'Limits', meta), width);
    if (this.collapsedSections.has('limits')) return [header];
    const rows = [header];
    // Size every window's bar identically — to the width left by the widest reset label — so both meters
    // and the trailing % / reset columns line up regardless of per-window reset text length.
    const resetWidth = Math.max(...limits.windows.map((w) => visibleWidth(this.rateLimitReset(w.resetsAt, w.windowMinutes))));
    const cells = Math.max(4, width - 15 - resetWidth);
    for (const window of limits.windows) rows.push(this.rateLimitWindowRow(window, cells));
    return rows;
  }

  private goalRows(goal: GoalView | null, width: number): string[] {
    if (goal?.status !== 'active') return [];
    const budget = goal.turn_budget > 0 ? `${goal.turns_used}/${goal.turn_budget} turns` : `${goal.turns_used} turns`;
    const title = truncateToWidth(inlineText(goal.goal), Math.max(1, width - 4), '…');
    const rows = [
      sectionHeaderRow(sectionHeaderContent(this.chevron('goal'), 'Goal', budget), width),
    ];
    if (this.collapsedSections.has('goal')) return rows;
    rows.push(`  ${color.accent('◆')} ${color.text('Active')} ${color.faint(`· ${formatDuration(goalElapsedSeconds(goal))}`)}`);
    if (title) rows.push(`  ${color.dim(title)}`);
    try {
      const subgoals = JSON.parse(goal.subgoals) as { done?: boolean }[];
      if (Array.isArray(subgoals) && subgoals.length > 0) {
        rows.push(`  ${color.faint(`Subgoals ${subgoals.filter((subgoal) => subgoal?.done).length}/${subgoals.length}`)}`);
      }
    } catch { /* malformed legacy subgoals are omitted */ }
    return rows;
  }

  private rateLimitWindowRow(window: BrainRateLimitWindow, cells: number): string {
    const labelWidth = 7;
    const label = this.rateLimitDuration(window.windowMinutes).padEnd(labelWidth);
    const pctValue = Math.max(0, Math.min(100, window.usedPercent));
    const pct = `${Math.round(pctValue)}%`.padStart(4);
    const reset = this.rateLimitReset(window.resetsAt, window.windowMinutes);
    // `  label` + bar + ` pct reset`; cells is shared across windows so the bars and columns align.
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

  /** A framed segmented usage meter: lit ▰ segments inside a faint `[ ]` frame that always marks the
   *  full extent, so the empty remainder is blank (no track line) yet you still see where the bar ends.
   *  Usage is pressure, so the fill shifts accent → warning (70 %) → error (90 %); the percentage number
   *  beside it stays in the neutral text color. The two frame cells count toward the given width. */
  private progressBar(percent: number, cells: number): string {
    const value = Math.max(0, Math.min(100, percent));
    // Two cells go to the [ ] frame; callers always pass a comfortable width (>=8 context, >=4 limits).
    const inner = cells - 2;
    // A tiny non-zero usage rounds to zero segments and reads as empty; show at least one lit segment so
    // a live meter is never indistinguishable from 0 % (still capped at the inner cell count).
    const filled = Math.min(inner, Math.max(value > 0 ? 1 : 0, Math.round((value / 100) * inner)));
    const tone = value >= 90 ? color.error : value >= 70 ? color.warning : color.accent;
    return `${color.faint('[')}${tone('▰'.repeat(filled))}${' '.repeat(inner - filled)}${color.faint(']')}`;
  }

  /** Active (connected) MCP servers by name plus a connected/total count; hidden when unavailable
   *  AND when nothing is connected — an all-idle section is just panel noise. */
  private mcpRows(mcp: TelemetryState['mcp'], width: number): string[] {
    if (!mcp) return [];
    const connected = mcp.filter((s) => s.status === 'connected');
    if (connected.length === 0) return [];
    const rows = [sectionHeaderRow(sectionHeaderContent(this.chevron('mcp'), 'MCP', `${connected.length}/${mcp.length} active`), width)];
    if (this.collapsedSections.has('mcp')) return rows;
    for (const server of connected.slice(0, MCP_NAMES_SHOWN)) {
      rows.push(`  ${color.success('●')} ${color.text(truncateToWidth(inlineText(server.name), Math.max(1, width - 6), '…'))}`);
    }
    if (connected.length > MCP_NAMES_SHOWN) rows.push(`  ${color.faint(`… +${connected.length - MCP_NAMES_SHOWN} more`)}`);
    return rows;
  }

  private lspRows(lspEnabled: boolean | null, width: number): string[] {
    if (lspEnabled == null) return [];
    const collapsed = this.collapsedSections.has('lsp');
    const state = lspEnabled ? 'Active' : 'Inactive';
    const header = sectionHeaderRow(
      sectionHeaderContent(this.chevron('lsp'), 'LSP', collapsed ? `· ${state}` : ''),
      width,
    );
    if (collapsed) return [header];
    return [
      header,
      `  ${lspEnabled ? color.success('●') : color.faint('○')} ${color.text(state)} ${color.faint('· /lsp toggles')}`,
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
