import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';
import { resolveMascotArt } from './mascot.js';
import { FLOAT_BAND } from './mascotFloat.js';
import { ProcessPanel, SubagentPanel, WorkflowPanel, sectionHeaderContent, sectionHeaderRow } from './components.js';
import type { SubagentPanelEntry } from './components.js';
import type { WorkflowState } from '../../brain/transcript.js';
import { chatTheme, color, paintRow } from './theme.js';
import type { BrainRateLimits, BrainRateLimitWindow, BrainUsageView, GoalView, McpServerView } from './brainClient.js';
import type { ProcessInfo } from '../../brain/processRegistry.js';
import { formatDuration, formatK, terminalInlineText } from '../ui/text.js';
import { goalElapsedSeconds } from './goalState.js';
import { TELEMETRY_MAX_COLUMNS, TELEMETRY_MIN_COLUMNS } from './layoutBudget.js';

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
  /** User's `/maskot` preference. When false the mascot is hidden and its animation timer never arms.
   *  Optional so structural callers/tests default to shown (the product default). */
  showMascot?: boolean;
  /** The art to draw — the theme's own on a white-labeled instance, null when it ships none. Undefined
   *  keeps the built-in flame, so structural callers need not know about theming at all. */
  mascotArt?: string[] | null;
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

/** How the Context section is asked to place the session cost. `auto` is what rendering uses: prefer the
 *  full `tokens · % · $` line and only move the cost into the header when it does not fit. `narrow` is
 *  the measurement mode for {@link TelemetryPanel.contextRequiredWidth}, which asks what the rail needs
 *  once the cost has already moved. */
type ContextLayout = 'auto' | 'narrow';

interface ContextSummary {
  /** The summary row, indented like every other rail data row. */
  row: string;
  /** The cost for the header's faint meta, or '' while the summary row still carries it inline. */
  headerMeta: string;
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
    const state = this.getState();
    const art = resolveMascotArt(state.mascotArt);
    if (state.showMascot === false || art.length === 0) return false;
    if (this.maxRows === 0) return false;
    const functional = this.composeSections(this.sections(this.getState(), width));
    return this.maxRows == null || panelLogo(art, width).length + 2 + functional.rows.length <= this.maxRows;
  }
  /** How wide the rail's content actually needs to be, given everything currently populated, capped at
   *  `maxColumns`. Used to auto-fit the panel to its smallest useful size once at start instead of always
   *  opening at the fixed default width. */
  naturalWidth(maxColumns: number): number {
    const cap = Math.max(TELEMETRY_MIN_COLUMNS, Math.floor(maxColumns));
    const sections = this.sections(this.getState(), cap); // build at the cap so nothing truncates yet
    let widest = 0;
    for (const section of sections) {
      for (const row of measurableRows(section)) widest = Math.max(widest, visibleWidth(row));
    }
    return Math.min(cap, Math.max(TELEMETRY_MIN_COLUMNS, widest + PANEL_BAR_MARGIN * 2));
  }
  /** The narrowest rail width at which the Context section still shows every number it has: the
   *  `tokens · %` summary line, beside a header wide enough for the cost meta it takes on at exactly
   *  these widths. The manual drag-resize clamp (`inputRouter.ts`) uses this as its lower bound, so a
   *  hand-driven resize is never the reason a value disappears. The cost is deliberately NOT measured
   *  inline: below the width where the full line fits it MOVES into the header instead of being dropped
   *  ({@link contextSummary}), which is what lets a drag reach TELEMETRY_MIN_COLUMNS rather than stopping
   *  at the full line's length. Measured exactly like {@link naturalWidth} but scoped to Context alone,
   *  so it is independent of what the other sections happen to want, and recomputed on demand: tokens,
   *  percent and cost all move while a conversation runs. */
  contextRequiredWidth(): number {
    // Build at the rail's own maximum so nothing truncates during the measurement, in the same narrow
    // layout the rail itself adopts at this floor.
    const section = this.contextSection(this.getState(), TELEMETRY_MAX_COLUMNS, 'narrow');
    let widest = 0;
    for (const row of measurableRows(section)) widest = Math.max(widest, visibleWidth(row));
    // Capped at that same maximum: beyond it no rail width could show the line anyway, and the tiered
    // fallback in contextSummary stays the safety net for every width this floor does not govern.
    return Math.min(TELEMETRY_MAX_COLUMNS, Math.max(TELEMETRY_MIN_COLUMNS, widest + PANEL_BAR_MARGIN * 2));
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
  isSubagentPagerRow(row: number): boolean {
    return this.subagentTop >= 0 && this.subagentPanel.isPagerRow(row - this.subagentTop);
  }
  pageSubagents(): boolean { return this.subagentPanel.page(); }
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
  /** Content width inside the rail: the same PANEL_BAR_MARGIN gutter on both sides, so every row —
   *  header, data line, meter — ends at the same column and never touches the right edge. Single source
   *  for all five width calculations that used to disagree. */
  private contentWidth(width: number): number {
    return Math.max(1, width - PANEL_BAR_MARGIN * 2);
  }
  render(width: number): string[] {
    const st = this.getState();
    const sections = this.sections(st, width);
    const full = this.composeSections(sections);
    // A hidden mascot contributes no rows AND never lets the animation timer arm (canRenderMascot).
    // A rebranded instance with no art of its own reads the same way as an explicitly hidden one.
    const art = resolveMascotArt(st.mascotArt);
    const mascotEnabled = st.showMascot !== false && art.length > 0;
    const mascotRows = mascotEnabled ? ['', ...panelLogo(art, width, st.floatOffset), ''] : [];
    const showMascot = mascotEnabled && (this.maxRows == null || mascotRows.length + full.rows.length <= this.maxRows);
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

  /** The Context section on its own, so the drag-resize floor can measure exactly what the rail renders
   *  instead of a second, drifting copy of the same rows. A folded section keeps just its header; the
   *  chevron mirrors the Sub-agents/Processes panels and a one-value meta (the context %) keeps the
   *  folded row informative. Expanded, that same meta slot carries the session cost at the widths where
   *  {@link contextSummary} could not keep it inline. */
  private contextSection(st: TelemetryState, width: number, layout: ContextLayout = 'auto'): TelemetrySection {
    const usage = st.usage;
    const pct = usage?.percent != null ? `${Math.round(usage.percent)}%` : '—';
    const tokens = usage ? `${formatK(usage.tokens ?? 0)} / ${formatK(usage.contextWindow)}` : '—';
    const collapsed = this.collapsedSections.has('context');
    const summary = this.contextSummary(width, tokens, pct, usage, layout);
    const header = sectionHeaderRow(
      sectionHeaderContent(this.chevron('context'), 'Context', collapsed ? `· ${pct}` : summary.headerMeta),
      this.contentWidth(width),
    );
    return {
      id: 'context', minimumRows: 3,
      rows: collapsed ? [header] : [
        header,
        summary.row,
        `${' '.repeat(PANEL_BAR_MARGIN)}${this.contextBar(usage?.percent ?? 0, width)}`,
      ],
    };
  }

  /** Build complete semantic sections with no separator rows. Keeping those boundaries explicit lets
   * compact rendering preserve Context and Project, then add every enabled useful section before any
   * extra detail. */
  private sections(st: TelemetryState, width: number): TelemetrySection[] {
    // Nested panels render inside the rail, so they get the same gutter-narrowed width as every other
    // section — they add only their own left indent, never a right margin, so the edge is not doubled.
    const inner = this.contentWidth(width);
    this.processPanel.set(st.processes ?? []);
    this.processPanel.setMaxRows(PROCESS_ROWS_SHOWN);
    const processRows = this.processPanel.render(inner);
    this.subagentPanel.set(st.subagents ?? []);
    this.subagentPanel.setSelected(st.focusedSubagent ?? null);
    this.subagentPanel.setMaxRows(SUBAGENT_ROWS_SHOWN);
    const subagentRows = this.subagentPanel.render(inner);
    this.workflowPanel.set(st.workflows ?? []);
    this.workflowPanel.setMaxRows(WORKFLOW_ROWS_SHOWN);
    const workflowRows = this.workflowPanel.render(inner);
    const sections: TelemetrySection[] = [this.contextSection(st, width)];
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
      this.contentWidth(width),
    );
    sections.push({
      id: 'project', minimumRows: 3,
      rows: projectCollapsed ? [projectHeader] : [
        projectHeader,
        `  ${color.text(truncateToWidth(inlineText(st.cwd), this.contentWidth(width), '…'))}`,
        `  ${color.faint('branch')} ${color.accent(truncateToWidth(inlineText(st.branch || 'unknown'), Math.max(1, this.contentWidth(width) - 'branch '.length), '…'))}`,
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
      subagents.rows = this.subagentPanel.render(this.contentWidth(width));
    }
    const workflow = sections.find((section) => section.id === 'workflow');
    if (workflow) {
      this.workflowPanel.setMaxRows(counts.get('workflow') ?? 0);
      workflow.rows = this.workflowPanel.render(this.contentWidth(width));
    }
    return this.composeSections(sections, counts);
  }

  /** Two deliberately one-line subscription meters: enough to spot the 5h/weekly pressure and reset
   *  without turning the telemetry rail into a dashboard. Missing windows disappear independently. */
  private rateLimitRows(limits: BrainRateLimits | null, width: number): string[] {
    if (!limits || limits.windows.length === 0) return [];
    const meta = [limits.planType, limits.stale ? 'stale' : ''].filter(Boolean).map((value) => inlineText(String(value))).join(' · ');
    const header = sectionHeaderRow(sectionHeaderContent(this.chevron('limits'), 'Limits', meta), this.contentWidth(width));
    if (this.collapsedSections.has('limits')) return [header];
    const rows = [header];
    // Size every window's bar identically — to the width left by the widest reset label — so both meters
    // and the trailing % / reset columns line up regardless of per-window reset text length. The row after
    // its two-space indent is `label(7) bar(cells) ' ' pct(4) ' ' reset`, so the fixed overhead beside the
    // bar is 13 columns; the bar fills whatever the shared content width leaves.
    const resetWidth = Math.max(...limits.windows.map((w) => visibleWidth(this.rateLimitReset(w.resetsAt, w.windowMinutes))));
    // The floor keeps a bar present rather than pretty: at the 36-column minimum panel a long reset
    // label ("↻ Sat 01:40 PM") leaves it only a few cells. Raising the floor would buy legibility with
    // the right gutter, which the rail guarantees at every width — so the meter yields, not the margin.
    const cells = Math.max(4, this.contentWidth(width) - 13 - resetWidth);
    for (const window of limits.windows) rows.push(this.rateLimitWindowRow(window, cells));
    return rows;
  }

  private goalRows(goal: GoalView | null, width: number): string[] {
    if (goal?.status !== 'active') return [];
    const budget = goal.turn_budget > 0 ? `${goal.turns_used}/${goal.turn_budget} turns` : `${goal.turns_used} turns`;
    const title = truncateToWidth(inlineText(goal.goal), this.contentWidth(width), '…');
    const rows = [
      sectionHeaderRow(sectionHeaderContent(this.chevron('goal'), 'Goal', budget), this.contentWidth(width)),
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

  /** The session cost is the number the rail must never lose, and it is also the segment a narrow rail
   *  cannot keep inline. So it MOVES instead of degrading: while the full `tokens · % · $` fits the
   *  content width the line renders exactly as it always has, and below that the cost becomes the Context
   *  header's faint meta while the line keeps `tokens · %`, then the percentage alone (the bar underneath
   *  repeats it visually, so it is the cheapest thing to keep inline). The cost appears in exactly one of
   *  the two places, never both, and {@link contextRequiredWidth} guarantees the narrow form fits. */
  private contextSummary(
    width: number,
    tokens: string,
    pct: string,
    usage: BrainUsageView | null,
    layout: ContextLayout,
  ): ContextSummary {
    const cw = this.contentWidth(width);
    const separator = ` ${color.faint('·')} `;
    const tokensSegment = `${color.text(tokens)} ${color.faint('tokens')}`;
    const pctSegment = color.faint(pct);
    const cost = usage ? `$${usage.cost.toFixed(2)}` : '';
    if (layout === 'auto') {
      const full = [tokensSegment, pctSegment, cost ? color.faint(cost) : ''].filter(Boolean).join(separator);
      if (visibleWidth(full) <= cw) return { row: `  ${full}`, headerMeta: '' };
    }
    const withoutCost = [tokensSegment, pctSegment].join(separator);
    if (visibleWidth(withoutCost) <= cw) return { row: `  ${withoutCost}`, headerMeta: cost };
    return { row: `  ${truncateToWidth(pctSegment, cw, '…')}`, headerMeta: cost };
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
    const rows = [sectionHeaderRow(sectionHeaderContent(this.chevron('mcp'), 'MCP', `${connected.length}/${mcp.length} active`), this.contentWidth(width))];
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
      this.contentWidth(width),
    );
    if (collapsed) return [header];
    return [
      header,
      `  ${lspEnabled ? color.success('●') : color.faint('○')} ${color.text(state)} ${color.faint('· /lsp toggles')}`,
    ];
  }
}

/** The rows of a section that carry a real width preference. Progress bars stretch to fill whatever
 *  width they're given and want nothing of their own — excluding them is what keeps a width measurement
 *  a genuine "content" measurement instead of always reporting the cap it was built at. The context bar
 *  is always rows[2] when the section is expanded (rows[0]=header, rows[1]=the summary line);
 *  rate-limit window rows (rows[1..]) are bars too. The Context header is measured with the line because
 *  at a narrow width it is the header that carries the cost. */
function measurableRows(section: TelemetrySection): string[] {
  if (section.id === 'context') return section.rows.slice(0, 2);
  if (section.id === 'limits') return section.rows.slice(0, 1);
  return section.rows;
}

function panelLogo(source: string[], width: number, offset = 0): string[] {
  // The mascot, centered in the panel. Its truecolor lines already carry their own colors, so the panel
  // just pads them; wider than the panel (never, at the 36-col minimum) it clips gracefully.
  const art = source.map((line) => {
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
