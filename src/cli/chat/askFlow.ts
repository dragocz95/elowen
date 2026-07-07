import { matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { Component, Focusable, TUI, Container, Editor } from '@earendil-works/pi-tui';
import { getSelectListTheme } from '@earendil-works/pi-coding-agent';
import type { AskAnswer, AskQuestion } from '../../brain/events.js';
import { ChatEditor } from './picker.js';
import { ansi, chatTheme, color } from './theme.js';
import { padAnsi } from '../ui/text.js';

const OTHER = '\u0000other';

const fillInputBg = (text: string, width: number): string => `\x1b[${chatTheme().inputBg}m${padAnsi(text, width)}\x1b[0m`;
const open = (code: string, text: string): string => ansi.open(code, text);
const selectedGlyph = (active: boolean): string => active ? '☑' : '☐';

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

  constructor(private opts: AskChoiceDockOpts) {
    this.selected = new Set(opts.selected ?? []);
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; }

  invalidate(): void { /* stateless render from current selection */ }

  private rows(): { value: string; label: string; description?: string; other?: boolean }[] {
    const rows: { value: string; label: string; description?: string; other?: boolean }[] =
      this.opts.question.options.map((op) => ({ value: op.label, label: op.label, description: op.description }));
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
    if (matchesKey(data, 'escape')) { this.opts.onCancel(); return; }
    if (data === '\x1b[A' || matchesKey(data, 'up')) { this.move(-1); return; }
    if (data === '\x1b[B' || matchesKey(data, 'down')) { this.move(1); return; }
    if (data === ' ') { this.toggleCurrent(); return; }
    if (data === '\r' || matchesKey(data, 'enter')) { this.submit(); }
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
      ? plainSelected.map((item) => `✓ ${item}`).join('  ')
      : 'No answers selected';
    const choiceRows = this.rows().map((item, i) => {
      const picked = this.selected.has(item.value);
      const marker = item.other ? '✎' : selectedGlyph(picked);
      const labelWidth = Math.min(30, Math.max(18, Math.floor(innerWidth * 0.36)));
      const label = padAnsi(`${marker} ${item.label}`, labelWidth);
      const desc = truncateToWidth(item.description ?? '', Math.max(1, innerWidth - labelWidth - 5), '');
      const content = `  ${label} ${desc}`;
      if (i === this.selectedIndex) {
        return `${border('│')}${color.selected(padAnsi(content, innerWidth))}${border('│')}`;
      }
      const labelColor = picked ? theme.accentSoft : theme.text;
      return row(`  ${open(labelColor, label)} ${open(theme.muted, desc)}`);
    });
    const progress = `${this.opts.index + 1}/${this.opts.total}`;
    return [
      top,
      row(`  ${open(theme.text, 'Orca needs a decision')}  ${open(theme.faint, this.opts.question.header || 'ask_user_question')}  ${open(theme.faint, progress)}`),
      // The question wraps across as many rows as it needs — truncating it made long questions unanswerable.
      ...wrapTextWithAnsi(this.opts.question.question, Math.max(1, innerWidth - 4)).map((line) => row(`  ${open(theme.text, line)}`)),
      row(''),
      ...choiceRows,
      row(''),
      row(open(theme.accent, truncateToWidth(`  ${selectedText}`, innerWidth, ''))),
      row(`  ${open(theme.text, 'space')} ${open(theme.muted, 'toggle')}  ${open(theme.text, 'enter')} ${open(theme.muted, 'send')}  ${open(theme.text, 'esc')} ${open(theme.muted, 'cancel')}`),
      bottom,
    ];
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
        color.inputBg(padAnsi(`  ${color.bold('Other answer')} ${color.faint(q.header)}`, width)),
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
