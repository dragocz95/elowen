/**
 * Parsing and filtering for the log viewer. Pure functions, no React and no Monaco — the viewer is thin
 * glue on top of this, and every rule that decides what the user sees is tested here.
 *
 * Both loggers emit one fixed, column-aligned shape (src/shared/logger.ts, web/lib/serverLogger.ts):
 *
 *   2026-07-25 17:33:34.120  INFO   [brain-stop]  stop …: disposed
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export interface LogLine {
  /** 1-based line number in the ORIGINAL file. Survives filtering, so the gutter keeps showing the real
   *  position in the log rather than renumbering the filtered view. */
  n: number;
  text: string;
  level: LogLevel | null;
  scope: string | null;
}

export interface LogFilterOptions {
  query: string;
  /** Levels to keep. Empty = no level filter at all (show everything). */
  levels: ReadonlySet<LogLevel>;
}

const RECORD = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\s+(DEBUG|INFO|WARN|ERROR)\s+\[([^\]]*)\]/;

/** Split raw log lines into records. A line without the timestamp+level header is a CONTINUATION — a
 *  stack-trace frame or a wrapped payload — so it inherits the level and scope of the record it belongs
 *  to. Without that, filtering to `error` would show the error's first line and drop its whole stack.
 *
 *  `firstLine` is the file line number of `lines[0]`. It is NOT optional in practice: the viewer is
 *  normally handed a TAIL (the API serves the last 2000 lines by default), so numbering from 1 would
 *  report a position off by the whole dropped prefix — confidently and silently, which is worse than not
 *  showing a number at all. A tail also means the first lines can be continuations of a record that was
 *  cut off above the window; those stay unattributed rather than inheriting a level we cannot know. */
export function parseLogLines(lines: readonly string[], firstLine = 1): LogLine[] {
  const out: LogLine[] = [];
  let level: LogLevel | null = null;
  let scope: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    const m = RECORD.exec(text);
    if (m) {
      level = m[1].toLowerCase() as LogLevel;
      scope = m[2] || null;
    }
    out.push({ n: firstLine + i, text, level, scope });
  }
  return out;
}

/** The records matching both filters. The query matches anywhere in the line (case-insensitive), which
 *  covers the scope too — `[brain-stop]` is part of the text — so no separate scope control is needed. */
export function filterLogLines(lines: readonly LogLine[], { query, levels }: LogFilterOptions): LogLine[] {
  const needle = query.trim().toLowerCase();
  if (!needle && levels.size === 0) return [...lines];
  return lines.filter((line) => {
    // A continuation inherits its record's level, so an unparsed leading line (level null) is only ever
    // filtered out when the user actually picked levels.
    if (levels.size > 0 && (line.level === null || !levels.has(line.level))) return false;
    return !needle || line.text.toLowerCase().includes(needle);
  });
}

export type ScrollAction = 'top' | 'follow' | 'keep';

/** What a live content refresh does to the viewport. A refresh for the SAME filtered view keeps the
 *  reader where they are, following the tail only when they are already parked at the bottom. A first
 *  fill or a changed filter/severity (`sameView` false) shows the TOP instead: the reader is looking at a
 *  different, usually much shorter document, so reapplying the previous pixel offset would fling them to
 *  the wrong place — typically the bottom of the filtered results. */
export function refreshScrollAction(sameView: boolean, atBottom: boolean): ScrollAction {
  if (!sameView) return 'top';
  return atBottom ? 'follow' : 'keep';
}

