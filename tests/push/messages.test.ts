import { describe, it, expect } from 'vitest';
import { buildReview, buildNeedsInput, buildStalled, buildBlocked, buildDone } from '../../src/push/messages.js';

describe('push message builders', () => {
  it('review carries approve/rerun actions and points at escalations', () => {
    const p = buildReview({ missionId: 'm-e1', taskId: 't1', phaseTitle: 'Build', rationale: 'missing test' });
    expect(p.kind).toBe('review');
    expect(p.actions.map((a) => a.action)).toEqual(['approve', 'rerun']);
    expect(p.url).toBe('/escalations');
    expect(p.body).toContain('missing test');
  });

  it('needs_input gives allow/reject for a permission prompt (no options)', () => {
    const p = buildNeedsInput({ session: 'orca-a', question: 'Run rm?', hasOptions: false });
    expect(p.actions.map((a) => a.action)).toEqual(['allow', 'reject']);
    expect(p.session).toBe('orca-a');
  });

  it('needs_input is tap-to-open for a multiple-choice question (has options)', () => {
    const p = buildNeedsInput({ session: 'orca-a', question: 'Pick one', hasOptions: true });
    expect(p.actions).toEqual([]);
  });

  it('stalled and blocked offer an open action', () => {
    expect(buildStalled({ missionId: 'm-e1', epicTitle: 'E' }).actions.map((a) => a.action)).toEqual(['open']);
    expect(buildBlocked({ taskId: 't1', taskTitle: 'T' }).actions.map((a) => a.action)).toEqual(['open']);
  });

  it('done has no actions and appends the PR phrase only when a url is present', () => {
    const plain = buildDone({ missionId: 'm-e1', epicTitle: 'E' });
    expect(plain.actions).toEqual([]);
    expect(plain.title).toBe('Mise dokončena');
    expect(plain.url).toBe('/dash');

    const withPr = buildDone({ missionId: 'm-e1', epicTitle: 'E', prUrl: 'https://gh/pr/1' });
    expect(withPr.title).toContain('PR');
    expect(withPr.url).toBe('https://gh/pr/1');
    expect(withPr.prUrl).toBe('https://gh/pr/1');
  });
});
