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
import { useEffect, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import { Button } from "../components/Button.js";
import { TabContentFrame, TabEmptyState } from "../components/CanvasDetail.js";
import { CodeEditor } from "../components/CodeEditor.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { canvasRelativePath } from "../components/DeployFiles.js";
import { Dialog } from "../components/Dialog.js";
import { DraftPreview } from "../components/DraftPreview.js";
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
import { ApiError, api, type DraftFile } from "../lib/api.js";
import { cn } from "../lib/cn.js";
import { isEditableFile, isHtmlFile, nonEditableReason, singleHtmlFile } from "../lib/file-kind.js";
import {
  useDeleteDraftFile,
  usePublishDraft,
  useRenameDraftFile,
  useSaveDraftFile,
  useUploadDraftFile,
  useUploadDraftFiles,
} from "../lib/mutations.js";
import { useCanvas, useDraft } from "../lib/queries.js";

const AUTOSAVE_MS = 700;

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const rawUrl = (id: string, path: string) =>
  `/api/canvases/${id}/draft/file?path=${encodeURIComponent(path)}`;

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

  const selectedFile: DraftFile | undefined = draft?.files.find((f) => f.path === selected);
  const editable = selectedFile ? isEditableFile(selectedFile) : false;

  // On-page editing is only offered for a single static HTML page (see singleHtmlFile).
  const htmlFile = draft ? singleHtmlFile(draft.files) : null;
  const htmlCount = draft ? draft.files.filter(isHtmlFile).length : 0;
  const onPageHint =
    htmlCount === 0
      ? "On-page editing needs an HTML page in the draft."
      : `On-page editing works with a single HTML page (this draft has ${htmlCount}).`;

  useEffect(() => {
    if (selected === null && draft && draft.files.length > 0) {
      setSelected(draft.files[0]?.path ?? null);
    }
  }, [draft, selected]);

  // Fall back to code mode if the draft stops being a single HTML page.
  useEffect(() => {
    if (mode === "onpage" && !htmlFile) {
      setMode("code");
      setPane("code");
    }
  }, [mode, htmlFile]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

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
    const items = files.map((file) => ({ path: canvasRelativePath(file), file }));
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
    if (!path) return;
    try {
      await save.mutateAsync({ path, content: "" });
      setAddOpen(false);
      setNewPath("");
      setSelected(path);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't add the file", "error");
    }
  }

  async function confirmRename() {
    if (!renaming) return;
    const to = renameTo.trim();
    if (!to || to === renaming) return setRenaming(null);
    try {
      await rename.mutateAsync({ from: renaming, to });
      if (selected === renaming) setSelected(to);
      setRenaming(null);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't rename", "error");
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
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
    if (!htmlFile) return;
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

  if (canvas && canvas.status !== "active") {
    return (
      <TabEmptyState
        title="Editing is paused"
        description="Unarchive this canvas to edit and publish its draft."
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
      />
    );

  const canPublish = draft.files.length > 0 && (draft.dirty || draft.stale);
  const workspaceHeight = "h-[calc(100dvh-18.5rem)] min-h-[34rem]";
  const paneVisible = (target: EditorPane) => pane === target;

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
      <PublishBar
        dirty={draft.dirty}
        stale={draft.stale}
        saving={save.isPending}
        publishing={publish.isPending}
        canPublish={canPublish}
        selectedPath={selected}
        surface={mode}
        pane={pane}
        onPaneChange={changePane}
        onCodeMode={() => {
          setMode("code");
          setPane("code");
        }}
        onOnPageMode={() => void enterOnPage()}
        onPageAvailable={htmlFile !== null}
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
          <p className="text-xs text-subtle">
            Creates an empty text file. To add an image or other asset, use Upload.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" type="submit" loading={save.isPending} disabled={!newPath.trim()}>
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
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button size="sm" type="submit" loading={rename.isPending}>
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
