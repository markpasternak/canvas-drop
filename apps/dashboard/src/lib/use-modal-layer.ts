import { type RefObject, useEffect, useRef } from "react";

// Drawers and dialogs share one stack and one body lock. A pending top dialog
// still owns Escape; it must not dismiss an underlying drawer or dialog.
const layers: HTMLElement[] = [];
let savedBodyOverflow = "";

export function useModalLayer({
  open,
  panelRef,
  onClose,
  dismissable = true,
}: {
  open: boolean;
  panelRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  dismissable?: boolean;
}) {
  const latest = useRef({ onClose, dismissable });
  latest.current = { onClose, dismissable };
  const isTop = () => layers.at(-1) === panelRef.current;

  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    const restore = document.activeElement as HTMLElement | null;
    if (layers.length === 0) {
      savedBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    // Effects in nested children can run before their parent on an initial mount.
    const childIndex = layers.findIndex((layer) => panel.contains(layer));
    if (childIndex >= 0) layers.splice(childIndex, 0, panel);
    else layers.push(panel);
    if (layers.at(-1) === panel) {
      (panel.querySelector<HTMLElement>("[data-autofocus]") ?? panel).focus();
    }

    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || layers.at(-1) !== panel) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (latest.current.dismissable) latest.current.onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),summary,[tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => {
        if (element.matches(":disabled") || element.closest("[hidden],[inert]")) return false;
        for (
          let parent: HTMLElement | null = element;
          parent && parent !== panel;
          parent = parent.parentElement
        ) {
          const style = getComputedStyle(parent);
          if (style.display === "none" || style.visibility === "hidden") return false;
          if (parent.matches("details:not([open])")) {
            const summary = parent.querySelector(":scope > summary");
            if (!summary?.contains(element)) return false;
          }
        }
        return true;
      });
      if (focusables.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables.at(-1);
      const atPanel = document.activeElement === panel || !panel.contains(document.activeElement);
      if (event.shiftKey && (atPanel || document.activeElement === first)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (atPanel || document.activeElement === last)) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      const wasTop = layers.at(-1) === panel;
      const index = layers.indexOf(panel);
      if (index >= 0) layers.splice(index, 1);
      document.removeEventListener("keydown", onKey);
      if (layers.length === 0) document.body.style.overflow = savedBodyOverflow;
      if (wasTop && restore?.isConnected) restore.focus();
    };
  }, [open, panelRef]);

  return { isTop };
}
