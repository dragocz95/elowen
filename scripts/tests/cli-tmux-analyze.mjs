#!/usr/bin/env node
import { resolve } from 'node:path';

import { aggregateTmuxReports } from './cli-tmux-support.mjs';

const root = resolve(process.argv[2] ?? '');
const expectedArg = process.argv.find((value) => value.startsWith('--expected-rounds='));
const expectedRounds = expectedArg ? Number(expectedArg.split('=')[1]) : 2;

try {
  const summary = aggregateTmuxReports(root, { expectedRounds });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`FAIL cli-tmux-analyze: ${error.stack ?? error}\n`);
  process.exitCode = 1;
}
