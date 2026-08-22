import { describe, it, expect } from 'vitest';
import { eventVerb } from '../../../modules/dashboard/ActivityTile';
import { en } from '../../../lib/i18n/dictionaries/en';

const t = en;
const ev = t.dashboard.ev;

// The timeline carries more than tasks: identity audit rows (`sso.*`) and plugin rows
// (`plugin:<name>`) live in the same table. The verb used to fall through to "task completed" for
// every type this function did not recognise, so a Microsoft sign-in appeared on the dashboard as a
// finished task labelled with a raw `<objectId>@<tenantId>`.
describe('eventVerb', () => {
  it('names each identity event instead of calling it a finished task', () => {
    expect(eventVerb(t, 'sso.login', 'linked')).toBe(ev.signedIn);
    expect(eventVerb(t, 'sso.link', 'linked')).toBe(ev.accountLinked);
    expect(eventVerb(t, 'sso.provision', 'provisioned')).toBe(ev.accountProvisioned);
    expect(eventVerb(t, 'sso.denied', 'no_account')).toBe(ev.signInDenied);
    for (const type of ['sso.login', 'sso.link', 'sso.provision', 'sso.denied']) {
      expect(eventVerb(t, type, 'linked')).not.toBe(ev.taskDone);
    }
  });

  it('does not claim an unknown or plugin row is a finished task', () => {
    expect(eventVerb(t, 'plugin:msteams', 'anything')).toBe(ev.activity);
    expect(eventVerb(t, 'something-new', '')).toBe(ev.activity);
    // `detail` alone must not reopen the task ladder for a non-task row: these details are real task
    // statuses, and matching on them was how unrelated rows borrowed a task's verb in the first place.
    expect(eventVerb(t, 'plugin:msteams', 'open')).toBe(ev.activity);
    expect(eventVerb(t, 'sso.login', 'blocked')).toBe(ev.signedIn);
  });

  it('still reads a task row exactly as before', () => {
    expect(eventVerb(t, 'task', 'open')).toBe(ev.taskOpen);
    expect(eventVerb(t, 'task', 'working')).toBe(ev.taskWorking);
    expect(eventVerb(t, 'task', 'in_progress')).toBe(ev.taskWorking);
    expect(eventVerb(t, 'task', 'blocked')).toBe(ev.taskBlocked);
    expect(eventVerb(t, 'task', 'cancelled')).toBe(ev.taskCancelled);
    expect(eventVerb(t, 'task', 'closed')).toBe(ev.taskDone);
  });

  it('keeps the agents-domain verbs it already had', () => {
    expect(eventVerb(t, 'review', 'escalated: needs a human')).toBe(ev.reviewEscalated);
    expect(eventVerb(t, 'review', 'approved: ok')).toBe(ev.reviewApproved);
    expect(eventVerb(t, 'mission', 'active')).toBe(ev.missionActive);
    expect(eventVerb(t, 'mission', 'paused')).toBe(ev.missionPaused);
    expect(eventVerb(t, 'mission', 'stalled')).toBe(ev.missionStalled);
    expect(eventVerb(t, 'mission', 'done')).toBe(ev.missionEnded);
    expect(eventVerb(t, 'message', '')).toBe(ev.message);
    expect(eventVerb(t, 'decision', '')).toBe(ev.decision);
    expect(eventVerb(t, 'signal', 'needs_input')).toBe(ev.needsInput);
    expect(eventVerb(t, 'signal', 'working')).toBe(ev.signal);
  });
});
