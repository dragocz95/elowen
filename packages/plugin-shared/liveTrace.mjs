/** The transport-neutral render/fold engine for the chat adapters' live tool trace. The event→state
 *  reducer (which tool rows exist, their progress/summary) and the throttled message transport stay in
 *  each adapter's stream.mjs — those differ per surface (Discord REST vs grammY vs Baileys). What lives
 *  here is the shared *rendering rule*: how a settled tool result is summarized, how consecutive calls
 *  fold into one counted row (the rule the CLI transcript uses — `groupToolItems`/`failureSignature` in
 *  src/brain/transcript.ts), and how a row/card becomes text. Keeping it in one place is what stops the
 *  Discord and Telegram copies — near-verbatim today — from drifting apart, and ties the fold rule to the
 *  daemon's.
 *
 *  Per-surface presentation is injected through a `style`:
 *   - mentionSafe(s)  neutralize ping/mention injection (Discord escapes @everyone/<@; plain-text
 *                     Telegram has nothing to escape → identity)
 *   - fenceSafe(s)    neutralize ``` fences that would break a rendered code block (Discord → '''; a
 *                     plain-text surface leaves them literal → identity)
 *   - bold(s)/strike(s)  inline emphasis for card titles / completed items (identity where the surface
 *                     renders plain text)
 *   - summaryLine(s)  the dim "↳ result" line under a tool row (Discord subtext `-# ↳ …`; Telegram `  ↳ …`) */

/** Strip ANSI escapes and C0/C1 control characters from a value — the transport-neutral part of a tool
 *  output tail, before any surface-specific hardening. */
export function sanitizeControl(value) {
  return String(value ?? '')
    .replace(/\u001b(?:\[[0-?]*[ -\/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|.)?/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

/** Build the two text-shaping helpers for a surface. `compactLine` collapses a short value to one bounded
 *  line; `safeTail` cleans and tail-truncates a multi-line tool output. Both apply the surface's mention
 *  hardening; `safeTail` also strips control chars and neutralizes fences. */
export function makeTextHelpers(style) {
  const compactLine = (value, max = 180) => {
    const line = style.mentionSafe(String(value ?? '')).replace(/\s+/g, ' ').trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  };
  const safeTail = (value, max = 600) => {
    const clean = style.mentionSafe(style.fenceSafe(sanitizeControl(value))).trim();
    return clean.length > max ? `…${clean.slice(clean.length - max + 1)}` : clean;
  };
  return { compactLine, safeTail };
}

/** Whether a tool output reads as a failure. The tone is the structured verdict every ToolOutputView
 *  producer derives from the authoritative signals (isError flag, numeric exit code) — no string-matching
 *  of status values here. */
export function outputFailed(output) {
  return output?.tone === 'warning' || output?.tone === 'danger';
}

/** The one-line result summary for a settled tool: the last note if any, else — on a FAILURE — its status
 *  (the exit code / "needs attention"), else the last non-empty line of the output text. A clean success
 *  never surfaces its status: success is what the settled row already means, so naming it is noise. */
export function makeOutputSummary({ compactLine, safeTail }) {
  return (output) => {
    const notes = Array.isArray(output?.notes) ? output.notes.filter(Boolean) : [];
    const status = outputFailed(output) ? compactLine(output?.status) : '';
    const text = safeTail(output?.text ?? '').split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
    return compactLine(notes.at(-1) ?? (status || text));
  };
}

/** A `+A −R` edit summary from a unified diff, or `updated` when nothing counted. */
export function diffSummary(diff) {
  const lines = String(diff ?? '').split('\n');
  const added = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  const removed = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
  return [added ? `+${added}` : '', removed ? `−${removed}` : ''].filter(Boolean).join(' ') || 'updated';
}

/** Fold consecutive calls of the SAME tool into one counted row — the rule the CLI transcript uses
 *  (`groupToolItems`, src/brain/transcript.ts). A call that has something of its OWN to show (a result
 *  summary, an output tail, a live progress tail, a failure) keeps its row; a run of the SAME failure
 *  (differing only by the path or number it names) collapses to a count, mirroring `failureSignature` in
 *  src/brain/transcript.ts. Folding happens at RENDER time because a call's toolCallId routes its later
 *  output/diff/settle, so the rows must stay separate in the model. `compactLine` is injected so the
 *  failure signature uses the surface's own line shaping. */
export function makeFoldedCalls(compactLine) {
  const speaks = (call, display) => {
    if (call.state === 'error') return true;
    if (display.toolOutput !== 'hidden' && (call.summary || (display.toolOutput === 'tail' && call.finalTail))) return true;
    return display.toolActivity === 'live' && call.state === 'running' && Boolean(call.progress);
  };
  const failureSignature = (call) => {
    if (call.state !== 'error') return undefined;
    const shape = compactLine(call.summary).replace(/\S*\/\S+/g, '§').replace(/\d+/g, '#').slice(0, 160);
    return `${call.name}|${shape}`;
  };
  return (calls, display) => {
    const rows = [];
    for (const call of calls) {
      const last = rows[rows.length - 1];
      if (last && last.name === call.name && !speaks(last, display) && !speaks(call, display)) {
        rows[rows.length - 1] = { ...call, count: (last.count ?? 1) + 1, detail: call.detail ?? last.detail };
        continue;
      }
      const signature = failureSignature(call);
      if (signature && last && signature === failureSignature(last)) {
        rows[rows.length - 1] = { ...call, count: (last.count ?? 1) + 1, detail: call.detail ?? last.detail };
        continue;
      }
      rows.push(call);
    }
    return rows;
  };
}

/** One tool row plus optional bounded output. The tool icon carries the visual identity; completion is
 *  expressed by the compact result text rather than a second status icon. */
export function makeToolLinesFor({ compactLine, safeTail, style }) {
  return (c, display) => {
    let line = `${c.icon ?? '🔧'} \`${c.name}\``;
    if (c.detail) line += `: "${compactLine(c.detail, 100)}"`;
    if (c.count > 1) line += ` ×${c.count}`;
    if (display.toolOutput !== 'hidden' && c.summary) line += ` — ${compactLine(c.summary)}`;
    if (c.state === 'error' && !c.summary) line += ' — failed';
    const lines = [line];
    if (display.toolOutput === 'hidden') return lines;
    // Mid-run output is exclusive to live activity. A settled rolling tail is still useful with status
    // activity, while summary mode already carries its one-line result on the main row.
    const output = c.state === 'running'
      ? (display.toolActivity === 'live' ? c.progress : '')
      : (display.toolOutput === 'tail' ? c.finalTail : '');
    if (!output) return lines;
    const safe = safeTail(output);
    if (!safe) return lines;
    if (display.toolOutput === 'summary') lines.push(style.summaryLine(compactLine(safe.split('\n').at(-1), 220)));
    else lines.push(...safe.split('\n').slice(-6).map((part) => `> ${part || ' '}`));
    return lines;
  };
}

/** A display card (ctx.emitCard) — title + checklist (emoji per status, since chat surfaces have no
 *  task-list markdown) + freeform body. Capped so a long card can't blow the message limit. */
export function makeCardLines(style) {
  return (card, max = 15) => {
    const items = Array.isArray(card?.items) ? card.items : [];
    const glyph = (s) => (s === 'completed' ? '✅' : s === 'in_progress' ? '🔸' : '⬜');
    const done = items.filter((t) => t.status === 'completed').length;
    const lines = [];
    if (card?.title || items.length) lines.push(`📋 ${style.bold(card?.title ?? 'Card')}${items.length ? ` (${done}/${items.length})` : ''}`);
    for (const t of items.slice(0, max)) lines.push(`${glyph(t.status)} ${t.status === 'completed' ? style.strike(t.text) : t.text}`);
    if (items.length > max) lines.push(`… +${items.length - max}`);
    if (card?.body) lines.push(String(card.body));
    return lines;
  };
}
