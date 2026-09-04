// Ask-user plugin: a single tool `AskUserQuestion` that pauses the turn and lets the user pick from
// predefined options. The heavy lifting lives in the core ElicitationRegistry; this plugin owns the
// strict model-facing contract and the model-readable result.
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const ok = (text) => ({ content: [{ type: 'text', text }], details: {} });
const fail = (e) => ok(`Error: ${e instanceof Error ? e.message : String(e)}`);

const canonicalOptionSchema = Type.Object({
  label: Type.String({ minLength: 1, description: 'Concise display label (1-5 words).' }),
  description: Type.String({ minLength: 1, description: 'Explanation of the choice and its trade-offs.' }),
  preview: Type.Optional(Type.String({
    minLength: 1,
    description: 'Markdown preview for a single-select visual comparison. Do not use with multiSelect.',
  })),
}, { additionalProperties: false });

const questionSchema = Type.Object({
  question: Type.String({ minLength: 1, pattern: '\\?$', description: 'The complete, clear, specific question ending with "?".' }),
  header: Type.String({ minLength: 1, maxLength: 12, description: 'Very short chip label (at most 12 characters).' }),
  options: Type.Array(canonicalOptionSchema, {
    minItems: 2,
    maxItems: 4,
    description: 'Two to four distinct rich choices. Do not add an Other option; custom input is controlled separately.',
  }),
  multiSelect: Type.Boolean({ description: 'Whether the user may select multiple options.' }),
  custom: Type.Optional(Type.Boolean({ default: true, description: 'Whether the user may type a custom answer. Defaults to true.' })),
}, { additionalProperties: false });

/** Normalize historical pre-canonical calls for replay/migration code. Legacy string options, a missing
 * header, and `multiple` stay deliberately absent from the model-facing schema. Live execution validates
 * the canonical payload before calling this helper, so invalid current calls are never silently repaired. */
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
  const header = (typeof q?.header === 'string' && q.header.trim() ? q.header.trim() : fallbackHeader).slice(0, 12);
  return {
    question: String(q?.question ?? '').trim(),
    header,
    multiSelect,
    custom: q?.custom !== false,
    options,
  };
}

const QUESTION_FIELDS = new Set(['question', 'header', 'options', 'multiSelect', 'custom']);
const OPTION_FIELDS = new Set(['label', 'description', 'preview']);

function canonicalQuestions(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    throw new Error('questions must contain 1-4 questions.');
  }
  return value.map((raw, questionIndex) => {
    const at = `questions[${questionIndex}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${at} must be an object.`);
    const q = raw;
    const unknownQuestionField = Object.keys(q).find((key) => !QUESTION_FIELDS.has(key));
    if (unknownQuestionField) throw new Error(`${at}.${unknownQuestionField} is not supported.`);
    if (typeof q.question !== 'string' || !q.question.trim()) throw new Error(`${at}.question must be a non-empty string.`);
    if (!q.question.trim().endsWith('?')) throw new Error(`${at}.question must end with "?".`);
    if (typeof q.header !== 'string' || !q.header.trim()) throw new Error(`${at}.header must be a non-empty string.`);
    if (q.header.length > 12) throw new Error(`${at}.header must be at most 12 characters.`);
    if (typeof q.multiSelect !== 'boolean') throw new Error(`${at}.multiSelect must be a boolean.`);
    if (q.custom !== undefined && typeof q.custom !== 'boolean') throw new Error(`${at}.custom must be a boolean when provided.`);
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) {
      throw new Error(`${at}.options must contain 2-4 options.`);
    }
    const labels = new Set();
    for (const [optionIndex, rawOption] of q.options.entries()) {
      const optionAt = `${at}.options[${optionIndex}]`;
      if (!rawOption || typeof rawOption !== 'object' || Array.isArray(rawOption)) {
        throw new Error(`${optionAt} must contain a label and description.`);
      }
      const option = rawOption;
      const unknownOptionField = Object.keys(option).find((key) => !OPTION_FIELDS.has(key));
      if (unknownOptionField) throw new Error(`${optionAt}.${unknownOptionField} is not supported.`);
      if (typeof option.label !== 'string' || !option.label.trim()) throw new Error(`${optionAt}.label must be a non-empty string.`);
      if (typeof option.description !== 'string' || !option.description.trim()) {
        throw new Error(`${optionAt}.description must be a non-empty string.`);
      }
      if (labels.has(option.label.trim())) throw new Error(`${at}.options must have distinct labels.`);
      labels.add(option.label.trim());
      if (option.preview !== undefined && (typeof option.preview !== 'string' || !option.preview.trim())) {
        throw new Error(`${optionAt}.preview must be a non-empty string when provided.`);
      }
      if (q.multiSelect && option.preview !== undefined) {
        throw new Error(`${optionAt}.preview is only valid for a single-select question.`);
      }
    }
    return normalizeQuestion(q);
  });
}

/** Format the user's picks into a compact, model-readable result: one `"<question>" = "<answer>"` line
 * per question. Answers are index-aligned to the validated pending questions. */
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
      + 'question requires a clear question ending with "?", a header of at most 12 characters, 2-4 rich options '
      + 'with label and description, and multiSelect. Put a recommendation first when one is appropriate. Use '
      + 'preview only for a single-select choice the user should see before deciding. Set custom false only when '
      + 'free-text input would be invalid. Interactive surfaces show clickable controls; text-only surfaces may '
      + 'ask for numbered input. The tool always waits for the real user response.',
    parameters: Type.Object({
      questions: Type.Array(questionSchema, { minItems: 1, maxItems: 4, description: 'One to four questions asked together.' }),
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
    + 'Each question needs a clear `question` ending with "?", a non-empty `header` of at most 12 characters, '
    + '2-4 distinct options with non-empty `label` and `description`, and boolean `multiSelect`. Put a recommended '
    + 'option first when appropriate. Use `preview` only for a single-select visual choice. Custom input defaults '
    + 'to enabled; set `custom` false only when free text would be invalid.',
  );

  ctx.logger.info('askuser tool registered');
}
