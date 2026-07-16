// ask_user_question UI rendering: native Telegram inline-keyboard buttons for a parked question.
// Buttons carry a compact callback payload `a:<token>:<qi>:<oi>` (plus `:submit` / `:other`) — the
// adapter maps the short token back to the real ask id, keeping every payload well under Telegram's
// 64-byte callback_data limit even for long brain ask ids.

/** True when a question is answered by a single button click: single-select (not multiSelect). A click
 *  on a single-question single-select ask answers instantly; multiSelect / multi-question asks need Submit. */
export function askUsesButtons(q) {
  const n = q.options?.length ?? 0;
  return q.multiSelect !== true && n >= 1;
}

/** Build the inline-keyboard rows for a parked ask_user_question. Pure — exported for tests. Per question:
 *  a grid of option buttons (`a:<token>:<qi>:<oi>`; a picked option is prefixed ✅). Footer: Submit
 *  (skipped for a single single-select question where a click answers instantly) plus a free-text "Other"
 *  button on single-question asks unless the question sets `custom: false` (absent = allowed). */
export function buildAskKeyboard(token, questions, { cs = false, selected = {} } = {}) {
  const qs = questions.slice(0, 4);
  const rows = [];
  qs.forEach((q, qi) => {
    const picks = selected[qi] ?? [];
    let row = [];
    (q.options ?? []).slice(0, 20).forEach((op, oi) => {
      const on = picks.includes(op.label);
      row.push({ text: `${on ? '✅ ' : ''}${String(op.label).slice(0, 60)}`, callback_data: `a:${token}:${qi}:${oi}` });
      if (row.length === 2) { rows.push(row); row = []; } // two buttons per row keeps labels readable
    });
    if (row.length) rows.push(row);
  });
  const instant = qs.length === 1 && askUsesButtons(qs[0]); // a single-select button click answers by itself
  const footer = [];
  if (!instant) footer.push({ text: cs ? 'Odeslat' : 'Submit', callback_data: `a:${token}:submit` });
  if (qs.length === 1 && qs[0].custom !== false) footer.push({ text: cs ? '✏️ Jiné' : '✏️ Other', callback_data: `a:${token}:other` });
  if (footer.length) rows.push(footer);
  return rows;
}
