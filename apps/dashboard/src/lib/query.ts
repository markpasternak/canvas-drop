import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api.js";

/** Shared query client. Conservative defaults for a management app: don't refetch
 * on every focus, retry once for transient failures (network blips, 5xx), but
 * fail fast on 4xx. A 404/403 is deterministic — retrying it only delays the
 * "not found" / "no access" state behind a misleading skeleton. Auth-expiry (401)
 * is handled explicitly in api.ts and is also a 4xx, so it never retries either. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status !== undefined) {
          if (error.status >= 400 && error.status < 500) return false;
        }
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
    },
  },
});
