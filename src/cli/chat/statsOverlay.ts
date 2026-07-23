import { visibleWidth } from '@earendil-works/pi-tui';
import type { Component, Editor, Focusable, TUI } from '@earendil-works/pi-tui';
import { isEscapeKey, isKeyRelease, isLeftKey, isRightKey } from './keys.js';
import { chatTheme, color, paintRow } from './theme.js';
import { openCenteredModal } from './openCenteredModal.js';
import { formatK } from '../ui/text.js';
import type { ModelUsageView, BrainUsageView } from './brainClient.js';

interface StatsOverlayData {
  model: string | null;
  usage: BrainUsageView | null;
  models: ModelUsageView[];
}

type Section = 'conversation' | 'models';

class StatsOverlay implements Component, Focusable {
  private _focused = false;
  private section: Section = 'conversation';

  constructor(
    private readonly data: StatsOverlayData,
    private readonly onClose: () => void,
  ) {}

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; }
  invalidate(): void { /* state driven */ }

  private cycle(): void {
    this.section = this.section === 'conversation' ? 'models' : 'conversation';
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (isEscapeKey(data)) { this.onClose(); return; }
    if (isLeftKey(data) || isRightKey(data)) { this.cycle(); return; }
  }

  render(width: number): string[] {
    const bodyWidth = Math.max(1, width - 4);
    const line = (s: string): string => paintRow(chatTheme().modalBg, s, width);
    const { model, usage, models } = this.data;

    const out: string[] = [];
    out.push(line(`  ${color.bold(color.text('Stats'))}${color.faint(' '.repeat(Math.max(1, bodyWidth - 10)) + 'esc')}`));
    out.push(line(''));

    // Section header with arrows
    const navLabel = color.bold(this.section === 'conversation' ? color.text('‹ Conversation') : color.faint('‹ Conversation'));
    const navRight = this.section === 'models' ? color.bold(color.text('Models ›')) : color.faint('Models ›');
    const nav = `  ${navLabel}  ${color.faint('|')}  ${navRight}`;
    out.push(line(nav));

    // Section body
    if (this.section === 'conversation') {
      const u = usage;
      if (u) {
        out.push(line(`  ${color.faint('model'.padEnd(12))} ${color.text(model || '—')}`));
        if (u.percent != null) {
          out.push(line(`  ${color.faint('context'.padEnd(12))} ${color.text(`${Math.round(u.percent)}%  (${formatK(u.tokens ?? 0)} / ${formatK(u.contextWindow)})`)}`));
        }
        out.push(line(`  ${color.faint('tokens'.padEnd(12))} ${color.text(`${formatK(u.totalTokens)} total`)}`));
        out.push(line(`  ${color.faint('cost'.padEnd(12))} ${color.text(`$${u.cost.toFixed(2)}`)}`));
      } else {
        out.push(line(`  ${color.faint('no conversation usage data')}`));
      }
    } else {
      if (models.length === 0) {
        out.push(line(`  ${color.faint('no model usage data')}`));
      } else {
        // Header
        const headExec = color.faint('model');
        const headTokens = color.faint('tokens').padStart(14);
        const headCache = color.faint('cache').padStart(10);
        const headCost = color.faint('cost').padStart(12);
        out.push(line(`  ${headExec}${headTokens}${headCache}${headCost}`));

        // Sort by total descending
        const sorted = [...models].sort((a, b) => b.usage.total - a.usage.total);

        for (const m of sorted) {
          const exec = m.exec.length > 24 ? `${m.exec.slice(0, 22)}…` : m.exec.padEnd(24);
          const tokens = formatK(m.usage.total).padStart(14);
          const cache = formatK(m.usage.cacheRead + m.usage.cacheWrite).padStart(10);
          const costStr = m.usage.costUsd != null ? `$${m.usage.costUsd.toFixed(2)}` : '—';
          const cost = costStr.padStart(12);
          out.push(line(`  ${color.text(exec)}${color.text(tokens)}${color.faint(cache)}${color.text(cost)}`));
        }

        // Totals
        const totalTokens = models.reduce((sum, m) => sum + m.usage.total, 0);
        const totalCache = models.reduce((sum, m) => sum + m.usage.cacheRead + m.usage.cacheWrite, 0);
        const costs = models.map((m) => m.usage.costUsd).filter((c): c is number => c != null);
        const totalCost = costs.length ? costs.reduce((sum, c) => sum + c, 0) : null;
        out.push(line(''));
        out.push(line(`  ${color.accent('Σ')}  ${color.text(formatK(totalTokens).padStart(14))}  ${color.faint(formatK(totalCache).padStart(10))}  ${color.text((totalCost != null ? `$${totalCost.toFixed(2)}` : '—').padStart(12))}`));
      }
    }

    out.push(line(''));
    out.push(line(`  ${color.faint('\u2190 \u2192 switch section  \u00b7  esc close')}`));
    return out;
  }
}

/** Fetch data then open the stats overlay with ←→-switchable Conversation/Models sections. */
export function openStatsOverlay(o: {
  tui: TUI;
  editor: Editor;
  data: StatsOverlayData;
}): void {
  const longest = Math.max(
    60,
    ...o.data.models.map((m) => m.exec.length + 14 + 10 + 12 + 6),
    visibleWidth('model') + 14 + 10 + 12,
    visibleWidth('‹ Conversation  |  Models ›'),
  );
  openCenteredModal({
    tui: o.tui,
    editor: o.editor,
    makeComponent: (close) => new StatsOverlay(o.data, close),
    longest,
    minWidth: 54,
    pad: 12,
    maxHeight: 18,
  });
}
