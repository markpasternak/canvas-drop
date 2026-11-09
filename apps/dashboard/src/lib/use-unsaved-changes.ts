import { useBlocker } from "@tanstack/react-router";
import { useCallback, useLayoutEffect, useRef } from "react";

/** Keep the current view mounted until saving succeeds or the person explicitly
 * chooses to leave. Callers render a recovery dialog from the returned resolver.
 * No content or credentials are persisted by this hook. */
export function useUnsavedChanges(options: {
  dirty: boolean;
  saveBeforeLeave?: () => Promise<boolean>;
}) {
  const latest = useRef(options);
  latest.current = options;
  // useBlocker unregisters in a passive effect, which React can run a task
  // after the view has left the DOM. A navigation in that gap would still
  // consult this blocker and stay blocked behind a dialog nobody can see.
  // Layout cleanup runs during the unmount commit, so an unmounted view
  // never blocks.
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const shouldBlockFn = useCallback(async () => {
    if (!mounted.current || !latest.current.dirty) return false;
    if (!latest.current.saveBeforeLeave) return true;
    try {
      return !(await latest.current.saveBeforeLeave());
    } catch {
      // A rejected save is not permission to leave the only recoverable copy.
      return true;
    }
  }, []);
  const enableBeforeUnload = useCallback(() => mounted.current && latest.current.dirty, []);
  return useBlocker({ shouldBlockFn, enableBeforeUnload, withResolver: true });
}
