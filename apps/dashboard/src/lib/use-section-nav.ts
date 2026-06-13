import { useEffect, useRef, useState } from "react";

/**
 * Drives a floating in-page nav's active state. Active = the last section whose
 * top has scrolled past a line just below the sticky bar — EXCEPT:
 *   - at the page bottom, the last section wins (the lower sections can never
 *     reach the line otherwise, since there's no scroll room beneath them);
 *   - a click selects its target immediately and briefly suppresses the scroll
 *     computation so the smooth-scroll can settle without the highlight flicking.
 * `select` is what the nav links call. `ready` waits for the sections to mount.
 */
export function useSectionNav(ids: readonly string[], ready: boolean) {
  const [active, setActive] = useState(ids[0] ?? "");
  const suppressUntil = useRef(0);

  useEffect(() => {
    if (!ready) return;
    const compute = () => {
      if (Date.now() < suppressUntil.current) return;
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight > window.innerHeight + 4;
      // Bottom guard: reaching the end always lands on the final section.
      if (scrollable && window.scrollY + window.innerHeight >= doc.scrollHeight - 2) {
        setActive(ids[ids.length - 1] ?? "");
        return;
      }
      const line = 96; // just below the sticky top bar (h-14) + a little breathing room
      let current = ids[0] ?? "";
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= line) current = id;
      }
      setActive(current);
    };
    compute();
    window.addEventListener("scroll", compute, { passive: true });
    window.addEventListener("resize", compute);
    return () => {
      window.removeEventListener("scroll", compute);
      window.removeEventListener("resize", compute);
    };
  }, [ids, ready]);

  const select = (id: string) => {
    setActive(id);
    suppressUntil.current = Date.now() + 700;
  };

  return { active, select };
}
