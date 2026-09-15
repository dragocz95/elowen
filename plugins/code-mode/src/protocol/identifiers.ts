/**
 * Tool-name to JavaScript-identifier normalisation.
 *
 * Ported 1:1 from Codex `code-mode-protocol/src/description.rs::normalize_code_mode_identifier`.
 * Only ASCII is treated as valid: a non-ASCII letter is replaced rather than kept, which matches
 * the Rust `is_ascii_alphabetic` / `is_ascii_alphanumeric` checks and keeps the generated globals
 * safe to reference by a plain property access.
 */

function isAsciiAlphabetic(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function isAsciiAlphanumeric(ch: string): boolean {
  return isAsciiAlphabetic(ch) || (ch >= '0' && ch <= '9');
}

export function normalizeCodeModeIdentifier(toolKey: string): string {
  let identifier = '';

  // Iterate by code point, as the Rust original iterates `chars()`.
  let index = 0;
  for (const ch of toolKey) {
    const isValid = index === 0
      ? ch === '_' || ch === '$' || isAsciiAlphabetic(ch)
      : ch === '_' || ch === '$' || isAsciiAlphanumeric(ch);
    identifier += isValid ? ch : '_';
    index += 1;
  }

  return identifier.length === 0 ? '_' : identifier;
}
