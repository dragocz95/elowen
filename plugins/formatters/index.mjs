// Formatters plugin: after the files plugin's Write/Edit succeeds, run the project's own code
// formatter on the written file. It observes tool results via the `tools.call.after` hook (emitted by
// the session tool composer after each permitted plugin tool execute) — no coupling to the files plugin
// beyond its result shape. A formatter only runs when the PROJECT is set up for it (local binary or
// config file present); everything is fail-soft: any problem is logged and never fails the original tool.
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { basename, delimiter, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const RUN_TIMEOUT_MS = 10_000; // default formatter subprocess SIGKILL timeout; overridable via config.timeoutMs
const MAX_FILE_BYTES = 1024 * 1024; // default: files above 1 MB are never formatted; overridable via config.maxFileBytes

/** Read a numeric config override, clamped to [min, max]; falls back to `def` when unset/invalid. */
function configNumber(value, def, min, max) {
  return Math.min(Math.max(Number(value) || def, min), max);
}
/** The file-writing tools whose successful results trigger a format run. Terminal-side writes are out
 *  of scope — only the files plugin's structured write/edit results carry a reliable path. */
const WRITE_TOOLS = new Set(['Write', 'Edit']);

/** Whether `bin` resolves to an executable on the daemon's PATH (dependency-free `which`). */
function onPath(bin) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try { accessSync(join(dir, bin), constants.X_OK); return true; } catch { /* keep looking */ }
  }
  return false;
}

const hasAny = (dir, names) => names.some((n) => existsSync(join(dir, n)));

/** Whether a project file exists AND mentions `needle` (e.g. pyproject.toml declaring ruff). */
function fileMentions(path, needle) {
  try { return readFileSync(path, 'utf-8').includes(needle); } catch { return false; }
}

const PRETTIER_CONFIGS = [
  '.prettierrc', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml', '.prettierrc.json5',
  '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', '.prettierrc.toml',
  'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs',
];

const JS_FAMILY = [
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.vue', '.svelte',
  '.json', '.jsonc', '.yaml', '.yml', '.md', '.mdx', '.graphql', '.gql',
];

/** The formatter catalog (mirrors opencode's). Each entry: display name, command argv with a `$FILE`
 *  placeholder (argv[0] may be project-relative — resolved against the project dir, falling back to the
 *  bare binary name on PATH), the file extensions it owns, and `enabledWhen(projectDir)` — the "only run
 *  what the project actually uses" gate. Catalog ORDER is the tie-break for shared extensions (an
 *  explicit biome config wins over an incidentally present prettier binary). */
export const FORMATTERS = [
  {
    name: 'biome',
    command: ['node_modules/.bin/biome', 'format', '--write', '$FILE'],
    extensions: JS_FAMILY,
    enabledWhen: (dir) => hasAny(dir, ['biome.json', 'biome.jsonc']) && existsSync(join(dir, 'node_modules/.bin/biome')),
  },
  {
    name: 'prettier',
    command: ['node_modules/.bin/prettier', '--write', '$FILE'],
    extensions: JS_FAMILY,
    enabledWhen: (dir) => existsSync(join(dir, 'node_modules/.bin/prettier')) || (hasAny(dir, PRETTIER_CONFIGS) && onPath('prettier')),
  },
  {
    name: 'pint',
    command: ['vendor/bin/pint', '$FILE'],
    extensions: ['.php'],
    enabledWhen: (dir) => existsSync(join(dir, 'vendor/bin/pint')),
  },
  {
    name: 'ruff',
    command: ['ruff', 'format', '$FILE'],
    extensions: ['.py', '.pyi'],
    enabledWhen: (dir) => onPath('ruff') && (hasAny(dir, ['ruff.toml', '.ruff.toml']) || fileMentions(join(dir, 'pyproject.toml'), 'ruff')),
  },
  {
    name: 'gofmt',
    command: ['gofmt', '-w', '$FILE'],
    extensions: ['.go'],
    enabledWhen: (dir) => existsSync(join(dir, 'go.mod')) && onPath('gofmt'),
  },
  {
    name: 'rustfmt',
    command: ['rustfmt', '$FILE'],
    extensions: ['.rs'],
    enabledWhen: (dir) => existsSync(join(dir, 'Cargo.toml')) && onPath('rustfmt'),
  },
  {
    name: 'clang-format',
    command: ['clang-format', '-i', '$FILE'],
    extensions: ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx', '.ino'],
    enabledWhen: (dir) => existsSync(join(dir, '.clang-format')) && onPath('clang-format'),
  },
  {
    name: 'mix',
    command: ['mix', 'format', '$FILE'],
    extensions: ['.ex', '.exs', '.eex', '.heex', '.leex'],
    enabledWhen: (dir) => existsSync(join(dir, 'mix.exs')) && onPath('mix'),
  },
  {
    name: 'terraform',
    command: ['terraform', 'fmt', '$FILE'],
    extensions: ['.tf', '.tfvars'],
    enabledWhen: () => onPath('terraform'), // .tf files imply a terraform project; the CLI is the config
  },
  {
    name: 'shfmt',
    command: ['shfmt', '-w', '$FILE'],
    extensions: ['.sh', '.bash'],
    enabledWhen: () => onPath('shfmt'), // shfmt has no project config; PATH presence is the opt-in
  },
];

/** Pick the formatter for `filePath` in `projectDir`: first catalog entry (catalog order) that owns the
 *  extension, is not operator-disabled, and whose project gate passes. Null when nothing applies. */
export function resolveFormatter(filePath, projectDir, disabled = new Set()) {
  const ext = extname(filePath).toLowerCase();
  if (!ext) return null;
  for (const f of FORMATTERS) {
    if (!f.extensions.includes(ext) || disabled.has(f.name)) continue;
    try { if (f.enabledWhen(projectDir)) return f; } catch { /* a broken gate = not enabled */ }
  }
  return null;
}

/** Materialize an entry's argv for one run: substitute `$FILE`, and when the project-relative argv[0]
 *  (e.g. node_modules/.bin/prettier) is absent, fall back to the bare binary name so a PATH install still
 *  works (prettier enabled via a config file without a local bin). */
export function buildCommand(formatter, projectDir, filePath) {
  const argv = formatter.command.map((a) => (a === '$FILE' ? filePath : a));
  const head = argv[0];
  if (!isAbsolute(head) && head.includes('/') && !existsSync(join(projectDir, head))) argv[0] = basename(head);
  return argv;
}

/** The `tools.call.after` handler: parse the payload defensively, apply every guard (tool kind, result
 *  success, config toggles, work dir containment, file size), then spawn the matching formatter. Always
 *  fail-soft — this is an observer; nothing here may throw into the hook bus. */
export async function formatToolResult(ctx, payload) {
  try {
    const { tool, result } = payload && typeof payload === 'object' ? payload : {};
    if (!WRITE_TOOLS.has(tool)) return;
    const details = result && typeof result === 'object' ? result.details : undefined;
    if (!details || typeof details !== 'object' || details.ok === false) return;
    if (typeof details.path !== 'string' || !details.path) return;

    if (ctx.config.enabled === false) return; // master toggle (absent = on)
    const disabled = new Set(Array.isArray(ctx.config.disabled) ? ctx.config.disabled.filter((d) => typeof d === 'string') : []);
    const timeoutMs = configNumber(ctx.config.timeoutMs, RUN_TIMEOUT_MS, 5000, 60000);
    const maxFileBytes = configNumber(ctx.config.maxFileBytes, MAX_FILE_BYTES, 262144, 10485760);

    // Security: format only inside the current turn's project. Resolve + prefix-check so `..` segments
    // or a symlinked-in path string can't point the formatter at a file outside the work dir.
    const workDir = ctx.currentWorkDir();
    if (!workDir) return;
    const root = resolve(workDir);
    const file = resolve(details.path);
    if (!file.startsWith(root + sep)) return;

    let size;
    try { size = statSync(file).size; } catch { return; /* vanished since the write */ }
    if (size > maxFileBytes) return;

    const formatter = resolveFormatter(file, root, disabled);
    if (!formatter) return;

    const argv = buildCommand(formatter, root, file);
    try {
      await execFileP(argv[0], argv.slice(1), { cwd: root, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });
      ctx.logger.info(`formatted ${file} with ${formatter.name}`);
      // Annotate the tool result so the note reaches the transcript: the tools.call.after observer is
      // awaited before the result travels onward, so appending to details.notes here is race-free
      // (the supported annotation channel — see the hook contract in src/plugins/api.js).
      const notes = Array.isArray(details.notes) ? details.notes : (details.notes = []);
      notes.push(`formatted ${basename(file)} with ${formatter.name}`);
      // The files plugin computed details.diff at WRITE time, against the content it wrote. This reformat
      // just rewrote the file on disk, so that diff no longer matches disk — rendering it would show the
      // transcript the PRE-format file. A true before→formatted diff can't be recomputed here: the hook
      // payload carries no pre-write content. So invalidate the stale diff; messageView then falls back to
      // the notes-only view ("formatted <file> with <name>") — never a diff that contradicts disk.
      if ('diff' in details) delete details.diff;
    } catch (e) {
      ctx.logger.warn(`formatter ${formatter.name} failed for ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (e) {
    ctx.logger.warn(`formatting skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export { configNumber };

export function register(ctx) {
  ctx.registerHook({ name: 'tools.call.after', run: (payload) => formatToolResult(ctx, payload) });
  ctx.logger.info('registered tools.call.after formatting hook');
}
