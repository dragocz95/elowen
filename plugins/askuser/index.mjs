// Ask-user plugin: a single tool `AskUserQuestion` that pauses the turn and lets the user pick from
// predefined options — the Elowen analogue of Claude Code's AskUserQuestion / opencode's question tool.
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
      preview: Type.Optional(Type.String({
        description: 'Optional monospace content shown beside the list when this option is focused — an ASCII '
          + 'mockup, a code snippet, a diagram. Use it when the choice is something the user should SEE rather '
          + 'than read about (UI layouts, API shapes, config). Single-select questions only; newlines are kept.',
      })),
    }),
  ],
  { description: 'Either a plain string label, or an object {label, description?, preview?}.' },
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
  const multiSelect = q.multiple === true || q.multiSelect === true;
  const options = (Array.isArray(q.options) ? q.options : [])
    .map((o) => {
      if (typeof o === 'string') return { label: o.trim() };
      const option = { label: String(o?.label ?? '').trim(), description: o?.description };
      // A preview is a side-by-side pane for the FOCUSED option — a concept multi-select does not have
      // (every row is independently on or off). Dropping it here keeps every surface consistent, instead
      // of each renderer having to decide what a preview means when three boxes are ticked.
      if (!multiSelect && typeof o?.preview === 'string' && o.preview.trim()) option.preview = o.preview;
      return option;
    })
    .filter((o) => o.label);
  const header = (typeof q.header === 'string' && q.header.trim() ? q.header : String(q.question ?? '')).trim().slice(0, 30);
  return {
    question: String(q.question ?? '').trim(),
    header,
    multiSelect,
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
    name: 'AskUserQuestion',
    label: 'Ask the user',
    description:
      'Ask the user one or more structured questions and WAIT for their answer before continuing. It shows '
      + 'clickable choices and pauses the turn until they pick.\n'
      + 'Use it ONLY when you are blocked on a decision that is genuinely the user\'s to make — one you cannot '
      + 'resolve from the request, the codebase, the environment, or a sensible default. Reserve it for choices '
      + 'where their answer changes what you do next. If the choice is reversible and low-stakes, make the most '
      + 'reasonable assumption, say so in one line, and carry on. Never ask "Should I proceed?" — if you can act, act.\n'
      + 'When you do ask, give a recommendation rather than an open question: put the safest option FIRST and '
      + 'mark it in its description (e.g. "recommended"), so the user can one-click it. Keep labels to 1-5 words '
      + 'and put the trade-offs in each option\'s `description`. Bundle related decisions into one call (up to 4 '
      + 'questions) instead of asking them one after another.\n'
      + 'Only `question` and `options` are required; an option may be a plain string. `header` (≤30 chars) is a '
      + 'short chip label, `multiple` lets the user pick several, and `custom` (default true) offers a free-text '
      + 'answer — set it false only when the answer MUST be one of the options. Never add an "Other" option '
      + 'yourself; free text is offered automatically.\n'
      + 'Give an option a `preview` (monospace: an ASCII mockup, a code snippet, a diagram) when the user needs '
      + 'to SEE the choice rather than read about it — comparing UI layouts, API shapes or config. The picker '
      + 'then shows the focused option\'s preview beside the list. Single-select only; do not use previews for '
      + 'plain preference questions where the labels already say it.\n'
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
    'When a decision is genuinely the user\'s to make, call `AskUserQuestion` rather than asking an '
    + 'open-ended question in prose — it shows clickable options and pauses until they pick. Ask only once '
    + 'the cheaper answers are exhausted: resolve it from the environment, from convention, or from a '
    + 'reversible default first, and state the assumption instead of blocking. When you do ask, lead with a '
    + 'recommendation: safest option first, labels of 1–5 words, the trade-offs in each option\'s '
    + 'description, and a `preview` when the user should SEE the choice (a layout, a code shape) rather '
    + 'than read about it. Put choices only in `options`, never numbered in the question text.',
  );

  ctx.logger.info('askuser tool registered');
}
