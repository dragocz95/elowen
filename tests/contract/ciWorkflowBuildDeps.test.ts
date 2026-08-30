import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** `npm run build` does not only compile the daemon — it also bundles every plugin's browser UI, and
 *  those bundles import the WEB APP's libraries (lucide-react, monaco, react-query, dompurify, marked)
 *  because they render inside it. Those live in `web/node_modules`, which a bare `npm ci` at the repo
 *  root does not install.
 *
 *  This was a real outage of the whole pipeline: twelve of sixteen jobs went red at once, every one of
 *  them failing in `npm run build` on "Could not resolve lucide-react" long before it reached what it
 *  was written to test. It is invisible locally, where `web/node_modules` is simply always there, and it
 *  only appeared when the first plugin started shipping a browser UI — so nothing about the change that
 *  triggered it looked related to CI at all.
 *
 *  Hence a test rather than a comment in the workflow: any new job that builds must install the web
 *  dependencies too, and a reviewer cannot be expected to remember why. */
describe('CI workflow: jobs that build also install the web dependencies', () => {
  const workflow = join(process.cwd(), '.github', 'workflows', 'ci.yml');

  it('pairs every `npm run build` job with `npm ci --prefix web`', () => {
    expect(existsSync(workflow)).toBe(true);
    const yaml = readFileSync(workflow, 'utf-8');

    // Split on job keys (two-space indent under `jobs:`) — enough structure for this check without
    // pulling in a YAML parser the repo does not otherwise use in tests.
    const body = yaml.split('\njobs:\n')[1];
    expect(body).toBeTruthy();
    const jobs = body.split(/\n {2}(?=[a-z0-9_-]+:\n)/);

    // A job that runs entirely inside web/ is a different case: its `npm run build` IS the web app's
    // build and its plain `npm ci` already installs those dependencies. Adding `--prefix web` there
    // would resolve to web/web/ and fail — which is exactly what happened on the first attempt.
    const rootBuildJobs = jobs.filter((j) => j.includes('npm run build') && !j.includes('working-directory: web'));

    const offenders = rootBuildJobs
      .filter((j) => !j.includes('npm ci --prefix web'))
      .map((j) => j.split(':', 1)[0].trim());

    expect(offenders).toEqual([]);
    // Guard the guard: if the split ever stops finding jobs, the filter above would be vacuously happy.
    expect(rootBuildJobs.length).toBeGreaterThan(5);
  });

  it('runs the destructive dist build probe outside the parallel daemon suite', () => {
    const yaml = readFileSync(workflow, 'utf-8');
    const daemon = yaml.split('\n  daemon:\n')[1]?.split(/\n  [a-z0-9_-]+:\n/, 1)[0] ?? '';

    // distIntegrity deliberately removes dist/ before rebuilding it. Arming that file inside the ordinary
    // parallel suite races process-level tests importing dist/store/db.js and its copied schema.sql.
    expect(daemon).toContain('- run: npm test');
    expect(daemon).toMatch(/- run: npx vitest run tests\/scripts\/distIntegrity\.test\.ts\n\s+env:\n\s+ELOWEN_DIST_BUILD_TEST: '1'/);
    expect(daemon).not.toMatch(/- run: npm test\n\s+env:\n\s+ELOWEN_DIST_BUILD_TEST/);
  });

  it('still describes plugin bundles as depending on the web app libraries', () => {
    // The pairing above is only correct while plugin bundles really do resolve against web/node_modules.
    // If a future change vendors those libraries, this test should be revisited, not silently kept.
    const builder = readFileSync(join(process.cwd(), 'scripts', 'build-plugins-web.mjs'), 'utf-8');
    expect(builder).toContain("'web', 'node_modules'");
  });
});
