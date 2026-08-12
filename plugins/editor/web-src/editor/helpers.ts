import type { FileNode } from '../runtime';

export interface TreeNode { name: string; path: string; type: 'file' | 'dir'; children: TreeNode[] }

export function buildTree(nodes: FileNode[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', type: 'dir', children: [] };
  const dirs = new Map<string, TreeNode>([['', root]]);
  for (const node of [...nodes].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = node.path.split('/');
    const parentPath = parts.slice(0, -1).join('/');
    const treeNode: TreeNode = { name: parts[parts.length - 1] ?? node.path, path: node.path, type: node.type, children: [] };
    (dirs.get(parentPath) ?? root).children.push(treeNode);
    if (node.type === 'dir') dirs.set(node.path, treeNode);
  }
  const sort = (tree: TreeNode) => {
    tree.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    tree.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

const extOf = (path: string) => path.split('.').pop()?.toLowerCase() ?? '';
export const baseName = (path: string) => path.split('/').pop() ?? path;
export function langOf(path: string): string {
  const map: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', json: 'json', css: 'css', scss: 'scss', html: 'html', md: 'markdown', py: 'python', sh: 'shell', bash: 'shell', yml: 'yaml', yaml: 'yaml', sql: 'sql', toml: 'ini', env: 'ini', go: 'go', rs: 'rust', php: 'php' };
  return map[extOf(path)] ?? 'plaintext';
}
export const parentDir = (path: string) => path.split('/').slice(0, -1).join('/');
export const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif']);
export const isImage = (path: string) => imageExtensions.has(extOf(path));
export const isMarkdown = (path: string) => ['md', 'markdown'].includes(extOf(path));
export function copyName(path: string): string {
  const base = baseName(path);
  const dot = base.lastIndexOf('.');
  return joinPath(parentDir(path), `${dot > 0 ? base.slice(0, dot) : base} copy${dot > 0 ? base.slice(dot) : ''}`);
}
