#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveTmuxRunId } from './cli-tmux-support.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runId = resolveTmuxRunId(process.env);
const env = { ...process.env, ELOWEN_TMUX_RUN_ID: runId };
const steps = [
  ['--test', 'scripts/tests/cli-tmux-support.test.mjs'],
  ['scripts/tests/cli-tmux-short.mjs'],
  ['scripts/tests/cli-tmux-signals.mjs'],
  ['scripts/tests/cli-tmux.mjs'],
];

process.stdout.write(`tmux evidence run id: ${runId}\n`);
for (const args of steps) {
  const result = spawnSync(process.execPath, args, { cwd: repo, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
