import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorkspacePathView } from '../../src/plugins/pathView.js';
import { resolveDelegatedWorkspace } from '../../src/brain/workspaceScope.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'elowen-path-view-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'file.ts'), 'ok');
  return createWorkspacePathView({
    accountUserId: 7,
    workspaceId: 'ws_test',
    projectId: 3,
    path: root,
  });
}

describe('workspace PathView', () => {
  it('resolves only logical relative paths and renders them without the host root', () => {
    const view = fixture();
    const resolved = view.resolve('src/file.ts');
    expect(resolved).toBe(join(view.root, 'src', 'file.ts'));
    expect(view.display(resolved)).toBe('src/file.ts');
    expect(view.stateKey(resolved)).toBe('ws_test\0src/file.ts');
    expect(view.sanitize(`failed at ${resolved}`)).toBe('failed at ./src/file.ts');
  });

  it('rejects absolute paths, traversal, symlink leaves and symlink ancestors', () => {
    const view = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'elowen-path-outside-'));
    writeFileSync(join(outside, 'secret'), 'nope');
    symlinkSync(join(outside, 'secret'), join(view.root, 'leaf'));
    symlinkSync(outside, join(view.root, 'ancestor'));

    expect(() => view.resolve('/')).toThrow('absolute paths are unavailable');
    expect(() => view.resolve(view.root)).toThrow('absolute paths are unavailable');
    expect(() => view.resolve('../outside')).toThrow('outside the assigned workspace');
    expect(() => view.resolve('leaf')).toThrow('outside the assigned workspace');
    expect(() => view.resolve('ancestor/new/file')).toThrow('outside the assigned workspace');
    expect(() => view.resolve('.git')).toThrow('Git metadata paths are unavailable');
    expect(() => view.resolve('nested/.git/config')).toThrow('Git metadata paths are unavailable');
  });

  it('preserves meaningful leading and trailing whitespace in filenames', () => {
    const view = fixture();
    writeFileSync(join(view.root, ' spaced '), 'ok');
    expect(view.resolve(' spaced ')).toBe(join(view.root, ' spaced '));
  });

  it('allows a nonexistent target only through an existing in-workspace parent', () => {
    const view = fixture();
    expect(view.resolve('src/new/deep.ts')).toBe(join(view.root, 'src', 'new', 'deep.ts'));
  });

  it('lets an explicit scope inherit itself but refuses a sibling workspace', () => {
    const sandbox = {
      resolveWorkspace: ({ accountUserId, workspace }: any) => ({ accountUserId, ...workspace, path: `/host/${workspace.workspaceId}` }),
      workspacesFor: () => [],
    } as any;
    const access = {
      admin: true, projectIds: [], contributionUserId: 7,
      workspaceRef: { workspaceId: 'ws_parent', projectId: 3 },
    };
    expect(resolveDelegatedWorkspace(sandbox, access)?.workspaceId).toBe('ws_parent');
    expect(() => resolveDelegatedWorkspace(sandbox, access, 'ws_sibling')).toThrow('cannot switch to a sibling');
  });
});
