import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/Button.js";
import { CodeEditor } from "../components/CodeEditor.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { Dialog } from "../components/Dialog.js";
import { DraftPreview } from "../components/DraftPreview.js";
import { EmptyState } from "../components/EmptyState.js";
import { Field } from "../components/Field.js";
import { FileTree } from "../components/FileTree.js";
import { PublishBar } from "../components/PublishBar.js";
import { Skeleton } from "../components/Skeleton.js";
import { useToast } from "../components/Toast.js";
import { ApiError, api } from "../lib/api.js";
import {
  useDeleteDraftFile,
  usePublishDraft,
  useRenameDraftFile,
  useSaveDraftFile,
} from "../lib/mutations.js";
import { useCanvas, useDraft } from "../lib/queries.js";

const AUTOSAVE_MS = 700;

/**
 * In-browser editor (M5, U8): file tree + CodeMirror over the draft, autosave, the
 * publish bar (dirty/stale/Publish), and an owner-only draft preview. Edits write
 * to the draft only; Publish snapshots a new immutable version.
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
  const del = useDeleteDraftFile(id);
  const rename = useRenameDraftFile(id);
  const publish = usePublishDraft(id);
  const toast = useToast();

  const bufferRef = useRef<string>("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-select the first file once the draft loads.
  useEffect(() => {
    if (selected === null && draft && draft.files.length > 0) {
      setSelected(draft.files[0]?.path ?? null);
    }
  }, [draft, selected]);

  // Load the selected file's text content (owner-only, never cached).
  const content = useQuery({
    queryKey: ["draft-file", id, selected],
    queryFn: () => api.getDraftFile(id, selected as string),
    enabled: selected !== null,
  });

  const flush = async (): Promise<void> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (selected === null) return;
    try {
      await save.mutateAsync({ path: selected, content: bufferRef.current });
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't save", "error");
    }
  };

  const onEditorChange = (next: string) => {
    bufferRef.current = next;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void flush(), AUTOSAVE_MS);
  };

  const selectFile = async (path: string) => {
    if (path === selected) return;
    await flush(); // persist pending edits before switching
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
        {/* File manager */}
        <aside className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-subtle">Files</span>
            <Button variant="ghost" size="sm" onClick={() => setAddOpen(true)}>
              + Add
            </Button>
          </div>
          <FileTree files={draft.files} selected={selected} onSelect={selectFile} />
          {selected && (
            <div className="flex gap-1 pt-1">
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
              <Button variant="ghost" size="sm" onClick={() => setDeleting(selected)}>
                Delete
              </Button>
            </div>
          )}
        </aside>

        {/* Editor + preview */}
        <section className="grid gap-4 xl:grid-cols-2">
          <div className="h-[28rem]">
            {selected === null ? (
              <EmptyState title="No file selected" description="Pick a file or add one to start." />
            ) : content.isLoading ? (
              <Skeleton className="h-full" />
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
        This removes the file from the draft. It won't affect the live version until you publish.
      </ConfirmDialog>
    </div>
  );
}
