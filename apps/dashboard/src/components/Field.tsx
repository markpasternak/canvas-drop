import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { useId } from "react";
import { cn } from "../lib/cn.js";
import { inputControl } from "../lib/input-styles.js";

const control = inputControl;

function Label({
  htmlFor,
  children,
  hint,
}: {
  htmlFor: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <label htmlFor={htmlFor} className="text-sm font-medium text-fg">
        {children}
      </label>
      {hint && <span className="text-xs text-subtle">{hint}</span>}
    </div>
  );
}

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: ReactNode;
  description?: ReactNode;
  mono?: boolean;
}

export function Field({ label, hint, description, mono, className, ...rest }: FieldProps) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} hint={hint}>
        {label}
      </Label>
      <input id={id} className={cn(control, mono && "font-mono", className)} {...rest} />
      {description && <p className="text-xs text-muted">{description}</p>}
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
  ...rest
}: TextareaFieldProps) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} hint={hint}>
        {label}
      </Label>
      <textarea id={id} className={cn(control, mono && "font-mono", className)} {...rest} />
      {description && <p className="text-xs text-muted">{description}</p>}
    </div>
  );
}
