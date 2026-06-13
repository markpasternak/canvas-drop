import { useMemo } from "react";
import type { DraftFile } from "../lib/api.js";
import { cn } from "../lib/cn.js";

interface TreeNode {
  name: string;
  path: string; // full path for files; "" for the synthetic root
  isDir: boolean;
  children: TreeNode[];
}

/** Build a nested tree from flat manifest paths (e.g. "a/b.css"). */
function buildTree(files: DraftFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", isDir: true, children: [] };
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const segments = file.path.split("/");
    let node = root;
    segments.forEach((seg, i) => {
      const isLeaf = i === segments.length - 1;
      const full = segments.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.name === seg && c.isDir !== isLeaf);
      if (!child) {
        child = { name: seg, path: full, isDir: !isLeaf, children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }
  // Directories first, then files, each alphabetical.
  const order = (n: TreeNode) => {
    n.children.sort((a, b) =>
      a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
    );
    for (const c of n.children) order(c);
  };
  order(root);
  return root;
}

export interface FileTreeProps {
  files: DraftFile[];
  selected: string | null;
  onSelect: (path: string) => void;
}

/** Draft file tree (R16). Read affordance only; add/rename/delete live in the toolbar. */
export function FileTree({ files, selected, onSelect }: FileTreeProps) {
  const tree = useMemo(() => buildTree(files), [files]);
  if (files.length === 0) {
    return <p className="px-2 py-3 text-xs text-subtle">No files yet — add one to begin.</p>;
  }
  return (
    <ul className="space-y-0.5 text-sm" aria-label="Draft files">
      {tree.children.map((node) => (
        <TreeRow key={node.path} node={node} depth={0} selected={selected} onSelect={onSelect} />
      ))}
    </ul>
  );
}

function TreeRow({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const pad = { paddingLeft: `${depth * 0.875 + 0.5}rem` };
  if (node.isDir) {
    return (
      <li>
        <div
          className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-subtle"
          style={pad}
        >
          <span aria-hidden>▾</span>
          {node.name}/
        </div>
        <ul className="space-y-0.5">
          {node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </ul>
      </li>
    );
  }
  const active = node.path === selected;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(node.path)}
        style={pad}
        aria-current={active ? "true" : undefined}
        className={cn(
          "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left transition-colors",
          active ? "bg-accent-subtle text-accent" : "text-fg hover:bg-canvas",
        )}
      >
        <span aria-hidden className="text-subtle">
          ▪
        </span>
        <span className="truncate font-mono text-xs">{node.name}</span>
      </button>
    </li>
  );
}
