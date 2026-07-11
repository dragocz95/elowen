import { truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { isDownKey, isEnterKey, isEscapeKey, isUpKey } from './keys.js';
import type { Component, Focusable, TUI, Container, Editor } from '@earendil-works/pi-tui';
import { getSelectListTheme } from '@earendil-works/pi-coding-agent';
import type { AskAnswer, AskQuestion } from '../../brain/events.js';
import { ChatEditor } from './picker.js';
import { ansi, chatTheme, color } from './theme.js';
import { padAnsi, terminalInlineText, terminalPlainText } from '../ui/text.js';

const OTHER = '\u0000other';

const fillInputBg = (text: string, width: number): string => `\x1b[${chatTheme().inputBg}m${padAnsi(text, width)}\x1b[0m`;
const open = (code: string, text: string): string => ansi.open(code, text);
const selectedGlyph = (active: boolean): string => active ? '☑' : '☐';
const inlineText = terminalInlineText;

export interface AskChoiceDockOpts {
  tui: TUI;
  question: AskQuestion;
  index: number;
  total: number;
  selected?: string[];
  onSubmit: (selected: string[]) => void;
  onOther: (selected: string[]) => void;
  onCancel: () => void;
}

/** Bottom ask_user_question dock, modelled after Claude Code's checklist prompt. It replaces the chat
 *  editor while active: arrows move, Space toggles checkboxes, Enter submits, and the selected answers
 *  are echoed in the action row so the user never has to type unless they choose Other. */
export class AskChoiceDock implements Component, Focusable {
  private selectedIndex = 0;
  private selected: Set<string>;
  private _focused = false;
  private maxRows: number | null = null;

  constructor(private opts: AskChoiceDockOpts) {
    this.selected = new Set(opts.selected ?? []);
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; }

  setMaxRows(rows: number | null): void {
    this.maxRows = rows == null ? null : Math.max(1, Math.floor(rows));
  }

  invalidate(): void { /* stateless render from current selection */ }

  private rows(): { value: string; label: string; description?: string; other?: boolean }[] {
    const rows: { value: string; label: string; description?: string; other?: boolean }[] =
      this.opts.question.options.map((op) => ({
        value: op.label,
        label: inlineText(op.label),
        description: op.description ? inlineText(op.description) : undefined,
      }));
    // Free-text "Other" is offered unless the question explicitly forbids it (`custom: false`);
    // an absent flag means true — older events predate it.
    if (this.opts.question.custom !== false) rows.push({ value: OTHER, label: 'Other...', description: 'type your own answer', other: true });
    return rows;
  }

  private move(delta: number): void {
    const rows = this.rows();
    this.selectedIndex = rows.length ? (this.selectedIndex + delta + rows.length) % rows.length : 0;
    this.opts.tui.requestRender();
  }

  private toggleCurrent(): void {
    const row = this.rows()[this.selectedIndex];
    if (!row) return;
    if (row.other) {
      this.opts.onOther([...this.selected]);
      return;
    }
    if (this.opts.question.multiSelect) {
      if (this.selected.has(row.value)) this.selected.delete(row.value);
      else this.selected.add(row.value);
    } else {
      this.selected.clear();
      this.selected.add(row.value);
    }
    this.opts.tui.requestRender();
  }

  private submit(): void {
    const row = this.rows()[this.selectedIndex];
    if (row?.other) {
      this.opts.onOther([...this.selected]);
      return;
    }
    if (!this.opts.question.multiSelect && this.selected.size === 0 && row) {
      this.opts.onSubmit([row.value]);
      return;
    }
    this.opts.onSubmit([...this.selected]);
  }

  handleInput(data: string): void {
    if (isEscapeKey(data)) { this.opts.onCancel(); return; }
    if (isUpKey(data)) { this.move(-1); return; }
    if (isDownKey(data)) { this.move(1); return; }
    if (data === ' ') { this.toggleCurrent(); return; }
    if (isEnterKey(data)) { this.submit(); }
  }

  render(width: number): string[] {
    const w = Math.max(2, width);
    const innerWidth = Math.max(1, w - 2);
    const theme = chatTheme();
    const border = color.accent;
    const top = `${border('╭')}${color.faint('─'.repeat(innerWidth))}${border('╮')}`;
    const bottom = `${border('╰')}${color.faint('─'.repeat(innerWidth))}${border('╯')}`;
    const row = (content: string): string => `${border('│')}${fillInputBg(content, innerWidth)}${border('│')}`;
    const plainSelected = [...this.selected];
    const selectedText = plainSelected.length
      ? plainSelected.map((item) => `✓ ${inlineText(item)}`).join('  ')
      : 'No answers selected';
    // Labels and descriptions WRAP across as many rows as they need — a fixed label column truncated
    // long options (the actual answer text) into an unreadable "…", the same trap the question itself
    // avoids. Continuation lines align under the label, past the "  ☐ " marker gutter.
    const gutter = 4; // '  ' indent + marker + ' '
    const cont = ' '.repeat(gutter);
    const wrapInner = Math.max(1, innerWidth - gutter);
    const choiceGroups = this.rows().map((item, i) => {
      const picked = this.selected.has(item.value);
      const marker = item.other ? '✎' : selectedGlyph(picked);
      const labelLines = wrapTextWithAnsi(item.label, wrapInner);
      const descLines = item.description ? wrapTextWithAnsi(item.description, wrapInner) : [];
      const visual = [
        ...labelLines.map((ln, idx) => ({ text: `${idx === 0 ? `  ${marker} ` : cont}${ln}`, muted: false })),
        ...descLines.map((ln) => ({ text: `${cont}${ln}`, muted: true })),
      ];
      const selectedRow = i === this.selectedIndex;
      const labelColor = picked ? theme.accentSoft : theme.text;
      return visual.map((v) => selectedRow
        ? `${border('│')}${color.selected(padAnsi(v.text, innerWidth))}${border('│')}`
        : row(open(v.muted ? theme.muted : labelColor, v.text)));
    });
    const choiceRows = choiceGroups.flat();
    const progress = `${this.opts.index + 1}/${this.opts.total}`;
    const titleRow = row(`  ${open(theme.text, 'Elowen needs a decision')}  ${open(theme.faint, inlineText(this.opts.question.header || 'ask_user_question'))}  ${open(theme.faint, progress)}`);
    const questionRows = wrapTextWithAnsi(terminalPlainText(this.opts.question.question), Math.max(1, innerWidth - 4))
      .map((line) => row(`  ${open(theme.text, line)}`));
    const actionRow = row(`  ${open(theme.text, 'space')} ${open(theme.muted, 'toggle')}  ${open(theme.text, 'enter')} ${open(theme.muted, 'send')}  ${open(theme.text, 'esc')} ${open(theme.muted, 'cancel')}`);
    const full = [
      top,
      titleRow,
      // The question wraps across as many rows as it needs — truncating it made long questions unanswerable.
      ...questionRows,
      row(''),
      ...choiceRows,
      row(''),
      row(open(theme.accent, truncateToWidth(`  ${selectedText}`, innerWidth, ''))),
      actionRow,
      bottom,
    ];
    if (this.maxRows == null || full.length <= this.maxRows) return full;

    // A blocking dock on a short terminal borrows as much space as the central budget allows. If the
    // complete question still cannot fit, keep stable chrome plus the active option and move a bounded
    // choice window with keyboard selection. Nothing important disappears permanently below a slice.
    const cap = Math.max(1, this.maxRows);
    if (cap <= 4) return [top, titleRow, actionRow, bottom].slice(0, cap);
    const contentRows = Math.max(0, cap - 4); // top + title + actions + bottom
    const questionBudget = Math.min(questionRows.length, Math.max(questionRows.length > 0 ? 1 : 0, Math.floor(contentRows / 3)));
    let choiceBudget = Math.max(0, contentRows - questionBudget);
    const selectedGroup = choiceGroups[this.selectedIndex] ?? [];
    const selectedRows = selectedGroup.slice(0, choiceBudget);
    choiceBudget -= selectedRows.length;
    const visibleGroups = new Map<number, string[]>();
    visibleGroups.set(this.selectedIndex, selectedRows);
    for (let distance = 1; choiceBudget > 0 && distance < choiceGroups.length; distance++) {
      for (const index of [this.selectedIndex - distance, this.selectedIndex + distance]) {
        const group = choiceGroups[index];
        if (!group || group.length > choiceBudget) continue;
        visibleGroups.set(index, group);
        choiceBudget -= group.length;
      }
    }
    const visibleChoices = [...visibleGroups.entries()].sort(([a], [b]) => a - b).flatMap(([, rows]) => rows);
    return [top, titleRow, ...questionRows.slice(0, questionBudget), ...visibleChoices, actionRow, bottom].slice(0, cap);
  }
}

export interface AskFlowOpts {
  tui: TUI;
  /** The layout slot normally holding the editor; the flow borrows it, then restores the editor. */
  slot: Container;
  editor: Editor;
  questions: AskQuestion[];
  /** All questions answered — deliver the picks (aligned to `questions`). */
  onComplete: (answers: AskAnswer[]) => void;
  /** User bailed (Esc) — the caller aborts the parked turn so it doesn't wait for the timeout. */
  onCancel: () => void;
}

/** Drive an `ask_user_question` turn in the TUI. The active question replaces the chat input with a
 *  checklist dock: Space toggles choices, Enter confirms, and selected answers are visible at the bottom.
 *  Free-text Other remains available (unless the question sets `custom: false`), but only after the user
 *  explicitly chooses it. */
export function runAskFlow(o: AskFlowOpts): void {
  const answers: AskAnswer[] = [];

  const setSlot = (component: Component, focus: Component): void => {
    o.slot.clear();
    o.slot.addChild(component);
    o.tui.setFocus(focus);
    o.tui.requestRender(true);
  };

  const restore = (): void => {
    o.slot.clear();
    o.slot.addChild(o.editor);
    o.tui.setFocus(o.editor);
    o.tui.requestRender(true);
  };

  const cancel = (): void => { restore(); o.onCancel(); };

  const next = (): void => {
    const q = o.questions[answers.length];
    if (!q) { restore(); o.onComplete(answers); return; }
    askChoice(q, []);
  };

  const askOther = (q: AskQuestion, selected: string[]): void => {
    const input = new ChatEditor(o.tui, { borderColor: color.faint, selectList: getSelectListTheme() }, {});
    // Esc in the free-text "Other" input goes back to the choice list (and reports it consumed the key).
    input.onEscape = (): boolean => { askChoice(q, selected); return true; };
    input.onSubmit = (text: string) => {
      const other = text.trim();
      answers.push({ header: q.header, selected, other: other || undefined });
      next();
    };
    setSlot({
      invalidate: () => { input.invalidate?.(); },
      handleInput: (data: string) => { input.handleInput?.(data); },
      render: (width: number) => [
        color.inputBg(padAnsi(`  ${color.bold('Other answer')} ${color.faint(inlineText(q.header))}`, width)),
        color.inputBg(padAnsi(`  ${color.faint('type your own answer · enter send · esc back')}`, width)),
        ...input.render(width),
      ],
    }, input);
  };

  const askChoice = (q: AskQuestion, selected: string[]): void => {
    const dock = new AskChoiceDock({
      tui: o.tui,
      question: q,
      index: answers.length,
      total: o.questions.length,
      selected,
      onCancel: cancel,
      onOther: (picked) => askOther(q, picked),
      onSubmit: (picked) => {
        answers.push({ header: q.header, selected: picked });
        next();
      },
    });
    setSlot(dock, dock);
  };

  next();
}
