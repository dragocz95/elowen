import { matchesKey } from '@earendil-works/pi-tui';

/** The single seam for every key-string comparison in the chat TUI. All `matchesKey` chord matches
 *  and raw escape-sequence checks live behind these named predicates, so configurable keybinds only
 *  ever have to touch this module. Each predicate mirrors its original inline check exactly. */

export function isModeToggleKey(data: string): boolean {
  return data === '\x1b[Z' // Shift+Tab in xterm-compatible terminals.
    || data === '\x1b[9;5u' // Ctrl+Tab when modifyOtherKeys/kitty-style reporting is enabled.
    || matchesKey(data, 'shift+tab')
    || matchesKey(data, 'ctrl+tab');
}

export function isCtrlC(data: string): boolean { return matchesKey(data, 'ctrl+c'); }
export function isCtrlD(data: string): boolean { return matchesKey(data, 'ctrl+d'); }
export function isCtrlL(data: string): boolean { return matchesKey(data, 'ctrl+l'); }
export function isCtrlO(data: string): boolean { return matchesKey(data, 'ctrl+o'); }
export function isCtrlP(data: string): boolean { return matchesKey(data, 'ctrl+p'); }
export function isCtrlR(data: string): boolean { return matchesKey(data, 'ctrl+r'); }
export function isCtrlS(data: string): boolean { return matchesKey(data, 'ctrl+s'); }
export function isCtrlU(data: string): boolean { return matchesKey(data, 'ctrl+u'); }

export function isEscapeKey(data: string): boolean { return matchesKey(data, 'escape'); }
export function isEnterKey(data: string): boolean { return data === '\r' || matchesKey(data, 'enter'); }
export function isBackspaceKey(data: string): boolean { return matchesKey(data, 'backspace') || data === '\x7f'; }
export function isUpKey(data: string): boolean { return data === '\x1b[A' || matchesKey(data, 'up'); }
export function isDownKey(data: string): boolean { return data === '\x1b[B' || matchesKey(data, 'down'); }

/** The raw Tab byte only (also what ctrl+i sends) — used where Tab completes into the input and the
 *  broader `matchesKey('tab')` sequences must NOT trigger. */
export function isTabByte(data: string): boolean { return data === '\t'; }
/** Tab in any reported form (raw byte or kitty/modifyOtherKeys sequence). */
export function isTabKey(data: string): boolean { return data === '\t' || matchesKey(data, 'tab'); }

export function isPageUpKey(data: string): boolean { return data === '\x1b[5~'; }
export function isPageDownKey(data: string): boolean { return data === '\x1b[6~'; }
