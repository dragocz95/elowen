export type TurnContextPlacement = 'before-user' | 'after-user';

const CLOSE = '</context>';
const OPEN: Record<TurnContextPlacement, string> = {
  'before-user': '<context placement="before-user">',
  'after-user': '<context placement="after-user">',
};

/** Render the exact volatile turn-context envelope consumed by the prompt builder.
 *
 * Provider output may contain a literal closing delimiter. Neutralising it here makes the generated
 * frame structurally unambiguous for both the model and the recall-query stripper. */
export function renderTurnContextFrame(parts: readonly string[], placement: TurnContextPlacement): string {
  if (parts.length === 0) return '';
  const body = parts
    .map((part) => part
      .replaceAll(OPEN['before-user'], '[context placement="before-user"]')
      .replaceAll(OPEN['after-user'], '[context placement="after-user"]')
      .replace(/<\s*\/\s*context\s*>/gi, '[/context]'))
    .join('\n');
  return `${OPEN[placement]}\n${body}\n${CLOSE}\n\n`;
}

/** Remove only envelopes produced by {@link renderTurnContextFrame}.
 *
 * A bare `<context>` may be legitimate assistant/tool data and is intentionally preserved. The generated
 * opening strings are exact, while renderTurnContextFrame guarantees the first exact closing delimiter is
 * the matching boundary, so this scanner does not need to interpret arbitrary XML-like user content. */
export function stripTurnContextFrames(text: string): string {
  const closeToken = `\n${CLOSE}\n\n`;
  const openingAt = (from: number): { index: number; token: string } | undefined => {
    const beforeToken = `${OPEN['before-user']}\n`;
    const afterToken = `${OPEN['after-user']}\n`;
    const before = text.indexOf(beforeToken, from);
    const after = text.indexOf(afterToken, from);
    if (before < 0 && after < 0) return undefined;
    return after < 0 || (before >= 0 && before < after)
      ? { index: before, token: beforeToken }
      : { index: after, token: afterToken };
  };

  let cursor = 0;
  let scan = 0;
  let clean = '';
  while (scan < text.length) {
    const opening = openingAt(scan);
    if (!opening) break;
    const close = text.indexOf(closeToken, opening.index + opening.token.length);
    if (close < 0) break;
    const nested = openingAt(opening.index + opening.token.length);
    if (nested && nested.index < close) {
      // The first opener is an unmatched look-alike before a later real frame. Preserve it and let the
      // next iteration examine the nested exact opener instead of pairing across unrelated content.
      scan = nested.index;
      continue;
    }
    clean += `${text.slice(cursor, opening.index)} `;
    cursor = close + closeToken.length;
    scan = cursor;
  }
  return clean + text.slice(cursor);
}
