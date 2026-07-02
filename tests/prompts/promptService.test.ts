import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { UserPromptStore } from '../../src/store/userPromptStore.js';
import { PromptService } from '../../src/prompts/promptService.js';
import { rawTemplate } from '../../src/prompts/index.js';

let prompts: PromptService;
let store: UserPromptStore;

beforeEach(() => {
  store = new UserPromptStore(openDb(':memory:'));
  prompts = new PromptService(store);
});

describe('PromptService.render', () => {
  it('uses the file default when the user has no override', () => {
    expect(prompts.render('advisor', { userName: 'Alice' }, 1)).toBe(rawTemplate('advisor').replaceAll('{{userName}}', 'Alice'));
  });

  it('uses the file default when no userId is given', () => {
    store.set(1, 'advisor', 'CUSTOM {{userName}}');
    expect(prompts.render('advisor', { userName: 'Bob' })).toContain('You are'); // default advisor text, not CUSTOM
  });

  it("uses the user's override and substitutes vars", () => {
    store.set(1, 'worker', 'Hello {{agentName}}, do {{taskId}}.');
    expect(prompts.render('worker', { agentName: 'a1', taskId: 't9' }, 1)).toBe('Hello a1, do t9.');
  });

  it('isolates overrides per user', () => {
    store.set(1, 'worker', 'USER ONE');
    expect(prompts.render('worker', {}, 2)).toBe(rawTemplate('worker'));
  });

  it('ignores an override for a non-editable template name', () => {
    store.set(1, 'planner-fallback', 'SHOULD NOT WIN');
    expect(prompts.render('planner-fallback', {}, 1)).toBe(rawTemplate('planner-fallback'));
  });

  it('appends (never replaces) the advisor override — the system identity stays intact', () => {
    store.set(1, 'advisor', 'Always answer in Czech for {{userName}}.');
    const out = prompts.render('advisor', { userName: 'Filip' }, 1);
    expect(out.startsWith(rawTemplate('advisor').replaceAll('{{userName}}', 'Filip'))).toBe(true);
    expect(out).toContain('## User preferences (added by the user)');
    expect(out).toContain('Always answer in Czech for Filip.');
  });
});
