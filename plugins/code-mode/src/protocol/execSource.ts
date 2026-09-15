/**
 * The `exec` tool input contract: a Lark grammar plus the `// @exec:` pragma parser.
 *
 * Ported 1:1 from Codex `core/src/tools/code_mode/execute_spec.rs` and
 * `code-mode-protocol/src/description.rs::parse_exec_source`. The grammar text and the error
 * strings are reproduced verbatim: gpt-5.6 and newer are trained against this exact surface, so a
 * paraphrase would be a behavioural change, not a cosmetic one. The one deliberate divergence is
 * the trailing detail of the non-integer pragma error, where Rust interpolates a serde message we
 * have no equivalent for; the sentence up to the colon is identical.
 */

/** Lark grammar constraining `exec` input to an optional pragma line followed by raw JavaScript. */
export const CODE_MODE_FREEFORM_GRAMMAR = `
start: pragma_source | plain_source
pragma_source: PRAGMA_LINE NEWLINE SOURCE
plain_source: SOURCE

PRAGMA_LINE: /[ \\t]*\\/\\/ @exec:[^\\r\\n]*/
NEWLINE: /\\r?\\n/
SOURCE: /[\\s\\S]+/
`;

export const CODE_MODE_PRAGMA_PREFIX = '// @exec:';

/** `Number.MAX_SAFE_INTEGER`, spelled as in the Rust original's `MAX_JS_SAFE_INTEGER`. */
const MAX_JS_SAFE_INTEGER = 2 ** 53 - 1;

const PRAGMA_FIELDS = ['yield_time_ms', 'max_output_tokens'] as const;

export interface ParsedExecSource {
  code: string;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

/** Thrown for every malformed input; the message is returned to the model as the tool result. */
export class ExecSourceError extends Error {}

export function parseExecSource(input: string): ParsedExecSource {
  if (input.trim().length === 0) {
    throw new ExecSourceError(
      'exec expects raw JavaScript source text (non-empty). Provide JS only, optionally with first-line `// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}`.',
    );
  }

  const newlineIndex = input.indexOf('\n');
  const firstLine = newlineIndex === -1 ? input : input.slice(0, newlineIndex);
  const rest = newlineIndex === -1 ? '' : input.slice(newlineIndex + 1);

  const trimmed = firstLine.trimStart();
  if (!trimmed.startsWith(CODE_MODE_PRAGMA_PREFIX)) {
    return { code: input };
  }

  if (rest.trim().length === 0) {
    throw new ExecSourceError('exec pragma must be followed by JavaScript source on subsequent lines');
  }

  const directive = trimmed.slice(CODE_MODE_PRAGMA_PREFIX.length).trim();
  if (directive.length === 0) {
    throw new ExecSourceError(
      'exec pragma must be a JSON object with supported fields `yield_time_ms` and `max_output_tokens`',
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(directive);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ExecSourceError(
      `exec pragma must be valid JSON with supported fields \`yield_time_ms\` and \`max_output_tokens\`: ${detail}`,
    );
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ExecSourceError(
      'exec pragma must be a JSON object with supported fields `yield_time_ms` and `max_output_tokens`',
    );
  }

  const pragma = value as Record<string, unknown>;
  for (const key of Object.keys(pragma)) {
    if (!(PRAGMA_FIELDS as readonly string[]).includes(key)) {
      throw new ExecSourceError(
        `exec pragma only supports \`yield_time_ms\` and \`max_output_tokens\`; got \`${key}\``,
      );
    }
  }

  return {
    code: rest,
    yieldTimeMs: readPragmaField(pragma, 'yield_time_ms'),
    maxOutputTokens: readPragmaField(pragma, 'max_output_tokens'),
  };
}

/** Both fields deserialize as unsigned integers in Rust, so a float, a negative or an oversized
 *  value is rejected rather than silently coerced. */
function readPragmaField(pragma: Record<string, unknown>, field: (typeof PRAGMA_FIELDS)[number]): number | undefined {
  const raw = pragma[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new ExecSourceError(
      `exec pragma fields \`yield_time_ms\` and \`max_output_tokens\` must be non-negative safe integers: invalid value for \`${field}\``,
    );
  }
  if (raw > MAX_JS_SAFE_INTEGER) {
    throw new ExecSourceError(`exec pragma field \`${field}\` must be a non-negative safe integer`);
  }
  return raw;
}
