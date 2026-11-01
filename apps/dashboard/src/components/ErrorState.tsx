import { ArrowClockwise, HouseLine } from "@phosphor-icons/react";
import {
  type ErrorComponentProps,
  Link,
  type NotFoundRouteProps,
  useRouterState,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { BrandMark } from "./Brand.js";

function useCurrentPath(): string {
  return useRouterState({ select: (state) => state.location.pathname });
}

function ErrorShell({
  status,
  code,
  title,
  message,
  path,
  children,
}: {
  status: string;
  code: string;
  title: string;
  message: string;
  path: string;
  children?: ReactNode;
}) {
  return (
    <section className="mx-auto grid min-h-[calc(100dvh-8rem)] w-full max-w-5xl place-items-center py-10">
      <div className="w-full overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-panel)]">
        <div className="flex items-center gap-2 border-b border-border bg-surface-raised px-4 py-3 text-sm font-semibold text-fg">
          <BrandMark className="size-8" />
          canvas-drop
        </div>
        <div className="space-y-6 p-6 sm:p-8">
          <div className="min-w-0">
            <h1 className="max-w-lg font-display text-h1 leading-tight text-fg">{title}</h1>
            <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">{message}</p>
          </div>
          <details className="text-sm text-muted">
            <summary className="cursor-pointer">Technical details</summary>
            <dl className="mt-3 grid gap-3 border-t border-border pt-3">
              <div>
                <dt>Status</dt>
                <dd className="font-mono">HTTP {status}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs font-medium text-subtle">Code</dt>
                <dd className="mt-1 break-words font-mono text-sm text-fg">{code}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs font-medium text-subtle">Path</dt>
                <dd className="mt-1 break-words font-mono text-sm text-fg">{path}</dd>
              </div>
            </dl>
          </details>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-border bg-surface-raised px-6 py-4 sm:px-8">
          {children}
          <Link
            to="/"
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border-strong bg-surface px-3.5 text-sm font-medium text-fg transition-all duration-100 [transition-timing-function:var(--ease-out)] hover:bg-surface-hover active:translate-y-px"
          >
            <HouseLine size={16} aria-hidden />
            Home
          </Link>
        </div>
      </div>
    </section>
  );
}

export function DashboardNotFoundState(_props: NotFoundRouteProps) {
  const path = useCurrentPath();
  return (
    <ErrorShell
      status="404"
      code="not_found"
      title="Page not found"
      message="This link isn't available. Check the address or return to your canvases."
      path={path}
    />
  );
}

export function DashboardRouteErrorState({ reset }: ErrorComponentProps) {
  const path = useCurrentPath();
  const message = "This view couldn't be loaded. Try again, or return to your canvases.";
  return (
    <ErrorShell
      status="500"
      code="route_error"
      title="Dashboard view failed"
      message={message}
      path={path}
    >
      <button
        type="button"
        onClick={reset}
        className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-accent px-3.5 text-sm font-semibold text-accent-fg shadow-[var(--shadow-panel)] transition-all duration-100 [transition-timing-function:var(--ease-out)] hover:bg-accent-hover active:translate-y-px"
      >
        <ArrowClockwise size={16} weight="bold" aria-hidden />
        Try again
      </button>
    </ErrorShell>
  );
}
