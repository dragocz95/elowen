import { CURSOR_MARKER, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';

export function padAnsi(text: string, width: number): string {
  const w = visibleWidth(text);
  return w > width ? truncateToWidth(text, width) : text + ' '.repeat(width - w);
}

const isCsiFinal = (code: number): boolean => code >= 0x40 && code <= 0x7e;

const readStringControl = (input: string, start: number): { end: number; terminator: string } => {
  let i = start;
  while (i < input.length) {
    if (input.charCodeAt(i) === 0x07) return { end: i, terminator: '\x07' };
    if (input.charCodeAt(i) === 0x1b && input[i + 1] === '\\') return { end: i, terminator: '\x1b\\' };
    if (input.charCodeAt(i) === 0x9c) return { end: i, terminator: '\x9c' };
    i++;
  }
  return { end: input.length, terminator: '' };
};

/** Final defense for a fully styled frame. Only terminal sequences Elowen/pi-tui intentionally own are
 * allowed through: SGR colors/styles, OSC 8 hyperlinks produced by Markdown, and PI's cursor marker.
 * Every cursor movement, erase command, title/clipboard OSC, DCS, APC, PM and C0/C1 control is removed. */
export function terminalSafeAnsi(input: string): string {
  let out = '';
  for (let i = 0; i < input.length;) {
    if (input.startsWith(CURSOR_MARKER, i)) {
      out += CURSOR_MARKER;
      i += CURSOR_MARKER.length;
      continue;
    }
    const code = input.charCodeAt(i);
    if (code === 0x1b && input[i + 1] === '[') {
      const start = i;
      i += 2;
      while (i < input.length && !isCsiFinal(input.charCodeAt(i))) i++;
      if (i < input.length) {
        const final = input[i]!;
        const params = input.slice(start + 2, i);
        i++;
        if (final === 'm' && /^[0-9:;]*$/.test(params)) out += input.slice(start, i);
      }
      continue;
    }
    if (code === 0x1b && input[i + 1] === ']') {
      const bodyStart = i + 2;
      const control = readStringControl(input, bodyStart);
      const body = input.slice(bodyStart, control.end);
      if (control.terminator && /^8;[^;]*;[^\x00-\x1f\x7f-\x9f]*$/.test(body)) {
        out += `\x1b]${body}${control.terminator}`;
      }
      i = control.end + control.terminator.length;
      continue;
    }
    if (code === 0x1b && ['P', '^', '_'].includes(input[i + 1] ?? '')) {
      const control = readStringControl(input, i + 2);
      i = control.end + control.terminator.length;
      continue;
    }
    if (code === 0x1b) { i += Math.min(2, input.length - i); continue; }
    if (code === 0x9b) {
      i++;
      while (i < input.length && !isCsiFinal(input.charCodeAt(i))) i++;
      if (i < input.length) i++;
      continue;
    }
    if ([0x90, 0x9d, 0x9e, 0x9f].includes(code)) {
      const control = readStringControl(input, i + 1);
      i = control.end + control.terminator.length;
      continue;
    }
    if (code === 0x0a) { out += '\n'; i++; continue; }
    if (code === 0x09) {
      const line = out.slice(out.lastIndexOf('\n') + 1);
      out += ' '.repeat(8 - (visibleWidth(line) % 8));
      i++;
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) { i++; continue; }
    const point = input.codePointAt(i)!;
    out += String.fromCodePoint(point);
    i += point > 0xffff ? 2 : 1;
  }
  return out;
}

/** One array entry handed to pi-tui must always represent exactly one physical terminal row. Keep this
 * separate from terminalSafeAnsi(): transcript/tool renderers intentionally sanitize multiline text before
 * splitting it, while the final root/overlay boundary folds an accidental embedded line break into a cell. */
export function terminalPhysicalRow(input: string): string {
  return input.replace(/[\r\n]+/g, ' ');
}

/** Wrap a PI overlay at its final render boundary. Overlays are composited after the root frame, so
 * source-level sanitization alone cannot protect pickers supplied by API/plugin metadata. Delegating
 * input/focus keeps the wrapper transparent to PI while every produced row crosses the same invariant. */
export function terminalSafeComponent(component: Component): Component {
  const safe: Component = {
    invalidate: () => component.invalidate(),
    render: (width) => component.render(width).map((row) => terminalPhysicalRow(terminalSafeAnsi(row))),
    ...(component.handleInput ? { handleInput: (data: string) => component.handleInput?.(data) } : {}),
    ...(component.wantsKeyRelease != null ? { wantsKeyRelease: component.wantsKeyRelease } : {}),
  };
  if ('focused' in component) {
    Object.defineProperty(safe, 'focused', {
      enumerable: true,
      configurable: false,
      get: () => (component as Component & { focused: boolean }).focused,
      set: (value: boolean) => { (component as Component & { focused: boolean }).focused = value; },
    });
  }
  return safe;
}

/** Encode untrusted/user-controlled text into printable terminal cells. Stored transcripts remain byte-for-
 * byte intact; only the TUI projection crosses this boundary. Elowen owns every ANSI sequence that reaches
 * pi-tui, while tool/model output may contribute text, newlines and deterministic tab-stop spacing only. */
export function terminalPlainText(input: string): string {
  const lines = [''];
  const current = (): string => lines[lines.length - 1]!;
  const setCurrent = (value: string): void => { lines[lines.length - 1] = value; };

  for (let i = 0; i < input.length;) {
    const code = input.charCodeAt(i);
    if (code === 0x1b) {
      const kind = input[i + 1];
      if (kind === '[') {
        i += 2;
        while (i < input.length && !isCsiFinal(input.charCodeAt(i))) i++;
        if (i < input.length) i++;
        continue;
      }
      if (kind === ']' || kind === 'P' || kind === '^' || kind === '_') {
        i += 2;
        while (i < input.length) {
          if (input.charCodeAt(i) === 0x07) { i++; break; }
          if (input.charCodeAt(i) === 0x1b && input[i + 1] === '\\') { i += 2; break; }
          i++;
        }
        continue;
      }
      i += Math.min(2, input.length - i);
      continue;
    }
    if (code === 0x9b) {
      i++;
      while (i < input.length && !isCsiFinal(input.charCodeAt(i))) i++;
      if (i < input.length) i++;
      continue;
    }
    if (code === 0x0a) { lines.push(''); i++; continue; }
    if (code === 0x0d) {
      if (input.charCodeAt(i + 1) === 0x0a) i++;
      lines.push('');
      i++;
      continue;
    }
    if (code === 0x09) {
      const spaces = 8 - (visibleWidth(current()) % 8);
      setCurrent(current() + ' '.repeat(spaces));
      i++;
      continue;
    }
    if (code === 0x08) {
      const graphemes = [...current()];
      graphemes.pop();
      setCurrent(graphemes.join(''));
      i++;
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) { i++; continue; }
    const point = input.codePointAt(i)!;
    setCurrent(current() + String.fromCodePoint(point));
    i += point > 0xffff ? 2 : 1;
  }
  return lines.join('\n');
}

/** Printable one-line projection for labels, counters and metadata. Keep this centralized so every chat
 * surface applies identical control stripping and whitespace folding to untrusted text. */
export function terminalInlineText(input: string): string {
  return terminalPlainText(input).replace(/\s+/g, ' ').trim();
}

export function formatK(n: number): string {
  return n < 1000 ? String(n) : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`;
}

/** Elapsed run time for humans: seconds under a minute, then `2m 17s` — a five-digit seconds counter
 *  reads as noise once an agent runs long. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
