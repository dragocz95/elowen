import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { openDb } from '../../src/store/db.js';
import type { Db } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { snapshotTaskChanges } from '../../src/overseer/taskSnapshot.js';

let db: Db;
let tasks: TaskStore;
let root: string;
const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=Test', ...args], { stdio: 'pipe' });
const w = (rel: string, body: string) => { const p = join(root, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body); };
const head = () => execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

beforeEach(() => {
  db = openDb(':memory:');
  tasks = new TaskStore(db);
  root = mkdtempSync(join(tmpdir(), 'orca-snap-'));
  git('init', '-q');
  w('a.md', 'one\n');
  git('add', '-A'); git('commit', '-q', '-m', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('snapshotTaskChanges', () => {
  it('freezes the files committed between baseline and HEAD', async () => {
    tasks.create({ id: 't1', project_id: 1, title: 'Phase' });
    tasks.markBase('t1', head());
    w('a.md', 'two\n'); w('b.ts', 'export const x = 1;\n');
    git('add', '-A'); git('commit', '-q', '-m', 'work');

    await snapshotTaskChanges(tasks, 't1', root);

    const t = tasks.get('t1')!;
    const byPath = Object.fromEntries(t.changed_files.map((f) => [f.path, f]));
    expect(byPath['a.md']).toEqual({ path: 'a.md', added: 1, deleted: 1 });
    expect(byPath['b.ts']).toEqual({ path: 'b.ts', added: 1, deleted: 0 });
    expect(t.base_sha).toBeTruthy();
    expect(t.head_sha).toBe(head());
  });

  it('stores an empty list when the task committed nothing since baseline', async () => {
    tasks.create({ id: 't2', project_id: 1, title: 'Phase' });
    tasks.markBase('t2', head());
    await snapshotTaskChanges(tasks, 't2', root);
    expect(tasks.get('t2')!.changed_files).toEqual([]);
  });

  it('no-ops (no snapshot) when the task has no baseline label', async () => {
    tasks.create({ id: 't3', project_id: 1, title: 'Manual' });
    w('a.md', 'changed\n'); git('add', '-A'); git('commit', '-q', '-m', 'x');
    await snapshotTaskChanges(tasks, 't3', root);
    const t = tasks.get('t3')!;
    expect(t.changed_files).toEqual([]);
    expect(t.base_sha).toBeNull();
  });
});
