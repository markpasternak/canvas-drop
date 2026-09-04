import type { SVGProps } from "react";
import { cn } from "../lib/cn.js";

interface BrandMarkProps extends Omit<SVGProps<SVGSVGElement>, "title"> {
  title?: string;
  decorative?: boolean;
}

export function BrandMark({
  className,
  title = "canvas-drop mark",
  decorative = true,
  ...props
}: BrandMarkProps) {
  // Mark geometry mirrors @canvas-drop/shared `LOGO_PATHS` (brand/logo.ts), which
  // the server renders via brandMarkSvg(). The dashboard inlines it (it doesn't
  // bundle @canvas-drop/shared) — keep these paths in sync when the mark changes.
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      className={cn("shrink-0", className)}
      {...props}
    >
      <title>{title}</title>
      <g strokeLinecap="round" strokeLinejoin="round">
        <path
          d="M9 10H7a3 3 0 0 0-3 3v13a3 3 0 0 0 3 3h18a3 3 0 0 0 3-3V13a3 3 0 0 0-3-3h-2"
          stroke="var(--logo-frame, var(--fg))"
          strokeWidth="2"
        />
        <path
          d="M16 2v12m-5-5 5 5 5-5"
          stroke="var(--logo-drop, var(--accent))"
          strokeWidth="2.5"
        />
        <path
          d="M11 20l-3 3 3 3m10-6 3 3-3 3m-3-7-4 8"
          stroke="var(--logo-drop, var(--accent))"
          strokeWidth="1.75"
        />
      </g>
    </svg>
  );
}
