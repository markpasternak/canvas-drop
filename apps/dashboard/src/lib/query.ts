import { QueryClient } from "@tanstack/react-query";

/** Shared query client. Conservative defaults for a management app: don't refetch
 * on every focus, retry once (auth-expiry is handled explicitly in api.ts, not by
 * retrying). */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
