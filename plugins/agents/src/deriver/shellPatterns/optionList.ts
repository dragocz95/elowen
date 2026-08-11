import { logger } from '../../lib/logger.js';

const log = logger('deriver');

export interface ParsedChoiceList {
  question: string;
  options: { id: string; label: string }[];
}

/** Parse an agent's interactive multiple-choice list from a captured tmux pane. Every CLI that asks
 *  the user to pick an option (Claude's AskUserQuestion, OpenCode's question tool) renders the same
 *  shape — a numbered list above a one-line footer — and differs only in the FOOTER text and which
 *  trailing "escape hatch" options to drop (e.g. "Type your own answer", "Chat about this"). So the
 *  list parsing lives here once; each provider module passes its own `footer` and `exclude` regexes.
 *
 *  Options are parsed ONLY from the contiguous 1..N run directly above the footer (walking up,
 *  stopping at "1.") so incidental "N." lines elsewhere in the scrollback can't leak in. The id of an
 *  option is its 1-based list position — the deriver turns that into Down × (id-1) then Enter. */
export function parseChoiceList(output: string, footer: RegExp, exclude: RegExp): ParsedChoiceList | null {
  const lines = output.split('\n');
  const footerIdx = lines.findIndex((l) => footer.test(l));
  if (footerIdx < 0) return null;
  // Strip the gutter: box-drawing, the focus cursor (❯), list bullets, and the title checkbox (☐).
  const strip = (l: string) => l.replace(/^[\s┃│|>❯●○☐•*-]*/, '').replace(/\s+$/, '');
  const collected: { n: number; label: string }[] = [];
  let firstOptIdx = -1;
  // Cap the walk so an all-numbered scrollback can't loop the whole pane. Set it well above any real
  // "ask the user" list (Claude allows ~4 options, OpenCode similar) — exceeding it means we never
  // reached "1.", and the loud bail below turns that into a visible escalation, not a silent hang.
  const MAX_OPTIONS = 64;
  for (let i = footerIdx - 1; i >= 0 && collected.length < MAX_OPTIONS; i--) {
    const m = strip(lines[i] ?? '').match(/^(\d+)\.\s+(\S.*)$/);
    if (!m) continue; // skip blanks, descriptions, separators and the question line
    // Drop a right-column gutter that capture-pane glues on (two+ spaces, then sidebar text).
    const label = (m[2] ?? '').replace(/\s{2,}.*$/, '').trim();
    const n = Number(m[1]);
    collected.push({ n, label });
    if (n === 1) { firstOptIdx = i; break; } // reached the top of the list
  }
  collected.reverse(); // ascending: 1, 2, 3, …
  // A matched footer means a choice UI is definitely on screen and the agent is blocked on it. If we
  // still can't parse a clean list, bail — but LOUDLY: a silent null would make the deriver read the
  // pane as "working" and the agent would hang invisibly (the very "locked forever" failure this
  // feature exists to avoid). The warn makes such a miss debuggable instead of silent.
  // Require a clean 1..N run; a gap means we mis-parsed, so bail rather than risk wrong navigation.
  if (collected.length < 2 || collected.some((o, i) => o.n !== i + 1)) {
    log.warn(`choice footer matched but no clean 1..N option list parsed (got ${collected.length} numbered lines)`);
    return null;
  }
  const options = collected
    .filter((o) => !exclude.test(o.label))
    .map((o) => ({ id: String(o.n), label: o.label }));
  if (options.length === 0) {
    log.warn('choice footer matched but every option was filtered out as an escape hatch');
    return null;
  }
  // The question is the nearest non-empty line above option 1 that isn't a section header.
  let question = '';
  for (let i = firstOptIdx - 1; i >= 0; i--) {
    const s = strip(lines[i] ?? '').replace(/\s{2,}.*$/, '').trim();
    if (s === '' || /^#\s*questions?$/i.test(s)) continue;
    question = s; break;
  }
  return { question, options };
}
