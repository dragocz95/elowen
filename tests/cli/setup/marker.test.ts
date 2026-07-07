import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMarker, writeMarker, clearMarker, isOnboarded, markerPath } from '../../../src/cli/setup/marker.js';

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'orca-marker-')); env = { HOME: home }; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('cli/setup.marker', () => {
  it('round-trips a completed marker', () => {
    writeMarker(env, { completed: true, skipped: false, updatedAt: '2026-01-01' });
    expect(readMarker(env)).toEqual({ completed: true, skipped: false, updatedAt: '2026-01-01' });
    expect(isOnboarded(env)).toBe(true);
  });

  it('reads null / not-onboarded when absent', () => {
    expect(readMarker(env)).toBeNull();
    expect(isOnboarded(env)).toBe(false);
  });

  it('reads null on malformed JSON (never throws)', () => {
    mkdirSync(join(home, '.config', 'orca'), { recursive: true });
    writeFileSync(markerPath(env), '{ not json', 'utf8');
    expect(readMarker(env)).toBeNull();
    expect(isOnboarded(env)).toBe(false);
  });

  it('an interrupted-only marker is not onboarded but keeps resume state', () => {
    writeMarker(env, { completed: false, skipped: false, updatedAt: 'x', resume: { answers: { account: { username: 'admin', created: true, signedIn: false } } } });
    expect(isOnboarded(env)).toBe(false);
    expect(readMarker(env)?.resume?.answers.account?.username).toBe('admin');
  });

  it('clears the marker (and is a no-op when already absent)', () => {
    writeMarker(env, { completed: true, skipped: false, updatedAt: 'x' });
    clearMarker(env);
    expect(readMarker(env)).toBeNull();
    expect(() => clearMarker(env)).not.toThrow();
  });
});
