import { describe, it, expect } from 'vitest';
import { dataDir, dbPath, logDir, runFile, toolResultSpillDir } from '../../src/shared/paths.js';

describe('shared/paths', () => {
  const env = { HOME: '/h' } as NodeJS.ProcessEnv;

  it('defaults the data dir to ~/.config/elowen', () => {
    expect(dataDir(env)).toBe('/h/.config/elowen');
  });
  it('derives the db path under the data dir', () => {
    expect(dbPath(env)).toBe('/h/.config/elowen/elowen.db');
  });
  it('lets ELOWEN_DB override the db path verbatim', () => {
    expect(dbPath({ HOME: '/h', ELOWEN_DB: '/tmp/x.db' } as NodeJS.ProcessEnv)).toBe('/tmp/x.db');
  });
  it('defaults logs under the data dir but honors ELOWEN_LOG_DIR', () => {
    expect(logDir(env)).toBe('/h/.config/elowen/logs');
    expect(logDir({ HOME: '/h', ELOWEN_LOG_DIR: '/var/log/o' } as NodeJS.ProcessEnv)).toBe('/var/log/o');
  });
  it('puts run.json in the data dir', () => {
    expect(runFile(env)).toBe('/h/.config/elowen/run.json');
  });
  it('spill dirs are per-session and path-safe for hostile ids', () => {
    expect(toolResultSpillDir(env, 'sess-1')).toBe('/h/.config/elowen/tool-results/sess-1');
    // Separators and dot segments in a minted id must never escape tool-results/.
    expect(toolResultSpillDir(env, 'a/b')).toBe('/h/.config/elowen/tool-results/a%2Fb');
    expect(toolResultSpillDir(env, '..')).toBe('/h/.config/elowen/tool-results/_..');
    expect(toolResultSpillDir(env, 'x%y')).toBe('/h/.config/elowen/tool-results/x%25y');
  });
});
