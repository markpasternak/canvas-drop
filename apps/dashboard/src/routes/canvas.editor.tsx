import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import { BinaryFileView } from "../components/BinaryFileView.js";
import { Button } from "../components/Button.js";
import { CodeEditor } from "../components/CodeEditor.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { canvasRelativePath } from "../components/DeployFiles.js";
import { Dialog } from "../components/Dialog.js";
import { DraftPreview } from "../components/DraftPreview.js";
import { EmptyState } from "../components/EmptyState.js";
import { Field } from "../components/Field.js";
import { FileTree } from "../components/FileTree.js";
import { PublishBar } from "../components/PublishBar.js";
import { Skeleton } from "../components/Skeleton.js";
import { useToast } from "../components/Toast.js";
import { ApiError, api, type DraftFile } from "../lib/api.js";
import { cn } from "../lib/cn.js";
import { isBinaryMime } from "../lib/file-kind.js";
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

/**
 * In-browser editor (M5, U8): file tree + CodeMirror over the draft, autosave, the
 * publish bar (dirty/stale/Publish), an owner-only draft preview, and binary-asset
 * handling (images/fonts get a preview + Replace, never the text editor).
 */
export default function Editor() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { data: canvas } = useCanvas(id);
  const { data: draft, isLoading, isError } = useDraft(id);
  const [selected, setSelected] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
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
  const replaceInputRef = useRef<HTMLInputElement>(null);

  // Autosave buffer is bound to the file it belongs to (bufferPathRef), tracks the
  // last-loaded baseline (loadedRef), and a dirty flag — so a flush only ever writes
  // genuinely-edited content back to the correct file, never an empty or stale buffer.
  const bufferRef = useRef<string>("");
  const bufferPathRef = useRef<string | null>(null);
  const loadedRef = useRef<string>("");
  const dirtyRef = useRef<boolean>(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedFile: DraftFile | undefined = draft?.files.find((f) => f.path === selected);
  const editable = selectedFile ? !isBinaryMime(selectedFile.mime) : false;

  // Auto-select the first file once the draft loads.
  useEffect(() => {
    if (selected === null && draft && draft.files.length > 0) {
      setSelected(draft.files[0]?.path ?? null);
    }
  }, [draft, selected]);

  // Clear any pending autosave timer on unmount so a debounced save can't fire a
  // ghost PUT after the user has navigated away.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // Load the selected text file's content (owner-only, never cached). Skipped for
  // binary files — their bytes must never be pulled into the text editor.
  const content = useQuery({
    queryKey: ["draft-file", id, selected],
    queryFn: () => api.getDraftFile(id, selected as string),
    enabled: selected !== null && editable,
  });

  // Seed the autosave buffer when a text file's content arrives. `value` is the
  // editor's initial doc; the buffer mirrors it as the clean baseline for `selected`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-seed only when content/file changes
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
    // Only write a genuinely-edited buffer back to the file it belongs to.
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
    if (bufferPathRef.current !== selected) return; // editor not yet bound to this file
    bufferRef.current = next;
    dirtyRef.current = next !== loadedRef.current;
    if (timerRef.current) clearTimeout(timerRef.current);
    if (dirtyRef.current) timerRef.current = setTimeout(() => void flush(), AUTOSAVE_MS);
  };

  const selectFile = async (path: string) => {
    if (path === selected) return;
    await flush(); // persist the outgoing file's pending edits first
    setSelected(path);
  };

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

  // Drag files anywhere onto the file panel to add them to the draft.
  const dropzone = useDropzone({
    noClick: true,
    onDrop: (accepted) => void uploadFiles(accepted),
  });

  async function onReplaceChosen(file: File) {
    if (!selected) return;
    try {
      await upload.mutateAsync({ path: selected, file });
      // Reset the text baseline (the bytes changed underneath us) and reload.
      loadedRef.current = "";
      dirtyRef.current = false;
      await content.refetch();
      setRefreshKey((k) => k + 1);
      toast("File replaced");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't replace the file", "error");
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
      <EmptyState
        title="Editing is paused"
        description="Unarchive this canvas to edit and publish its draft."
      />
    );
  }
  if (isLoading) return <Skeleton className="h-96" />;
  if (isError || !draft) {
    return <EmptyState title="Couldn't load the editor" description="Please try again." />;
  }

  return (
    <div className="space-y-4">
      <PublishBar
        dirty={draft.dirty}
        stale={draft.stale}
        saving={save.isPending}
        publishing={publish.isPending}
        canPublish={draft.files.length > 0}
        onPublish={onPublish}
      />

      <div className="grid gap-4 lg:grid-cols-[14rem_1fr]">
        {/* File manager — drop files anywhere here to upload them into the draft. */}
        <aside
          {...dropzone.getRootProps({
            className: cn(
              "space-y-2 rounded-lg p-1 transition-colors",
              dropzone.isDragActive && "bg-accent-subtle ring-2 ring-accent ring-inset",
            ),
          })}
        >
          <input {...dropzone.getInputProps()} />
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-subtle">Files</span>
            <div className="flex gap-1">
              <Button variant="ghost" size="sm" onClick={() => setAddOpen(true)}>
                + New
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={dropzone.open}
                loading={uploadMany.isPending}
              >
                Upload
              </Button>
            </div>
          </div>
          {dropzone.isDragActive ? (
            <p className="px-2 py-6 text-center text-xs text-accent">Drop files to upload…</p>
          ) : (
            <FileTree files={draft.files} selected={selected} onSelect={selectFile} />
          )}
          {selected && (
            <div className="flex flex-wrap gap-1 pt-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setRenaming(selected);
                  setRenameTo(selected);
                }}
              >
                Rename
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => replaceInputRef.current?.click()}
                loading={upload.isPending}
              >
                Replace
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDeleting(selected)}>
                Delete
              </Button>
            </div>
          )}
          <input
            ref={replaceInputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onReplaceChosen(file);
              e.target.value = ""; // allow re-selecting the same filename
            }}
          />
        </aside>

        {/* Editor + preview */}
        <section className="grid gap-4 xl:grid-cols-2">
          <div className="h-[28rem]">
            {selected === null || !selectedFile ? (
              <EmptyState title="No file selected" description="Pick a file or add one to start." />
            ) : !editable ? (
              <BinaryFileView
                canvasId={id}
                path={selected}
                mime={selectedFile.mime}
                size={selectedFile.size}
                refreshKey={refreshKey}
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
            )}
          </div>
          <div className="h-[28rem]">
            <DraftPreview
              canvasId={id}
              refreshKey={refreshKey}
              onRefresh={() => setRefreshKey((k) => k + 1)}
            />
          </div>
        </section>
      </div>

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
    </div>
  );
}
