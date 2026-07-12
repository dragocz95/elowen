#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { aggregateTmuxReports } from './cli-tmux-support.mjs';

const root = resolve(process.argv[2] ?? '');
const expectedArg = process.argv.find((value) => value.startsWith('--expected-rounds='));
const expectedRounds = expectedArg ? Number(expectedArg.split('=')[1]) : 2;
const expectedCommitArg = process.argv.find((value) => value.startsWith('--expected-commit='));
const expectedDistHashArg = process.argv.find((value) => value.startsWith('--expected-dist-hash='));
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

try {
  const summary = aggregateTmuxReports(root, {
    expectedRounds,
    repo,
    ...(expectedCommitArg ? { expectedCommit: expectedCommitArg.split('=').slice(1).join('=') } : {}),
    ...(expectedDistHashArg ? { expectedDistHash: expectedDistHashArg.split('=').slice(1).join('=') } : {}),
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`FAIL cli-tmux-analyze: ${error.stack ?? error}\n`);
  process.exitCode = 1;
}
