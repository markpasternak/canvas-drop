import { useNavigate } from "@tanstack/react-router";
import { ApiError } from "../lib/api.js";
import { useCloneCanvas } from "../lib/mutations.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { useToast } from "./Toast.js";

/**
 * "Make a copy" confirmation (plan 002). Spells out what a clone does — a NEW
 * canvas you own, seeded from the source's published files, starting as an
 * unpublished draft, not shared or listed — before it happens, then drops the
 * cloner into the new canvas's editor. Reused by the dashboard cards, the canvas
 * Overview, and the gallery (templatable items only).
 *
 * `keepsPassword` is set only when cloning your OWN password-protected canvas (the
 * clone carries the password); gallery clones are never protected, so it's false.
 */
export function CloneDialog({
  open,
  onClose,
  sourceId,
  sourceTitle,
  keepsPassword = false,
}: {
  open: boolean;
  onClose: () => void;
  sourceId: string;
  sourceTitle: string;
  keepsPassword?: boolean;
}) {
  const clone = useCloneCanvas();
  const navigate = useNavigate();
  const toast = useToast();

  async function confirm() {
    try {
      const created = await clone.mutateAsync(sourceId);
      onClose();
      toast("Copy created — customize it, then publish when you're ready.");
      navigate({ to: "/canvases/$id/editor", params: { id: created.id } });
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't make a copy", "error");
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={confirm}
      title="Make a copy"
      actionLabel="Make a copy"
      loading={clone.isPending}
    >
      This creates a <strong>new canvas you own</strong>, named “Copy of{" "}
      {sourceTitle || "Untitled canvas"}”, with the same files. It starts as an{" "}
      <strong>unpublished draft</strong> — nothing goes live until you publish it — and it isn't
      shared or listed in the gallery. {keepsPassword ? "Its password is carried over. " : ""}
      You'll land in the editor to customize it.
    </ConfirmDialog>
  );
}
