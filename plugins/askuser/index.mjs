// Ask-user plugin: a single tool `ask_user_question` that pauses the turn and lets the user pick from
// predefined options — the Orca analogue of Claude Code's AskUserQuestion. The heavy lifting (parking
// the turn, emitting the interactive event, awaiting the answer) lives in the core ElicitationRegistry;
// this plugin is just the tool surface. `ctx.askUser(questions)` returns one answer per question once the
// user responds on any surface (CLI picker, web buttons, Discord components).
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const ok = (text) => ({ content: [{ type: 'text', text }], details: {} });
const fail = (e) => ok(`Error: ${e instanceof Error ? e.message : String(e)}`);

/** One selectable option — accept the SIMPLE form (a plain label string) or the rich form
 *  ({label, optional description}), so the model can send `["Blue","Green"]` and it just works. */
const optionSchema = Type.Union(
  [
    Type.String({ description: 'A choice label, e.g. "Blue".' }),
    Type.Object({
      label: Type.String({ description: 'The choice shown on the button/row.' }),
      description: Type.Optional(Type.String({ description: 'Optional one-line hint under the label.' })),
    }),
  ],
  { description: 'Either a plain string label, or an object {label, description?}.' },
);

/** One question. ONLY `question` + `options` are required — `header` and `multiSelect` are optional and
 *  default sensibly, and each option may be a bare string. Deliberately forgiving so the tool never
 *  bounces on a minimal, obvious call. */
const questionSchema = Type.Object({
  question: Type.String({ description: 'The full question. Put the choices in `options`; do NOT number them in the text.' }),
  options: Type.Array(optionSchema, { minItems: 2, maxItems: 5, description: '2–5 choices — a plain string each (e.g. "Blue"), or {label, description?}. A free-text "Other" is added automatically; do not include it.' }),
  header: Type.Optional(Type.String({ description: 'Optional short chip label (kept to ~20 chars), e.g. "Colour". Defaults to the start of the question.' })),
  multiSelect: Type.Optional(Type.Boolean({ description: 'Optional — true lets the user pick several. Default false (pick one).' })),
});

/** Coerce a loosely-shaped question into the canonical {question, header, multiSelect, options:[{label,
 *  description?}]} the clients render — bare-string options become {label}, a missing header derives from
 *  the question, empty-label options are dropped. */
export function normalizeQuestion(q) {
  const options = (Array.isArray(q.options) ? q.options : [])
    .map((o) => (typeof o === 'string' ? { label: o.trim() } : { label: String(o?.label ?? '').trim(), description: o?.description }))
    .filter((o) => o.label);
  const header = (typeof q.header === 'string' && q.header.trim() ? q.header : String(q.question ?? '')).trim().slice(0, 20);
  return { question: String(q.question ?? '').trim(), header, multiSelect: q.multiSelect === true, options };
}

/** Format the user's picks into a compact, model-readable result. Answers are index-aligned to
 *  questions (every client returns them in question order); each renders as its prose + the chosen
 *  label(s) and any free-text "Other". */
function formatAnswers(questions, answers) {
  const list = Array.isArray(answers) ? answers : [];
  const lines = questions.map((q, i) => {
    const a = list[i] ?? { selected: [] };
    const picks = [...(a.selected ?? [])];
    if (typeof a.other === 'string' && a.other.trim()) picks.push(a.other.trim());
    return `- ${q.question}\n  → ${picks.length ? picks.join(', ') : '(no answer)'}`;
  });
  return `The user answered:\n${lines.join('\n')}`;
}

export function register(ctx) {
  ctx.registerTool(defineTool({
    name: 'ask_user_question',
    label: 'Ask the user',
    description:
      'Ask the user one or more multiple-choice questions and WAIT for their answer before continuing. '
      + 'Use it at a genuine decision point where the user should pick between concrete options — it shows '
      + 'clickable choices and pauses the turn until they choose. Only `question` and `options` are '
      + 'required per question (`header`/`multiSelect` are optional; an option may be a plain string). A '
      + 'free-text "Other" is always added, so never add one yourself.\n'
      + 'Minimal example: {"questions":[{"question":"Which colour?","options":["Blue","Green","Red"]}]}',
    parameters: Type.Object({
      questions: Type.Array(questionSchema, { minItems: 1, maxItems: 4, description: '1–4 questions asked together.' }),
    }),
    execute: async (_id, p) => {
      try {
        const questions = (p.questions ?? []).map(normalizeQuestion).filter((q) => q.question && q.options.length >= 2);
        if (questions.length === 0) return ok('Error: each question needs a non-empty `question` and at least 2 `options`.');
        const answers = await ctx.askUser(questions);
        return ok(formatAnswers(questions, answers));
      } catch (e) {
        return fail(e);
      }
    },
  }));

  // Nudge the model to reach for the tool at decision points instead of burying options in prose.
  ctx.registerSystemPromptFragment(
    'When you need the user to choose between concrete options, call `ask_user_question` rather than '
    + 'listing choices in prose — it shows clickable options and pauses until the user picks. Each '
    + 'question needs only `question` + `options` (options can be plain strings); `header`/`multiSelect` '
    + 'are optional. Put choices only in `options`, and do not use it for open-ended questions.',
  );

  ctx.logger.info('askuser tool registered');
}
