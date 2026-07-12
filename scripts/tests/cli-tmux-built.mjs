#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { aggregateTmuxReports, resolveTmuxRunId } from './cli-tmux-support.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runId = resolveTmuxRunId(process.env);
const configuredRoot = process.env.ELOWEN_TMUX_ARTIFACT_ROOT?.trim();
const artifactRoot = configuredRoot
  ? resolve(configuredRoot)
  : mkdtempSync(join(tmpdir(), 'elowen-tui-built-round-'));
mkdirSync(artifactRoot, { recursive: true });
if (configuredRoot && readdirSync(artifactRoot).length > 0) {
  process.stderr.write(`FAIL test:cli-tmux:built — configured evidence root must be empty: ${artifactRoot}\n`);
  process.exit(1);
}
const env = {
  ...process.env,
  ELOWEN_TMUX_RUN_ID: runId,
  ELOWEN_TMUX_ARTIFACT_ROOT: artifactRoot,
};
const steps = [
  ['--test', 'scripts/tests/cli-tmux-support.test.mjs'],
  ['scripts/tests/cli-tmux-goal.mjs'],
  ['scripts/tests/cli-tmux-short.mjs'],
  ['scripts/tests/cli-tmux-signals.mjs'],
  ['scripts/tests/cli-tmux.mjs'],
];

if (spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status !== 0) {
  process.stderr.write('FAIL test:cli-tmux:built — tmux is required for this evidence gate.\n');
  process.exit(1);
}

process.stdout.write(`tmux evidence run id: ${runId}\n`);
process.stdout.write(`tmux evidence root: ${artifactRoot}\n`);
for (const args of steps) {
  const result = spawnSync(process.execPath, args, { cwd: repo, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const summary = aggregateTmuxReports(artifactRoot, { expectedRounds: 1, repo });
writeFileSync(join(artifactRoot, 'aggregate.json'), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`PASS test:cli-tmux:built — raw evidence revalidated. Aggregate: ${join(artifactRoot, 'aggregate.json')}\n`);
