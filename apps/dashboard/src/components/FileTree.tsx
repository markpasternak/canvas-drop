import {
  CaretDown,
  CaretRight,
  File,
  FileArchive,
  FileCode,
  FileCss,
  FileCsv,
  FileDoc,
  FileHtml,
  FileImage,
  FileJs,
  FileMd,
  FilePdf,
  FileSvg,
  FileText,
  FileTs,
  FileXls,
  FolderSimple,
  type Icon,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import type { DraftFile } from "../lib/api.js";
import { cn } from "../lib/cn.js";
import { fileLabel, isImage } from "../lib/file-kind.js";

interface TreeNode {
  name: string;
  path: string; // full path for files; "" for the synthetic root
  isDir: boolean;
  file?: DraftFile; // present on leaf nodes
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
        child = {
          name: seg,
          path: full,
          isDir: !isLeaf,
          children: [],
          file: isLeaf ? file : undefined,
        };
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

/** Draft file tree (R16). Read affordance only; add/rename/delete live in the toolbar.
 * Folders start expanded; clicking one collapses its subtree (state is per-path). */
export function FileTree({ files, selected, onSelect }: FileTreeProps) {
  const tree = useMemo(() => buildTree(files), [files]);
  // Collapsed folder paths. Empty = everything expanded (the prior behaviour).
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  if (files.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface-sunken px-3 py-8 text-center">
        <FilePlusPlaceholder />
        <p className="mt-3 text-xs font-medium text-fg">No draft files</p>
        <p className="mt-1 text-xs text-subtle">Add or upload a file to begin.</p>
      </div>
    );
  }
  return (
    <ul className="space-y-1 text-sm" aria-label="Draft files">
      {tree.children.map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          selected={selected}
          onSelect={onSelect}
          collapsed={collapsed}
          onToggle={toggle}
        />
      ))}
    </ul>
  );
}

/** Fixed-width chevron column. Folders show the caret; files render an empty slot of
 * the same width so every row's icon tile lines up in a single column at each level. */
function Chevron({ state }: { state: "open" | "closed" | "leaf" }) {
  return (
    <span
      aria-hidden
      className="grid size-3.5 shrink-0 place-items-center text-subtle group-hover:text-fg"
    >
      {state === "closed" && <CaretRight size={12} weight="bold" />}
      {state === "open" && <CaretDown size={12} weight="bold" />}
    </span>
  );
}

function TreeRow({
  node,
  selected,
  onSelect,
  collapsed,
  onToggle,
}: {
  node: TreeNode;
  selected: string | null;
  onSelect: (path: string) => void;
  collapsed: ReadonlySet<string>;
  onToggle: (path: string) => void;
}) {
  if (node.isDir) {
    const isCollapsed = collapsed.has(node.path);
    return (
      <li>
        <button
          type="button"
          onClick={() => onToggle(node.path)}
          aria-expanded={!isCollapsed}
          className="group flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors duration-100 [transition-timing-function:var(--ease-out)] hover:bg-surface-hover"
        >
          <Chevron state={isCollapsed ? "closed" : "open"} />
          {/* Matching icon tile so the folder carries the same weight as file rows. */}
          <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-surface-raised text-muted group-hover:text-fg">
            <FolderSimple size={16} weight="duotone" aria-hidden />
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-fg">
            {node.name}/
          </span>
        </button>
        {!isCollapsed && (
          // Indent + a vertical guide line so it's clear which files live in this folder.
          // The guide sits under the folder's chevron column (ml ≈ row px + half-chevron).
          <ul className="mt-1 ml-[0.9375rem] space-y-1 border-l border-border pl-2">
            {node.children.map((child) => (
              <TreeRow
                key={child.path}
                node={child}
                selected={selected}
                onSelect={onSelect}
                collapsed={collapsed}
                onToggle={onToggle}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }
  const active = node.path === selected;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(node.path)}
        aria-current={active ? "true" : undefined}
        className={cn(
          "group flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors duration-100 [transition-timing-function:var(--ease-out)]",
          active ? "bg-accent-subtle text-accent" : "text-fg hover:bg-surface-hover",
        )}
      >
        {/* Empty chevron slot keeps file icons aligned with sibling folder icons. */}
        <Chevron state="leaf" />
        {node.file && <FileKindIcon file={node.file} active={active} />}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-xs">{node.name}</span>
          {node.file && (
            <span className="block text-[0.625rem] font-medium text-subtle group-aria-[current=true]:text-accent/70">
              {fileLabel(node.file)}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

function iconForFile(file: Pick<DraftFile, "path" | "mime">): Icon {
  const ext = file.path.slice(file.path.lastIndexOf(".") + 1).toLowerCase();
  if (isImage(file)) return FileImage;
  if (["html", "htm", "xhtml"].includes(ext)) return FileHtml;
  if (["css", "scss", "sass", "less"].includes(ext)) return FileCss;
  if (["js", "mjs", "cjs", "jsx"].includes(ext)) return FileJs;
  if (["ts", "tsx"].includes(ext)) return FileTs;
  if (ext === "svg") return FileSvg;
  if (["md", "markdown", "mdx"].includes(ext)) return FileMd;
  if (["json", "jsonc", "json5", "yaml", "yml", "toml", "xml"].includes(ext)) return FileCode;
  if (["csv", "tsv"].includes(ext)) return FileCsv;
  if (["xlsx", "xls"].includes(ext)) return FileXls;
  if (["doc", "docx"].includes(ext)) return FileDoc;
  if (ext === "pdf") return FilePdf;
  if (["zip", "gz", "tar", "rar", "7z"].includes(ext)) return FileArchive;
  if (["txt", "text", "log"].includes(ext)) return FileText;
  return File;
}

export function FileKindIcon({
  file,
  active = false,
  size = 18,
}: {
  file: Pick<DraftFile, "path" | "mime">;
  active?: boolean;
  size?: number;
}) {
  const Icon = iconForFile(file);
  return (
    <span
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-md border",
        active
          ? "border-accent/20 bg-accent/10 text-accent"
          : "border-border bg-surface-raised text-muted group-hover:text-fg",
      )}
      aria-hidden
    >
      <Icon size={size} weight="duotone" />
    </span>
  );
}

function FilePlusPlaceholder() {
  return (
    <span className="mx-auto grid size-10 place-items-center rounded-lg border border-border bg-surface-raised text-subtle">
      <FileText size={18} weight="duotone" aria-hidden />
    </span>
  );
}
