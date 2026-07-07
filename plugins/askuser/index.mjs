// Ask-user plugin: a single tool `ask_user_question` that pauses the turn and lets the user pick from
// predefined options — the Orca analogue of Claude Code's AskUserQuestion / opencode's question tool.
// The heavy lifting (parking the turn, emitting the interactive event, awaiting the answer) lives in the
// core ElicitationRegistry; this plugin is just the tool surface. `ctx.askUser(questions)` returns one
// answer per question once the user responds on any surface (CLI picker, web form, Discord components,
// WhatsApp numbered reply).
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
      label: Type.String({ description: 'Display text (1-5 words, concise).' }),
      description: Type.Optional(Type.String({ description: 'Optional one-line explanation of the choice.' })),
    }),
  ],
  { description: 'Either a plain string label, or an object {label, description?}.' },
);

/** One question, mirroring opencode's structured question schema. ONLY `question` + `options` are
 *  required — everything else defaults sensibly, and each option may be a bare string. Deliberately
 *  forgiving so the tool never bounces on a minimal, obvious call. `multiSelect` is the legacy alias
 *  of `multiple`, still accepted for backward compatibility. */
const questionSchema = Type.Object({
  question: Type.String({ description: 'The complete question. Put the choices in `options`; do NOT number them in the text.' }),
  options: Type.Array(optionSchema, { minItems: 2, maxItems: 25, description: '2–25 choices — a plain string each (e.g. "Blue"), or {label, description?}. Put the safest/recommended option first. Do not add an "Other" option; free text is offered automatically unless `custom` is false.' }),
  header: Type.Optional(Type.String({ description: 'Very short label (max 30 chars), e.g. "Colour". Defaults to the start of the question.' })),
  multiple: Type.Optional(Type.Boolean({ description: 'Optional — true lets the user select multiple choices. Default false (pick one).' })),
  multiSelect: Type.Optional(Type.Boolean({ description: 'Deprecated alias of `multiple`.' })),
  custom: Type.Optional(Type.Boolean({ description: 'Allow typing a custom free-text answer (default: true). Set false only when the answer must be one of the options.' })),
});

/** Coerce a loosely-shaped question into the canonical {question, header, multiSelect, custom,
 *  options:[{label, description?}]} the clients render — bare-string options become {label}, a missing
 *  header derives from the question, empty-label options are dropped. `multiple` (opencode name) and
 *  the legacy `multiSelect` are both honored; `custom` defaults to true (free-text answer allowed). */
export function normalizeQuestion(q) {
  const options = (Array.isArray(q.options) ? q.options : [])
    .map((o) => (typeof o === 'string' ? { label: o.trim() } : { label: String(o?.label ?? '').trim(), description: o?.description }))
    .filter((o) => o.label);
  const header = (typeof q.header === 'string' && q.header.trim() ? q.header : String(q.question ?? '')).trim().slice(0, 30);
  return {
    question: String(q.question ?? '').trim(),
    header,
    multiSelect: q.multiple === true || q.multiSelect === true,
    custom: q.custom !== false,
    options,
  };
}

/** Format the user's picks into a compact, model-readable result: one `"<question>" = "<answer>"` line
 *  per question (opencode's format). Answers are index-aligned to questions (every client returns them
 *  in question order); multiple picks and any free-text answer join with ', '. */
export function formatAnswers(questions, answers) {
  const list = Array.isArray(answers) ? answers : [];
  const lines = questions.map((q, i) => {
    const a = list[i] ?? { selected: [] };
    const picks = [...(a.selected ?? [])];
    if (typeof a.other === 'string' && a.other.trim()) picks.push(a.other.trim());
    return `"${q.question}" = "${picks.length ? picks.join(', ') : '(no answer)'}"`;
  });
  return `User answered:\n${lines.join('\n')}\nYou can now continue with the user's answers in mind.`;
}

export function register(ctx) {
  ctx.registerTool(defineTool({
    name: 'ask_user_question',
    label: 'Ask the user',
    description:
      'Ask the user one or more structured questions and WAIT for their answer before continuing. '
      + 'Use it at any genuine decision point instead of asking open-ended questions in prose — it shows '
      + 'clickable choices and pauses the turn until the user picks. Prefer concrete options with a safe, '
      + 'recommended default FIRST (mark it in its description, e.g. "recommended") so the user can '
      + 'one-click the default. Only `question` and `options` are required per question; `header` (≤30 '
      + 'chars), `multiple` (select several) and `custom` (allow a free-text answer, default true) are '
      + 'optional, and an option may be a plain string. Never add an "Other" option yourself — free text '
      + 'is offered automatically unless you set `custom: false`.\n'
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
    'When you need the user to make a decision, call `ask_user_question` rather than asking open-ended '
    + 'questions in prose — it shows clickable options and pauses until the user picks. Offer concrete '
    + 'options with a safe, recommended default listed first; keep labels short (1–5 words) and put '
    + 'detail in option descriptions. Each question needs only `question` + `options` (options can be '
    + 'plain strings); `header`, `multiple` and `custom` are optional. Set `custom: false` only when the '
    + 'answer must be one of the options. Put choices only in `options`, never numbered in the text.',
  );

  ctx.logger.info('askuser tool registered');
}
