import * as p from '../../ui/prompts.js';
import { isFirstRun, createAdmin, login } from '../../setup.js';
import { guard, type StepResult, type WizardCtx } from '../types.js';

/** Step 0 — the daemon's first admin. On a fresh box (zero users) create it; on a re-run or an
 *  `elowen install` box an admin already exists, so offer to sign in (later steps need the token) or skip. */
export async function runAccountStep(ctx: WizardCtx): Promise<StepResult> {
  const first = await isFirstRun(ctx.fetchFn, ctx.base);
  return first ? createFlow(ctx) : existingFlow(ctx);
}

async function createFlow(ctx: WizardCtx): Promise<StepResult> {
  const username = (guard(await p.text({
    message: 'Admin username', initialValue: 'admin',
    validate: (v) => (!(v ?? '').trim() ? 'Required' : undefined),
  })) as string).trim();
  const password = guard(await p.password({
    message: 'Admin password', validate: (v) => ((v ?? '').length < 4 ? 'At least 4 characters' : undefined),
  })) as string;
  guard(await p.password({
    message: 'Confirm password', validate: (v) => (v !== password ? 'Passwords do not match' : undefined),
  }));

  const s = p.spinner();
  s.start('Creating admin…');
  try {
    ctx.token = await createAdmin(ctx.fetchFn, ctx.base, { username, password });
    s.stop('Admin account created.');
    ctx.answers.account = { username, created: true, signedIn: true };
    return { status: 'done' };
  } catch (e) {
    const msg = (e as Error).message;
    s.stop(`Creating the admin failed: ${msg}`, 'error');
    // 409: a user appeared between the first-run check and the create → sign in instead of aborting.
    if (msg.includes('(409)')) return existingFlow(ctx);
    return { status: 'skipped' };
  }
}

/** Cap on sign-in attempts so a wrong password can never trap the operator in an endless loop. */
const MAX_SIGNIN_ATTEMPTS = 5;

async function existingFlow(ctx: WizardCtx): Promise<StepResult> {
  p.log.info('An admin account already exists.');
  // Embedded in `elowen install`, the box is already provisioned and the admin exists — signing in is
  // optional (only later steps that change shared settings need it), so lead with a clear "continue"
  // path instead of implying a mandatory login.
  const options = ctx.embedded
    ? [
        { value: 'continue', label: 'Continue — admin already exists', hint: 'recommended' },
        { value: 'signin', label: 'Sign in', hint: 'needed to change shared settings in later steps' },
        { value: 'back', label: '← Go back' },
      ]
    : [
        { value: 'signin', label: 'Sign in', hint: 'recommended — later steps need it' },
        { value: 'skip', label: 'Skip for now' },
        { value: 'back', label: '← Go back' },
      ];
  const choice = guard(await p.select({ message: 'How do you want to continue?', options })) as string;
  if (choice === 'back') return { status: 'back' };
  if (choice === 'continue') {
    ctx.answers.account = { username: '', created: false, signedIn: false };
    return { status: 'skipped' };
  }
  if (choice === 'skip') return skipSignIn(ctx);
  return signInLoop(ctx);
}

/** Sign in with bounded, escapable retries. A wrong password never traps: after each failure the operator
 *  explicitly picks Try again / Skip / Go back, and the attempt count is capped — so mashing Enter can't
 *  bounce forever between username and password. */
async function signInLoop(ctx: WizardCtx): Promise<StepResult> {
  for (let attempt = 1; ; attempt++) {
    const username = (guard(await p.text({ message: 'Username', initialValue: 'admin' })) as string).trim();
    const password = guard(await p.password({ message: 'Password' })) as string;
    const s = p.spinner();
    s.start('Signing in…');
    try {
      ctx.token = await login(ctx.fetchFn, ctx.base, { username, password });
      s.stop('Signed in.');
      ctx.answers.account = { username, created: false, signedIn: true };
      return { status: 'done' };
    } catch (e) {
      s.stop(`Sign-in failed: ${(e as Error).message}`, 'error');
      if (attempt >= MAX_SIGNIN_ATTEMPTS) {
        p.log.warn('Too many failed attempts — skipping sign-in. Re-run `elowen setup` to try again.');
        return skipSignIn(ctx);
      }
      const next = guard(await p.select({
        message: 'Sign-in failed. What now?',
        options: [
          { value: 'retry', label: 'Try again' },
          { value: 'skip', label: 'Skip sign-in' },
          { value: 'back', label: '← Go back' },
        ],
      })) as string;
      if (next === 'back') return { status: 'back' };
      if (next === 'skip') return skipSignIn(ctx);
      // 'retry' → loop.
    }
  }
}

function skipSignIn(ctx: WizardCtx): StepResult {
  p.log.warn('Skipped — steps that change shared settings need an admin sign-in and may be limited.');
  ctx.answers.account = { username: '', created: false, signedIn: false };
  return { status: 'skipped' };
}
