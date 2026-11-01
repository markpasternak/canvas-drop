import { CaretDown } from "@phosphor-icons/react";
import type { Ref, SelectHTMLAttributes } from "react";
import { cn } from "../lib/cn.js";
import { selectControl, selectSizes } from "../lib/input-styles.js";

export interface NativeSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  controlSize?: keyof typeof selectSizes;
  wrapperClassName?: string;
  ref?: Ref<HTMLSelectElement>;
}

/** A real select with the app's shared trigger treatment. The trailing icon has
 * its own reserved space, while the platform retains its keyboard and mobile picker. */
export function NativeSelect({
  className,
  wrapperClassName = "w-full",
  controlSize = "lg",
  children,
  ref,
  ...props
}: NativeSelectProps) {
  return (
    <span className={cn("relative inline-flex min-w-0", wrapperClassName)}>
      <select
        ref={ref}
        className={cn(
          selectControl,
          selectSizes[controlSize],
          "peer w-full appearance-none truncate pr-9 pl-3",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <CaretDown
        size={14}
        weight="bold"
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-subtle peer-disabled:opacity-50"
      />
    </span>
  );
}
