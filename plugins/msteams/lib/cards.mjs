// Adaptive Cards for the interactive surfaces: AskUserQuestion choice cards and the local pickers
// (/model, /reasoning, /display, /context). Action.Submit payloads arrive back as `message` activities
// whose `value` carries the compact data objects built here:
//   { ea: <token>, q, o }   ask option tap        { ea: <token>, s: 1 }  ask submit
//   { ea: <token>, ot: 1 }  ask "Other" (with the `other` Input.Text merged in)
//   { ep: <kind>, v }       picker choice          { ep: <kind>, p }      picker page turn
// Cards must stay well under Teams' ~28KB payload cap — option labels are clamped and long option sets
// paged, so a runaway ask can never produce an undeliverable card.

const LABEL_MAX = 60;
const PICKER_PAGE_SIZE = 8;

const clamp = (s, max = LABEL_MAX) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const card = (body, actions = []) => ({
  contentType: 'application/vnd.microsoft.card.adaptive',
  content: {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    body,
    ...(actions.length ? { actions } : {}),
  },
});

/** The AskUserQuestion choice card. Selected options carry a ✅ prefix; a single single-select question
 *  submits on tap (no Submit row), everything else toggles and submits explicitly. `Other` free text is
 *  offered on single-question asks (unless the question opts out) as a native Input.Text. */
export function buildAskCard(token, questions, { cs = false, selected = [] } = {}) {
  const body = [];
  const actions = [];
  const single = questions.length === 1 && questions[0]?.multiSelect !== true;
  questions.forEach((q, qi) => {
    body.push({ type: 'TextBlock', text: `**${clamp(q.header ?? '', 80)}** — ${clamp(q.question ?? '', 400)}`, wrap: true });
    const picks = new Set(selected[qi] ?? []);
    const buttons = (q.options ?? []).slice(0, 12).map((option, oi) => ({
      type: 'Action.Submit',
      title: `${picks.has(option.label) ? '✅ ' : ''}${clamp(option.label)}`,
      data: { ea: token, q: qi, o: oi },
    }));
    if (buttons.length) body.push({ type: 'ActionSet', actions: buttons });
  });
  if (!single) actions.push({ type: 'Action.Submit', title: cs ? 'Odeslat' : 'Submit', data: { ea: token, s: 1 } });
  if (questions.length === 1 && questions[0]?.custom !== false) {
    body.push({ type: 'Input.Text', id: 'other', placeholder: cs ? 'Vlastní odpověď…' : 'Your own answer…' });
    actions.push({ type: 'Action.Submit', title: cs ? '✏️ Jinak' : '✏️ Other', data: { ea: token, ot: 1 } });
  }
  return card(body, actions);
}

/** A paged list picker (models, conversations, reasoning levels…). `options` is the FULL set; the page
 *  window renders one button per option (current pick marked ✅) plus prev/next when needed. */
export function buildPickerCard(kind, title, options, { cs = false, page = 0, current } = {}) {
  const pages = Math.max(1, Math.ceil(options.length / PICKER_PAGE_SIZE));
  const at = Math.min(Math.max(page, 0), pages - 1);
  const window = options.slice(at * PICKER_PAGE_SIZE, (at + 1) * PICKER_PAGE_SIZE);
  const body = [
    { type: 'TextBlock', text: clamp(title, 200), wrap: true },
    { type: 'ActionSet', actions: window.map((option) => ({
      type: 'Action.Submit',
      title: `${current !== undefined && option.value === current ? '✅ ' : ''}${clamp(option.label)}`,
      data: { ep: kind, v: option.value },
    })) },
  ];
  const actions = [];
  if (pages > 1) {
    if (at > 0) actions.push({ type: 'Action.Submit', title: cs ? '‹ Předchozí' : '‹ Prev', data: { ep: kind, p: at - 1 } });
    actions.push({ type: 'Action.Submit', title: `${at + 1}/${pages}`, data: { ep: kind, p: at } });
    if (at < pages - 1) actions.push({ type: 'Action.Submit', title: cs ? 'Další ›' : 'Next ›', data: { ep: kind, p: at + 1 } });
  }
  return card(body, actions);
}

/** A settled (answered/expired) card: a plain one-liner replacing the interactive body. */
export function settledCard(text) {
  return card([{ type: 'TextBlock', text: clamp(text, 400), wrap: true }]);
}
