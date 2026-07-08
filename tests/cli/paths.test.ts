import { describe, it, expect } from 'vitest';
import { dataDir, dbPath, logDir, runFile } from '../../src/cli/paths.js';

describe('cli/paths', () => {
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
});
