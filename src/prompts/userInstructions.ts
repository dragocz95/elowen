import { xmlEscape } from '../shared/xml.js';

/** Account-owned instructions are system-prompt material, but still data inside the surrounding prompt
 *  contract. Escaping keeps their boundary explicit even when the text contains XML-like markup. */
export function userInstructionsBlock(instructions: string): string {
  return `<user_instructions source="account">\nThe following instructions were configured by the account owner. Apply them unless they conflict with higher-priority instructions.\n<content>\n${xmlEscape(instructions)}\n</content>\n</user_instructions>`;
}
