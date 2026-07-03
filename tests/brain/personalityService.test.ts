import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { PersonalityStore } from '../../src/store/personalityStore.js';
import { PersonalityService } from '../../src/brain/personalityService.js';
import { personalityText } from '../../src/brain/personality.js';

/** A fake prompts seam that echoes the template name + vars so tests can assert the persona render is
 *  the exact call the brain makes, without pulling in the real template files. */
function fakePrompts() {
  return {
    render(name: string, vars: Record<string, string>, userId?: number): string {
      return `[${name}] ${JSON.stringify(vars)} u=${userId}`;
    },
  };
}

function fakeUsers(map: Record<number, { name?: string; username?: string }>) {
  return { get: (id: number) => map[id] };
}

function build() {
  const store = new PersonalityStore(openDb(':memory:'));
  const service = new PersonalityService({
    store,
    prompts: fakePrompts(),
    users: fakeUsers({ 1: { name: 'Filip', username: 'filip' } }),
    agentName: () => 'Orca',
  });
  return { store, service };
}

describe('PersonalityService.activeAppend', () => {
  it('returns undefined when no active profile is pinned', () => {
    const { service } = build();
    expect(service.activeAppend(1, 'discord')).toBeUndefined();
  });

  it('returns the labeled chunk with tone + style present', () => {
    const { store, service } = build();
    const p = store.create(1, { platform: 'discord', name: 'Snarky', tone: 'dry', style: 'terse', prompt: 'Be witty.' });
    store.setActive(1, 'discord', p.id);
    expect(service.activeAppend(1, 'discord')).toBe(
      'User personality for discord:\nName: Snarky\nTone: dry\nStyle: terse\n\nInstructions:\nBe witty.',
    );
  });

  it('omits empty tone/style lines', () => {
    const { store, service } = build();
    const p = store.create(1, { platform: 'discord', name: 'Plain', prompt: 'Just answer.' });
    store.setActive(1, 'discord', p.id);
    expect(service.activeAppend(1, 'discord')).toBe(
      'User personality for discord:\nName: Plain\n\nInstructions:\nJust answer.',
    );
  });

  it('respects enabled-only — a disabled active profile resolves to undefined', () => {
    const { store, service } = build();
    const p = store.create(1, { platform: 'discord', name: 'Off', prompt: 'x' });
    store.setActive(1, 'discord', p.id);
    store.update(1, p.id, { enabled: false });
    expect(service.activeAppend(1, 'discord')).toBeUndefined();
  });

  it('isolates platforms — a web profile does not leak into discord', () => {
    const { store, service } = build();
    const web = store.create(1, { platform: 'web', name: 'WebOnly', prompt: 'web voice' });
    store.setActive(1, 'web', web.id);
    expect(service.activeAppend(1, 'discord')).toBeUndefined();
    expect(service.activeAppend(1, 'web')).toContain('WebOnly');
  });
});

describe('PersonalityService.preview', () => {
  it('renders both layers and a faithful resolved string when a profile is active', () => {
    const { store, service } = build();
    const p = store.create(1, { platform: 'discord', name: 'Snarky', tone: 'dry', prompt: 'Be witty.' });
    store.setActive(1, 'discord', p.id);
    const pv = service.preview(1, 'discord');
    expect(pv.platform).toBe('discord');
    expect(pv.layers).toHaveLength(2);
    expect(pv.layers[0].label).toBe('Core persona');
    // discord is a shared channel → the advisor-channel persona, same call the brain makes.
    expect(pv.layers[0].text).toContain('[advisor-channel]');
    expect(pv.layers[0].text).toContain('"ownerName":"Filip"');
    expect(pv.layers[1].label).toBe('User personality (discord)');
    expect(pv.layers[1].text).toContain('Name: Snarky');
    expect(pv.resolved).toBe(`${pv.layers[0].text}\n\n${service.activeAppend(1, 'discord')}`);
  });

  it('shows a note and core-only resolved when no profile is active', () => {
    const { service } = build();
    const pv = service.preview(1, 'web');
    // web is an owner surface → the advisor persona.
    expect(pv.layers[0].text).toContain('[advisor]');
    expect(pv.layers[1].text).toBe('no active profile');
    expect(pv.resolved).toBe(pv.layers[0].text);
  });

  it('renders the persona with the user\'s real advisorStyle, not a fixed default', () => {
    const store = new PersonalityStore(openDb(':memory:'));
    const service = new PersonalityService({
      store, prompts: fakePrompts(), users: fakeUsers({ 1: { name: 'Filip' } }),
      userSettings: (id) => (id === 1 ? { advisorStyle: 'friendly' } : undefined),
      agentName: () => 'Orca',
    });
    // The fake prompts echoes vars, so the {{personality}} paragraph appears verbatim — it must be the
    // 'friendly' text, matching what the brain renders (brainService uses the same advisorStyle seam).
    expect(service.preview(1, 'web').layers[0].text).toContain(personalityText('friendly'));
    expect(service.preview(1, 'web').layers[0].text).not.toContain(personalityText('professional'));
  });
});
