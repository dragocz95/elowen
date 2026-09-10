import { describe, it, expect } from 'vitest';
import { createBoundSiteSpec, createContainerSpec, guestMountTarget, RESERVED_GUEST_ROOTS as pluginReserved } from '../../plugins/sandbox/lib/containerSpec.mjs';
import { managedGuestRoot as pluginRoot } from '../../plugins/sandbox/lib/containerPaths.mjs';
import { createProjectSchema } from '../../src/api/schemas/projects.js';
import { isReservedProjectSlug, managedGuestRoot as coreRoot, RESERVED_GUEST_ROOTS } from '../../src/shared/projectExecution.js';

const SAMPLES: [string | undefined, number, string][] = [
  ['kolin', 3, '/kolin'],
  ['Sales-Dashboard', 4, '/sales-dashboard'],
  ['personal-2-21be2b6e', 9, '/personal-2-21be2b6e'],
  ['a b/c', 5, '/a-b-c'],
  ['../docs', 6, '/docs'],
  ['-', 7, '/project-7'],
  ['', 8, '/project-8'],
  [undefined, 12, '/project-12'],
];

describe('managed project mount point', () => {
  // Core resolves it for the prompt, the tools and the status; the plugin resolves it for the container.
  // They are two implementations because a bundled plugin cannot import core at runtime, so they are held
  // in step here rather than by convention.
  it.each(SAMPLES)('derives the same directory from %s in core and in the sandbox plugin', (slug, id, expected) => {
    expect(coreRoot(slug, id)).toBe(expected);
    expect(pluginRoot(slug, id)).toBe(expected);
  });

  it('always produces one valid top-level directory', () => {
    for (const [slug, id] of SAMPLES) expect(() => guestMountTarget(coreRoot(slug, id))).not.toThrow();
  });

  // A slug that lands on a base-image directory produced a project that could be created and never
  // started: every start threw `Invalid project mount target`, and the slug is not patchable. The two
  // lists therefore have to agree, and creation is where the collision is refused.
  it('refuses a slug that would mount over a directory of the base image', () => {
    expect([...pluginReserved].sort()).toEqual([...RESERVED_GUEST_ROOTS].sort());
    for (const name of RESERVED_GUEST_ROOTS) {
      expect(isReservedProjectSlug(name)).toBe(true);
      expect(() => guestMountTarget(`/${name}`)).toThrow(/mount target/);
      expect(createProjectSchema.safeParse({ slug: name, executionKind: 'managed' }).success).toBe(false);
    }
    // Normalisation is part of the rule: `../etc` is stripped to the reserved `etc`.
    expect(isReservedProjectSlug('../etc')).toBe(true);
    expect(createProjectSchema.safeParse({ slug: 'kolin', executionKind: 'managed' }).success).toBe(true);
  });

  const paths = { sandboxDataDir: '/srv/sandbox', namespace: 'elowen' };

  it('mounts the project at its own name and makes it the container working directory', () => {
    const spec = createContainerSpec({ resource: { kind: 'project', id: 3 }, workspaceTarget: '/kolin', generation: 1, image: 'localhost/base:v1' }, paths);
    expect(spec.workdir).toBe('/kolin');
    expect(spec.mounts.find((mount: { target: string }) => mount.target === '/kolin')).toBeTruthy();
    expect(spec.mounts.some((mount: { target: string }) => mount.target === '/workspace')).toBe(false);
  });

  it('refuses a mount point that would take over a directory of the base image', () => {
    for (const target of ['/', '/data', '/root', '/etc', '/workspace', '/worktrees', '/a/b', '/Kolin']) {
      expect(() => createContainerSpec({ resource: { kind: 'project', id: 3 }, workspaceTarget: target, generation: 1, image: 'localhost/base:v1' }, paths)).toThrow(/mount target/);
    }
  });

  it('gives a project moved to a new mount point a new container identity', () => {
    const at = (target: string) => createContainerSpec({ resource: { kind: 'project', id: 3 }, workspaceTarget: target, generation: 1, image: 'localhost/base:v1' }, paths).specHash;
    expect(at('/kolin')).not.toBe(at('/other'));
  });

  // Sites were migrated separately and their containers are in production: their specification identity
  // must not move because projects gained a named mount. This is the exact hash those containers carry.
  it('leaves the Site container specification hash untouched', () => {
    const spec = createBoundSiteSpec(
      { resource: { kind: 'site', id: 'demo-site' }, generation: 3, image: 'localhost/site:v1' },
      { namespace: 'elowen', sitesDataDir: '/srv/sites-data', sourcePath: '/srv/sites/demo-site', brokerDir: '/srv/broker/demo-site' },
    );
    expect(spec.specHash).toBe('c5737001dfd0aab0b0e9c41034d4792392c819205d63ba27c51aa2e37c49a0fb');
    expect(spec.workdir).toBe('/workspace');
  });
});
