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
      viewBox="158 209 372 432"
      fill="none"
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      className={cn("shrink-0", className)}
      {...props}
    >
      <title>{title}</title>
      {/* frame — the drop container */}
      <path
        d="M245 335H218C191.49 335 170 356.49 170 383V581C170 607.51 191.49 629 218 629H470C496.51 629 518 607.51 518 581V383C518 356.49 496.51 335 470 335H443"
        stroke="var(--logo-frame, var(--fg))"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="24"
      />
      {/* download arrow */}
      <path
        d="M344 222V392"
        stroke="var(--logo-drop, var(--accent))"
        strokeLinecap="round"
        strokeWidth="27"
      />
      <path
        d="M291 349L344 402L397 349"
        stroke="var(--logo-drop, var(--accent))"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="27"
      />
      {/* code </> */}
      <path
        d="M286 462L241 507L286 552"
        stroke="var(--logo-drop, var(--accent))"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="25"
      />
      <path
        d="M402 462L447 507L402 552"
        stroke="var(--logo-drop, var(--accent))"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="25"
      />
      <path
        d="M366 452L326 566"
        stroke="var(--logo-drop, var(--accent))"
        strokeLinecap="round"
        strokeWidth="20"
      />
    </svg>
  );
}
