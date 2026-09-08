// Ask-user plugin: a single tool `AskUserQuestion` that pauses the turn and lets the user pick from
// predefined options. The heavy lifting lives in the core ElicitationRegistry; this plugin owns the
// model-facing contract and the model-readable result.
//
// The contract is 1:1 with the reference AskUserQuestion tool: same field names, same descriptions, same
// constraints (array bounds and the `multiSelect` default), and the same uniqueness rule. `custom` is the
// one Elowen extension — it controls whether the free-text answer is offered.
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const ok = (text) => ({ content: [{ type: 'text', text }], details: {} });
const fail = (e) => ok(`Error: ${e instanceof Error ? e.message : String(e)}`);

/** Width of the chip the header is rendered in. It is a RENDER budget, not a constraint: a longer header
 *  is clipped by the CLI dock and the web card, never rejected. The reference states the width in the
 *  field description and enforces nothing, because losing a whole turn to a 13-character chip label is a
 *  worse outcome than a clipped chip. */
const CHIP_WIDTH = 12;

const DESCRIPTION =
  'Asks the user multiple choice questions to gather information, clarify ambiguity, understand preferences, make decisions or offer them choices.';

// Elowen renders previews as markdown (a monospace box in the CLI dock, <pre> in the web card), so the
// markdown variant of the reference preview guidance is the one that applies — and no HTML fragment
// validation runs, because no surface interprets a preview as HTML.
const PREVIEW_FEATURE_PROMPT = `
Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).
`;

const TOOL_PROMPT = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

Plan mode note: In plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is my plan ready?" or "Should I proceed?" - use ExitPlanMode for plan approval. IMPORTANT: Do not reference "the plan" in your questions (e.g., "Do you have feedback about the plan?", "Does the plan look good?") because the user cannot see the plan in the UI until you call ExitPlanMode. If you need plan approval, use ExitPlanMode instead.
`;

const questionOptionSchema = Type.Object({
  label: Type.String({
    description: 'The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.',
  }),
  description: Type.String({
    description: 'Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.',
  }),
  preview: Type.Optional(Type.String({
    description: 'Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.',
  })),
});

const questionSchema = Type.Object({
  question: Type.String({
    description: 'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
  }),
  header: Type.String({
    description: `Very short label displayed as a chip/tag (max ${CHIP_WIDTH} chars). Examples: "Auth method", "Library", "Approach".`,
  }),
  options: Type.Array(questionOptionSchema, {
    minItems: 2,
    maxItems: 4,
    description: "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.",
  }),
  multiSelect: Type.Optional(Type.Boolean({
    default: false,
    description: 'Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.',
  })),
  // Elowen extension, deliberately an extra field rather than a renamed one: the reference always offers
  // the free-text answer, Elowen lets a question turn it off when free text would be an invalid answer.
  // Absent means enabled.
  custom: Type.Optional(Type.Boolean({
    default: true,
    description: 'Whether the user may type a custom answer. Defaults to true.',
  })),
});

/** Normalize historical pre-canonical calls for replay/migration code. Legacy string options, a missing
 * header, and `multiple` stay deliberately absent from the model-facing schema. Live execution validates
 * the canonical payload before calling this helper, so invalid current calls are never silently repaired.
 *
 * The header passes through at full length: it is clipped where it is drawn, so cutting it here would
 * discard text a wider surface can still show. */
export function normalizeQuestion(q) {
  const multiSelect = q?.multiple === true || q?.multiSelect === true;
  const options = (Array.isArray(q?.options) ? q.options : [])
    .map((o) => {
      if (typeof o === 'string') return { label: o.trim() };
      const option = { label: String(o?.label ?? '').trim(), description: o?.description };
      if (!multiSelect && typeof o?.preview === 'string' && o.preview.trim()) option.preview = o.preview;
      return option;
    })
    .filter((o) => o.label);
  const fallbackHeader = String(q?.question ?? '').trim();
  const header = typeof q?.header === 'string' && q.header.trim() ? q.header.trim() : fallbackHeader;
  return {
    question: String(q?.question ?? '').trim(),
    header,
    multiSelect,
    custom: q?.custom !== false,
    options,
  };
}

/** The reference's uniqueness rule, message included: two questions with the same text cannot be told
 * apart in the answer block, and two options with the same label inside one question cannot be told apart
 * in the pick. */
const UNIQUENESS_MESSAGE = 'Question texts must be unique, option labels must be unique within each question';

function isUnique(questions) {
  const texts = questions.map((q) => q.question);
  if (texts.length !== new Set(texts).size) return false;
  for (const question of questions) {
    const labels = question.options.map((option) => option.label);
    if (labels.length !== new Set(labels).size) return false;
  }
  return true;
}

/** Runtime mirror of the schema: types, array bounds and the uniqueness rule, nothing else. Everything the
 * reference schema accepts is accepted here — no length cap on the header, no question-mark rule, no
 * reserved option label — so a turn is never lost to a rejection the reference would not have made. */
function canonicalQuestions(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    throw new Error('questions must contain 1-4 questions.');
  }
  const questions = value.map((raw, questionIndex) => {
    const at = `questions[${questionIndex}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${at} must be an object.`);
    const q = raw;
    if (typeof q.question !== 'string') throw new Error(`${at}.question must be a string.`);
    if (typeof q.header !== 'string') throw new Error(`${at}.header must be a string.`);
    if (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean') {
      throw new Error(`${at}.multiSelect must be a boolean when provided.`);
    }
    if (q.custom !== undefined && typeof q.custom !== 'boolean') throw new Error(`${at}.custom must be a boolean when provided.`);
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) {
      throw new Error(`${at}.options must contain 2-4 options.`);
    }
    for (const [optionIndex, rawOption] of q.options.entries()) {
      const optionAt = `${at}.options[${optionIndex}]`;
      if (!rawOption || typeof rawOption !== 'object' || Array.isArray(rawOption)) {
        throw new Error(`${optionAt} must contain a label and description.`);
      }
      if (typeof rawOption.label !== 'string') throw new Error(`${optionAt}.label must be a string.`);
      if (typeof rawOption.description !== 'string') throw new Error(`${optionAt}.description must be a string.`);
      if (rawOption.preview !== undefined && typeof rawOption.preview !== 'string') {
        throw new Error(`${optionAt}.preview must be a string when provided.`);
      }
    }
    return normalizeQuestion(q);
  });
  if (!isUnique(questions)) throw new Error(UNIQUENESS_MESSAGE);
  return questions;
}

/** Format the user's picks into a compact, model-readable result: one `"<question>" = "<answer>"` line
 * per question. Answers are index-aligned to the validated pending questions.
 *
 * A chosen option's `preview` follows on its own line. The preview is the one part of the question the
 * model wrote but never saw rendered, and it is what the user actually compared before deciding — without
 * it the answer names a label whose content the model has to reconstruct from memory. */
export function formatAnswers(questions, answers) {
  const list = Array.isArray(answers) ? answers : [];
  const lines = [];
  questions.forEach((q, i) => {
    const a = list[i] ?? { selected: [] };
    const selected = [...(a.selected ?? [])];
    const picks = [...selected];
    if (typeof a.other === 'string' && a.other.trim()) picks.push(a.other.trim());
    lines.push(`"${q.question}" = "${picks.length ? picks.join(', ') : '(no answer)'}"`);
    for (const label of selected) {
      const preview = (q.options ?? []).find((option) => option.label === label)?.preview;
      if (preview) lines.push(`selected preview: ${preview}`);
    }
  });
  return `User answered:\n${lines.join('\n')}\nYou can now continue with the user's answers in mind.`;
}

export function register(ctx) {
  ctx.registerTool(defineTool({
    name: 'AskUserQuestion',
    label: 'Ask the user',
    description: `${DESCRIPTION}\n\n${TOOL_PROMPT}${PREVIEW_FEATURE_PROMPT}`,
    parameters: Type.Object({
      questions: Type.Array(questionSchema, {
        minItems: 1,
        maxItems: 4,
        description: 'Questions to ask the user (1-4 questions)',
      }),
    }, { additionalProperties: false }),
    execute: async (_id, p) => {
      try {
        if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('arguments must be an object.');
        const unknownField = Object.keys(p).find((key) => key !== 'questions');
        if (unknownField) throw new Error(`${unknownField} is not supported.`);
        const questions = canonicalQuestions(p.questions);
        const answers = await ctx.askUser(questions);
        return ok(formatAnswers(questions, answers));
      } catch (e) {
        return fail(e);
      }
    },
  }));

  ctx.registerSystemPromptFragment(
    'When a decision is genuinely the user\'s to make, call `AskUserQuestion` rather than asking an '
    + 'open-ended question in prose. It pauses until the user answers and shows clickable controls where '
    + 'supported; text-only surfaces may request numbered input. Ask only after cheaper answers are exhausted. '
    + 'If you do not understand why the user has denied a tool call, use `AskUserQuestion` to ask them. '
    + 'Each question needs a `question`, a short `header` shown as a chip, and 2-4 distinct options with '
    + '`label` and `description`. Put a recommended option first when appropriate, and set `multiSelect` true '
    + 'when the choices are not mutually exclusive. Use `preview` only for a single-select visual choice. '
    + 'Custom input defaults to enabled; set `custom` false only when free text would be invalid.',
  );

  ctx.logger.info('askuser tool registered');
}
