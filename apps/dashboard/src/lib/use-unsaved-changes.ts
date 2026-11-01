import { useBlocker } from "@tanstack/react-router";
import { useCallback, useRef } from "react";

/** Keep the current view mounted until saving succeeds or the person explicitly
 * chooses to leave. Callers render a recovery dialog from the returned resolver.
 * No content or credentials are persisted by this hook. */
export function useUnsavedChanges(options: {
  dirty: boolean;
  saveBeforeLeave?: () => Promise<boolean>;
}) {
  const latest = useRef(options);
  latest.current = options;
  const shouldBlockFn = useCallback(async () => {
    if (!latest.current.dirty) return false;
    if (!latest.current.saveBeforeLeave) return true;
    try {
      return !(await latest.current.saveBeforeLeave());
    } catch {
      // A rejected save is not permission to leave the only recoverable copy.
      return true;
    }
  }, []);
  const enableBeforeUnload = useCallback(() => latest.current.dirty, []);
  return useBlocker({ shouldBlockFn, enableBeforeUnload, withResolver: true });
}
