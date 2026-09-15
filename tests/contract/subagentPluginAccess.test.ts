import { describe, expect, it } from 'vitest';
import manifest from '../../plugins/subagent/elowen-plugin.json';

/** The Agents page belongs to every authenticated account, because choosing which model a built-in agent
 *  runs on is that person's own setting and needs no administrator. `web.adminOnly` would hide the nav
 *  entry AND 403 the bundle, so declaring it is the same as not shipping that choice at all.
 *
 *  What stays administrative is AUTHORING — creating, overwriting and deleting the shared agent-definition
 *  files. That is enforced on the routes themselves (`tests/api/pluginRoutes.test.ts`,
 *  `tests/api/subagentAgentsAccess.test.ts`), never by hiding the page. */
describe('subagent browser access contract', () => {
  it('is not administrator-only chrome', () => {
    expect((manifest as { web: { adminOnly?: boolean } }).web.adminOnly).toBeUndefined();
  });

  it('asks for no plugin UI contract version newer than the one already released', () => {
    // A version bump is an instance-wide claim about what `window.ElowenUiRuntime` publishes; this page
    // reads the account's own settings through the generic query seam so it has to make no such claim.
    expect(manifest.web.requiresApiVersion).toBeLessThanOrEqual(16);
  });
});
