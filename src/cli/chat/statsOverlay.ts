import { visibleWidth } from '@earendil-works/pi-tui';
import type { Component, Editor, Focusable, TUI } from '@earendil-works/pi-tui';
import { isEscapeKey, isKeyRelease, isLeftKey, isRightKey } from './keys.js';
import { color } from './theme.js';
import { FRAME_COLS, framed, hintRow, sectionRule, sectionTabs, titleRow } from './modalFrame.js';
import { openCenteredModal } from './openCenteredModal.js';
import { formatK } from '../ui/text.js';
import type { ModelUsageView, BrainUsageView } from './brainClient.js';

interface StatsOverlayData {
  model: string | null;
  usage: BrainUsageView | null;
  models: ModelUsageView[];
}

type Section = 'conversation' | 'models';

/** Right-aligned label + value pair — the calm two-column grid all etched modals share. */
const LABEL_W = 10;
const kv = (label: string, value: string): string => ` ${color.dim(label.padStart(LABEL_W))}   ${value}`;

function contextBar(width: number, percent: number): string {
  const on = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return color.text('▰'.repeat(on)) + color.faint('▱'.repeat(width - on));
}

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
    const bodyWidth = Math.max(1, width - FRAME_COLS);
    const { model, usage, models } = this.data;

    const body: string[] = [];
    body.push('');
    const tabs = sectionTabs([
      { label: 'Conversation', active: this.section === 'conversation' },
      { label: 'Models', active: this.section === 'models' },
    ]);
    body.push(titleRow('Stats', tabs.text, bodyWidth, tabs.width));
    body.push('');

    if (this.section === 'conversation') {
      body.push(sectionRule('session', bodyWidth));
      body.push('');
      const u = usage;
      if (u) {
        body.push(kv('model', color.text(model || '—')));
        if (u.percent != null) {
          body.push(kv('context', color.text(`${Math.round(u.percent)}%`) + color.faint(`   ${formatK(u.tokens ?? 0)} / ${formatK(u.contextWindow)}`)));
          body.push(kv('', contextBar(Math.min(34, Math.max(10, bodyWidth - LABEL_W - 6)), u.percent)));
        }
        body.push('');
        body.push(sectionRule('usage', bodyWidth));
        body.push('');
        body.push(kv('tokens', color.text(`${formatK(u.totalTokens)} total`)));
        body.push(kv('cost', color.bold(color.text(`$${u.cost.toFixed(2)}`))));
      } else {
        body.push(kv('', color.faint('no conversation usage data')));
      }
    } else {
      body.push(sectionRule('per model', bodyWidth));
      body.push('');
      if (models.length === 0) {
        body.push(kv('', color.faint('no model usage data')));
      } else {
        const execW = 26, tokW = 10, cacheW = 10, costW = 10;
        const pad = '   ';
        body.push(`${pad}${color.dim('model'.padEnd(execW))}${color.dim('tokens'.padStart(tokW))}${color.dim('cache'.padStart(cacheW))}${color.dim('cost'.padStart(costW))}`);

        const sorted = [...models].sort((a, b) => b.usage.total - a.usage.total);
        for (const m of sorted) {
          const exec = m.exec.length > execW - 2 ? `${m.exec.slice(0, execW - 4)}…` : m.exec;
          const costStr = m.usage.costUsd != null ? `$${m.usage.costUsd.toFixed(2)}` : '—';
          body.push(`${pad}${color.text(exec.padEnd(execW))}${color.text(formatK(m.usage.total).padStart(tokW))}${color.faint(formatK(m.usage.cacheRead + m.usage.cacheWrite).padStart(cacheW))}${color.text(costStr.padStart(costW))}`);
        }

        const totalTokens = models.reduce((sum, m) => sum + m.usage.total, 0);
        const totalCache = models.reduce((sum, m) => sum + m.usage.cacheRead + m.usage.cacheWrite, 0);
        const costs = models.map((m) => m.usage.costUsd).filter((c): c is number => c != null);
        const totalCost = costs.length ? costs.reduce((sum, c) => sum + c, 0) : null;
        body.push(`${pad}${color.faint('─'.repeat(execW + tokW + cacheW + costW))}`);
        body.push(`${pad}${color.accent('Σ'.padEnd(execW))}${color.text(formatK(totalTokens).padStart(tokW))}${color.faint(formatK(totalCache).padStart(cacheW))}${color.bold(color.text((totalCost != null ? `$${totalCost.toFixed(2)}` : '—').padStart(costW)))}`);
      }
    }

    body.push('');
    body.push(hintRow('← → section · esc close'));
    return framed(body, width);
  }
}

/** Fetch data then open the stats overlay with ←→-switchable Conversation/Models sections. */
export function openStatsOverlay(o: {
  tui: TUI;
  editor: Editor;
  data: StatsOverlayData;
}): void {
  const longest = Math.max(
    62,
    ...o.data.models.map((m) => Math.min(m.exec.length, 26) + 10 + 10 + 10 + 6),
    visibleWidth('Stats        ● Conversation    ○ Models') + 8,
  );
  openCenteredModal({
    tui: o.tui,
    editor: o.editor,
    makeComponent: (close) => new StatsOverlay(o.data, close),
    longest,
    minWidth: 56,
    pad: 8,
    maxHeight: 20,
  });
}
