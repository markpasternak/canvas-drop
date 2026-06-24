import {
  DownloadSimple,
  Eye,
  PencilSimple,
  Plus,
  Trash,
  UploadSimple,
} from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
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
import { IconButton, IconLink } from "../components/IconButton.js";
import { NonEditableFileView } from "../components/NonEditableFileView.js";
import { OnPageEditor } from "../components/OnPageEditor.js";
import { type EditorPane, PublishBar } from "../components/PublishBar.js";
import { Skeleton } from "../components/Skeleton.js";
import { PaneHeader, WorkspacePane } from "../components/Surface.js";
import { useToast } from "../components/Toast.js";
import { ApiError, api, type DraftFile, type DraftView } from "../lib/api.js";
import { cn } from "../lib/cn.js";
import {
  draftUsesScripts,
  isEditableFile,
  isHtmlFile,
  nonEditableReason,
  normalizeDraftPath,
  singleHtmlFile,
} from "../lib/file-kind.js";
import {
  useCreateDraftFile,
  useDeleteDraftFile,
  usePublishDraft,
  useRenameDraftFile,
  useSaveDraftFile,
  useUploadDraftFile,
  useUploadDraftFiles,
} from "../lib/mutations.js";
import { keys, useCanvas, useDraft } from "../lib/queries.js";

const AUTOSAVE_MS = 700;
const ROOT_HTML = "index.html";

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const rawUrl = (id: string, path: string) =>
  `/api/canvases/${id}/draft/file?path=${encodeURIComponent(path)}`;

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
  const { data: canvas } = useCanvas(id);
  const { data: draft, isLoading, isError } = useDraft(id);
  const [selected, setSelected] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [mode, setMode] = useState<"code" | "onpage">("code");
  const [pane, setPane] = useState<EditorPane>("code");
  const [previewVisible, setPreviewVisible] = useState(true);
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
  const publish = usePublishDraft(id);
  const toast = useToast();
  const qc = useQueryClient();
  const replaceInputRef = useRef<HTMLInputElement>(null);

  // Autosave buffer is bound to its file (bufferPathRef) + dirty-tracked, so a flush
  // only ever writes genuinely-edited content back to the correct file.
  const bufferRef = useRef<string>("");
  const bufferPathRef = useRef<string | null>(null);
  const loadedRef = useRef<string>("");
  const dirtyRef = useRef<boolean>(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The draft fork-point the current buffer is based on. Sent as the unmount-flush
  // precondition (If-Draft-Base) so a stale flush landing after a restore is rejected.
  const baseVersionRef = useRef<string | null>(null);

  const selectedFile: DraftFile | undefined = draft?.files.find((f) => f.path === selected);
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

  // Keep the buffer's fork-point in sync with the draft so the unmount flush can pin it.
  useEffect(() => {
    baseVersionRef.current = draft?.baseVersionId ?? null;
  }, [draft?.baseVersionId]);

  // Fall back to code mode if on-page editing stops being available — the draft loses
  // its single HTML page, or it gains JavaScript (on-page can't render JS; see onPageAvailable).
  useEffect(() => {
    if (mode === "onpage" && !onPageAvailable) {
      setMode("code");
      setPane("code");
    }
  }, [mode, onPageAvailable]);

  // On unmount (tab switch / navigation), persist any edit still inside the autosave
  // debounce window — clearing the timer alone would silently drop it. Write directly
  // (not via the react-query mutation, whose observer is torn down on unmount) so the
  // PUT survives the component going away; the draft refetches fresh on remount.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (dirtyRef.current && bufferPathRef.current !== null) {
        const path = bufferPathRef.current;
        const body = bufferRef.current;
        const expectedBaseVersionId = baseVersionRef.current;
        dirtyRef.current = false;
        // Surface the in-flight edit to other draft consumers (the Versions tab's restore
        // confirm-gate reads `draft.dirty`) so a restore can't bypass confirmation while
        // this flush is still settling. Reconciled to server-authoritative dirty on settle.
        qc.setQueryData<DraftView>(keys.draft(id), (d) => (d ? { ...d, dirty: true } : d));
        // Bound the best-effort flush and pin its fork-point: a slow/unreachable server on
        // navigation must not leave the PUT pending, and a flush that lands after a restore
        // is rejected (409 DRAFT_CONFLICT) instead of clobbering the restored file. Warn
        // instead of swallowing silently so a dropped exit-save is diagnosable.
        void api
          .putDraftFile(id, path, body, {
            signal: AbortSignal.timeout(5000),
            expectedBaseVersionId,
          })
          .catch((err) => {
            console.warn(`canvas-drop: failed to flush pending edit to ${path} on exit`, err);
          })
          .finally(() => {
            void qc.invalidateQueries({ queryKey: keys.draft(id) });
          });
      }
    };
  }, [id, qc]);

  const content = useQuery({
    queryKey: ["draft-file", id, selected],
    queryFn: () => api.getDraftFile(id, selected as string),
    enabled: selected !== null && editable,
  });

  useEffect(() => {
    if (content.data !== undefined && editable) {
      loadedRef.current = content.data;
      bufferRef.current = content.data;
      bufferPathRef.current = selected;
      dirtyRef.current = false;
    }
  }, [content.data, selected, editable]);

  const flush = async (): Promise<void> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!dirtyRef.current || bufferPathRef.current === null) return;
    const path = bufferPathRef.current;
    const body = bufferRef.current;
    try {
      await save.mutateAsync({ path, content: body });
      loadedRef.current = body;
      dirtyRef.current = false;
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't save", "error");
    }
  };

  const onEditorChange = (next: string) => {
    if (bufferPathRef.current !== selected) return;
    bufferRef.current = next;
    dirtyRef.current = next !== loadedRef.current;
    if (timerRef.current) clearTimeout(timerRef.current);
    if (dirtyRef.current) timerRef.current = setTimeout(() => void flush(), AUTOSAVE_MS);
  };

  const selectFile = async (path: string) => {
    if (path === selected) return;
    await flush();
    setSelected(path);
    setPane("code");
    setMode("code");
  };

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    const paths = canvasRelativePaths(files);
    const items = files.map((file, i) => ({ path: paths[i] as string, file }));
    try {
      await uploadMany.mutateAsync(items);
      setSelected(items[items.length - 1]?.path ?? selected);
      setRefreshKey((k) => k + 1);
      toast(`Uploaded ${files.length} ${files.length === 1 ? "file" : "files"}`);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't upload", "error");
    }
  }

  const dropzone = useDropzone({ noClick: true, onDrop: (a) => void uploadFiles(a) });

  async function onReplaceChosen(file: File) {
    if (!selected) return;
    try {
      await upload.mutateAsync({ path: selected, file });
      loadedRef.current = "";
      dirtyRef.current = false;
      await content.refetch();
      setRefreshKey((k) => k + 1);
      toast("File replaced");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't replace the file", "error");
    }
  }

  async function addFile() {
    const path = newPath.trim();
    if (!path || addDuplicate) return;
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
    try {
      await create.mutateAsync(ROOT_HTML);
      setSelected(ROOT_HTML);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't add index.html", "error");
    }
  }

  async function renameFileToIndex(path: string) {
    if (!indexPathAvailable || path === ROOT_HTML) return;
    try {
      await rename.mutateAsync({ from: path, to: ROOT_HTML });
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
      await rename.mutateAsync({ from: renaming, to });
      if (selected === renaming) setSelected(normalizeDraftPath(to) ?? to);
      setRenaming(null);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't rename", "error");
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    // Clear any pending autosave for the file being deleted FIRST. Otherwise an
    // in-window edit (debounce timer pending, or the unmount-flush) would re-PUT the
    // buffer and resurrect the file the user just deleted.
    if (bufferPathRef.current === deleting) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      dirtyRef.current = false;
      bufferPathRef.current = null;
    }
    try {
      const next = await del.mutateAsync(deleting);
      if (selected === deleting) setSelected(next.files[0]?.path ?? null);
      setDeleting(null);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't delete", "error");
    }
  }

  async function enterOnPage() {
    if (!htmlFile || !onPageAvailable) return;
    await flush(); // persist any pending code edit before switching surfaces
    setSelected(htmlFile.path);
    setMode("onpage");
    setPane("onpage");
  }

  async function onPageSave(html: string) {
    if (!htmlFile) return;
    try {
      await save.mutateAsync({ path: htmlFile.path, content: html });
      // The HTML file changed underneath the Code editor — invalidate its content
      // query so switching back to Code shows the on-page edits (not a stale buffer
      // that would otherwise overwrite them on the next code edit).
      qc.invalidateQueries({ queryKey: ["draft-file", id, htmlFile.path] });
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't save", "error");
    }
  }

  async function onPublish() {
    await flush();
    try {
      const result = await publish.mutateAsync();
      toast(`Published version ${result.version}`);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't publish", "error");
    }
  }

  // ⌘↵ / Ctrl+Enter publishes the draft — the keyboard mirror of the Publish button.
  // Scoped to the editor by this route's mount lifetime (mirrors the editor-local ⌘S
  // in CodeEditor). Reads the publish gate via a ref so the listener stays mounted
  // once and never goes stale; a no-op when the draft isn't publishable or a publish
  // is already in flight.
  const publishShortcutRef = useRef<() => void>(() => {});
  publishShortcutRef.current = () => {
    if (!draft || publish.isPending) return;
    const publishable = draft.files.length > 0 && (draft.dirty || draft.stale);
    if (!publishable) return;
    void onPublish();
  };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        publishShortcutRef.current();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (canvas && canvas.status !== "active") {
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
  if (isError || !draft) {
    return <TabEmptyState title="Couldn't load the editor" description="Please try again." />;
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
    ) : content.isError ? (
      <EmptyState
        title="Couldn’t load this file"
        description={
          content.error instanceof ApiError
            ? content.error.hint
            : "The file’s contents couldn’t be read. If this canvas was deployed before the editor existed, re-deploy it."
        }
      />
    ) : (
      <CodeEditor
        key={selected}
        path={selected}
        value={content.data ?? ""}
        onChange={onEditorChange}
        onSave={() => void flush()}
      />
    );

  const canPublish = draft.files.length > 0 && (draft.dirty || draft.stale);
  const workspaceHeight = "h-[calc(100dvh-18.5rem)] min-h-[34rem]";
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

  const changePane = (next: EditorPane) => {
    if (next === "preview") setPreviewVisible(true);
    if (next === "code") setMode("code");
    setPane(next);
  };

  const fileRail = (
    <WorkspacePane
      {...dropzone.getRootProps({
        className: cn(
          "flex-col transition-colors",
          "h-full min-w-0",
          paneVisible("files") ? "flex" : "hidden",
          "lg:flex",
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

  const selectedActions =
    selected && selectedFile ? (
      <div className="flex items-center gap-1">
        <IconLink
          href={rawUrl(id, selected)}
          download={baseName(selected)}
          label="Download file"
          className="border-border bg-surface-raised"
        >
          <DownloadSimple size={15} weight="bold" aria-hidden />
        </IconLink>
        <IconButton
          label="Replace file"
          onClick={() => replaceInputRef.current?.click()}
          className="border-border bg-surface-raised"
        >
          <UploadSimple size={15} weight="bold" aria-hidden />
        </IconButton>
        <IconButton
          label="Rename file"
          onClick={() => {
            setRenaming(selected);
            setRenameTo(selected);
          }}
          className="border-border bg-surface-raised"
        >
          <PencilSimple size={15} weight="bold" aria-hidden />
        </IconButton>
        <IconButton
          label="Delete file"
          tone="danger"
          onClick={() => setDeleting(selected)}
          className="border-border bg-surface-raised"
        >
          <Trash size={15} weight="bold" aria-hidden />
        </IconButton>
      </div>
    ) : null;

  const editorPane =
    mode === "code" ? (
      <WorkspacePane
        className={cn(
          "flex-col",
          "h-full min-w-0",
          paneVisible("code") ? "flex" : "hidden",
          "lg:flex",
        )}
      >
        <PaneHeader
          title={<span className="font-mono">{selected ?? "No file selected"}</span>}
          description={editable ? "Autosaves to draft" : "Asset preview"}
          actions={
            <>
              {selectedActions}
              {!previewVisible && (
                <IconButton label="Show preview" onClick={() => setPreviewVisible(true)}>
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
          "lg:block",
        )}
      >
        <DraftPreview
          canvasId={id}
          refreshKey={refreshKey}
          onRefresh={() => setRefreshKey((k) => k + 1)}
          fullscreen={false}
          onToggleFullscreen={() => setPreviewFullscreen(true)}
          onHide={() => setPreviewVisible(false)}
          usesScripts={usesScripts}
        />
      </section>
    ) : null;

  const onPagePane =
    mode === "onpage" && htmlFile ? (
      <section
        className={cn(
          "min-h-0 h-full min-w-0",
          paneVisible("onpage") ? "block" : "hidden",
          "lg:block",
        )}
      >
        <OnPageEditor
          canvasId={id}
          htmlPath={htmlFile.path}
          saving={save.isPending}
          onSave={onPageSave}
        />
      </section>
    ) : null;

  return (
    <TabContentFrame className="space-y-3">
      {draftRepairNotice}
      <PublishBar
        dirty={draft.dirty}
        stale={draft.stale}
        saving={save.isPending}
        publishing={publish.isPending}
        canPublish={canPublish}
        hasFiles={draft.files.length > 0}
        selectedPath={selected}
        surface={mode}
        pane={pane}
        onPaneChange={changePane}
        onCodeMode={() => {
          setMode("code");
          setPane("code");
        }}
        onOnPageMode={() => void enterOnPage()}
        onPageAvailable={onPageAvailable}
        onPageHint={onPageHint}
        previewAvailable
        onPublish={onPublish}
      />

      <div
        className={cn(
          "grid min-w-0 gap-3",
          workspaceHeight,
          mode === "onpage"
            ? "lg:grid-cols-[16rem_minmax(0,1fr)]"
            : previewVisible
              ? "lg:grid-cols-[16rem_minmax(28rem,1.08fr)_minmax(22rem,0.92fr)]"
              : "lg:grid-cols-[16rem_minmax(0,1fr)]",
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
      {previewFullscreen && (
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
