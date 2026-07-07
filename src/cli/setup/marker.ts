import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../paths.js';
import type { WizardAnswers } from './types.js';

/** Records that the CLI onboarding wizard has run (so the launcher doesn't re-nag every start) and holds
 *  partial answers so an interrupted run can resume. CLI-owned local JSON — like install.json — rather
 *  than daemon config, so the first-run gate and the non-TTY fallback can decide WITHOUT spinning up the
 *  daemon, and so partial resume state has a home the daemon config schema doesn't provide. */
export interface SetupMarker {
  completed: boolean;
  /** Finished via "Skip remaining" — completed, but with steps left unconfigured. */
  skipped: boolean;
  updatedAt: string;
  /** Present only for an interrupted run: the answers gathered so far. Deliberately NO step index — the
   *  bearer token is never persisted (it's a secret), so a resumed run MUST re-enter at the Account step
   *  to sign in again; jumping mid-wizard would 401 on every daemon call with misleading errors. */
  resume?: { answers: WizardAnswers };
}

export function markerPath(env: NodeJS.ProcessEnv): string {
  return join(dataDir(env), 'setup.json');
}

export function readMarker(env: NodeJS.ProcessEnv): SetupMarker | null {
  try { return JSON.parse(readFileSync(markerPath(env), 'utf8')) as SetupMarker; }
  catch { return null; }
}

export function writeMarker(env: NodeJS.ProcessEnv, marker: SetupMarker): void {
  mkdirSync(dataDir(env), { recursive: true });
  writeFileSync(markerPath(env), JSON.stringify(marker, null, 2), 'utf8');
}

export function clearMarker(env: NodeJS.ProcessEnv): void {
  rmSync(markerPath(env), { force: true });
}

/** True once the wizard has been completed (or explicitly skipped-to-finish) — the gate that stops the
 *  launcher from re-offering setup. A never-run or interrupted-only marker reads as not onboarded. */
export function isOnboarded(env: NodeJS.ProcessEnv): boolean {
  return readMarker(env)?.completed === true;
}
