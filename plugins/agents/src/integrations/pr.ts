import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../lib/logger.js';

const run = promisify(execFile);
const log = logger('github-pr');

export interface PrRef { number: number; url: string }

/** gh child-process env. A token is passed as GH_TOKEN (never on the command line) ONLY when one is
 *  configured — an empty GH_TOKEN would override gh's own stored auth (`gh auth login`) and break it,
 *  so when no token is set we omit it and let gh use its keyring/hosts.yml login. */
function ghEnv(token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: '1' };
  if (token) env.GH_TOKEN = token; else delete env.GH_TOKEN;
  return env;
}

/** Open a GitHub PR for `head` → `base` via the `gh` CLI, authenticated with `token` (passed as
 *  GH_TOKEN, never on the command line) or gh's own stored login when no token is set. `gh pr create`
 *  prints the new PR's URL as its last line; the number is parsed from it. When the branch already has
 *  a PR (a re-run), create fails and we fall back to reading the existing one. Returns null when `gh` is
 *  missing/unauthenticated or both calls fail — the caller degrades gracefully (the branch is still
 *  pushed; the PR can be opened by hand). */
export async function createPR(input: { dir: string; base: string; head: string; title: string; body: string; token: string }): Promise<PrRef | null> {
  const env = ghEnv(input.token);
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

interface PrReview { state: string; body: string; author: string; submittedAt: string }
interface PrComment { body: string; author: string; createdAt: string }
/** A line-level (diff) review comment — where bots like Codex and humans pin actionable feedback. These
 *  are NOT in `gh pr view`'s `comments` (those are conversation/issue comments), only in the REST API. */
interface PrLineComment { body: string; path: string; line: number | null; author: string; createdAt: string }
export interface PrStatus { state: string; reviews: PrReview[]; comments: PrComment[]; lineComments: PrLineComment[] }

/** Read a PR's lifecycle state, reviews, conversation comments and line-level (diff) review comments.
 *  Lifecycle/reviews/conversation come from `gh pr view --json`; line comments need the REST API
 *  (`gh api repos/{owner}/{repo}/pulls/N/comments`, gh fills owner/repo from the cwd's git remote) since
 *  `gh pr view` omits them. Used by the feedback poller to turn a review into fix phases. Returns null
 *  when `gh pr view` is missing/unauthenticated or its JSON can't be read — the poller treats that as
 *  "no new feedback". A failing line-comment call degrades to an empty list (reviews still flow). */
export async function readPRReviews(input: { dir: string; number: number; token: string }): Promise<PrStatus | null> {
  const env = ghEnv(input.token);
  let view: { state?: unknown; reviews?: unknown; comments?: unknown };
  try {
    const { stdout } = await run('gh', ['pr', 'view', String(input.number), '--json', 'state,reviews,comments'], { cwd: input.dir, env });
    view = JSON.parse(stdout) as typeof view;
  } catch (e) {
    log.error(`gh pr view (reviews) failed for #${input.number}`, e);
    return null;
  }
  const reviews: PrReview[] = Array.isArray(view.reviews) ? view.reviews.map((r) => {
    const o = r as { state?: unknown; body?: unknown; submittedAt?: unknown; author?: { login?: unknown } };
    return { state: String(o.state ?? ''), body: String(o.body ?? ''), author: String(o.author?.login ?? ''), submittedAt: String(o.submittedAt ?? '') };
  }) : [];
  const comments: PrComment[] = Array.isArray(view.comments) ? view.comments.map((c) => {
    const o = c as { body?: unknown; createdAt?: unknown; author?: { login?: unknown } };
    return { body: String(o.body ?? ''), author: String(o.author?.login ?? ''), createdAt: String(o.createdAt ?? '') };
  }) : [];
  const lineComments = await readLineComments(input.dir, input.number, env);
  return { state: String(view.state ?? ''), reviews, comments, lineComments };
}

/** Fetch line-level review comments via the REST API. Failure (no remote, gh missing, bad JSON) degrades
 *  to an empty list — it must never sink the whole review read. */
async function readLineComments(dir: string, number: number, env: NodeJS.ProcessEnv): Promise<PrLineComment[]> {
  try {
    const { stdout } = await run('gh', ['api', `repos/{owner}/{repo}/pulls/${number}/comments`, '--paginate'], { cwd: dir, env });
    const arr = JSON.parse(stdout) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.map((c) => {
      const o = c as { body?: unknown; path?: unknown; line?: unknown; original_line?: unknown; created_at?: unknown; user?: { login?: unknown } };
      const line = typeof o.line === 'number' ? o.line : typeof o.original_line === 'number' ? o.original_line : null;
      return { body: String(o.body ?? ''), path: String(o.path ?? ''), line, author: String(o.user?.login ?? ''), createdAt: String(o.created_at ?? '') };
    });
  } catch (e) {
    log.warn(`gh api line comments failed for #${number} — treating as none`, e);
    return [];
  }
}

export type MergeResult = { ok: true } | { ok: false; reason: string };

/** Squash-merge a PR via `gh pr merge --squash --delete-branch`, but only after a pre-flight gate so the
 *  UI can show a clear reason instead of gh's cryptic refusal: the PR must be OPEN, free of base-branch
 *  conflicts, and have all status checks green (none pending or failing). Returns the reason on refusal.
 *  The branch is deleted on success. */
export async function mergePR(input: { dir: string; number: number; token: string }): Promise<MergeResult> {
  const env = ghEnv(input.token);
  let view: { state?: unknown; mergeable?: unknown; statusCheckRollup?: unknown; headRefName?: unknown };
  try {
    const { stdout } = await run('gh', ['pr', 'view', String(input.number), '--json', 'state,mergeable,statusCheckRollup,headRefName'], { cwd: input.dir, env });
    view = JSON.parse(stdout) as typeof view;
  } catch (e) {
    log.error(`gh pr view (merge gate) failed for #${input.number}`, e);
    return { ok: false, reason: 'could not read PR status' };
  }
  if (String(view.state) !== 'OPEN') return { ok: false, reason: `PR is ${String(view.state ?? 'unknown').toLowerCase()}` };
  if (String(view.mergeable) === 'CONFLICTING') return { ok: false, reason: 'merge conflicts with the base branch' };
  const checks = checksState(view.statusCheckRollup);
  if (checks === 'pending') return { ok: false, reason: 'CI checks are still running' };
  if (checks === 'failing') return { ok: false, reason: 'CI checks are failing' };
  // Merge and branch deletion are SEPARATE steps. Bundling them as `--squash --delete-branch` made a
  // failed branch delete (branch protection, a race, lost permission) abort the whole call with a
  // non-zero exit — even though the squash-merge had already landed — so the UI cried "gh refused the
  // merge" over a merged PR. Merge first; the branch delete is best-effort cleanup that never fails it.
  try {
    await run('gh', ['pr', 'merge', String(input.number), '--squash'], { cwd: input.dir, env });
  } catch (e) {
    log.error(`gh pr merge failed for #${input.number}`, e);
    return { ok: false, reason: 'gh refused the merge' };
  }
  const head = typeof view.headRefName === 'string' ? view.headRefName : '';
  if (head) {
    try {
      await run('gh', ['api', '-X', 'DELETE', `repos/{owner}/{repo}/git/refs/heads/${head}`], { cwd: input.dir, env });
    } catch (e) {
      log.warn(`gh: merged #${input.number} but could not delete branch ${head} — leaving it`, e);
    }
  }
  return { ok: true };
}

/** Roll a PR's status checks up into pending / failing / passing. Handles both shapes gh returns:
 *  CheckRun (`status` COMPLETED + `conclusion`) and StatusContext (`state`). Unknown entries are ignored
 *  so one odd shape can't wedge the gate; an empty rollup is passing (nothing to wait on). */
function checksState(rollup: unknown): 'pending' | 'failing' | 'passing' {
  if (!Array.isArray(rollup)) return 'passing';
  let pending = false;
  for (const c of rollup) {
    const o = c as { status?: unknown; conclusion?: unknown; state?: unknown };
    if (o.state !== undefined) { // StatusContext (commit status): SUCCESS | PENDING | EXPECTED | FAILURE | ERROR
      const s = String(o.state);
      if (s === 'FAILURE' || s === 'ERROR') return 'failing';
      if (s === 'PENDING' || s === 'EXPECTED') pending = true;
    } else { // CheckRun: must be COMPLETED with a non-failing conclusion
      if (String(o.status ?? '') !== 'COMPLETED') { pending = true; continue; }
      const concl = String(o.conclusion ?? '');
      if (['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(concl)) return 'failing';
    }
  }
  return pending ? 'pending' : 'passing';
}

/** The last non-empty line of `gh pr create` output is the PR URL; pull the number out of `/pull/<n>`. */
function parsePrUrl(out: string): PrRef | null {
  const url = out.split('\n').map((s) => s.trim()).filter(Boolean).pop() ?? '';
  const m = /\/pull\/(\d+)/.exec(url);
  return m ? { number: Number(m[1]), url } : null;
}
