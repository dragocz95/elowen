/** The exec spec from a task's `exec:<spec>` label, or '' if it has none. Mirrors the web-side
 *  `taskExec` so usage groups by exactly the strings the model list/icons use. */
export function execOfLabels(labels?: string[]): string {
  const l = labels?.find((x) => x.startsWith('exec:'));
  return l ? l.slice('exec:'.length) : '';
}
