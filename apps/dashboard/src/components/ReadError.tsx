import type { ReactNode } from "react";
import { Button } from "./Button.js";
import { InlineNotice } from "./Surface.js";

/** Only a successful empty response may render an empty state. */
export function ReadError({
  title = "Couldn't load this information",
  children,
  onRetry,
  retrying = false,
}: {
  title?: string;
  children?: ReactNode;
  onRetry: () => void;
  retrying?: boolean;
}) {
  return (
    <InlineNotice tone="danger" role="alert">
      <div className="space-y-3">
        <p className="font-medium">{title}</p>
        {children && <div>{children}</div>}
        <Button variant="secondary" size="sm" onClick={onRetry} loading={retrying}>
          Try again
        </Button>
      </div>
    </InlineNotice>
  );
}
