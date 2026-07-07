import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TUI } from '@earendil-works/pi-tui';
import { getSelectListTheme, initTheme } from '@earendil-works/pi-coding-agent';
import { ChatEditor } from '../../../src/cli/chat/picker.js';
import {
  appendPromptHistory,
  loadPromptHistory,
  MAX_PROMPT_HISTORY,
  MAX_STASH_ENTRIES,
  PromptStash,
} from '../../../src/cli/chat/promptHistory.js';

const dirs: string[] = [];
const makeEnv = (): NodeJS.ProcessEnv => {
  const home = mkdtempSync(join(tmpdir(), 'orca-history-'));
  dirs.push(home);
  return { HOME: home };
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('prompt history persistence (per project)', () => {
  it('appends and reloads prompts in order, keyed by workDir', () => {
    const env = makeEnv();
    appendPromptHistory('/proj/a', 'first', env);
    appendPromptHistory('/proj/a', 'second', env);
    appendPromptHistory('/proj/b', 'other project', env);
    expect(loadPromptHistory('/proj/a', env)).toEqual(['first', 'second']);
    expect(loadPromptHistory('/proj/b', env)).toEqual(['other project']);
    expect(loadPromptHistory('/proj/c', env)).toEqual([]);
  });

  it('dedupes consecutive prompts but keeps non-adjacent repeats', () => {
    const env = makeEnv();
    appendPromptHistory('/p', 'npm test', env);
    appendPromptHistory('/p', 'npm test', env);
    appendPromptHistory('/p', 'fix it', env);
    appendPromptHistory('/p', 'npm test', env);
    expect(loadPromptHistory('/p', env)).toEqual(['npm test', 'fix it', 'npm test']);
  });

  it('caps the stored history and keeps the newest entries', () => {
    const env = makeEnv();
    for (let i = 0; i < MAX_PROMPT_HISTORY + 20; i++) appendPromptHistory('/p', `prompt ${i}`, env);
    const entries = loadPromptHistory('/p', env);
    expect(entries).toHaveLength(MAX_PROMPT_HISTORY);
    expect(entries[0]).toBe('prompt 20');
    expect(entries[entries.length - 1]).toBe(`prompt ${MAX_PROMPT_HISTORY + 19}`);
  });

  it('ignores blank prompts and survives a corrupt or missing file', () => {
    const env = makeEnv();
    appendPromptHistory('/p', '   ', env); // blank → no write at all
    expect(loadPromptHistory('/p', env)).toEqual([]);
    const file = join(env.HOME!, '.config', 'orca', 'cli-history.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'not json{', 'utf-8');
    expect(loadPromptHistory('/p', env)).toEqual([]);
    appendPromptHistory('/p', 'recovers', env); // overwrites the corrupt file
    expect(loadPromptHistory('/p', env)).toEqual(['recovers']);
    expect(() => JSON.parse(readFileSync(file, 'utf-8'))).not.toThrow();
  });

  it('drops non-string junk from a tampered file instead of recalling it', () => {
    const env = makeEnv();
    const file = join(env.HOME!, '.config', 'orca', 'cli-history.json');
    appendPromptHistory('/p', 'real', env);
    writeFileSync(file, JSON.stringify({ '/p': ['real', 42, null, ''] }), 'utf-8');
    expect(loadPromptHistory('/p', env)).toEqual(['real']);
  });
});

describe('persisted history feeds the editor ↑-recall across sessions', () => {
  beforeAll(() => { initTheme(); });

  it('walks back through reloaded prompts and forward to the empty draft', () => {
    const env = makeEnv();
    appendPromptHistory('/p', 'oldest', env);
    appendPromptHistory('/p', 'newest', env);
    const tui = { requestRender: () => { /* not rendering */ }, terminal: { rows: 24, columns: 80 } } as unknown as TUI;
    const editor = new ChatEditor(tui, { borderColor: (s) => s, selectList: getSelectListTheme() }, {});
    for (const entry of loadPromptHistory('/p', env)) editor.addToHistory(entry); // the runChat seeding
    const press = (data: string): void => { editor.render(60); editor.handleInput(data); };
    press('\x1b[A');
    expect(editor.getText()).toBe('newest');
    press('\x1b[A');
    expect(editor.getText()).toBe('oldest');
    press('\x1b[B');
    expect(editor.getText()).toBe('newest');
    press('\x1b[B'); // past the newest → the (empty) draft comes back
    expect(editor.getText()).toBe('');
  });
});

describe('PromptStash (ctrl+s)', () => {
  it('is LIFO: the most recently stashed draft pops first', () => {
    const stash = new PromptStash();
    stash.push('first draft');
    stash.push('second draft');
    expect(stash.size).toBe(2);
    expect(stash.pop()).toBe('second draft');
    expect(stash.pop()).toBe('first draft');
    expect(stash.pop()).toBeUndefined();
    expect(stash.size).toBe(0);
  });

  it('ignores blank drafts and caps at the max, dropping the oldest', () => {
    const stash = new PromptStash();
    stash.push('   ');
    expect(stash.size).toBe(0);
    for (let i = 0; i < MAX_STASH_ENTRIES + 3; i++) stash.push(`draft ${i}`);
    expect(stash.size).toBe(MAX_STASH_ENTRIES);
    expect(stash.pop()).toBe(`draft ${MAX_STASH_ENTRIES + 2}`);
    let last: string | undefined;
    for (let i = 0; i < MAX_STASH_ENTRIES - 1; i++) last = stash.pop();
    expect(last).toBe('draft 3'); // drafts 0–2 fell off the bottom
  });
});
