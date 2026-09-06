import { useState } from "react";
import { normalizeAdminCanvasSearch } from "../lib/admin-filters.js";
import type { AdminCanvasesSearch } from "../router.js";
import { Button } from "./Button.js";
import { Dialog } from "./Dialog.js";
import { Field } from "./Field.js";
import { useToast } from "./Toast.js";

interface SavedView {
  name: string;
  search: AdminCanvasesSearch;
}

/** This component is keyed by userId by its parent; state never crosses accounts. */
export function AdminSavedViews({
  userId,
  search,
  onApply,
}: {
  userId: string;
  search: AdminCanvasesSearch;
  onApply: (search: AdminCanvasesSearch) => void;
}) {
  const storageKey = `admin:canvas-views:v1:${userId}`;
  const [views, setViews] = useState<SavedView[]>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      if (!Array.isArray(stored)) return [];
      const names = new Set<string>();
      return stored.slice(0, 20).flatMap((v: unknown) => {
        if (
          !v ||
          typeof v !== "object" ||
          !("name" in v) ||
          typeof v.name !== "string" ||
          !("search" in v)
        )
          return [];
        const name = v.name.trim().slice(0, 60);
        if (names.has(name.toLowerCase())) return [];
        names.add(name.toLowerCase());
        return name
          ? [{ name, search: { ...normalizeAdminCanvasSearch(v.search), page: undefined } }]
          : [];
      });
    } catch {
      return [];
    }
  });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const toast = useToast();
  const persist = (next: SavedView[]) => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setViews(next);
      return true;
    } catch {
      toast("This browser could not save your views", "error");
      return false;
    }
  };
  return (
    <section className="flex flex-wrap items-center gap-2" aria-label="Saved canvas views">
      <span className="text-xs text-muted">Saved on this browser</span>
      {views.map((view, index) => (
        <div key={view.name} className="flex items-center rounded-lg border border-border">
          <Button size="sm" variant="ghost" onClick={() => onApply(view.search)}>
            {view.name}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Delete saved view ${view.name}`}
            onClick={() => persist(views.filter((_, i) => i !== index))}
          >
            ×
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="secondary"
        disabled={views.length >= 20}
        onClick={() => {
          setName("");
          setOpen(true);
        }}
      >
        Save view
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Save this view"
        description="Save the current conditions and sort order for your account on this browser."
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = name.trim();
            if (!trimmed || views.length >= 20) return;
            if (views.some((v) => v.name.toLowerCase() === trimmed.toLowerCase())) {
              toast("Choose a different view name", "error");
              return;
            }
            if (
              persist([
                ...views,
                {
                  name: trimmed,
                  search: { ...normalizeAdminCanvasSearch(search), page: undefined },
                },
              ])
            )
              setOpen(false);
          }}
        >
          <Field
            label="View name"
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            placeholder="Public without passwords"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              Save view
            </Button>
          </div>
        </form>
      </Dialog>
    </section>
  );
}
