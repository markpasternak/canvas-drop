import { useToast } from "../components/Toast.js";

/**
 * Copy-to-clipboard as a callback, for places that aren't a standalone button —
 * e.g. a "Copy link" item inside an ActionMenu, where the affordance must be a
 * real `role="menuitem"` rather than the bespoke CopyButton. Mirrors CopyButton's
 * graceful fallback + toast announcement so both paths behave identically.
 */
export function useClipboardCopy() {
  const toast = useToast();
  return async (value: string, message = "Copied to clipboard") => {
    try {
      await navigator.clipboard.writeText(value);
      toast(message);
    } catch {
      toast("Couldn't copy. Copy it manually.", "error");
    }
  };
}
