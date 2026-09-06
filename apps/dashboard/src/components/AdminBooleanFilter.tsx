import { FilterSelect } from "./Filters.js";

export function AdminBooleanFilter({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | undefined;
  onChange: (value: boolean | undefined) => void;
}) {
  return (
    <FilterSelect
      label={label}
      value={value === undefined ? "any" : String(value)}
      options={[
        { value: "any", label: `${label}: Any` },
        { value: "true", label: `${label}: Yes` },
        { value: "false", label: `${label}: No` },
      ]}
      onValueChange={(next) => onChange(next === "any" ? undefined : next === "true")}
    />
  );
}
