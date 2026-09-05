import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { useId } from "react";
import { cn } from "../lib/cn.js";
import { inputControl } from "../lib/input-styles.js";

const control = inputControl;

function Label({
  htmlFor,
  children,
  hint,
  hintId,
}: {
  htmlFor: string;
  children: ReactNode;
  hint?: ReactNode;
  hintId?: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <label htmlFor={htmlFor} className="text-sm font-medium text-fg">
        {children}
      </label>
      {hint && (
        <span id={hintId} className="text-xs text-subtle">
          {hint}
        </span>
      )}
    </div>
  );
}

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: ReactNode;
  description?: ReactNode;
  mono?: boolean;
}

export function Field({
  label,
  hint,
  description,
  mono,
  className,
  id: providedId,
  "aria-describedby": describedBy,
  ...rest
}: FieldProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const hintId = hint ? `${id}-hint` : undefined;
  const descriptionId = description ? `${id}-description` : undefined;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} hint={hint} hintId={hintId}>
        {label}
      </Label>
      <input
        id={id}
        aria-describedby={
          [describedBy, hintId, descriptionId].filter(Boolean).join(" ") || undefined
        }
        className={cn(control, mono && "font-mono", className)}
        {...rest}
      />
      {description && (
        <p id={descriptionId} className="text-xs text-muted">
          {description}
        </p>
      )}
    </div>
  );
}

export interface TextareaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: ReactNode;
  description?: ReactNode;
  mono?: boolean;
}

export function TextareaField({
  label,
  hint,
  description,
  mono,
  className,
  id: providedId,
  "aria-describedby": describedBy,
  ...rest
}: TextareaFieldProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const hintId = hint ? `${id}-hint` : undefined;
  const descriptionId = description ? `${id}-description` : undefined;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} hint={hint} hintId={hintId}>
        {label}
      </Label>
      <textarea
        id={id}
        aria-describedby={
          [describedBy, hintId, descriptionId].filter(Boolean).join(" ") || undefined
        }
        className={cn(control, mono && "font-mono", className)}
        {...rest}
      />
      {description && (
        <p id={descriptionId} className="text-xs text-muted">
          {description}
        </p>
      )}
    </div>
  );
}
