#!/usr/bin/env node
// Host orchestrator for the "first unboxing" install smoke test (`npm run test:install`).
// Freshly builds the project, packs the real npm tarball, asserts the tarball actually ships the built
// artifacts, then builds a clean-machine Docker image that installs ONLY that tarball and runs the
// in-container contract assertions (scripts/install-smoke/smoke.mjs). Any failure — build, pack, a
// missing file in the tarball, the image build (e.g. a mis-pinned dep), or a container assertion — exits
// non-zero and fails CI. Style mirrors scripts/tests/cli-tmux-built.mjs.
import { spawnSync } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const tgz = join(here, 'elowen.tgz');
const IMAGE = 'elowen-install-smoke:local';
const CONTAINER = `elowen-install-smoke-${process.pid}`;

function die(msg) { process.stderr.write(`FAIL test:install — ${msg}\n`); cleanup(); process.exit(1); }

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: repo, ...opts });
  if (r.error) die(`${cmd} could not run: ${r.error.message}`);
  if (typeof r.status === 'number' && r.status !== 0) die(`${cmd} ${args.join(' ')} exited ${r.status}`);
  return r;
}

function cleanup() {
  try { rmSync(tgz, { force: true }); } catch { /* ignore */ }
  spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
}

const version = JSON.parse(spawnSync('node', ['-p', "JSON.stringify(require('./package.json').version)"], { cwd: repo, encoding: 'utf8' }).stdout.trim());
if (!version) die('could not read package version');

// 1. Fresh build — npm pack does NOT run prepublishOnly, so a stale/empty dist would otherwise ship.
//    prebuild wipes dist/ and postbuild verifies it, guarding the "cp -r merges, deletions don't prune" gotcha.
process.stdout.write(`\n[test:install] building elowen ${version}…\n`);
run('npm', ['run', 'build']);
run('npm', ['run', 'build:web']);

// 2. Pack the real tarball into this directory under a fixed name (keeps the Dockerfile ARG-free).
process.stdout.write('\n[test:install] packing tarball…\n');
rmSync(tgz, { force: true });
const packed = spawnSync('npm', ['pack', '--pack-destination', here], { cwd: repo, encoding: 'utf8' });
if (packed.status !== 0) die(`npm pack failed: ${packed.stderr}`);
const tarball = packed.stdout.trim().split('\n').pop().trim();
if (!existsSync(join(here, tarball))) die(`npm pack did not produce ${tarball}`);
renameSync(join(here, tarball), tgz);

// 3. Tarball manifest guard — the tripwire that catches `files`/build omissions before Docker even runs.
process.stdout.write('[test:install] verifying tarball contents…\n');
const listed = spawnSync('tar', ['-tzf', tgz], { encoding: 'utf8' });
if (listed.status !== 0) die(`could not read tarball: ${listed.stderr}`);
const entries = listed.stdout.split('\n');
const hasExact = (p) => entries.includes(`package/${p}`);
const hasPrefix = (p) => entries.some((e) => e.startsWith(`package/${p}`));
for (const f of ['dist/cli/bin.js', 'dist/daemon/index.js', 'dist/store/schema.sql', 'web-dist/server.js']) {
  if (!hasExact(f)) die(`tarball is missing ${f} (check package.json "files" and the build)`);
}
for (const p of ['dist/prompts/', 'dist/plugins/', 'web-dist/.next/static/', 'prompts/', 'plugins/']) {
  if (!hasPrefix(p)) die(`tarball ships no ${p} entries (check package.json "files" and the build)`);
}

// 4a. Native mode (`--native`, used by the macOS CI job): no Docker on the platform, so install the
//     tarball globally on THIS machine and run the same smoke assertions against it directly. Guarded
//     hard against dev boxes: a pre-existing global elowen (above all a linked checkout, which a global
//     install would silently replace and detach) refuses the run.
if (process.argv.includes('--native')) {
  const globalRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout.trim();
  if (globalRoot && existsSync(join(globalRoot, 'elowen'))) {
    die('refusing --native: elowen is already installed globally on this machine (this mode is for clean CI runners).');
  }
  process.stdout.write('\n[test:install] installing tarball globally (native mode)…\n');
  run('npm', ['install', '-g', '--no-audit', '--no-fund', tgz]);
  process.stdout.write('\n[test:install] running unboxing smoke natively…\n');
  const native = spawnSync('node', [join(here, 'smoke.mjs')], {
    stdio: 'inherit', cwd: repo, timeout: 180_000,
    env: { ...process.env, ELOWEN_EXPECTED_VERSION: version },
  });
  spawnSync('npm', ['rm', '-g', 'elowen'], { stdio: 'ignore' });
  if (native.error || native.status !== 0) die(`native smoke failed${native.signal ? ` (${native.signal})` : ''}`);
  cleanup();
  process.stdout.write(`\nPASS test:install — elowen ${version} unboxes cleanly (native).\n`);
  process.exit(0);
}

// 4b. Docker — only reached once the tarball is proven complete. Clear message if Docker is unavailable.
if (spawnSync('docker', ['version'], { stdio: 'ignore' }).status !== 0) {
  die('Docker is required to run the container smoke (build + tarball checks passed). Start Docker and retry, or run this in CI. On a Docker-less clean machine (CI runner), use --native.');
}
process.stdout.write('\n[test:install] building clean-machine image…\n');
run('docker', ['build', '-t', IMAGE, '--build-arg', `ELOWEN_VERSION=${version}`, here]);

process.stdout.write('\n[test:install] running unboxing smoke in a clean container…\n');
const runResult = spawnSync('docker', ['run', '--rm', '--name', CONTAINER, IMAGE], { stdio: 'inherit', cwd: repo, timeout: 180_000 });
if (runResult.error || runResult.status !== 0) { cleanup(); die(`container smoke failed${runResult.signal ? ` (${runResult.signal})` : ''}`); }

cleanup();
process.stdout.write(`\nPASS test:install — elowen ${version} unboxes cleanly.\n`);
