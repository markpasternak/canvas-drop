import { ArrowSquareOut, Eye, LinkSimple, Plus, UploadSimple } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import { ActionMenu, ActionMenuItem } from "../components/ActionMenu.js";
import { Button } from "../components/Button.js";
import { TabContentFrame, TabEmptyState } from "../components/CanvasDetail.js";
import { CodeEditor } from "../components/CodeEditor.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { canvasRelativePaths } from "../components/DeployFiles.js";
import { Dialog } from "../components/Dialog.js";
import { DraftPreview } from "../components/DraftPreview.js";
import { EditorStatusBar } from "../components/EditorStatusBar.js";
import { EmptyState } from "../components/EmptyState.js";
import { Field } from "../components/Field.js";
import { FileTree } from "../components/FileTree.js";
import { IconButton } from "../components/IconButton.js";
import { NonEditableFileView } from "../components/NonEditableFileView.js";
import { OnPageEditor } from "../components/OnPageEditor.js";
import { type EditorPane, type LocalDirtyState, PublishBar } from "../components/PublishBar.js";
import { PublishReviewDialog } from "../components/PublishReviewDialog.js";
import { ReadError } from "../components/ReadError.js";
import { Skeleton } from "../components/Skeleton.js";
import { PaneHeader, WorkspacePane } from "../components/Surface.js";
import { useToast } from "../components/Toast.js";
import { ApiError, api, type DraftFile, type DraftView } from "../lib/api.js";
import { useClipboardCopy } from "../lib/clipboard.js";
import { cn } from "../lib/cn.js";
import {
  draftUsesScripts,
  isEditableFile,
  isHtmlFile,
  nonEditableReason,
  normalizeDraftPath,
  singleHtmlFile,
} from "../lib/file-kind.js";
import { relativeTime } from "../lib/format.js";
import {
  useCreateDraftFile,
  useDeleteDraftFile,
  useRenameDraftFile,
  useSaveDraftFile,
  useUploadDraftFile,
  useUploadDraftFiles,
} from "../lib/mutations.js";
import { keys, useCanvas, useDraft, usePublishedFiles } from "../lib/queries.js";
import { useUnsavedChanges } from "../lib/use-unsaved-changes.js";

const AUTOSAVE_MS = 700;
const ROOT_HTML = "index.html";

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const rawUrl = (id: string, path: string) =>
  `/api/canvases/${id}/draft/file?path=${encodeURIComponent(path)}`;

/** A save refused because this session lost its role (editor-roles plan U12 / KTD14). */
interface LockedOut {
  path: string;
  code: string;
  /** The buffer at the moment of refusal — what copy/download hand back. */
  content: string;
}

/** A stale-save refusal in flight (editor-roles plan, KTD8/KTD14). */
interface DraftConflict {
  path: string;
  currentHash: string;
  updatedByName: string | null;
  updatedAt: number | null;
  /** The server's current content for the path (null when it could not be fetched). */
  theirs: string | null;
}

function DraftRepairNotice({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <section className="border border-warning/30 bg-warning-subtle/40 px-4 py-3 text-warning">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-0.5">
          <h2 className="text-sm font-semibold text-fg">{title}</h2>
          <p className="max-w-3xl text-xs leading-relaxed text-muted">{description}</p>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </section>
  );
}

/**
 * In-browser editor (M5): file tree + CodeMirror over the draft, autosave, the
 * publish bar, an owner-only live preview of the whole draft site (collapsible /
 * full screen), and non-editable-asset handling (images preview + Download/Replace;
 * an editable-text allowlist keeps binaries like .xlsx out of the text editor).
 */
export default function Editor() {
  const { id } = useParams({ strict: false }) as { id: string };
  return <EditorWorkspace key={id} id={id} />;
}

/** Route identity owns buffers and mutation callbacks, including delayed non-save writes. */
function EditorWorkspace({ id }: { id: string }) {
  const { data: canvas } = useCanvas(id);
  const { data: draft, isLoading, isError, refetch: refetchDraft } = useDraft(id);
  const [selected, setSelected] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [editorRevision, setEditorRevision] = useState(0);
  const [pageTooLarge, setPageTooLarge] = useState(false);
  const pageTooLargeRef = useRef(false);
  const [mode, setMode] = useState<"code" | "onpage">("code");
  const [onPagePath, setOnPagePath] = useState<string | null>(null);
  const [pane, setPane] = useState<EditorPane>("code");
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);

  const save = useSaveDraftFile(id);
  const create = useCreateDraftFile(id);
  const upload = useUploadDraftFile(id);
  const uploadMany = useUploadDraftFiles(id);
  const del = useDeleteDraftFile(id);
  const rename = useRenameDraftFile(id);
  const [reviewCanvasId, setReviewCanvasId] = useState<string | null>(null);
  const [preparingReview, setPreparingReview] = useState(false);
  const preparingReviewRef = useRef(false);
  const toast = useToast();
  const qc = useQueryClient();
  const replaceInputRef = useRef<HTMLInputElement>(null);

  // Autosave buffer is bound to its file (bufferPathRef) + dirty-tracked, so a flush
  // only ever writes genuinely-edited content back to the correct file.
  const bufferRef = useRef<string>("");
  const bufferPathRef = useRef<string | null>(null);
  const loadedRef = useRef<string>("");
  const dirtyRef = useRef<boolean>(false);
  const uncertainWriteRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The reactive twin of dirtyRef, for the status bar: "unsaved" while an edit sits
  // in the debounce window, "failed" after a flush error — so the bar never claims
  // "All changes published" while the buffer holds the only copy of an edit.
  const [localDirty, setLocalDirty] = useState<LocalDirtyState>("clean");
  // Per-path content hashes the editor last saw (editor-roles plan, KTD8): every save —
  // autosave, unmount flush, delete, rename — carries the path's hash as
  // `If-Draft-File-Hash`, so two editors on one file get a conflict, never a silent
  // overwrite. Refreshed from every draft view (each save response included), EXCEPT for
  // a path with an open conflict: its stale buffer must not become eligible for a
  // follow-up save just because the tracked hash caught up.
  const hashesRef = useRef<Map<string, string>>(new Map());
  const [conflict, setConflict] = useState<DraftConflict | null>(null);
  const conflictRef = useRef<DraftConflict | null>(null);
  conflictRef.current = conflict;
  // Access lost mid-session (editor-roles plan U12 / KTD14): a 404 (removed, demoted,
  // org departure, transferred away) or OWNER_ONLY answer to a save. The server no
  // longer accepts this session's writes, so autosave stops and the buffer is kept on
  // screen — with copy/download — until the editor chooses to leave.
  const [lockedOut, setLockedOut] = useState<LockedOut | null>(null);
  const lockedOutRef = useRef<LockedOut | null>(null);
  lockedOutRef.current = lockedOut;
  /** The save currently in flight, if any (review #6). */
  const flushingRef = useRef<Promise<boolean> | null>(null);
  const copy = useClipboardCopy();

  const selectedFile: DraftFile | undefined = draft?.files.find((f) => f.path === selected);
  const publishedFiles = usePublishedFiles(id, canvas?.currentVersionId, canvas?.url);
  const publishedFile = publishedFiles.data?.files.find((f) => f.path === selected);
  const fileUrl =
    selected && canvas
      ? `${canvas.url.replace(/\/$/, "")}/${selected.split("/").map(encodeURIComponent).join("/")}`
      : null;
  const fileIsLive = canvas?.publicationState === "published" && canvas.status === "active";
  const editable = selectedFile ? isEditableFile(selectedFile) : false;

  // On-page editing is only offered for a single static HTML page (see singleHtmlFile).
  const htmlFiles = draft ? draft.files.filter(isHtmlFile) : [];
  const htmlFile = draft ? singleHtmlFile(draft.files) : null;
  // JS-driven drafts can't run in the sandboxed inline preview (opaque origin → ES
  // modules CORS-blocked, SDK calls unauthenticated), so the preview pane swaps to a
  // "Open full preview" notice; static canvases keep the live inline frame.
  const usesScripts = draft ? draftUsesScripts(draft.files) : false;
  const htmlCount = htmlFiles.length;
  const rootHtmlFile = htmlFiles.find((f) => f.path.toLowerCase() === ROOT_HTML) ?? null;
  // On-page (Page text) editing renders the entry HTML in a sandboxed iframe and edits
  // its visible text inline. For a JS-driven canvas the visible content is mounted by
  // scripts that can't run in the sandbox, so you'd only ever edit the static shell —
  // meaningless. Gate it off alongside the same JS signal the preview uses.
  const onPageAvailable = htmlFile !== null && !usesScripts;
  const onPageHint = usesScripts
    ? "Page-text editing isn't available for canvases that render content with JavaScript — edit the source in Code."
    : htmlCount === 0
      ? "On-page editing needs an HTML page in the draft."
      : `On-page editing works with a single HTML page (this draft has ${htmlCount}).`;

  // Inline duplicate-path detection for the Add / Rename dialogs. A create or a
  // rename onto an existing path would silently destroy that file server-side, so we
  // flag it and disable the action; the server is still authoritative (PATH_EXISTS).
  const existingPaths = new Set(draft?.files.map((f) => f.path) ?? []);
  const indexPathAvailable = !existingPaths.has(ROOT_HTML);
  const addCandidate = normalizeDraftPath(newPath);
  const addDuplicate = addCandidate !== null && existingPaths.has(addCandidate);
  const renameCandidate = normalizeDraftPath(renameTo);
  const renameDuplicate =
    renameCandidate !== null && renameCandidate !== renaming && existingPaths.has(renameCandidate);

  useEffect(() => {
    if (selected === null && draft && draft.files.length > 0) {
      setSelected(draft.files[0]?.path ?? null);
    }
  }, [draft, selected]);

  // Track every file's hash from the server's draft view (the conflicted path is left
  // alone until the editor resolves it — see hashesRef). Called SYNCHRONOUSLY from every
  // mutation response (review #13) — the effect below is only the backstop for reads —
  // so a rename or delete right after a save already carries the post-save hash.
  const trackHashes = (view: DraftView, acknowledgedPath?: string) => {
    const next = new Map<string, string>();
    for (const f of view.files) {
      if (f.hash === undefined) continue;
      if (
        conflictRef.current?.path === f.path ||
        (dirtyRef.current && bufferPathRef.current === f.path && acknowledgedPath !== f.path)
      ) {
        const kept = hashesRef.current.get(f.path);
        if (kept !== undefined) next.set(f.path, kept);
        continue;
      }
      next.set(f.path, f.hash);
    }
    // A background delete is still a concurrent edit. Keep the hash we edited
    // against even when the path is absent, so saving cannot recreate it as new.
    for (const path of [
      conflictRef.current?.path,
      dirtyRef.current ? bufferPathRef.current : null,
    ]) {
      if (!path || path === acknowledgedPath || next.has(path)) continue;
      const kept = hashesRef.current.get(path);
      if (kept !== undefined) next.set(path, kept);
    }
    hashesRef.current = next;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: trackHashes reads refs only
  useEffect(() => {
    if (!draft) return;
    trackHashes(draft);
  }, [draft]);

  // Fall back to code mode if on-page editing stops being available — the draft loses
  // its single HTML page, or it gains JavaScript (on-page can't render JS; see onPageAvailable).
  useEffect(() => {
    if (mode === "onpage" && !onPageAvailable && !dirtyRef.current) {
      setMode("code");
      setPane("code");
    }
  }, [mode, onPageAvailable]);

  // A route exit is now awaited and recoverable. Cleanup only cancels the debounce;
  // it never dispatches an invisible best-effort write after the UI has disappeared.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const content = useQuery({
    queryKey: keys.draftFile(id, selected ?? ""),
    queryFn: () => api.getDraftFile(id, selected as string),
    enabled: selected !== null && editable,
  });

  useEffect(() => {
    if (
      content.data !== undefined &&
      editable &&
      !dirtyRef.current &&
      !conflictRef.current &&
      !lockedOutRef.current
    ) {
      if (bufferPathRef.current === selected && loadedRef.current !== content.data)
        setEditorRevision((revision) => revision + 1);
      loadedRef.current = content.data;
      bufferRef.current = content.data;
      bufferPathRef.current = selected;
      dirtyRef.current = false;
      setLocalDirty("clean");
    }
  }, [content.data, selected, editable]);

  /** Persist the autosave buffer. Returns false when the save failed — callers that
   *  would overwrite the buffer (file switch, surface switch, publish) must abort so
   *  the unsaved edit isn't silently lost. */
  const flush = (): Promise<boolean> => {
    // One save in flight at a time (review #6): a second trigger (autosave timer, Cmd+S,
    // file switch, Publish) waits for the first and then re-reads the dirty flag and
    // the post-save hash instead of racing with a hash captured before the first landed.
    if (flushingRef.current) return flushingRef.current.then(() => flush());
    const run = flushOnce().finally(() => {
      flushingRef.current = null;
    });
    flushingRef.current = run;
    return run;
  };

  const flushOnce = async (): Promise<boolean> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pageTooLargeRef.current) return false;
    if (!dirtyRef.current || bufferPathRef.current === null) return true;
    const path = bufferPathRef.current;
    const body = bufferRef.current;
    // A path with an unresolved conflict never auto-saves — the editor must choose first.
    if (conflictRef.current?.path === path) return false;
    // Once the server has refused this session's role, no further save is attempted.
    if (lockedOutRef.current) return false;
    try {
      uncertainWriteRef.current = true;
      const saved = await save.mutateAsync({
        path,
        content: body,
        expectedHash: hashesRef.current.get(path) ?? "none",
      });
      uncertainWriteRef.current = false;
      trackHashes(saved, path);
      // The buffer may have moved on while the save was in flight — new keystrokes,
      // or a different file entirely. Only touch the dirty state for OUR file, and
      // only mark clean when the buffer still holds exactly what we saved (a stale
      // resolution must never mask a newer unsaved edit).
      if (bufferPathRef.current === path) {
        loadedRef.current = body;
        // Even a revert to the previous loaded text is a newer revision once this
        // request has changed the server. Recompute against the acknowledged body.
        dirtyRef.current = bufferRef.current !== body || pageTooLargeRef.current;
        setLocalDirty(dirtyRef.current ? "unsaved" : "clean");
      }
      setRefreshKey((k) => k + 1);
      return !dirtyRef.current || (await flushOnce());
    } catch (err) {
      // A rejected response does not establish that the server did not commit.
      // Preserve even a revert to the old baseline until a later write is acknowledged.
      if (bufferPathRef.current === path) dirtyRef.current = true;
      if (err instanceof ApiError && err.code === "DRAFT_CONFLICT") {
        // Another editor saved this file first (R17): keep the buffer, show their
        // current content beside it, and let the editor compare before choosing.
        openConflict(path, err);
        return false;
      }
      if (err instanceof ApiError && (err.status === 404 || err.code === "OWNER_ONLY")) {
        // The role behind this session is gone (or the act is the owner's): keep the
        // buffer, stop saving, and say so once — no toast storm on every debounce.
        const refusal = { path, code: err.code, content: bufferRef.current };
        lockedOutRef.current = refusal;
        setLockedOut(refusal);
        setLocalDirty("failed");
        return false;
      }
      setLocalDirty("failed");
      toast(err instanceof ApiError ? err.hint : "Couldn't save", "error");
      return false;
    }
  };

  /** Surface a stale-save refusal: fetch the server's current content for the path so the
   *  editor can compare it with the kept buffer (KTD14 — the buffer is never dropped). */
  function openConflict(path: string, err: ApiError) {
    const d = err.details;
    const next: DraftConflict = {
      path,
      currentHash: typeof d.currentHash === "string" ? d.currentHash : "none",
      updatedByName: typeof d.updatedByName === "string" ? d.updatedByName : null,
      updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : null,
      theirs: null,
    };
    conflictRef.current = next;
    setConflict(next);
    setLocalDirty("conflict");
    loadConflictComparison(next);
  }

  function loadConflictComparison(snapshot: DraftConflict) {
    // Optional comparison must not delay the recovery dialog or discard/export.
    void api
      .getDraftFile(id, snapshot.path, AbortSignal.timeout(15_000))
      .then((theirs) => {
        if (conflictRef.current !== snapshot) return;
        const next = { ...snapshot, theirs };
        conflictRef.current = next;
        setConflict(next);
      })
      .catch(() => {});
  }

  /** Resolve a conflict by adopting the other editor's version: the buffer becomes theirs. */
  function adoptTheirVersion() {
    if (!conflict) return;
    const theirs = conflict.theirs ?? "";
    hashesRef.current.set(conflict.path, conflict.currentHash);
    qc.setQueryData(keys.draftFile(id, conflict.path), theirs);
    if (bufferPathRef.current === conflict.path) {
      bufferRef.current = theirs;
      loadedRef.current = theirs;
      dirtyRef.current = false;
      uncertainWriteRef.current = false;
      setLocalDirty("clean");
    }
    conflictRef.current = null;
    setConflict(null);
    setMode("code");
    setPane("code");
    setEditorRevision((revision) => revision + 1);
    setRefreshKey((k) => k + 1);
  }

  /** Resolve a conflict by re-saving the kept buffer over their version — an explicit
   *  choice, pinned to the hash they wrote so a THIRD change is still caught. */
  async function overwriteWithMine() {
    if (!conflict) return;
    hashesRef.current.set(conflict.path, conflict.currentHash);
    conflictRef.current = null;
    setConflict(null);
    if (bufferPathRef.current === conflict.path) {
      dirtyRef.current = true;
      setLocalDirty("unsaved");
      await flush();
    }
  }

  const onEditorChange = (next: string) => {
    if (bufferPathRef.current !== selected || lockedOutRef.current) return;
    bufferRef.current = next;
    dirtyRef.current = next !== loadedRef.current || uncertainWriteRef.current;
    setLocalDirty(dirtyRef.current ? "unsaved" : "clean");
    if (timerRef.current) clearTimeout(timerRef.current);
    if (dirtyRef.current) timerRef.current = setTimeout(() => void flush(), AUTOSAVE_MS);
  };

  const selectFile = async (path: string) => {
    if (path === selected) return;
    // A failed flush keeps the unsaved edit in the buffer; switching files would
    // overwrite the buffer with the next file's content and lose it for good.
    if (!(await flush())) return;
    setSelected(path);
    setPane("code");
    setMode("code");
  };

  async function uploadFiles(files: File[]) {
    if (files.length === 0 || !(await flush())) return;
    const paths = canvasRelativePaths(files);
    // Each upload carries the hash we last saw for its path (review #2): a new path has
    // none; an existing one is replaced only against the version we loaded.
    const items = files.map((file, i) => {
      const path = paths[i] as string;
      return { path, file, expectedHash: hashesRef.current.get(path) };
    });
    try {
      await uploadMany.mutateAsync(items);
      setSelected(items[items.length - 1]?.path ?? selected);
      setRefreshKey((k) => k + 1);
      toast(`Uploaded ${files.length} ${files.length === 1 ? "file" : "files"}`);
    } catch (err) {
      if (!(await refuseIfLockedOut(err))) toast(uploadErrorHint(err), "error");
    }
  }

  /** A binary write has no text buffer to compare, so a stale-save refusal is explained
   *  (who saved, when) and the draft is refreshed so the next attempt carries the current
   *  hash — never retried blindly, never silently overwriting (KTD14). */
  function uploadErrorHint(err: unknown): string {
    if (err instanceof ApiError && err.code === "DRAFT_CONFLICT") {
      void qc.invalidateQueries({ queryKey: keys.draft(id) });
      const who = typeof err.details.updatedByName === "string" ? err.details.updatedByName : null;
      return `${who ?? "Someone else"} changed this file since you loaded it — the draft was refreshed; check it and upload again.`;
    }
    return err instanceof ApiError ? err.hint : "Couldn't upload";
  }

  /** A 404 / OWNER_ONLY on any write means this session lost its role: show the
   *  blocking notice (keeping the buffer) instead of a one-off toast. */
  async function refuseIfLockedOut(err: unknown): Promise<boolean> {
    if (err instanceof ApiError && (err.status === 404 || err.code === "OWNER_ONLY")) {
      setLockedOut({
        path: bufferPathRef.current ?? selected ?? "",
        code: err.code,
        content: bufferRef.current,
      });
      setLocalDirty("failed");
      return true;
    }
    return false;
  }

  const dropzone = useDropzone({
    noClick: true,
    // A clipboard file should not become a draft upload merely because the file
    // rail has focus. Keep the existing drop/picker interactions after v19.
    noPaste: true,
    onDrop: (a) => void uploadFiles(a),
  });

  async function onReplaceChosen(file: File) {
    if (!selected) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    try {
      // Wait for any in-flight save of this path so the replace pins the post-save hash.
      await flushingRef.current;
      const view = await upload.mutateAsync({
        path: selected,
        file,
        expectedHash: hashesRef.current.get(selected) ?? "none",
      });
      trackHashes(view);
      loadedRef.current = "";
      dirtyRef.current = false;
      uncertainWriteRef.current = false;
      setLocalDirty("clean"); // the replaced bytes ARE the saved state
      await content.refetch();
      setRefreshKey((k) => k + 1);
      toast("File replaced");
    } catch (err) {
      if (!(await refuseIfLockedOut(err))) toast(uploadErrorHint(err), "error");
    }
  }

  async function addFile() {
    const path = newPath.trim();
    if (!path || addDuplicate || !(await flush())) return;
    try {
      await create.mutateAsync(path);
      setAddOpen(false);
      setNewPath("");
      setSelected(normalizeDraftPath(path) ?? path);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't add the file", "error");
    }
  }

  async function addIndexFile() {
    if (!indexPathAvailable) {
      setAddOpen(true);
      setNewPath(ROOT_HTML);
      return;
    }
    if (!(await flush())) return;
    try {
      await create.mutateAsync(ROOT_HTML);
      setSelected(ROOT_HTML);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't add index.html", "error");
    }
  }

  /** Keep a pending autosave from resurrecting a just-renamed file at its old path:
   *  persist the buffer first, then retarget it to the new path after the rename
   *  (covers a failed flush leaving `dirtyRef` set — the mirror of the delete guard). */
  async function guardedRename(from: string, to: string): Promise<void> {
    if (!(await flush())) throw new Error("Save or recover your edits before renaming.");
    const view = await rename.mutateAsync({
      from,
      to,
      expectedHash: hashesRef.current.get(from),
    });
    trackHashes(view);
    if (bufferPathRef.current === from) bufferPathRef.current = to;
  }

  async function renameFileToIndex(path: string) {
    if (!indexPathAvailable || path === ROOT_HTML) return;
    try {
      await guardedRename(path, ROOT_HTML);
      if (selected === path) setSelected(ROOT_HTML);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't rename to index.html", "error");
    }
  }

  async function confirmRename() {
    if (!renaming) return;
    const to = renameTo.trim();
    if (!to || to === renaming) return setRenaming(null);
    if (renameDuplicate) return;
    try {
      await guardedRename(renaming, normalizeDraftPath(to) ?? to);
      if (selected === renaming) setSelected(normalizeDraftPath(to) ?? to);
      setRenaming(null);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't rename", "error");
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    // Preserve the buffer until deletion is acknowledged; a failed DELETE must not
    // mark unsaved text clean or let navigation discard it.
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    try {
      // A save of this very path may still be in flight; let it settle so the delete is
      // pinned to the hash the server actually holds (review #13).
      await flushingRef.current;
      const next = await del.mutateAsync({
        path: deleting,
        expectedHash: hashesRef.current.get(deleting),
      });
      trackHashes(next);
      if (bufferPathRef.current === deleting) {
        dirtyRef.current = false;
        uncertainWriteRef.current = false;
        bufferPathRef.current = null;
        setLocalDirty("clean");
      }
      if (selected === deleting) setSelected(next.files[0]?.path ?? null);
      setDeleting(null);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't delete", "error");
    }
  }

  async function enterOnPage() {
    if (!htmlFile || !onPageAvailable) return;
    // Persist any pending code edit before switching surfaces; abort on failure so
    // the on-page seeding doesn't overwrite the unsaved buffer.
    if (!(await flush())) return;
    setSelected(htmlFile.path);
    setOnPagePath(htmlFile.path);
    setMode("onpage");
    setPane("onpage");
  }

  function onPageSave(html: string) {
    if (!onPagePath) return;
    pageTooLargeRef.current = false;
    setPageTooLarge(false);
    // Same buffer and debounce as Code, including failure, conflict and route exit.
    bufferPathRef.current = onPagePath;
    bufferRef.current = html;
    dirtyRef.current = html !== loadedRef.current || uncertainWriteRef.current;
    if (lockedOutRef.current) {
      const refusal = { ...lockedOutRef.current, content: html };
      lockedOutRef.current = refusal;
      setLockedOut(refusal);
      setLocalDirty("failed");
      return;
    }
    setLocalDirty(conflictRef.current ? "conflict" : dirtyRef.current ? "unsaved" : "clean");
    if (timerRef.current) clearTimeout(timerRef.current);
    if (dirtyRef.current && !conflictRef.current)
      timerRef.current = setTimeout(() => void flush(), AUTOSAVE_MS);
  }

  const blocker = useUnsavedChanges({
    dirty: localDirty !== "clean" || save.isPending,
    saveBeforeLeave: flush,
  });
  useEffect(() => {
    // Recovery must be visible above the preview, and cancelling the pending
    // navigation should return to the editable workspace rather than reopen it.
    if (blocker.status === "blocked") setPreviewFullscreen(false);
  }, [blocker.status]);
  function discardBuffer() {
    if (timerRef.current) clearTimeout(timerRef.current);
    pageTooLargeRef.current = false;
    setPageTooLarge(false);
    dirtyRef.current = false;
    uncertainWriteRef.current = false;
    bufferRef.current = loadedRef.current;
    conflictRef.current = null;
    lockedOutRef.current = null;
    setConflict(null);
    setLockedOut(null);
    setLocalDirty("clean");
  }

  async function onPublish() {
    if (preparingReviewRef.current) return;
    preparingReviewRef.current = true;
    setPreparingReview(true);
    try {
      // Review only the saved draft; a failed/conflicted save keeps the buffer here.
      if (await flush()) setReviewCanvasId(id);
    } finally {
      preparingReviewRef.current = false;
      setPreparingReview(false);
    }
  }

  // The one publishable gate, shared by the Publish button and the ⌘↵ shortcut so
  // they can never diverge. Local buffer dirtiness counts: an edit inside the
  // debounce window (or one whose save failed) is publishable — onPublish flushes
  // the buffer first.
  const canPublish =
    !!draft && draft.files.length > 0 && (draft.dirty || draft.stale || localDirty !== "clean");

  // ⌘↵ / Ctrl+Enter opens publish review — the keyboard mirror of the button.
  // Scoped to the editor by this route's mount lifetime (mirrors the editor-local ⌘S
  // in CodeEditor). Reads the publish gate via a ref so the listener stays mounted
  // once and never goes stale; a no-op when the draft isn't publishable or a publish
  // is already in flight.
  const publishShortcutRef = useRef<() => void>(() => {});
  publishShortcutRef.current = () => {
    if (!draft || preparingReviewRef.current || reviewCanvasId === id || !canPublish) return;
    void onPublish();
  };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        // A dialog owns the keyboard while open (Add file / Rename / Delete) —
        // publishing the draft from inside one would be a surprise.
        if (document.querySelector('[role="dialog"]')) return;
        e.preventDefault();
        publishShortcutRef.current();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (canvas && canvas.status !== "active" && localDirty === "clean") {
    return (
      <TabEmptyState
        title="Editing is paused"
        description={
          canvas.status === "disabled"
            ? "An administrator disabled this canvas, so it's read-only. Editing and publishing are turned off until it's restored."
            : "Unarchive this canvas to edit and publish its draft."
        }
      />
    );
  }
  if (isLoading) {
    return (
      <TabContentFrame>
        <Skeleton className="h-64" />
      </TabContentFrame>
    );
  }
  if (!draft) {
    return <ReadError title="Couldn’t load the editor" onRetry={() => void refetchDraft()} />;
  }

  const body =
    selected === null || !selectedFile ? (
      <EmptyState title="No file selected" description="Pick a file, or add one to start." />
    ) : !editable ? (
      <NonEditableFileView
        canvasId={id}
        file={selectedFile}
        reason={nonEditableReason(selectedFile)}
        refreshKey={refreshKey}
        onReplace={() => replaceInputRef.current?.click()}
      />
    ) : content.isLoading ? (
      <Skeleton className="h-full" />
    ) : content.isError && !dirtyRef.current ? (
      <EmptyState
        title="Couldn’t load this file"
        description={
          content.error instanceof ApiError
            ? content.error.hint
            : "The file’s contents couldn’t be read. If this canvas was deployed before the editor existed, re-deploy it."
        }
        action={
          <Button size="sm" variant="secondary" onClick={() => void content.refetch()}>
            Retry file
          </Button>
        }
      />
    ) : (
      <CodeEditor
        key={`${selected}:${editorRevision}`}
        readOnly={!!lockedOut || canvas?.status !== "active"}
        path={selected}
        value={bufferPathRef.current === selected ? bufferRef.current : (content.data ?? "")}
        onChange={onEditorChange}
        onSave={() => void flush()}
      />
    );

  const workspaceHeight = "h-[calc(100dvh-16rem)] min-h-[26rem]";
  const paneVisible = (target: EditorPane) => pane === target;
  const selectedIsHtml = selectedFile ? isHtmlFile(selectedFile) : false;
  const draftRepairNotice =
    htmlCount === 0 ? (
      <DraftRepairNotice
        title="No HTML page in this draft"
        description="Add an index.html file so the canvas has a root page to publish."
        action={
          <Button
            size="sm"
            variant="secondary"
            loading={create.isPending}
            onClick={() => void addIndexFile()}
          >
            Add index.html
          </Button>
        }
      />
    ) : rootHtmlFile === null && htmlCount === 1 && htmlFile ? (
      <DraftRepairNotice
        title="Home page is inferred"
        description={`${htmlFile.path} can publish as the only HTML page, but renaming it to index.html makes the canvas root explicit.`}
        action={
          indexPathAvailable ? (
            <Button
              size="sm"
              variant="secondary"
              loading={rename.isPending}
              onClick={() => void renameFileToIndex(htmlFile.path)}
            >
              Rename to index.html
            </Button>
          ) : undefined
        }
      />
    ) : rootHtmlFile === null && htmlCount > 1 ? (
      <DraftRepairNotice
        title="Choose the root page"
        description={
          selectedIsHtml
            ? "Multiple HTML files need an index.html. Rename the selected page if it should load at the canvas root."
            : "Multiple HTML files need an index.html. Select the intended home page, then rename it."
        }
        action={
          selected && selectedIsHtml && indexPathAvailable ? (
            <Button
              size="sm"
              variant="secondary"
              loading={rename.isPending}
              onClick={() => void renameFileToIndex(selected)}
            >
              Rename selected
            </Button>
          ) : undefined
        }
      />
    ) : null;

  const changePane = async (next: EditorPane) => {
    if (mode === "onpage" && !(await flush())) return;
    if (next === "preview") setPreviewVisible(true);
    if (next === "code" || next === "preview") setMode("code");
    setPane(next);
  };

  const fileRail = (
    <WorkspacePane
      {...dropzone.getRootProps({
        className: cn(
          "flex-col transition-colors",
          "h-full min-w-0",
          paneVisible("files") ? "flex" : "hidden",
          "@[44rem]/editor:flex",
          dropzone.isDragActive && "bg-accent-subtle ring-2 ring-accent ring-inset",
        ),
      })}
    >
      <input {...dropzone.getInputProps()} />
      <PaneHeader
        title="Files"
        description={`${draft.files.length} in draft`}
        actions={
          <>
            <IconButton label="Add file" onClick={() => setAddOpen(true)}>
              <Plus size={15} weight="bold" aria-hidden />
            </IconButton>
            <IconButton
              label="Upload files"
              onClick={dropzone.open}
              disabled={uploadMany.isPending}
            >
              <UploadSimple size={15} weight="bold" aria-hidden />
            </IconButton>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
        {dropzone.isDragActive ? (
          <p className="rounded-lg border border-dashed border-accent/50 px-2 py-12 text-center text-xs font-medium text-accent">
            Drop files to upload
          </p>
        ) : (
          <FileTree files={draft.files} selected={selected} onSelect={selectFile} />
        )}
      </div>
      <input
        ref={replaceInputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onReplaceChosen(file);
          e.target.value = "";
        }}
      />
    </WorkspacePane>
  );

  const fileLinkMenu = fileUrl ? (
    <ActionMenu label="File link" icon={<LinkSimple size={15} weight="bold" aria-hidden />}>
      <div className="w-72 max-w-[calc(100vw-2rem)] space-y-1 border-b border-border px-2 py-2">
        <p className="break-all font-mono text-xs text-fg">{fileUrl}</p>
        <p className="text-xs text-muted">
          {!fileIsLive
            ? "Canvas is offline"
            : publishedFiles.isError
              ? "Published status unavailable"
              : publishedFiles.isPending
                ? "Checking published file…"
                : !publishedFile
                  ? "Not published yet"
                  : publishedFile.hash !== selectedFile?.hash || localDirty !== "clean"
                    ? "Draft differs from published file"
                    : "Published file"}
        </p>
      </div>
      <ActionMenuItem onSelect={() => copy(fileUrl, "File URL copied")}>Copy URL</ActionMenuItem>
      {fileIsLive && publishedFile && !publishedFiles.isError && (
        <ActionMenuItem
          href={publishedFile.url}
          target="_blank"
          rel="noreferrer"
          icon={<ArrowSquareOut size={15} aria-hidden />}
        >
          Open published file
        </ActionMenuItem>
      )}
    </ActionMenu>
  ) : null;

  const selectedActions =
    selected && selectedFile ? (
      <div className="flex items-center gap-1">
        <ActionMenu label="File actions">
          <ActionMenuItem
            onSelect={() => {
              const anchor = document.createElement("a");
              anchor.href = rawUrl(id, selected);
              anchor.download = baseName(selected);
              anchor.click();
            }}
          >
            Download file
          </ActionMenuItem>
          <ActionMenuItem onSelect={() => replaceInputRef.current?.click()}>
            Replace file
          </ActionMenuItem>
          <ActionMenuItem
            onSelect={() => {
              setRenaming(selected);
              setRenameTo(selected);
            }}
          >
            Rename file
          </ActionMenuItem>
          <ActionMenuItem onSelect={() => setDeleting(selected)}>Delete file</ActionMenuItem>
        </ActionMenu>
        {fileLinkMenu}
      </div>
    ) : null;

  const editorPane =
    mode === "code" ? (
      <WorkspacePane
        className={cn(
          "flex-col",
          "h-full min-w-0",
          paneVisible("code") ? "flex" : "hidden",
          pane === "preview" && previewVisible
            ? "@[44rem]/editor:hidden @[68rem]/editor:flex"
            : "@[44rem]/editor:flex",
        )}
      >
        <PaneHeader
          title={
            <span className="block whitespace-normal break-all font-mono">
              {selected ?? "No file selected"}
            </span>
          }
          description={editable ? "Autosaves to draft" : "Asset preview"}
          actions={
            <>
              {selectedActions}
              {!previewVisible && (
                <IconButton
                  label="Show preview"
                  onClick={() => {
                    setPreviewVisible(true);
                    setPane("preview");
                  }}
                >
                  <Eye size={15} weight="bold" aria-hidden />
                </IconButton>
              )}
            </>
          }
        />
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{body}</div>
      </WorkspacePane>
    ) : null;

  const previewPane =
    mode === "code" && previewVisible ? (
      <section
        className={cn(
          "min-h-0 h-full min-w-0",
          paneVisible("preview") ? "block" : "hidden",
          paneVisible("preview") ? "@[44rem]/editor:block" : "@[68rem]/editor:block",
        )}
      >
        <DraftPreview
          canvasId={id}
          refreshKey={refreshKey}
          onRefresh={() => setRefreshKey((k) => k + 1)}
          fullscreen={false}
          onToggleFullscreen={() => setPreviewFullscreen(true)}
          onHide={() => {
            setPreviewVisible(false);
            setPane("code");
          }}
          usesScripts={usesScripts}
        />
      </section>
    ) : null;

  const onPagePane =
    mode === "onpage" && onPagePath ? (
      <section
        className={cn(
          "min-h-0 h-full min-w-0",
          paneVisible("onpage") ? "block" : "hidden",
          "@[44rem]/editor:block",
        )}
      >
        <OnPageEditor
          canvasId={id}
          htmlPath={onPagePath}
          saving={save.isPending}
          onSave={onPageSave}
          onTooLarge={() => {
            pageTooLargeRef.current = true;
            setPageTooLarge(true);
            dirtyRef.current = true;
            setLocalDirty("failed");
            if (timerRef.current) clearTimeout(timerRef.current);
          }}
        />
      </section>
    ) : null;

  return (
    <TabContentFrame className="@container/editor min-w-0 space-y-3">
      {isError && (
        <ReadError title="Couldn't refresh the draft" onRetry={() => void refetchDraft()}>
          Your last loaded files and local edits remain here. Retry to check the current draft.
        </ReadError>
      )}
      {draftRepairNotice}
      {lockedOut && (
        <section
          className="border border-danger/30 bg-danger-subtle/40 px-4 py-3"
          data-testid="editor-locked-out"
          role="alert"
        >
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-fg">
              {lockedOut.code === "OWNER_ONLY"
                ? "Only the owner can do that"
                : "You no longer have edit access to this canvas"}
            </h2>
            <p className="max-w-3xl text-xs leading-relaxed text-muted">
              {lockedOut.code === "OWNER_ONLY"
                ? "The server refused that change because it is reserved for the canvas owner."
                : "Your access was changed while you were editing — the server no longer accepts saves from this session."}{" "}
              Your unsaved edits to {lockedOut.path} are kept here until you leave: copy or download
              them now.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => copy(lockedOut.content, "Copied your edits")}
              >
                Copy my edits
              </Button>
              <a
                href={`data:text/plain;charset=utf-8,${encodeURIComponent(lockedOut.content)}`}
                download={baseName(lockedOut.path)}
                className="inline-flex h-8 items-center rounded-md border border-border bg-surface px-3 text-xs font-medium text-fg hover:bg-surface-raised"
              >
                Download my edits
              </a>
              <Link
                to="/"
                className="text-xs font-medium text-accent underline-offset-2 hover:underline"
              >
                Back to your canvases
              </Link>
            </div>
          </div>
        </section>
      )}
      {conflict && (
        <section
          className="border border-danger/30 bg-danger-subtle/40 px-4 py-3"
          data-testid="draft-conflict"
          role="alert"
        >
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-fg">
              Someone else saved {conflict.path} first
            </h2>
            <p className="max-w-3xl text-xs leading-relaxed text-muted">
              {conflict.updatedByName ?? "Another editor"} saved changes to this file{" "}
              {conflict.updatedAt ? relativeTime(conflict.updatedAt) : "just now"}. Your unsaved
              edits are kept in the editor — compare them with the saved version below, then choose.
            </p>
            {conflict.theirs !== null && (
              <pre className="max-h-48 overflow-auto rounded-lg border border-border bg-surface p-2 font-mono text-xs text-fg">
                <code>{conflict.theirs}</code>
              </pre>
            )}
            <div className="flex flex-wrap gap-2">
              {conflict.theirs === null && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => loadConflictComparison(conflict)}
                >
                  Retry comparison
                </Button>
              )}
              <Button
                size="sm"
                variant="secondary"
                disabled={conflict.theirs === null}
                onClick={adoptTheirVersion}
              >
                Use their version
              </Button>
              <Button size="sm" variant="danger" onClick={() => void overwriteWithMine()}>
                Overwrite with mine
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => copy(bufferRef.current, "Copied your version")}
              >
                Copy my version
              </Button>
            </div>
          </div>
        </section>
      )}
      <PublishBar
        dirty={draft.dirty}
        stale={draft.stale}
        localDirty={localDirty}
        saving={save.isPending}
        publishing={preparingReview}
        canPublish={canPublish}
        hasFiles={draft.files.length > 0}
        hasPublishedVersion={!!canvas?.currentVersionId}
        selectedPath={selected}
        surface={mode}
        pane={pane}
        onPaneChange={changePane}
        onCodeMode={async () => {
          if (!(await flush())) return;
          setMode("code");
          setPane("code");
        }}
        onOnPageMode={() => void enterOnPage()}
        onPageAvailable={onPageAvailable}
        onPageHint={onPageHint}
        previewAvailable
        onPublish={onPublish}
      />
      {pageTooLarge && (
        <p role="alert" className="text-sm text-danger">
          This page exceeds the 2 MB Page text limit. The latest text is still in the page below but
          cannot be saved or exported here. Shorten it or copy the text before leaving. A smaller
          page will save normally.
        </p>
      )}
      {localDirty === "failed" && !lockedOut && !pageTooLarge && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger">
          <span>Your edits are still here. Save them before leaving.</span>
          <Button
            size="sm"
            variant="secondary"
            loading={save.isPending}
            onClick={() => void flush()}
          >
            Retry save
          </Button>
          <a
            href={`data:text/plain;charset=utf-8,${encodeURIComponent(bufferRef.current)}`}
            download={baseName(bufferPathRef.current ?? "draft.html")}
            className="underline"
          >
            Download my edits
          </a>
        </div>
      )}
      <Dialog
        open={blocker.status === "blocked"}
        onClose={() => blocker.reset?.()}
        title="Your edits haven’t been saved"
      >
        <p className="text-sm text-muted">
          {pageTooLarge
            ? "Return to Page text and shorten or copy the oversized content. The source download cannot include this edit. "
            : "Stay here to resolve the save or export your current file. "}
          Leaving without saving discards the unsaved changes to{" "}
          <code>{bufferPathRef.current}</code>.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => blocker.reset?.()}>
            Keep editing
          </Button>
          {!pageTooLarge && (
            <a
              className="inline-flex min-h-10 items-center px-3 text-sm text-accent underline"
              href={`data:text/plain;charset=utf-8,${encodeURIComponent(bufferRef.current)}`}
              download={baseName(bufferPathRef.current ?? "draft.html")}
            >
              Download my edits
            </a>
          )}

          {!conflict && !lockedOut && !pageTooLarge && (
            <Button
              loading={save.isPending}
              onClick={async () => {
                if (await flush()) blocker.proceed?.();
              }}
            >
              Retry save and leave
            </Button>
          )}
          <Button
            variant="danger"
            disabled={save.isPending}
            onClick={() => {
              discardBuffer();
              blocker.proceed?.();
            }}
          >
            Discard edits and leave
          </Button>
        </div>
      </Dialog>
      {reviewCanvasId === id && (
        <PublishReviewDialog canvasId={id} onClose={() => setReviewCanvasId(null)} />
      )}

      <div
        className={cn(
          "grid min-w-0 gap-3",
          workspaceHeight,
          mode === "onpage"
            ? "@[44rem]/editor:grid-cols-[minmax(10rem,14rem)_minmax(0,1fr)]"
            : previewVisible
              ? "@[44rem]/editor:grid-cols-[minmax(10rem,14rem)_minmax(0,1fr)] @[68rem]/editor:grid-cols-[minmax(10rem,14rem)_minmax(0,1.1fr)_minmax(0,1fr)]"
              : "@[44rem]/editor:grid-cols-[minmax(10rem,14rem)_minmax(0,1fr)]",
        )}
      >
        {fileRail}
        {editorPane}
        {previewPane}
        {onPagePane}
      </div>

      {/* IDE-style status footer — revealed only by the workshop/canvas skins (CSS-gated). */}
      <EditorStatusBar path={selected} fileCount={draft.files.length} />

      {/* Full-screen preview overlay */}
      {previewFullscreen && blocker.status !== "blocked" && (
        <DraftPreview
          canvasId={id}
          refreshKey={refreshKey}
          onRefresh={() => setRefreshKey((k) => k + 1)}
          fullscreen
          onToggleFullscreen={() => setPreviewFullscreen(false)}
        />
      )}

      {/* Add file */}
      <Dialog open={addOpen} onClose={() => setAddOpen(false)} title="Add a file">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void addFile();
          }}
          className="space-y-4"
        >
          <Field
            label="File path"
            placeholder="e.g. styles/main.css"
            mono
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            data-autofocus
          />
          {addDuplicate ? (
            <p className="text-xs text-danger">
              A file already exists at that path — pick a different name.
            </p>
          ) : (
            <p className="text-xs text-subtle">
              Creates an empty text file. To add an image or other asset, use Upload.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              type="submit"
              loading={create.isPending}
              disabled={!newPath.trim() || addDuplicate}
            >
              Add file
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Rename */}
      <Dialog open={renaming !== null} onClose={() => setRenaming(null)} title="Rename file">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void confirmRename();
          }}
          className="space-y-4"
        >
          <Field
            label="New path"
            mono
            value={renameTo}
            onChange={(e) => setRenameTo(e.target.value)}
            data-autofocus
          />
          {renameDuplicate && (
            <p className="text-xs text-danger">
              A file already exists at that path — pick a different name.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              type="submit"
              loading={rename.isPending}
              disabled={renameDuplicate || !renameTo.trim()}
            >
              Rename
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Delete */}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        title={`Delete ${deleting ?? ""}?`}
        actionLabel="Delete"
        destructive
        loading={del.isPending}
      >
        This removes the file from the draft. It won’t affect the live version until you publish.
      </ConfirmDialog>
    </TabContentFrame>
  );
}
