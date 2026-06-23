import { useCombobox } from "downshift";
import { useId } from "react";
import type { PersonSuggestion } from "../lib/api.js";
import { cn } from "../lib/cn.js";
import { inputControl } from "../lib/input-styles.js";

interface PeopleEmailComboboxProps {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  suggestions: PersonSuggestion[];
  searchEnabled: boolean;
  searching: boolean;
}

const itemToString = (item: PersonSuggestion | null) => item?.email ?? "";

export function PeopleEmailCombobox({
  label,
  placeholder,
  value,
  onChange,
  onSubmit,
  suggestions,
  searchEnabled,
  searching,
}: PeopleEmailComboboxProps) {
  const inputId = useId();
  const labelId = useId();
  const canSearch = searchEnabled && value.trim().length >= 2;
  const items = canSearch ? suggestions : [];
  const {
    closeMenu,
    getInputProps,
    getItemProps,
    getLabelProps,
    getMenuProps,
    highlightedIndex,
    isOpen,
    openMenu,
  } = useCombobox<PersonSuggestion>({
    inputId,
    items,
    inputValue: value,
    itemToString,
    labelId,
    onInputValueChange: ({ inputValue }) => onChange(inputValue ?? ""),
    onSelectedItemChange: ({ selectedItem }) => {
      if (selectedItem) onChange(selectedItem.email);
    },
    stateReducer: (_state, { type, changes }) => {
      switch (type) {
        case useCombobox.stateChangeTypes.InputChange:
          return {
            ...changes,
            highlightedIndex: 0,
            isOpen: (changes.inputValue ?? "").trim().length >= 2,
            selectedItem: null,
          };
        case useCombobox.stateChangeTypes.InputClick:
        case useCombobox.stateChangeTypes.FunctionOpenMenu:
        case useCombobox.stateChangeTypes.ToggleButtonClick:
          return { ...changes, isOpen: canSearch };
        case useCombobox.stateChangeTypes.InputKeyDownEnter:
        case useCombobox.stateChangeTypes.ItemClick:
          return { ...changes, isOpen: false };
        default:
          return changes;
      }
    },
  });
  const showMenu = isOpen && canSearch;
  function choosePerson(person: PersonSuggestion) {
    onChange(person.email);
    closeMenu();
  }

  const menuProps = getMenuProps(
    {
      "aria-label": "People suggestions",
      className: cn(
        "absolute z-30 mt-1 max-h-56 w-full overflow-auto rounded-md border border-border-strong bg-surface-raised p-1 text-sm shadow-[var(--shadow-md)]",
        !showMenu && "hidden",
      ),
      hidden: !showMenu,
    },
    { suppressRefError: true },
  );

  return (
    <div className="relative flex-1 space-y-1.5">
      <label {...getLabelProps({ className: "text-sm font-medium text-fg" })} htmlFor={inputId}>
        {label}
      </label>
      <input
        {...getInputProps({
          className: inputControl,
          placeholder,
          type: "email",
          onFocus: () => {
            if (canSearch) openMenu();
          },
          onKeyDown: (event) => {
            const highlighted = highlightedIndex >= 0 ? items[highlightedIndex] : null;
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (highlighted) {
              choosePerson(highlighted);
              return;
            }
            closeMenu();
            onSubmit();
          },
        })}
      />
      <ul {...menuProps}>
        {showMenu && searching && <li className="px-3 py-2 text-muted">Searching people...</li>}
        {showMenu && !searching && suggestions.length === 0 && (
          <li className="px-3 py-2 text-muted">No matching signed-in people</li>
        )}
        {showMenu &&
          !searching &&
          suggestions.map((person, index) => (
            <li
              key={person.id}
              {...getItemProps({
                item: person,
                index,
                className: cn(
                  "cursor-pointer rounded px-3 py-2",
                  highlightedIndex === index ? "bg-accent-subtle text-accent-strong" : "text-fg",
                ),
                onPointerDown: (event) => {
                  event.preventDefault();
                  choosePerson(person);
                },
              })}
            >
              <div className="font-medium">{person.name}</div>
              <div className="text-xs text-muted">{person.email}</div>
            </li>
          ))}
      </ul>
    </div>
  );
}
