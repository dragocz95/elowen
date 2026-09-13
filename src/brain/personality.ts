/** Single source of truth for the advisor's communication style ("pills" in Account settings).
 *  The chosen style resolves to an English persona paragraph that is substituted for the
 *  `{{personality}}` placeholder in `prompts/advisor.md`. It shapes HOW Elowen talks to the user
 *  (tone, verbosity, and Czech vykani vs tykani), never WHAT it is allowed to do. */

export const ADVISOR_STYLES = ['professional', 'friendly', 'concise', 'detailed'] as const;
export type AdvisorStyle = typeof ADVISOR_STYLES[number];
export const DEFAULT_ADVISOR_STYLE: AdvisorStyle = 'concise';

/** True when the string is one of the known styles (used to validate stored/incoming values). */
export function isAdvisorStyle(v: string | undefined): v is AdvisorStyle {
  return v !== undefined && (ADVISOR_STYLES as readonly string[]).includes(v);
}

const TEXTS: Record<AdvisorStyle, string> = {
  professional:
    'Use a professional, formal register. Be precise, organized, and direct without sacrificing accuracy for brevity. '
    + 'In Czech, always use the formal second person (vykani). Avoid casual chatter.',
  friendly:
    'Use a friendly, relaxed, conversational tone with light humor when appropriate. '
    + 'In Czech, use the informal second person (tykani). Keep the substance accurate and reliable.',
  concise:
    'Be concise. Lead with the result and use the fewest words that fully answer the request. '
    + 'Skip preamble, filler, pleasantries, and repeated context. Add detail when requested or needed to avoid misleading the user.',
  detailed:
    'Give a detailed, organized explanation of the result and its reasons. '
    + 'Explain relevant tradeoffs, assumptions, and alternatives so the user understands the decision. Keep the depth useful and readable.',
};

/** The persona paragraph for a style. Unknown or empty input falls back to the professional default. */
export function personalityText(style: string): string {
  return TEXTS[isAdvisorStyle(style) ? style : DEFAULT_ADVISOR_STYLE];
}
