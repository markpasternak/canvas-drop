import { Trash } from "@phosphor-icons/react";
import { useState } from "react";
import { ApiError, type Me } from "../lib/api.js";
import { useAddAlias, useRegenerateSlug, useRemoveAlias } from "../lib/mutations.js";
import { useAliases } from "../lib/queries.js";
import type { SlugStatus } from "../lib/use-slug-availability.js";
import { Button } from "./Button.js";
import { CopyButton } from "./CopyButton.js";
import { Dialog } from "./Dialog.js";
import { IconButton } from "./IconButton.js";
import { Row } from "./SettingsSection.js";
import { SlugField } from "./SlugField.js";
import { useToast } from "./Toast.js";

/** Most aliases one canvas may carry — mirrors the server's MAX_SLUG_ALIASES. */
const MAX_ALIASES = 10;

/**
 * "Also reachable at" (plan 2026-10-30-1815): the canvas's slug aliases. Each alias URL
 * redirects to the canonical URL, so access rules are unchanged. An alias can be copied,
 * removed, or made the primary slug (a rename that keeps the outgoing slug as an alias).
 */
export function SlugAliases({ canvasId, me }: { canvasId: string; me: Me | undefined }) {
  const toast = useToast();
  const { data } = useAliases(canvasId);
  const add = useAddAlias(canvasId);
  const remove = useRemoveAlias(canvasId);
  const promote = useRegenerateSlug(canvasId);
  const [adding, setAdding] = useState(false);
  const aliases = data?.aliases ?? [];
  const full = aliases.length >= MAX_ALIASES;

  const fail = (err: unknown, fallback: string) =>
    toast(err instanceof ApiError ? err.hint : fallback, "error");

  return (
    <>
      <Row
        title="Also reachable at"
        description={
          full
            ? `This canvas has the maximum of ${MAX_ALIASES} aliases.`
            : "Other URLs that redirect to this canvas. Access rules still apply."
        }
      >
        <Button size="sm" variant="secondary" onClick={() => setAdding(true)} disabled={full}>
          Add alias
        </Button>
      </Row>
      {aliases.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border">
          {aliases.map((alias) => (
            <li key={alias.slug} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1 break-all font-mono text-sm">{alias.url}</span>
              <CopyButton value={alias.url} label="Copy" toastMessage="Link copied" />
              <Button
                size="sm"
                variant="ghost"
                disabled={promote.isPending}
                onClick={async () => {
                  try {
                    await promote.mutateAsync({ slug: alias.slug, keepOldAsAlias: true });
                    toast("Primary URL changed");
                  } catch (err) {
                    fail(err, "Couldn't change the primary URL");
                  }
                }}
              >
                Make primary
              </Button>
              <IconButton
                label={`Remove alias ${alias.slug}`}
                tone="danger"
                disabled={remove.isPending}
                onClick={async () => {
                  try {
                    await remove.mutateAsync(alias.slug);
                    toast("Alias removed");
                  } catch (err) {
                    fail(err, "Couldn't remove the alias");
                  }
                }}
              >
                <Trash size={15} weight="bold" aria-hidden />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <AddAliasDialog
        open={adding}
        onClose={() => setAdding(false)}
        me={me}
        loading={add.isPending}
        onConfirm={async (slug) => {
          try {
            await add.mutateAsync(slug);
            setAdding(false);
            toast("Alias added");
          } catch (err) {
            fail(err, "Couldn't add the alias");
          }
        }}
      />
    </>
  );
}

function AddAliasDialog({
  open,
  onClose,
  onConfirm,
  me,
  loading,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (slug: string) => void;
  me: Me | undefined;
  loading: boolean;
}) {
  const [resolved, setResolved] = useState<{ slug: string; status: SlugStatus }>({
    slug: "",
    status: "idle",
  });
  const ready = resolved.slug !== "" && resolved.status === "available";

  return (
    <Dialog open={open} onClose={onClose} title="Add an alias">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !loading) onConfirm(resolved.slug);
        }}
      >
        <SlugField
          instance={me ? { urlMode: me.urlMode, baseUrl: me.baseUrl } : undefined}
          onResolved={setResolved}
          label="Alias"
          idleHint="Another name for this canvas. It redirects to the main URL."
          optional={false}
          autoFocus
        />
        <p className="text-sm text-muted">
          Anyone who knows or guesses this name can find the canvas, but only people who can open it
          will get through.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" type="button" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button size="sm" type="submit" loading={loading} disabled={!ready}>
            Add alias
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
