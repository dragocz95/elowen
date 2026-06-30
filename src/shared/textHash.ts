/** Fast, non-cryptographic 32-bit string hash (djb-style, `h*31 + c`), rendered base-36. Used to cheaply
 *  tell whether a captured tmux pane changed between samples — collision-resistant enough for a
 *  change-detector, and paired with the content length at the call site to make a stray collision
 *  read as "changed" rather than "idle". Shared by the deriver and the pane-activity tracker. */
export function textHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
