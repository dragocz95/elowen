import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';
import { MASCOT_ART } from './mascot.js';
import { color, glyph } from './theme.js';
import { padAnsi, terminalInlineText } from '../ui/text.js';

const inlineText = terminalInlineText;
export const TOP_RULE_ROWS = 1;
export const PANEL_GUTTER_COLUMNS = 3;
const BANNER_ROWS = MASCOT_ART.length;
export class TopRule implements Component {
  /** `getTitle` supplies the active conversation's name; falls back to the brand when it's still empty
   *  (a brand-new, not-yet-titled chat). Kept as a getter so the rule re-renders when the title lands. */
  constructor(private readonly getTitle: () => string = () => '') {}
  invalidate(): void { /* stateless */ }
  render(width: number): string[] {
    const title = inlineText(this.getTitle());
    const label = title
      ? ` ${color.accent(glyph.whale)} ${color.text(truncateToWidth(title, Math.max(8, width - 12), '…'))} `
      // The brand fallback is 28 visible chars — on a narrower terminal it MUST clip too, or pi-tui's
      // width assert throws and takes the whole TUI down (leaving mouse reporting on).
      : truncateToWidth(` ${color.accent('Elowen Chat')} ${color.faint('new conversation')} `, width, '…');
    return [`${label}${color.accent('─'.repeat(Math.max(0, width - visibleWidth(label))))}`];
  }
}

export class MainColumn implements Component {
  /** `getChildren` so the column can swap its stack per render (start screen ↔ normal chat layout). */
  constructor(private getReserve: () => number, private getChildren: () => Component[]) {}
  invalidate(): void { for (const child of this.getChildren()) child.invalidate?.(); }
  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const reserve = Math.max(0, Math.min(Math.max(0, safeWidth - 1), this.getReserve()));
    const mainWidth = Math.max(0, safeWidth - reserve);
    const lines: string[] = [];
    for (const child of this.getChildren()) {
      for (const line of child.render(mainWidth)) {
        lines.push(`${padAnsi(line, mainWidth)}${' '.repeat(reserve)}`);
      }
    }
    return lines;
  }
}

export interface StartScreenState {
  /** Pre-coloured model/mode line shown under the input (mirrors the normal prompt meta line). */
  modelLine: string;
  /** Pre-coloured keyboard hints, right-aligned to the input box edge. */
  hints: string;
  /** Pre-coloured tip line, centered below the hints. */
  tip: string;
  /** Transient system lines (command output, errors) that normally render in the transcript. */
  notice: string;
  /** Pre-coloured bottom-left status (project dir · git branch). */
  statusLeft: string;
  /** Plain version string, rendered faint in the bottom-right corner. */
  version: string;
}

/** The centered input box geometry of the start screen — shared with overlay anchoring (the slash
 *  suggestions must open right under this input, not at the normal layout's bottom-of-screen slot). */
export function startScreenBox(width: number): { boxWidth: number; leftPad: number } {
  const safeWidth = Math.max(1, Math.floor(width));
  const boxWidth = Math.min(safeWidth, Math.max(Math.min(32, safeWidth), Math.min(72, safeWidth - 8)));
  return { boxWidth, leftPad: Math.max(0, Math.floor((width - boxWidth) / 2)) };
}

/** Row (0-based, within the start screen's rows) where the input box starts — mirror of the vertical
 *  centering in {@link StartScreen.render}, kept here so overlay anchoring can never drift from it. */
export function startScreenInputTop(rows: number, inputRows: number, noticeRows: number): number {
  const bodyLength = BANNER_ROWS + 1 + inputRows + 2 + 2 + 1 + (noticeRows ? 1 + noticeRows : 0);
  if (bodyLength > rows - 1) {
    let room = Math.max(0, rows - 1);
    const inputCount = Math.min(inputRows, room);
    room -= inputCount;
    const noticeCount = Math.min(noticeRows, room);
    room -= noticeCount;
    const modelCount = room > 0 ? 1 : 0;
    room -= modelCount;
    const hintCount = room > 0 ? 1 : 0;
    const compactLength = inputCount + noticeCount + modelCount + hintCount;
    return Math.max(0, rows - 1 - compactLength);
  }
  const topPad = Math.max(0, Math.floor((rows - 1 - bodyLength) / 2) - 1);
  return topPad + BANNER_ROWS + 1;
}

/** The empty-conversation start screen (opencode-style): a centered two-tone ELOWEN wordmark, the input
 *  box beneath it with the model line, keyboard hints, a tip — and a slim bottom status row with the
 *  project on the left and the Elowen version in the bottom-right corner. The right telemetry panel stays
 *  hidden until the first message lands. */
export class StartScreen implements Component {
  constructor(
    private readonly input: Component,
    private readonly getRows: () => number,
    private readonly getState: () => StartScreenState,
  ) {}
  invalidate(): void { this.input.invalidate?.(); }
  render(width: number): string[] {
    width = Math.max(1, Math.floor(width));
    const st = this.getState();
    const center = (text: string): string => {
      const clipped = truncateToWidth(text, width, '…');
      return `${' '.repeat(Math.max(0, Math.floor((width - visibleWidth(clipped)) / 2)))}${clipped}`;
    };
    const { boxWidth, leftPad } = startScreenBox(width);
    const indent = ' '.repeat(leftPad);
    const inputLines = this.input.render(boxWidth);
    const noticeLines = st.notice ? st.notice.split('\n') : [];
    const boxLine = (line: string): string => `${indent}${truncateToWidth(line, boxWidth, '…')}`;
    const hint = truncateToWidth(st.hints, boxWidth, '…');
    const hintLine = `${' '.repeat(Math.max(0, leftPad + boxWidth - visibleWidth(hint)))}${hint}`;
    const body = [
      ...MASCOT_ART.map((line) => center(line)),
      '',
      ...inputLines.map(boxLine),
      `${indent}${truncateToWidth(st.modelLine, boxWidth, '…')}`,
      hintLine,
      '',
      '',
      center(st.tip),
      ...(noticeLines.length ? ['', ...noticeLines.map((line) => center(line))] : []),
    ];
    const sidePad = Math.min(2, Math.max(0, Math.floor((width - 1) / 4)));
    const available = Math.max(0, width - sidePad * 2);
    let versionLabel = truncateToWidth(color.faint(`elowen v${st.version}`), Math.floor(available * 0.45), '…');
    let statusLeft = truncateToWidth(st.statusLeft, Math.max(0, available - visibleWidth(versionLabel) - 1), '…');
    if (!statusLeft && available > 0) {
      versionLabel = truncateToWidth(versionLabel, available, '…');
    }
    const statusGap = Math.max(0, available - visibleWidth(statusLeft) - visibleWidth(versionLabel));
    const statusRow = padAnsi(`${' '.repeat(sidePad)}${statusLeft}${' '.repeat(statusGap)}${versionLabel}`, width);
    const rows = Math.max(1, Math.floor(this.getRows()));
    // Short terminals cannot fit the decorative mascot/tip block. Keep the composer and status pinned,
    // then spend any remaining rows on live notices/model/hints; never return more than the allocation.
    if (body.length > rows - 1) {
      let room = Math.max(0, rows - 1);
      const inputCount = Math.min(inputLines.length, room);
      const shownInput = (inputCount > 0 ? inputLines.slice(-inputCount) : []).map(boxLine);
      room -= shownInput.length;
      const shownNotice = noticeLines.slice(0, room).map((line) => center(line));
      room -= shownNotice.length;
      const showModel = room > 0;
      if (showModel) room--;
      const showHints = room > 0;
      const compact = [
        ...shownInput,
        ...(showModel ? [`${indent}${truncateToWidth(st.modelLine, boxWidth, '…')}`] : []),
        ...(showHints ? [hintLine] : []),
        ...shownNotice,
      ];
      while (compact.length < rows - 1) compact.unshift('');
      return [...compact, statusRow];
    }
    // Center the block vertically, biased slightly upward (startScreenInputTop mirrors this math);
    // the status row is pinned to the last line.
    const topPad = Math.max(0, startScreenInputTop(rows, inputLines.length, noticeLines.length) - BANNER_ROWS - 1);
    const lines: string[] = Array.from({ length: topPad }, () => '');
    lines.push(...body);
    while (lines.length < rows - 1) lines.push('');
    lines.push(statusRow);
    return lines;
  }
}
