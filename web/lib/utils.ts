import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** The class merger every shadcn component expects at the `utils` alias in components.json.
 *
 *  It is not a cosmetic helper: `twMerge` resolves CONFLICTS between Tailwind utilities by keeping the
 *  last one, which is what makes a component's `className` prop able to override the component's own
 *  defaults. Template-literal concatenation — the pattern the hand-written kit uses — emits both classes
 *  and leaves the winner to source order in the stylesheet, so a caller passing `px-2` to something built
 *  with `px-3` gets whichever Tailwind happened to emit last. Every component ported to shadcn composes
 *  its classes through here for that reason. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
