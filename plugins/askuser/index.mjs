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

const canonicalOptionSchema = Type.Object({
  label: Type.String({ description: 'Concise display label (1-5 words).' }),
  description: Type.String({ description: 'Explanation of the choice and its trade-offs.' }),
  preview: Type.Optional(Type.String({ description: 'Optional markdown preview for a single-select visual comparison.' })),
});

const questionSchema = Type.Object({
  question: Type.String({ description: 'The complete, clear, specific question, normally ending with "?".' }),
  header: Type.String({ maxLength: 12, description: 'Very short chip label (max 12 characters).' }),
  options: Type.Array(canonicalOptionSchema, {
    minItems: 2,
    maxItems: 4,
    description: '2-4 distinct rich choices. Do not add an Other option; the UI provides it automatically.',
  }),
  multiSelect: Type.Boolean({ description: 'Whether the user may select multiple options.' }),
  custom: Type.Optional(Type.Boolean({ description: 'Elowen feature: whether the user may type a custom answer (default true).' })),
});
const annotationsSchema = Type.Record(Type.String(), Type.Object({
  preview: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
}));
const metadataSchema = Type.Object({ source: Type.Optional(Type.String()) });

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
      'Ask the user one to four structured questions and wait for the answer. Use this only for a decision that '
      + 'cannot be resolved from the request, code, environment, convention, or a reversible default. Each '
      + 'canonical question requires question, a header of at most 12 characters, 2-4 rich options with label '
      + 'and description, and multiSelect. Put the recommended option first. Do not add Other because the UI '
      + 'provides custom input automatically. Preview is for single-select visual comparisons only. Optional '
      + 'answers, annotations, and metadata are transport fields; supplied answers never skip the interactive prompt.',
    parameters: Type.Object({
      questions: Type.Array(questionSchema, { minItems: 1, maxItems: 4, description: '1-4 questions asked together.' }),
      answers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'Answers collected by a permission component.' })),
      annotations: Type.Optional(annotationsSchema),
      metadata: Type.Optional(metadataSchema),
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
