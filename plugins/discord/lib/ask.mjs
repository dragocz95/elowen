// ask_user_question UI rendering: native Discord components for a parked question.
/** True when a question renders as a button row: single-select with few options — a click IS the pick.
 *  MultiSelect or >5 options need a string select (Discord caps 5 buttons per action row). */
export function askUsesButtons(q) {
  const n = q.options?.length ?? 0;
  return q.multiSelect !== true && n >= 1 && n <= 5;
}

/** Build the component rows for a parked ask_user_question message. Pure — exported for tests.
 *  Per question: a row of ≤5 buttons (single-select, `ask:<id>:<qi>:<oi>`; picked = green) or one
 *  string select (`ask:<id>:<qi>`, multi-capable, ≤25 options). Footer row: Submit — skipped for a
 *  single button-question where a click answers instantly — plus a free-text "Other" button on
 *  single-question asks unless the question sets `custom: false` (absent = allowed). */
export function buildAskComponents(id, questions, { cs = false, selected = {} } = {}) {
  const qs = questions.slice(0, 4);
  const rows = qs.map((q, qi) => {
    if (askUsesButtons(q)) {
      return {
        type: 1,
        components: q.options.slice(0, 5).map((op, oi) => ({
          type: 2,
          style: (selected[qi] ?? []).includes(op.label) ? 3 : 2, // green when picked, grey otherwise
          custom_id: `ask:${id}:${qi}:${oi}`,
          label: String(op.label).slice(0, 80),
        })),
      };
    }
    return {
      type: 1,
      components: [{
        type: 3,
        custom_id: `ask:${id}:${qi}`,
        placeholder: (q.multiSelect ? (cs ? `${q.header} — vyber jednu či víc` : `${q.header} — pick one or more`) : q.header).slice(0, 150),
        min_values: q.multiSelect ? 0 : 1,
        max_values: q.multiSelect ? Math.min(q.options.length, 25) : 1,
        options: q.options.slice(0, 25).map((op, oi) => ({
          label: String(op.label).slice(0, 100),
          value: String(oi),
          description: op.description ? String(op.description).slice(0, 100) : undefined,
        })),
      }],
    };
  });
  const instant = qs.length === 1 && askUsesButtons(qs[0]); // a button click answers by itself
  const footer = [];
  if (!instant) footer.push({ type: 2, style: 3, custom_id: `ask:${id}:submit`, label: cs ? 'Odeslat' : 'Submit' });
  if (qs.length === 1 && qs[0].custom !== false) footer.push({ type: 2, style: 2, custom_id: `ask:${id}:other`, label: cs ? '✏️ Jiné' : '✏️ Other' });
  if (footer.length) rows.push({ type: 1, components: footer });
  return rows;
}
