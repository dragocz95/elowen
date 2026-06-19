'use client';
import { ChevronRight, File as FileIcon, Folder, FolderOpen } from 'lucide-react';
import type { TreeNode } from './helpers';

interface RowProps {
  node: TreeNode; depth: number;
  expanded: Set<string>; onToggle: (p: string) => void;
  selected: string | null; onSelect: (p: string) => void;
  changed: Set<string>;
  onContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
}

function TreeRow({ node, depth, expanded, onToggle, selected, onSelect, changed, onContextMenu }: RowProps) {
  const isOpen = expanded.has(node.path);
  const ctx = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); onContextMenu(e, node); };
  if (node.type === 'dir') {
    const hasChange = changed.size > 0 && [...changed].some((c) => c.startsWith(node.path + '/'));
    const FolderIcon = isOpen ? FolderOpen : Folder;
    return (
      <li role="treeitem" aria-expanded={isOpen} aria-label={node.name}>
        <button type="button" onClick={() => onToggle(node.path)} onContextMenu={ctx} className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-xs text-text-muted transition-colors hover:bg-elevated" style={{ paddingLeft: depth * 12 + 6 }}>
          <ChevronRight size={11} className={`shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`} aria-hidden />
          <FolderIcon size={13} className={`shrink-0 ${hasChange ? 'text-accent' : 'text-text-muted'}`} aria-hidden />
          <span className={`truncate ${hasChange ? 'text-text' : ''}`}>{node.name}</span>
        </button>
        {isOpen ? <ul role="group" className="m-0 list-none p-0">{node.children.map((c) => <TreeRow key={c.path} node={c} depth={depth + 1} expanded={expanded} onToggle={onToggle} selected={selected} onSelect={onSelect} changed={changed} onContextMenu={onContextMenu} />)}</ul> : null}
      </li>
    );
  }
  const isChanged = changed.has(node.path);
  return (
    <li role="treeitem" aria-selected={selected === node.path}>
      <button type="button" onClick={() => onSelect(node.path)} onContextMenu={ctx} className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs transition-colors hover:bg-elevated ${selected === node.path ? 'bg-accent/15 text-accent' : isChanged ? 'font-medium text-accent' : 'text-text'}`} style={{ paddingLeft: depth * 12 + 16 }} title={node.path}>
      <FileIcon size={12} className={`shrink-0 ${isChanged ? 'text-accent' : 'text-text-muted'}`} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
      {isChanged ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden /> : null}
      </button>
    </li>
  );
}

/** The project file tree. Left-click selects (file) or toggles (dir); right-click anywhere raises a
 *  context menu — on a node for `node`, on empty space with `null` for project-root actions. */
export function FileTree({ tree, expanded, onToggle, selected, onSelect, changed, onContextMenu, emptyLabel, treeLabel }: {
  tree: TreeNode[];
  expanded: Set<string>; onToggle: (p: string) => void;
  selected: string | null; onSelect: (p: string) => void;
  changed: Set<string>;
  onContextMenu: (e: React.MouseEvent, node: TreeNode | null) => void;
  emptyLabel: string; treeLabel: string;
}) {
  return (
    <div className="h-full" onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, null); }}>
      {tree.length === 0
        ? <p className="p-3 text-center text-xs text-text-muted">{emptyLabel}</p>
        : <ul role="tree" aria-label={treeLabel} className="m-0 list-none p-0">{tree.map((n) => <TreeRow key={n.path} node={n} depth={0} expanded={expanded} onToggle={onToggle} selected={selected} onSelect={onSelect} changed={changed} onContextMenu={onContextMenu} />)}</ul>}
    </div>
  );
}
