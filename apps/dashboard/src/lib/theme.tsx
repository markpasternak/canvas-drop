import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";

type ThemeChoice = "system" | "light" | "dark";

const KEY = "canvas-drop-theme";
const ThemeContext = createContext<{
  choice: ThemeChoice;
  setChoice: (c: ThemeChoice) => void;
} | null>(null);

function apply(choice: ThemeChoice) {
  const el = document.documentElement;
  if (choice === "system") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", choice);
}

/** System-driven by default (prefers-color-scheme), with a persisted manual
 * override. Both themes are first-class (§14.3). */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => {
    // A `?theme=light|dark` query param wins (shareable themed links); otherwise
    // the persisted manual choice; otherwise follow the OS.
    if (typeof location !== "undefined") {
      const param = new URLSearchParams(location.search).get("theme");
      if (param === "light" || param === "dark") return param;
    }
    const stored = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    return stored === "light" || stored === "dark" ? stored : "system";
  });

  useEffect(() => {
    apply(choice);
  }, [choice]);

  const setChoice = (c: ThemeChoice) => {
    setChoiceState(c);
    try {
      if (c === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, c);
    } catch {
      /* private mode — non-fatal */
    }
  };

  return <ThemeContext.Provider value={{ choice, setChoice }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
