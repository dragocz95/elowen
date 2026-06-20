import { describe, it, expect } from 'vitest';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';

describe('FakeTmuxDriver', () => {
  it('records sent keys and returns scripted pane content', async () => {
    const t = new FakeTmuxDriver();
    t.setPane('s1', 'hello');
    await t.sendKeys('s1', ['Enter']);
    expect(await t.capturePane('s1', 60)).toBe('hello');
    expect(t.sentKeys('s1')).toEqual([['Enter']]);
    expect(await t.list()).toEqual(['s1']);
  });

  it('capturePaneAnsi returns the scripted pane', async () => {
    const t = new FakeTmuxDriver();
    t.setPane('s1', 'colored-output');
    expect(await t.capturePaneAnsi('s1', 200)).toBe('colored-output');
  });

  it('kill clears all per-session state (no leak of command/keys/size)', async () => {
    const t = new FakeTmuxDriver();
    await t.spawn('s1', { cwd: '/tmp', command: 'echo hi' });
    await t.sendKeys('s1', ['Enter']);
    await t.resize('s1', 100, 30);
    expect(t.commandFor('s1')).toBe('echo hi');
    await t.kill('s1');
    expect(t.commandFor('s1')).toBe('');
    expect(t.sentKeys('s1')).toEqual([]);
    expect(t.sizeFor('s1')).toBeUndefined();
  });
});
