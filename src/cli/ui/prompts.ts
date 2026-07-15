import { CURSOR_MARKER, ProcessTerminal, SelectList, TUI, decodeKittyPrintable, matchesKey, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { Component, Focusable, SelectItem } from '@earendil-works/pi-tui';
import { color, chatTheme, paintRow } from '../chat/theme.js';
import { MASCOT_ART } from '../chat/mascot.js';

const CANCEL: symbol = Symbol('elowen-prompt-cancel');

type MaybeCancel<T> = T | typeof CANCEL;
type Primitive = string | number | boolean;
type Option<T extends Primitive = string> = { value: T; label?: string; hint?: string; description?: string };
type SelectOptions<T extends Primitive> = {
  message: string;
  options: Option<T>[];
  initialValue?: T;
  note?: { title?: string; body: string };
};
type MultiSelectOptions<T extends Primitive> = SelectOptions<T> & {
  required?: boolean;
};
type TextOptions = {
  message: string;
  placeholder?: string;
  defaultValue?: string;
  initialValue?: string;
  validate?: (value: string) => string | undefined | void;
};
type ConfirmOptions = {
  message: string;
  initialValue?: boolean;
};

export function isCancel(value: unknown): value is symbol {
  return value === CANCEL;
}

function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function termWidth(): number {
  return Math.max(40, process.stdout.columns || 80);
}

function termHeight(): number {
  return Math.max(10, process.stdout.rows || 24);
}

/** Modal sizing: a comfortable minimum and the gutter kept clear of the terminal edges. */
const MIN_MODAL = 52;
const MODAL_MARGIN = 8;

let mascotArmed = false;

/** Arm the Elowen flame mascot above every subsequent prompt modal / installer surface. The prompt TUIs
 *  full-clear the screen (and scrollback) when they start, so art printed to stdout beforehand would be
 *  wiped instantly — the header is therefore rendered INSIDE each TUI via mascotHeaderLines(). Piped/CI
 *  output never arms (half-block art in logs is noise). */
export function mascot(): void {
  if (!process.stdout.isTTY) return;
  mascotArmed = true;
}

/** Header rows a modal/installer TUI prepends: the centered 28-column MASCOT_ART (single source, zero
 *  runtime decoding) plus a spacer — or nothing while unarmed, when the viewport is narrower than the art
 *  (it would hard-wrap into garbage), or too short to fit art + prompt without pushing the prompt off. */
export function mascotHeaderLines(width: number): string[] {
  if (!mascotArmed || width < 28 || termHeight() < 30) return [];
  const pad = ' '.repeat(Math.max(0, Math.floor((width - 28) / 2)));
  return [...MASCOT_ART.map((line) => pad + line), ''];
}

function bg(text: string, width: number, bgCode = chatTheme().modalBg): string {
  return paintRow(bgCode, text, width);
}

function isMouseInput(data: string): boolean {
  return /^\x1b\[<\d+;\d+;\d+[mM]$/.test(data);
}

function sanitizePrintable(text: string): string {
  return [...text].filter((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code >= 32 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
  }).join('');
}

export function printableInput(data: string): string {
  const kitty = decodeKittyPrintable(data);
  if (kitty !== undefined) return kitty;
  let out = '';
  let rest = data;
  while (rest) {
    const start = rest.indexOf('\x1b[200~');
    if (start === -1) {
      if (!rest.includes('\x1b')) out += sanitizePrintable(rest);
      break;
    }
    out += sanitizePrintable(rest.slice(0, start));
    const pasted = rest.slice(start + 6);
    const end = pasted.indexOf('\x1b[201~');
    if (end === -1) {
      out += sanitizePrintable(pasted);
      break;
    }
    out += sanitizePrintable(pasted.slice(0, end));
    rest = pasted.slice(end + 6);
  }
  return out;
}

/** The single framed-box renderer for every CLI surface — notes, prompts, the installer panel and the
 *  done screen (single source of truth). Every body line is WRAPPED to the inner width via wrapTextWithAnsi
 *  — never truncated — so content adapts to length instead of clipping. The box sizes to its widest line
 *  (body or title), clamped to [minWidth, termWidth() - margin]; pass `width` to force an exact size. An
 *  optional `title` sits in the top rule. Returns raw framed rows; callers center as needed. */
export function box(body: string[], opts: { title?: string; width?: number; minWidth?: number; margin?: number } = {}): string[] {
  const cap = termWidth() - (opts.margin ?? MODAL_MARGIN);
  const minWidth = Math.min(opts.minWidth ?? 44, cap);
  const titleText = opts.title ? ` ${color.bold(color.text(opts.title))} ` : '';
  const titleWidth = visibleWidth(titleText);
  const bodyWidth = body.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
  const desired = opts.width ?? Math.max(bodyWidth, titleWidth) + 4;
  const width = Math.max(minWidth, Math.min(desired, cap));
  const inner = Math.max(16, width - 4);
  const rule = Math.max(0, inner - titleWidth);
  return [
    `${color.accent('╭')}${color.faint('─'.repeat(rule))}${titleText}${color.accent('╮')}`,
    ...body.flatMap((line) => wrapTextWithAnsi(line, inner).map((wrapped) => `${color.accent('│')}${bg(wrapped, inner)}${color.accent('│')}`)),
    `${color.accent('╰')}${color.faint('─'.repeat(inner))}${color.accent('╯')}`,
  ];
}

/** Center a framed box within the terminal, left-padding each row — used by the block writers below. */
function frame(title: string, body: string[]): string[] {
  const rows = box(body, { title });
  const boxWidth = rows.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
  const left = Math.max(0, Math.floor((termWidth() - boxWidth) / 2));
  const pad = ' '.repeat(left);
  return rows.map((line) => `${pad}${line}`);
}

/** Widest natural content line for a picker: the message, or any option's label + hint. Lets the modal
 *  size to its content (clamped by modalWidth) instead of a hard-coded width. */
function optionsContentWidth<T extends Primitive>(message: string, options: Option<T>[]): number {
  const widest = options.reduce((max, option) => {
    const hint = option.hint ?? option.description ?? '';
    return Math.max(max, visibleWidth(option.label ?? String(option.value)) + (hint ? visibleWidth(hint) + 2 : 0));
  }, 0);
  return Math.max(visibleWidth(message), widest + 4); // + selection prefix / checkbox gutter
}

/** Clamp a content width to a comfortable modal width within the terminal. Never truncates — anything
 *  wider than the cap is wrapped by box() — this only decides how wide the frame grows. The cap matches
 *  box()'s own (termWidth - margin) so the two never disagree on a narrow terminal. */
function modalWidth(contentWidth: number): number {
  const cap = termWidth() - MODAL_MARGIN;
  return Math.max(Math.min(MIN_MODAL, cap), Math.min(contentWidth + 4, cap));
}

function writeBlock(title: string, body: string[] | string): void {
  const lines = Array.isArray(body) ? body : body.split('\n');
  process.stdout.write(`${frame(title, lines).join('\n')}\n`);
}

export function intro(message: string): void {
  writeBlock('Elowen', [message]);
}

export function outro(message: string): void {
  writeBlock('Done', [message]);
}

export function note(message: string, title = 'Note'): void {
  writeBlock(title, message);
}

export function cancel(message: string): void {
  writeBlock('Cancelled', [color.warning(message)]);
}

export type ProgressKind = 'info' | 'success' | 'error' | 'warn' | 'step' | 'message';
export type SpinnerKind = 'success' | 'error' | 'warn' | 'info';
export type Spinner = { start(message?: string): void; stop(message?: string, kind?: SpinnerKind): void };

/** A live surface that owns progress output. When one is active (the installer panel) p.log.* and
 *  p.spinner() route into it instead of writing raw stdout lines, so every step paints inside one frame. */
export interface ProgressSink {
  line(kind: ProgressKind, message: string): void;
  spinner(): Spinner;
}

let activeSink: ProgressSink | null = null;

/** Route p.log.* / p.spinner() into `sink` (the installer panel), or pass null to restore direct stdout. */
export function setProgressSink(sink: ProgressSink | null): void {
  activeSink = sink;
}

function logLine(kind: ProgressKind, message: string): void {
  if (activeSink) { activeSink.line(kind, message); return; }
  const dot = kind === 'success' ? color.success('●')
    : kind === 'error' ? color.error('●')
      : kind === 'warn' ? color.warning('●')
        : kind === 'step' ? color.accent('●')
          : color.faint('●');
  process.stdout.write(`  ${dot} ${message}\n`);
}

export const log = {
  info: (message: string): void => logLine('info', message),
  success: (message: string): void => logLine('success', message),
  error: (message: string): void => logLine('error', message),
  warn: (message: string): void => logLine('warn', message),
  step: (message: string): void => logLine('step', message),
  message: (message: string): void => logLine('message', message),
};

function logSpinner(kind: SpinnerKind, message: string): void {
  if (kind === 'error') log.error(message);
  else if (kind === 'warn') log.warn(message);
  else if (kind === 'info') log.info(message);
  else log.success(message);
}

export function spinner(): Spinner {
  if (activeSink) return activeSink.spinner();
  let active = '';
  let frame = 0;
  let timer: NodeJS.Timeout | undefined;
  const frames = ['-', '\\', '|', '/'];
  const render = (): void => {
    if (!process.stdout.isTTY || !active) return;
    const glyph = color.accent(frames[frame++ % frames.length]!);
    process.stdout.write(`\r\x1b[2K  ${glyph} ${active}`);
  };
  const clear = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K');
  };
  return {
    start(message = 'Working'): void {
      active = message;
      if (!process.stdout.isTTY) {
        log.step(message);
        return;
      }
      render();
      timer = setInterval(render, 120);
    },
    stop(message?: string, kind: SpinnerKind = 'success'): void {
      clear();
      const final = message ?? (active || 'Done');
      active = '';
      if (final) logSpinner(kind, final);
    },
  };
}

function promptModal<T>(componentFactory: (finish: (value: MaybeCancel<T>) => void) => Component & Focusable): Promise<MaybeCancel<T>> {
  if (!interactive()) return Promise.resolve(CANCEL);
  return new Promise((resolve) => {
    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal, true);
    let done = false;
    const finish = (value: MaybeCancel<T>): void => {
      if (done) return;
      done = true;
      tui.stop();
      process.stdout.write('\n');
      resolve(value);
    };
    const component = componentFactory(finish);
    tui.addChild({ invalidate(): void { /* stateless */ }, render: (width: number) => mascotHeaderLines(width) });
    tui.addChild(component);
    tui.setFocus(component);
    tui.start();
    tui.requestRender(true);
  });
}

class SelectPrompt<T extends Primitive> implements Component, Focusable {
  focused = true;
  private readonly list: SelectList;
  private filter = '';
  private readonly contentWidth: number;

  constructor(
    private readonly message: string,
    options: Option<T>[],
    initialValue: T | undefined,
    private readonly note: SelectOptions<T>['note'],
    private readonly finish: (value: MaybeCancel<T>) => void,
  ) {
    const items: SelectItem[] = options.map((option) => ({
      value: String(option.value),
      label: option.label ?? String(option.value),
      description: option.hint ?? option.description,
    }));
    this.list = new SelectList(items, 11, {
      selectedPrefix: (text) => color.selected(text),
      selectedText: (text) => color.selected(text),
      description: (text) => color.dim(text),
      scrollInfo: (text) => color.faint(text),
      noMatch: (text) => color.faint(text),
    }, { minPrimaryColumnWidth: 16 });
    const index = options.findIndex((option) => option.value === initialValue);
    if (index >= 0) this.list.setSelectedIndex(index);
    this.list.onSelect = (item) => {
      const option = options.find((candidate) => String(candidate.value) === item.value);
      this.finish((option?.value ?? item.value) as T);
    };
    this.list.onCancel = () => this.finish(CANCEL);
    this.contentWidth = optionsContentWidth(this.message, options);
  }

  invalidate(): void { this.list.invalidate(); }

  render(width: number): string[] {
    const modal = modalWidth(this.contentWidth);
    const inner = modal - 4;
    const lines = [
      color.bold(color.text(this.message)),
      color.faint(`Search ${this.filter ? color.text(this.filter) : color.faint('')}`),
      '',
      ...this.noteLines(inner),
      ...this.list.render(inner),
      '',
      color.faint('enter select · esc cancel'),
    ];
    return center(box(lines, { width: modal }), width);
  }

  handleInput(data: string): void {
    if (isMouseInput(data)) return;
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.finish(CANCEL);
      return;
    }
    if (matchesKey(data, 'backspace')) {
      this.filter = this.filter.slice(0, -1);
      this.list.setFilter(this.filter);
      return;
    }
    const printable = printableInput(data);
    if (printable) {
      this.filter += printable;
      this.list.setFilter(this.filter);
      return;
    }
    this.list.handleInput(data);
  }

  /** Render the attached note (e.g. the launcher's last `systemctl status`/journalctl output): each source
   *  line WRAPS to the modal width instead of being truncated, and the block is bounded to the terminal
   *  height (not a fixed line cap) so long output stays readable without overflowing the screen. */
  private noteLines(width: number): string[] {
    if (!this.note?.body.trim()) return [];
    const title = this.note.title ? color.accent(this.note.title) : color.accent('Result');
    const wrapped = this.note.body.trim().split('\n')
      .flatMap((line) => wrapTextWithAnsi(`  ${color.dim(line)}`, Math.max(1, width)));
    const budget = Math.max(4, termHeight() - 18);
    const overflow = wrapped.length - budget;
    const shown = overflow > 0
      ? [...wrapped.slice(0, budget), color.faint(`  … ${overflow} more line${overflow === 1 ? '' : 's'}`)]
      : wrapped;
    return [title, ...shown, ''];
  }
}

class MultiSelectPrompt<T extends Primitive> implements Component, Focusable {
  focused = true;
  private index = 0;
  private readonly selected = new Set<string>();
  private error = '';

  constructor(
    private readonly message: string,
    private readonly options: Option<T>[],
    initialValue: T | undefined,
    private readonly required: boolean,
    private readonly finish: (value: MaybeCancel<T[]>) => void,
  ) {
    if (initialValue !== undefined) this.selected.add(String(initialValue));
  }

  invalidate(): void { /* state-driven */ }

  render(width: number): string[] {
    const modal = modalWidth(optionsContentWidth(this.message, this.options));
    const inner = modal - 4;
    const lines = [color.bold(color.text(this.message)), color.faint('space toggles · enter confirms'), ''];
    const start = Math.max(0, Math.min(this.index - 5, this.options.length - 11));
    for (const [offset, option] of this.options.slice(start, start + 11).entries()) {
      const i = start + offset;
      const checked = this.selected.has(String(option.value));
      const marker = checked ? color.success('☑') : color.faint('☐');
      const label = option.label ?? String(option.value);
      const desc = option.hint ?? option.description ?? '';
      const row = `${marker} ${truncateToWidth(label, 24, '…', true)} ${color.dim(truncateToWidth(desc, Math.max(1, inner - 30), '…'))}`;
      lines.push(i === this.index ? color.selected(row) : row);
    }
    if (this.options.length > 11) lines.push(color.faint(`${start + 1}-${Math.min(this.options.length, start + 11)} / ${this.options.length}`));
    if (this.error) lines.push('', color.warning(this.error));
    lines.push('', color.faint('enter select · esc cancel'));
    return center(box(lines, { width: modal }), width);
  }

  handleInput(data: string): void {
    if (isMouseInput(data)) return;
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.finish(CANCEL);
    } else if (matchesKey(data, 'up')) {
      this.index = Math.max(0, this.index - 1);
    } else if (matchesKey(data, 'down')) {
      this.index = Math.min(this.options.length - 1, this.index + 1);
    } else if (matchesKey(data, 'space')) {
      const key = String(this.options[this.index]?.value ?? '');
      if (this.selected.has(key)) this.selected.delete(key);
      else this.selected.add(key);
      this.error = '';
    } else if (matchesKey(data, 'enter')) {
      if (this.required && this.selected.size === 0) {
        this.error = 'Select at least one option.';
        return;
      }
      const values = this.options.filter((option) => this.selected.has(String(option.value))).map((option) => option.value);
      this.finish(values);
    }
  }
}

/** Editable text-field state: the value, the caret position (in UTF-16 units, mirroring `value.slice`),
 *  and whether the field is still holding an untouched prefill. `touched` drives type-over: the first
 *  printable key on an untouched prefill replaces the whole value instead of appending to it. */
export interface FieldState {
  value: string;
  cursor: number;
  touched: boolean;
}

export function newFieldState(initial: string): FieldState {
  return { value: initial, cursor: initial.length, touched: false };
}

/** Pure reducer for the hand-rolled text field, shared by the text and password prompts (single source of
 *  truth). Handles type-over of an untouched prefill plus in-place editing: cursor navigation
 *  (left/right/home/end), delete-at-cursor and backspace-at-cursor. Returns the next state, or null for
 *  input it doesn't own (submit/cancel keys the caller handles). Any interaction marks the field touched,
 *  so once the user has moved the caret or edited, further typing inserts rather than type-overs. */
export function editField(state: FieldState, data: string): FieldState | null {
  if (matchesKey(data, 'left')) return { ...state, cursor: Math.max(0, state.cursor - 1), touched: true };
  if (matchesKey(data, 'right')) return { ...state, cursor: Math.min(state.value.length, state.cursor + 1), touched: true };
  if (matchesKey(data, 'home')) return { ...state, cursor: 0, touched: true };
  if (matchesKey(data, 'end')) return { ...state, cursor: state.value.length, touched: true };
  if (matchesKey(data, 'backspace')) {
    if (state.cursor === 0) return { ...state, touched: true };
    return { value: state.value.slice(0, state.cursor - 1) + state.value.slice(state.cursor), cursor: state.cursor - 1, touched: true };
  }
  if (matchesKey(data, 'delete')) {
    return { value: state.value.slice(0, state.cursor) + state.value.slice(state.cursor + 1), cursor: state.cursor, touched: true };
  }
  const printable = printableInput(data);
  if (!printable) return null;
  // Type-over: the first printable key on an untouched prefill replaces it, so a pre-filled 'admin' can
  // never become 'adminbob'. Once touched, insert at the caret.
  if (!state.touched) return { value: printable, cursor: printable.length, touched: true };
  return { value: state.value.slice(0, state.cursor) + printable + state.value.slice(state.cursor), cursor: state.cursor + printable.length, touched: true };
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Grapheme- and width-aware horizontal scroll window for the text-field input line (single source for the
 *  text + password prompts). The value is split into grapheme CLUSTERS so a slice can never fall through a
 *  surrogate pair or a combining sequence; masked mode shows exactly one bullet per cluster (an emoji is one
 *  mask glyph, not two). The visible window is measured in terminal COLUMNS via visibleWidth/sliceByColumn —
 *  so CJK double-width characters count as two and never overflow the modal frame — and slides to keep the
 *  caret in view, matching the old truncateToWidth-based behaviour. `cursor` is the caret's UTF-16 offset (as
 *  the editField reducer tracks it); a caret that lands mid-cluster snaps to the cluster boundary before it. */
export function inputWindow(value: string, cursor: number, maxWidth: number, masked: boolean, cursorMark: string): string {
  const width = Math.max(1, maxWidth);
  const before: string[] = [];
  const after: string[] = [];
  let offset = 0;
  for (const { segment } of graphemeSegmenter.segment(value)) {
    // A cluster whose end is at/left of the caret is "before"; the straddling/right clusters are "after",
    // so the caret sits on the cluster boundary at or before its raw UTF-16 position.
    (offset + segment.length <= cursor ? before : after).push(segment);
    offset += segment.length;
  }
  const glyph = (cluster: string): string => (masked ? '•' : cluster);
  const beforeStr = before.map(glyph).join('');
  const afterStr = after.map(glyph).join('');
  const caretCol = visibleWidth(beforeStr);
  // Scroll so the caret stays visible: when the text before the caret is wider than the window, drop the
  // leftmost columns (caret pinned to the right edge); otherwise start at column 0.
  const start = Math.max(0, caretCol - width);
  const beforeWidth = caretCol - start; // columns of pre-caret text kept in view
  const beforePart = sliceByColumn(beforeStr, start, beforeWidth, true);
  const afterPart = sliceByColumn(afterStr, 0, width - beforeWidth, true);
  return `${beforePart}${cursorMark}${afterPart}`;
}

class TextPrompt implements Component, Focusable {
  focused = true;
  private field: FieldState;
  private error = '';
  private readonly contentWidth: number;

  constructor(
    private readonly message: string,
    private readonly opts: TextOptions,
    private readonly masked: boolean,
    private readonly finish: (value: MaybeCancel<string>) => void,
  ) {
    this.field = newFieldState(opts.initialValue ?? opts.defaultValue ?? '');
    const seed = opts.initialValue ?? opts.defaultValue ?? opts.placeholder ?? '';
    this.contentWidth = Math.max(visibleWidth(this.message), visibleWidth(seed) + 4);
  }

  invalidate(): void { /* state-driven */ }

  /** Render the input line: masked or plain, with the caret at its actual position and a horizontal scroll
   *  window so a long value keeps the caret visible instead of truncating it away. */
  private renderInput(maxWidth: number): string {
    const cursorMark = this.focused ? CURSOR_MARKER : '';
    const { value, cursor } = this.field;
    if (!value) return `${color.faint(this.opts.placeholder ?? '')}${cursorMark}`;
    return inputWindow(value, cursor, maxWidth, this.masked, cursorMark);
  }

  render(width: number): string[] {
    const modal = modalWidth(this.contentWidth);
    const inner = modal - 4;
    const lines = [
      color.bold(color.text(this.message)),
      '',
      bg(` ${this.renderInput(inner - 2)}`, inner, chatTheme().inputBg),
    ];
    if (this.error) lines.push('', color.warning(this.error));
    lines.push('', color.faint('enter submit · esc cancel'));
    return center(box(lines, { width: modal }), width);
  }

  handleInput(data: string): void {
    if (isMouseInput(data)) return;
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.finish(CANCEL);
      return;
    }
    if (matchesKey(data, 'enter')) {
      const err = this.opts.validate?.(this.field.value);
      if (err) {
        this.error = err;
        return;
      }
      this.finish(this.field.value);
      return;
    }
    const next = editField(this.field, data);
    if (next) {
      this.field = next;
      this.error = '';
    }
  }
}

function center(lines: string[], width: number): string[] {
  const left = Math.max(0, Math.floor((width - Math.max(...lines.map(visibleWidth))) / 2));
  return ['', ...lines.map((line) => `${' '.repeat(left)}${line}`)];
}

/** A held terminal screen: a framed summary the operator dismisses with enter/esc. Used for the final
 *  install/setup DONE state so success is its own screen rather than more scrollback. */
class AckPrompt implements Component, Focusable {
  focused = true;

  constructor(
    private readonly title: string,
    private readonly body: string[],
    private readonly finish: (value: MaybeCancel<true>) => void,
  ) {}

  invalidate(): void { /* static */ }

  render(width: number): string[] {
    const lines = [...this.body, '', color.faint('press enter to close')];
    return center(box(lines, { title: this.title }), width);
  }

  handleInput(data: string): void {
    if (isMouseInput(data)) return;
    if (matchesKey(data, 'enter') || matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) this.finish(true);
  }
}

/** Render a distinct framed DONE screen and hold it until the operator presses enter/esc, then return so
 *  the caller can exit. Non-interactive (piped/CI) just prints the frame and returns immediately. */
export async function doneScreen(title: string, body: string[]): Promise<void> {
  if (!interactive()) { writeBlock(title, body); return; }
  await promptModal<true>((finish) => new AckPrompt(title, body, finish));
}

export async function select<T extends Primitive = string>(opts: SelectOptions<T>): Promise<MaybeCancel<T>> {
  return promptModal((finish) => new SelectPrompt(opts.message, opts.options, opts.initialValue, opts.note, finish));
}

export async function multiselect<T extends Primitive = string>(opts: MultiSelectOptions<T>): Promise<MaybeCancel<T[]>> {
  return promptModal((finish) => new MultiSelectPrompt(opts.message, opts.options, opts.initialValue, opts.required ?? false, finish));
}

export async function text(opts: TextOptions): Promise<MaybeCancel<string>> {
  return promptModal((finish) => new TextPrompt(opts.message, opts, false, finish));
}

export async function password(opts: TextOptions): Promise<MaybeCancel<string>> {
  return promptModal((finish) => new TextPrompt(opts.message, opts, true, finish));
}

export async function confirm(opts: ConfirmOptions): Promise<MaybeCancel<boolean>> {
  return select<boolean>({
    message: opts.message,
    initialValue: opts.initialValue ?? true,
    options: [
      { value: true, label: 'Yes', hint: 'continue' },
      { value: false, label: 'No', hint: 'cancel' },
    ],
  });
}
