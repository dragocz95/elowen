import type { FileNode } from '../../../lib/types';

export interface TreeNode { name: string; path: string; type: 'file' | 'dir'; children: TreeNode[] }

/** Build a nested, sorted tree (dirs first, then files; alpha within each) from the flat file list. */
export function buildTree(nodes: FileNode[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', type: 'dir', children: [] };
  const dirs = new Map<string, TreeNode>([['', root]]);
  for (const n of [...nodes].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = n.path.split('/');
    const parentPath = parts.slice(0, -1).join('/');
    const node: TreeNode = { name: parts[parts.length - 1] ?? n.path, path: n.path, type: n.type, children: [] };
    (dirs.get(parentPath) ?? root).children.push(node);
    if (n.type === 'dir') dirs.set(n.path, node);
  }
  const sort = (t: TreeNode) => {
    t.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    t.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

/** Monaco language id from a file extension. */
export function langOf(path: string): string {
  const ext = extOf(path);
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', css: 'css', scss: 'scss', html: 'html', md: 'markdown', py: 'python', sh: 'shell', bash: 'shell',
    yml: 'yaml', yaml: 'yaml', sql: 'sql', toml: 'ini', env: 'ini', go: 'go', rs: 'rust', php: 'php',
  };
  return map[ext] ?? 'plaintext';
}

const extOf = (p: string) => p.split('.').pop()?.toLowerCase() ?? '';
export const basename = (p: string) => p.split('/').pop() ?? p;
export const parentDir = (p: string) => p.split('/').slice(0, -1).join('/');
export const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif']);
export const isImage = (p: string) => IMAGE_EXT.has(extOf(p));
export const isMarkdown = (p: string) => extOf(p) === 'md' || extOf(p) === 'markdown';

/** Suggest a non-colliding "copy" name for duplication, e.g. `a.ts` → `a copy.ts`. */
export function copyName(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  return joinPath(parentDir(path), `${stem} copy${ext}`);
}
