import * as p from '../../ui/prompts.js';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { apiJson } from '../http.js';
import { deriveSlug, uniqueSlug } from '../slug.js';
import { guard, type StepResult, type WizardCtx } from '../types.js';
import { humanError } from './shared.js';

interface ProjectRow { id: number; slug: string; path: string }

/** Config-file names that mark a folder as an existing project (subtle reassurance only). */
const PROJECT_MARKERS = ['package.json', '.git', 'CLAUDE.md', 'pyproject.toml', 'go.mod', 'Cargo.toml'];

/** Step 2 — connect a default project so Elowen has somewhere to work. Offers the current folder, another
 *  path, an existing project, or skip. A new path is validated (and optionally created), a slug derived,
 *  then registered via POST /projects. */
export async function runProjectStep(ctx: WizardCtx): Promise<StepResult> {
  const existing = await listProjects(ctx);
  const choice = guard(await p.select({
    message: 'Which project should Elowen work in?',
    options: [
      { value: 'cwd', label: 'This folder', hint: process.cwd() },
      { value: 'custom', label: 'Another folder…', hint: 'enter a path' },
      ...(existing.length ? [{ value: 'existing', label: 'An existing project', hint: `${existing.length} registered` }] : []),
      { value: 'skip', label: 'Skip for now' },
      { value: 'back', label: '← Go back' },
    ],
  }));
  if (choice === 'back') return { status: 'back' };
  if (choice === 'skip') return { status: 'skipped' };

  if (choice === 'existing') {
    const pick = guard(await p.select({
      message: 'Pick a project',
      options: existing.map((e) => ({ value: String(e.id), label: e.slug, hint: e.path })),
    }));
    const proj = existing.find((e) => String(e.id) === pick)!;
    ctx.answers.project = { slug: proj.slug, path: proj.path, connected: true };
    return { status: 'done' };
  }

  // A new path: resolve it, validate via the daemon (the process that must read it), optionally create.
  let path = process.cwd();
  if (choice === 'custom') {
    const entered = (guard(await p.text({ message: 'Project folder path', placeholder: process.cwd() }))).trim();
    if (!entered) return { status: 'skipped' };
    path = entered;
  }
  path = resolve(path);

  if (!(await pathExists(ctx, path))) {
    const create = guard(await p.confirm({ message: `${path} doesn't exist. Create it?`, initialValue: true }));
    if (!create) return { status: 'back' }; // send them back to re-choose
    try { mkdirSync(path, { recursive: true }); }
    catch (e) { p.log.error(`Couldn't create the folder: ${(e as Error).message}`); return { status: 'skipped' }; }
  }

  if (PROJECT_MARKERS.some((f) => existsSync(join(path, f)))) p.log.info('Detected existing project configuration.');

  // Slug: derive from the folder, dedupe against registered projects, let the user override.
  const taken = new Set(existing.map((e) => e.slug));
  let slug = (guard(await p.text({
    message: 'Short name (slug)', initialValue: uniqueSlug(deriveSlug(path), taken),
    validate: (v) => (!/^[a-z0-9][a-z0-9-]*$/.test((v ?? '').trim()) ? 'Lowercase letters, numbers and dashes' : undefined),
  }))).trim();

  // Register — on a slug clash, tell them and re-prompt with the next free suggestion.
  for (;;) {
    const r = await apiJson(ctx, 'POST', '/projects', { slug, path, notes: '' });
    if (r.ok) {
      ctx.answers.project = { slug, path, connected: true };
      p.log.success(`Elowen will work in ${path} (${slug}).`);
      return { status: 'done' };
    }
    if (r.status === 409) {
      taken.add(slug);
      slug = (guard(await p.text({
        message: `"${slug}" is taken — pick another`, initialValue: uniqueSlug(slug, taken),
        validate: (v) => (!/^[a-z0-9][a-z0-9-]*$/.test((v ?? '').trim()) ? 'Lowercase letters, numbers and dashes' : undefined),
      }))).trim();
      continue;
    }
    p.log.error(humanError(new Error(`registering the project failed (${r.status})`), r.status));
    return { status: 'skipped' };
  }
}

async function listProjects(ctx: WizardCtx): Promise<ProjectRow[]> {
  const r = await apiJson<ProjectRow[]>(ctx, 'GET', '/projects');
  return r.ok && Array.isArray(r.data) ? r.data : [];
}

/** Ask the daemon (the process that actually reads the folder) whether the path is a readable directory:
 *  GET /fs/dirs returns 200 for a listable dir, 400 otherwise. */
async function pathExists(ctx: WizardCtx, path: string): Promise<boolean> {
  const r = await apiJson(ctx, 'GET', `/fs/dirs?path=${encodeURIComponent(path)}`);
  return r.ok;
}
