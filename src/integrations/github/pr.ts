import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../../shared/logger.js';

const run = promisify(execFile);
const log = logger('github-pr');

export interface PrRef { number: number; url: string }

/** Open a GitHub PR for `head` → `base` via the `gh` CLI, authenticated with `token` (passed as
 *  GH_TOKEN, never on the command line). `gh pr create` prints the new PR's URL as its last line; the
 *  number is parsed from it. When the branch already has a PR (a re-run), create fails and we fall back
 *  to reading the existing one. Returns null when `gh` is missing/unauthenticated or both calls fail —
 *  the caller degrades gracefully (the branch is still pushed; the PR can be opened by hand). */
export async function createPR(input: { dir: string; base: string; head: string; title: string; body: string; token: string }): Promise<PrRef | null> {
  const env = { ...process.env, GH_TOKEN: input.token, GH_PROMPT_DISABLED: '1' };
  try {
    const { stdout } = await run('gh', ['pr', 'create', '--base', input.base, '--head', input.head, '--title', input.title, '--body', input.body], { cwd: input.dir, env });
    const ref = parsePrUrl(stdout);
    if (ref) return ref;
  } catch (e) {
    log.warn(`gh pr create failed for ${input.head} — trying to read an existing PR`, e);
  }
  // The branch may already carry a PR (re-run after more commits) — read it instead of failing.
  try {
    const { stdout } = await run('gh', ['pr', 'view', input.head, '--json', 'number,url'], { cwd: input.dir, env });
    const j = JSON.parse(stdout) as { number?: unknown; url?: unknown };
    if (typeof j.number === 'number' && typeof j.url === 'string') return { number: j.number, url: j.url };
  } catch (e) {
    log.error(`gh pr view failed for ${input.head}`, e);
  }
  return null;
}

/** The last non-empty line of `gh pr create` output is the PR URL; pull the number out of `/pull/<n>`. */
function parsePrUrl(out: string): PrRef | null {
  const url = out.split('\n').map((s) => s.trim()).filter(Boolean).pop() ?? '';
  const m = /\/pull\/(\d+)/.exec(url);
  return m ? { number: Number(m[1]), url } : null;
}
