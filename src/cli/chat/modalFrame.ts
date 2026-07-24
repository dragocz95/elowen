import { padAnsi } from '../ui/text.js';
import { chatTheme, color, paintRow } from './theme.js';

/** Shared "etched" modal chrome: every modal floats on the OLED-black modal surface inside a faint
 *  rounded hairline frame, with inline section rules and a dim footer hint. Content rows are built at
 *  BODY width (frame width − 2); the frame helpers re-establish the full-row width invariant the
 *  overlay contract requires (visibleWidth(row) === width for every row). */

/** Columns consumed by the left+right frame border. */
export const FRAME_COLS = 2;

/** One framed content row: `│` + body padded to width−2 + `│`, painted on the modal surface. */
function frameRow(body: string, width: number): string {
  return paintRow(chatTheme().modalBg, `${color.faint('│')}${padAnsi(body, Math.max(0, width - FRAME_COLS))}${color.faint('│')}`, width);
}

function frameTop(width: number): string {
  return paintRow(chatTheme().modalBg, color.faint(`╭${'─'.repeat(Math.max(0, width - FRAME_COLS))}╮`), width);
}

function frameBottom(width: number): string {
  return paintRow(chatTheme().modalBg, color.faint(`╰${'─'.repeat(Math.max(0, width - FRAME_COLS))}╯`), width);
}

/** Wrap body rows (built at width−2) with the top and bottom frame border. */
export function framed(bodyRows: string[], width: number): string[] {
  return [frameTop(width), ...bodyRows.map((row) => frameRow(row, width)), frameBottom(width)];
}

/** ` ── title ─────…` inline section rule at body width. */
export function sectionRule(title: string, bodyWidth: number): string {
  const tail = Math.max(0, bodyWidth - title.length - 6);
  return ` ${color.faint('── ')}${color.dim(title)}${color.faint(` ${'─'.repeat(tail)}`)}`;
}

/** Title body row: bold title left, optional right-aligned extras (tabs, status pill). */
export function titleRow(title: string, right: string, bodyWidth: number, rightWidth: number): string {
  const left = `   ${color.bold(color.text(title))}`;
  const gap = Math.max(2, bodyWidth - 3 - title.length - rightWidth - 3);
  return `${left}${' '.repeat(gap)}${right}`;
}

/** Dim footer hint body row (` hint`), the modal's only key legend. */
export function hintRow(hint: string): string {
  return `   ${color.faint(hint)}`;
}

/** ●/○ section tab pair; returns the styled string and its visible width. */
export function sectionTabs(tabs: { label: string; active: boolean }[]): { text: string; width: number } {
  const parts = tabs.map((t) => t.active
    ? `${color.bold(color.text(`● ${t.label}`))}`
    : color.faint(`○ ${t.label}`));
  const text = parts.join('    ');
  const width = tabs.reduce((sum, t) => sum + t.label.length + 2, 0) + (tabs.length - 1) * 4;
  return { text, width };
}
