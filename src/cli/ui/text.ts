import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

export function padAnsi(text: string, width: number): string {
  const w = visibleWidth(text);
  return w >= width ? truncateToWidth(text, width) : text + ' '.repeat(width - w);
}

const isCsiFinal = (code: number): boolean => code >= 0x40 && code <= 0x7e;

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

export function formatK(n: number): string {
  return n < 1000 ? String(n) : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`;
}

/** Elapsed run time for humans: seconds under a minute, then `2m 17s` — a five-digit seconds counter
 *  reads as noise once an agent runs long. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
