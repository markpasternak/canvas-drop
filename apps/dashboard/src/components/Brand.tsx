import type { SVGProps } from "react";
import { cn } from "../lib/cn.js";

interface BrandMarkProps extends Omit<SVGProps<SVGSVGElement>, "title"> {
  title?: string;
  decorative?: boolean;
}

export function BrandMark({
  className,
  title = "Canvasdrop mark",
  decorative = true,
  ...props
}: BrandMarkProps) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      className={cn("shrink-0", className)}
      {...props}
    >
      <title>{title}</title>
      <path
        d="M14 37h-4a5 5 0 0 1-5-5V11a5 5 0 0 1 5-5h28a5 5 0 0 1 5 5v21a5 5 0 0 1-5 5h-4"
        stroke="var(--logo-frame, var(--fg))"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="4.75"
      />
      <path
        d="M24 14v16.5m-7-7 7 7 7-7"
        stroke="var(--logo-drop, var(--accent))"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="4.75"
      />
      <path
        d="M18 40h12"
        stroke="var(--logo-drop, var(--accent))"
        strokeLinecap="round"
        strokeWidth="4.75"
      />
    </svg>
  );
}
