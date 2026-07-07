import * as p from '../ui/prompts.js';
import { runAccountStep } from './steps/account.js';
import { runProjectStep } from './steps/project.js';
import { runAiStep } from './steps/aiProvider.js';
import { runMemoryStep } from './steps/memory.js';
import { runLspStep } from './steps/lsp.js';
import { readMarker, writeMarker } from './marker.js';
import { webBaseUrl } from '../installInfo.js';
import { apiJson } from './http.js';
import { guard, WizardCancelled, type WizardAnswers, type WizardCtx, type WizardStep } from './types.js';
import type { ReadinessCheck } from '../doctor.js';

const STEPS: WizardStep[] = [
  { id: 'account', title: 'Account', run: runAccountStep },
  { id: 'project', title: 'Project', run: runProjectStep },
  { id: 'ai', title: 'AI Provider', run: runAiStep },
  { id: 'memory', title: 'Memory', run: runMemoryStep },
  { id: 'lsp', title: 'Code intelligence', run: runLspStep },
];
const TOTAL = STEPS.length + 1; // + Review

/** What the Review screen decided: finish, skip the rest, or jump back to a step index to edit. */
export type ReviewDecision = 'finish' | 'skip-remaining' | number;

export interface NavHooks {
  onStep(index: number, step: WizardStep): void;
  review(): Promise<ReviewDecision>;
}

/** Pure step navigator — no terminal I/O, so it's unit-testable with fake steps and a scripted review.
 *  Forward on done/skipped, back on 'back' (clamped at 0), Review after the last step (which may jump to
 *  any index). A step that throws (e.g. WizardCancelled) propagates to the caller. */
export async function navigate(steps: WizardStep[], ctx: WizardCtx, hooks: NavHooks, startIndex = 0): Promise<{ done: boolean; skipped: boolean }> {
  let i = Math.max(0, Math.min(startIndex, steps.length));
  for (;;) {
    if (i >= steps.length) {
      const d = await hooks.review();
      if (d === 'finish') return { done: true, skipped: false };
      if (d === 'skip-remaining') return { done: true, skipped: true };
      i = Math.max(0, Math.min(d, steps.length - 1));
      continue;
    }
    hooks.onStep(i, steps[i]!);
    const r = await steps[i]!.run(ctx);
    i = r.status === 'back' ? Math.max(0, i - 1) : i + 1;
  }
}

export interface OnboardingOpts {
  reset?: boolean;
  /** Embedded inside another flow (e.g. `orca install`): skip the wizard's own intro/outro so the host
   *  provides the framing. Steps and progress still render. */
  embedded?: boolean;
}

/** Run the full onboarding wizard. Returns the admin username once the run completes (or null when the
 *  user bailed — progress is saved for resume). All configuration flows through the daemon HTTP API; only
 *  the local completion/resume marker is written here. */
export async function runOnboarding(base: string, env: NodeJS.ProcessEnv, opts: OnboardingOpts = {}): Promise<string | null> {
  const prior = opts.reset ? null : readMarker(env);
  const answers: WizardAnswers = prior?.resume?.answers ?? {};
  const ctx: WizardCtx = { base, fetchFn: fetch, answers };

  if (!opts.embedded) {
    p.intro('Welcome to Orca');
    p.log.message(`Let's get your workspace ready — ${TOTAL} quick steps. You can skip anything and finish later.`);
  }

  try {
    // A resumed run ALWAYS re-enters at the Account step: the bearer token isn't persisted (secret), and
    // every later step talks to the daemon — jumping past sign-in would 401 everywhere with misleading
    // errors ("the key may be wrong", "Saving the provider failed") while the summary claims success.
    const result = await navigate(STEPS, ctx, {
      onStep: (i, step) => p.log.step(`[${i + 1}/${TOTAL}] ${step.title}`),
      review: () => review(ctx),
    });
    await finish(env, ctx, result.skipped, !!opts.embedded);
    return answers.account?.username || null;
  } catch (e) {
    if (e instanceof WizardCancelled) {
      const save = await confirmSave();
      if (save) writeMarker(env, { completed: false, skipped: false, updatedAt: new Date().toISOString(), resume: { answers } });
      p.cancel(save ? 'Setup paused — resume anytime with `orca setup`.' : 'Setup cancelled.');
      return null;
    }
    throw e;
  }
}

async function review(ctx: WizardCtx): Promise<ReviewDecision> {
  const a = ctx.answers;
  p.note([
    `Account   ${accountSummary(a)}`,
    `Project   ${projectSummary(a)}`,
    `AI        ${a.ai?.summary ?? 'skipped'}`,
    `Memory    ${a.memory?.summary ?? 'skipped'}`,
    `LSP       ${a.lsp?.summary ?? 'skipped'}`,
  ].join('\n'), 'Setup summary');

  const decision = guard(await p.select({
    message: 'Ready to finish?',
    options: [
      { value: 'finish', label: 'Finish setup' },
      { value: 'edit', label: 'Go back and edit…' },
      { value: 'skip', label: 'Skip remaining' },
    ],
  })) as string;
  if (decision === 'finish') return 'finish';
  if (decision === 'skip') return 'skip-remaining';
  const which = guard(await p.select({ message: 'Edit which step?', options: STEPS.map((s, idx) => ({ value: String(idx), label: s.title })) })) as string;
  return Number(which);
}

/** Persist the completion marker and (unless embedded in a host flow) print a readiness matrix (what
 *  actually works right now, via GET /system/readiness) followed by the "next steps" outro including the
 *  web URL + login. Embedded mode (`orca install`) skips the outro — the host prints its own summary. */
async function finish(env: NodeJS.ProcessEnv, ctx: WizardCtx, skipped: boolean, embedded: boolean): Promise<void> {
  writeMarker(env, { completed: true, skipped, updatedAt: new Date().toISOString() });
  if (embedded) return; // the host (e.g. `orca install`) shows its own summary
  const answers = ctx.answers;

  try { await printReadiness(ctx); } catch { /* best-effort: a dropped daemon must not crash the outro */ }

  const username = answers.account?.username || 'your admin account'; // '' (skipped account) must fall through
  const lines = [
    `Open   ${webBaseUrl()}   (sign in as ${username})`,
    'Talk to it:  orca chat',
    'Connect Discord/WhatsApp:  Settings → Plugins',
  ];
  const unfinished = skipped
    || answers.project?.connected !== true
    || answers.ai?.status !== 'done'
    || answers.memory?.status !== 'done'
    || answers.lsp?.status !== 'done';
  if (unfinished) lines.push('Finish setup:  orca setup');
  p.note(lines.join('\n'), "You're set");
  p.outro('See you');
}

/** Print the readiness matrix: one '✓/✗ <label> — <detail>' line per check, with the hint on any ✗.
 *  Best-effort — a failed/absent readiness call just skips the matrix, never blocking completion. */
async function printReadiness(ctx: WizardCtx): Promise<void> {
  const checks = (await apiJson<{ checks?: ReadinessCheck[] }>(ctx, 'GET', '/system/readiness')).data?.checks ?? [];
  if (!checks.length) return;
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`${c.ok ? '✓' : '✗'} ${c.label} — ${c.detail}`);
    if (!c.ok && c.hint) lines.push(`   ${c.hint}`);
  }
  p.note(lines.join('\n'), 'What works now');
}

async function confirmSave(): Promise<boolean> {
  const ans = await p.confirm({ message: 'Save your progress and resume later?', initialValue: true });
  return !p.isCancel(ans) && ans === true;
}

function accountSummary(a: WizardAnswers): string {
  const acc = a.account;
  if (!acc) return 'skipped';
  if (acc.created) return `${acc.username} (created)`;
  if (acc.signedIn) return `${acc.username} (signed in)`;
  return 'not signed in';
}

function projectSummary(a: WizardAnswers): string {
  return a.project?.connected ? `${a.project.slug} → ${a.project.path}` : 'skipped';
}
