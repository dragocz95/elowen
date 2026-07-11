import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';
import { padAnsi } from '../ui/text.js';
import { ansi, chatTheme, color } from './theme.js';

export interface SuggestionItem {
  value: string;
  label: string;
  description?: string;
}

export type SuggestionKind = 'commands' | 'files';

const bgFill = (text: string, width: number): string =>
  `\x1b[${chatTheme().inputBg}m${padAnsi(text, width)}\x1b[0m`;

/** Shared non-capturing suggestion viewport used by both slash commands and file mentions. Filtering and
 * row formatting vary by kind; selection, clipping, scroll window and chrome have one implementation. */
export class SuggestionOverlay implements Component {
  private items: SuggestionItem[];
  private filter = '';
  private selectedIndex = 0;
  private maxRows: number | null = null;

  constructor(private readonly kind: SuggestionKind, items: SuggestionItem[] = []) {
    this.items = items;
  }

  invalidate(): void { /* state driven */ }

  setMaxRows(rows: number | null): void {
    this.maxRows = rows == null ? null : Math.max(1, Math.floor(rows));
  }

  setItems(items: SuggestionItem[]): void {
    this.items = items;
    this.selectedIndex = 0;
  }

  setFilter(text: string): void {
    const filter = text.startsWith('/') ? text.slice(1) : text;
    if (filter === this.filter) return;
    this.filter = filter;
    this.selectedIndex = 0;
  }

  moveSelection(delta: number): void {
    const count = this.visibleItems().length;
    if (count === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + count) % count;
  }

  selectedValue(): string | null {
    return this.visibleItems()[this.selectedIndex]?.value ?? null;
  }

  filteredItems(): SuggestionItem[] {
    return this.kind === 'commands' ? this.filteredCommands() : this.items;
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const top = `${color.accent('╭')}${color.faint('─'.repeat(innerWidth))}${color.accent('╮')}`;
    const bottom = `${color.accent('╰')}${color.faint('─'.repeat(innerWidth))}${color.accent('╯')}`;
    const row = (content: string): string => `${color.accent('│')}${bgFill(content, innerWidth)}${color.accent('│')}`;
    const items = this.visibleItems();
    if (this.selectedIndex >= items.length) this.selectedIndex = Math.max(0, items.length - 1);

    const cap = this.maxRows ?? Number.POSITIVE_INFINITY;
    const compact = innerWidth < 55;
    const subject = this.kind === 'commands' ? 'commands' : 'files';
    const action = this.kind === 'commands' ? 'run' : 'attach';
    const hintText = compact
      ? `${subject} · ↑↓ · tab/enter · esc`
      : `${subject} · ↑↓ select · tab/enter ${action} · esc dismiss`;
    const hint = row(`  ${ansi.open(chatTheme().faint, hintText)}`);
    if (cap <= 3) return cap === 1 ? [bottom] : cap === 2 ? [top, bottom] : [top, hint, bottom];

    const includeBlank = !Number.isFinite(cap) || cap >= 6;
    let itemLimit = 10;
    if (Number.isFinite(cap)) {
      itemLimit = Math.max(1, cap - 3 - (includeBlank ? 1 : 0));
      if (items.length > itemLimit && itemLimit > 1) itemLimit--;
    }
    const start = Math.max(0, Math.min(
      this.selectedIndex - Math.floor(itemLimit / 2),
      Math.max(0, items.length - itemLimit),
    ));
    const shown = items.slice(start, start + itemLimit);
    const itemRows = shown.length
      ? shown.map((item, index) => this.itemRow(item, start + index === this.selectedIndex, innerWidth, row))
      : [row(ansi.open(chatTheme().muted, `  No matching ${subject}`))];
    const counter = items.length > shown.length
      ? [row(ansi.open(chatTheme().faint, `  (${Math.min(this.selectedIndex + 1, items.length)}/${items.length})`))]
      : [];
    const full = [top, hint, ...(includeBlank ? [row('')] : []), ...itemRows, ...counter, bottom];
    return Number.isFinite(cap) ? full.slice(0, cap) : full;
  }

  private visibleItems(): SuggestionItem[] {
    return this.kind === 'commands' ? this.filteredCommands() : this.items;
  }

  private filteredCommands(): SuggestionItem[] {
    const query = this.filter.trim().toLowerCase().replace(/^\//, '');
    const score = (item: SuggestionItem): number => {
      if (!query) return 1;
      const name = item.value.replace(/^\//, '').toLowerCase();
      const description = (item.description ?? '').toLowerCase();
      if (name === query) return 100;
      if (name.startsWith(query)) return 80;
      if (name.includes(query)) return 60;
      if (description.includes(query)) return 35;
      let position = 0;
      for (const character of query) {
        position = name.indexOf(character, position);
        if (position === -1) return 0;
        position++;
      }
      return 20;
    };
    return this.items
      .map((item) => ({ item, score: score(item) }))
      .filter(({ score: value }) => value > 0)
      .sort((left, right) => right.score - left.score || left.item.value.localeCompare(right.item.value))
      .map(({ item }) => item);
  }

  private itemRow(
    item: SuggestionItem,
    selected: boolean,
    innerWidth: number,
    row: (content: string) => string,
  ): string {
    let content: string;
    if (this.kind === 'commands') {
      const command = padAnsi(item.label, 14);
      const description = truncateToWidth(item.description ?? '', Math.max(1, innerWidth - 17), '');
      content = `  ${command} ${description}`;
    } else {
      const descriptionWidth = item.description
        ? Math.min(visibleWidth(item.description), Math.max(0, innerWidth - 4 - visibleWidth(item.label) - 2))
        : 0;
      const label = truncateToWidth(item.label, Math.max(1, innerWidth - 4 - (descriptionWidth ? descriptionWidth + 2 : 0)), '…');
      const description = descriptionWidth ? `  ${truncateToWidth(item.description ?? '', descriptionWidth, '…')}` : '';
      content = `  ${label}${description}`;
    }
    if (selected) {
      return `${color.accent('│')}${ansi.sgr(`${chatTheme().selectedBg};30;1`, padAnsi(content, innerWidth))}${color.accent('│')}`;
    }
    if (this.kind === 'commands') {
      const label = padAnsi(item.label, 14);
      const description = truncateToWidth(item.description ?? '', Math.max(1, innerWidth - 17), '');
      return row(`  ${ansi.open(chatTheme().text, label)} ${ansi.open(chatTheme().muted, description)}`);
    }
    const descriptionWidth = item.description
      ? Math.min(visibleWidth(item.description), Math.max(0, innerWidth - 4 - visibleWidth(item.label) - 2))
      : 0;
    const label = truncateToWidth(item.label, Math.max(1, innerWidth - 4 - (descriptionWidth ? descriptionWidth + 2 : 0)), '…');
    const description = descriptionWidth ? `  ${truncateToWidth(item.description ?? '', descriptionWidth, '…')}` : '';
    return row(`  ${ansi.open(chatTheme().text, label)}${description ? ansi.open(chatTheme().muted, description) : ''}`);
  }
}

export class SlashOverlay extends SuggestionOverlay {
  constructor(items: SuggestionItem[]) { super('commands', items); }
}

export class MentionOverlay extends SuggestionOverlay {
  constructor() { super('files'); }
}
