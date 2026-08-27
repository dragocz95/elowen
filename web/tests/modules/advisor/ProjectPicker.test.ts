import { describe, expect, it } from 'vitest';
import { projectForPath } from '../../../modules/advisor/ProjectPicker';

const project = (id: number, slug: string, path: string) => ({ id, slug, path });

describe('projectForPath', () => {
  it('matches the directory itself and anything under it', () => {
    const projects = [project(1, 'kolin', '/var/www/kolin')];
    expect(projectForPath(projects, '/var/www/kolin')?.slug).toBe('kolin');
    expect(projectForPath(projects, '/var/www/kolin/src/api')?.slug).toBe('kolin');
  });

  it('does not mistake a sibling whose name merely starts the same', () => {
    // '/var/www/kolin-worktrees'.startsWith('/var/www/kolin') is true as a string and false as a
    // directory. Naming the wrong project would be worse than naming none, so the boundary is the
    // separator, not the prefix.
    const projects = [project(1, 'kolin', '/var/www/kolin')];
    expect(projectForPath(projects, '/var/www/kolin-worktrees')).toBeNull();
    expect(projectForPath(projects, '/var/www/kolinx/src')).toBeNull();
  });

  it('picks the innermost project when registrations nest', () => {
    // A monorepo registered alongside one of its packages: both contain the directory, and the answer
    // the user means is the closer one.
    const projects = [project(1, 'mono', '/repo'), project(2, 'pkg', '/repo/packages/ui')];
    expect(projectForPath(projects, '/repo/packages/ui/src')?.slug).toBe('pkg');
    expect(projectForPath(projects, '/repo/packages/api')?.slug).toBe('mono');
  });

  it('is insensitive to a trailing slash on the registered path', () => {
    const projects = [project(1, 'kolin', '/var/www/kolin/')];
    expect(projectForPath(projects, '/var/www/kolin')?.slug).toBe('kolin');
    expect(projectForPath(projects, '/var/www/kolin/src')?.slug).toBe('kolin');
  });

  it('reports nothing rather than guessing when the directory is unknown or absent', () => {
    const projects = [project(1, 'kolin', '/var/www/kolin')];
    expect(projectForPath(projects, '/tmp/scratch')).toBeNull();
    expect(projectForPath(projects, null)).toBeNull();
    expect(projectForPath(projects, undefined)).toBeNull();
    expect(projectForPath(projects, '')).toBeNull();
    // An empty registered path would otherwise contain every directory on the machine.
    expect(projectForPath([project(1, 'broken', '')], '/var/www/kolin')).toBeNull();
  });
});
