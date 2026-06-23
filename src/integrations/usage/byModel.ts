import type { TokenUsage } from './types.js';

/** The exec spec from a task's `exec:<spec>` label, or '' if it has none. Mirrors the web-side
 *  `taskExec` so the dashboard groups by exactly the strings the model list/icons use. */
export function execOfLabels(labels?: string[]): string {
  const l = labels?.find((x) => x.startsWith('exec:'));
  return l ? l.slice('exec:'.length) : '';
}

/** Sum per-task usage into one bucket per exec spec. `read` yields a task's usage (or null when its
 *  CLI session can't be found). Pure — the caller injects the reader — so it's unit-testable without
 *  touching any CLI session storage. Tasks with no exec label are skipped (nothing to attribute). */
export function aggregateUsageByExec<T extends { labels?: string[] }>(
  tasks: T[],
  read: (task: T) => TokenUsage | null,
): { exec: string; usage: TokenUsage }[] {
  const agg = new Map<string, TokenUsage>();
  for (const task of tasks) {
    const exec = execOfLabels(task.labels);
    if (!exec) continue;
    const u = read(task);
    if (!u) continue;
    const cur = agg.get(exec) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costUsd: null };
    cur.input += u.input;
    cur.output += u.output;
    cur.cacheRead += u.cacheRead;
    cur.cacheWrite += u.cacheWrite;
    cur.total += u.total;
    if (u.costUsd != null) cur.costUsd = (cur.costUsd ?? 0) + u.costUsd;
    agg.set(exec, cur);
  }
  return [...agg.entries()].map(([exec, usage]) => ({ exec, usage }));
}
