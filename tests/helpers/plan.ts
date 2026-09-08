import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { planFilePath } from '../../src/shared/paths.js';

/** Put a plan on disk the way a plan-mode turn would, for tests that need one to already exist.
 *
 *  Production has almost no such ingress on purpose: the plan file is written by the MODEL through the
 *  clamped Write/Edit tools. The one host-side write is `planStore.writePlan`, which a managed-project
 *  `ExitPlanMode` earns by writing its guest-authored plan THROUGH to the central store — tests seed
 *  directly rather than routing through the tool that would write it. */
export function seedPlan(sessionId: string, body: string): void {
  const path = planFilePath(process.env, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');
}
