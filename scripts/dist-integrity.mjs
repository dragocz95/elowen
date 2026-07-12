import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const emittedExtensions = new Map([
  ['.ts', '.js'],
  ['.tsx', '.js'],
  ['.mts', '.mjs'],
  ['.cts', '.cjs'],
]);
const javascriptExtensions = new Set(['.js', '.mjs', '.cjs']);

const toPosix = (path) => path.split(sep).join('/');

const listFiles = (directory) => {
  if (!existsSync(directory)) return [];
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(directory);
  return files;
};

const repositoryDist = (root) => {
  const repository = resolve(root);
  const manifestPath = join(repository, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.name !== 'elowen') throw new Error('dist integrity: expected package name "elowen"');
  const dist = resolve(repository, 'dist');
  if (dirname(dist) !== repository || basename(dist) !== 'dist') {
    throw new Error('dist integrity: refusing to operate outside repository dist');
  }
  return dist;
};

const emittedJavaScript = (root) => listFiles(join(root, 'src'))
  .filter((path) => !path.endsWith('.d.ts'))
  .flatMap((path) => {
    const outputExtension = emittedExtensions.get(extname(path));
    if (!outputExtension) return [];
    const sourceRelative = relative(join(root, 'src'), path);
    return [toPosix(join('dist', sourceRelative.slice(0, -extname(sourceRelative).length) + outputExtension))];
  });

const copiedJavaScript = (root) => ['plugins', 'prompts'].flatMap((sourceDirectory) => listFiles(join(root, sourceDirectory))
  .filter((path) => javascriptExtensions.has(extname(path)))
  .map((path) => toPosix(join('dist', sourceDirectory, relative(join(root, sourceDirectory), path)))));

const actualJavaScript = (root) => listFiles(repositoryDist(root))
  .filter((path) => javascriptExtensions.has(extname(path)))
  .map((path) => toPosix(join('dist', relative(repositoryDist(root), path))));

const sortedDifference = (left, right) => [...left].filter((path) => !right.has(path)).sort();

export function cleanDist(root) {
  rmSync(repositoryDist(root), { recursive: true, force: true });
}

export function inspectDistParity(root) {
  const expected = new Set([...emittedJavaScript(root), ...copiedJavaScript(root)]);
  const actual = new Set(actualJavaScript(root));
  return {
    missing: sortedDifference(expected, actual),
    orphaned: sortedDifference(actual, expected),
  };
}

export function assertDistParity(root) {
  const { missing, orphaned } = inspectDistParity(root);
  if (missing.length === 0 && orphaned.length === 0) return;
  throw new Error([
    ...missing.map((path) => `missing output: ${path}`),
    ...orphaned.map((path) => `orphaned output: ${path}`),
  ].join('\n'));
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const command = process.argv[2];
  const root = resolve(dirname(scriptPath), '..');
  if (command === 'clean') cleanDist(root);
  else if (command === 'verify') assertDistParity(root);
  else {
    process.stderr.write('usage: node scripts/dist-integrity.mjs <clean|verify>\n');
    process.exitCode = 2;
  }
}
