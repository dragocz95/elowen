import { color } from './theme.js';

export interface ProjectStatusInput {
  cwd: string;
  branch: string;
}

/** The one-line project context the composer footer and the start screen share: the client's own cwd and
 *  branch — what `/cd` moves. */
export function projectStatusLabel(input: ProjectStatusInput): string {
  const parts = [color.dim(input.cwd)];
  if (input.branch) parts.push(color.faint(input.branch));
  return parts.join(color.faint(' · '));
}
