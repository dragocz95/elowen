'use client';

import { useSkin } from './skinContext';
import { shellProfileFor, type ShellProfile } from './skins';

/** Which shell presentation the design on the document asks for.
 *
 *  The ONE way a component may ask. `shellProfileFor()` is the mapping and `lib/skins.ts` is where it
 *  lives; this is the hook that reads the live skin through it, so a component never holds a skin id and
 *  the alternative — `skin === 'studio-light' || skin === 'studio-oled'` sprinkled through the tree —
 *  has no shape to take. A design added to the family gets the right shell by appearing in
 *  SKIN_DEFINITIONS, with nothing else edited.
 *
 *  Read the PROFILE, never the choice: an operator who sets ELOWEN_SKIN without offering it in the
 *  allow-list gives everyone that design with nothing chosen, and the stored choice would then answer
 *  for a design nobody is looking at. */
export function useShellProfile(): ShellProfile {
  return shellProfileFor(useSkin().skin);
}
