import { ArrowSquareOut, Copy } from "@phosphor-icons/react";
import { ActionMenu, ActionMenuItem } from "../components/ActionMenu.js";
import { ConceptBadge, PublicationBadge } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { CanvasGridCard, cardNameLinkClass } from "../components/CanvasGridCard.js";

/**
 * DEV-ONLY acceptance harness for the full-bleed preview card (UX-sweep).
 *
 * Reachable at `/__card-demo` (registered in router.tsx). It renders the SAME shared
 * {@link CanvasGridCard} the owner list + gallery use, across four representative
 * preview cases — bright, dark, busy, low-contrast — in BOTH light and dark mode side
 * by side. The acceptance bar: name + status + tags + description + actions stay
 * readable in EVERY case in BOTH modes, because the protected readability system (a
 * theme-aware scrim + local frosted surfaces) carries the contrast — NOT a lucky
 * background image.
 *
 * The cases use fixed inline-SVG data URIs (a real <img> on the card's preview path),
 * so they genuinely exercise the on-image legibility, not the seeded generative mesh.
 */

/** A flat-fill SVG data URI — used for the bright (near-white), dark (near-black) and
 *  low-contrast (flat mid-gray) cases. */
function fill(color: string): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='160'><rect width='240' height='160' fill='${color}'/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** A high-frequency busy pattern (many small bright squares) — the worst case for an
 *  unprotected overlay, where only a local surface keeps text legible. */
function busy(): string {
  let rects = "";
  const palette = ["#ffffff", "#111111", "#ff5577", "#33ccaa", "#ffcc22", "#3366ff"];
  for (let y = 0; y < 160; y += 16) {
    for (let x = 0; x < 240; x += 16) {
      const c = palette[(x + y) % palette.length];
      rects += `<rect x='${x}' y='${y}' width='16' height='16' fill='${c}'/>`;
    }
  }
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='160'>${rects}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

interface DemoCase {
  key: string;
  label: string;
  previewUrl: string;
}

const CASES: DemoCase[] = [
  { key: "bright", label: "Bright (near-white)", previewUrl: fill("#f4f4f0") },
  { key: "dark", label: "Dark (near-black)", previewUrl: fill("#0c0e12") },
  { key: "busy", label: "Busy (high-frequency)", previewUrl: busy() },
  { key: "lowcontrast", label: "Low-contrast (flat mid-gray)", previewUrl: fill("#7d7f82") },
];

/** A representative card for one preview case — owner-style actions + a gallery-style
 *  status/template badge so the whole overlay vocabulary is on screen. */
function DemoCard({ c }: { c: DemoCase }) {
  return (
    <CanvasGridCard
      seed={`demo-${c.key}`}
      title="Quarterly revenue dashboard"
      previewUrl={c.previewUrl}
      status="published"
      coverType="listed"
      onActivate={() => {}}
      nameLink={
        <a href="#demo" className={cardNameLinkClass} aria-label={`Open ${c.label}`}>
          Quarterly revenue dashboard
        </a>
      }
      badges={
        <>
          <PublicationBadge state="published" />
          <ConceptBadge concept="templates">Template</ConceptBadge>
        </>
      }
      tags={["finance", "charts", "internal", "q3", "board"]}
      description="A live revenue dashboard with weekly cohorts, pipeline, and a forecast band — the description runs long enough to clamp to two lines."
      actions={
        <ActionMenu label={`More actions for ${c.label}`}>
          <ActionMenuItem icon={<ArrowSquareOut size={15} aria-hidden />}>
            Open in new tab
          </ActionMenuItem>
          <ActionMenuItem icon={<Copy size={15} aria-hidden />}>Copy link</ActionMenuItem>
        </ActionMenu>
      }
      footer={
        <div className="flex min-w-0 items-center gap-2">
          <span className="size-5 shrink-0 rounded-full bg-white/25" aria-hidden />
          <span className="truncate text-xs text-white/85">by Alex Rivera</span>
        </div>
      }
    />
  );
}

/** One themed pane (forced light or dark) of all four cases on the page background, so
 *  the card frame (border/shadow) is judged against a real surface in each mode. */
function ThemePane({ theme }: { theme: "light" | "dark" }) {
  return (
    <div
      data-theme={theme}
      className="flex-1 rounded-xl border border-border bg-canvas p-5 text-fg"
    >
      <h2 className="mb-4 font-serif text-lg font-medium capitalize">{theme} mode</h2>
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {CASES.map((c) => (
          <li key={c.key} className="space-y-2">
            <span className="text-xs font-medium text-subtle">{c.label}</span>
            {/* The card is itself an <li>; nest it in a bare <ul> so its markup is valid
                without affecting this label list. */}
            <ul className="contents">
              <DemoCard c={c} />
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function CardDemo() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-medium">Card readability harness</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          The shared full-bleed preview card across four preview cases — bright, dark, busy,
          low-contrast — in light and dark mode side by side. Every card's name, status, tags,
          description, and actions must stay readable in all eight cells, carried by the scrim +
          local frosted surfaces (not by a lucky background).
        </p>
      </div>
      <div className="flex flex-col gap-5 xl:flex-row">
        <ThemePane theme="light" />
        <ThemePane theme="dark" />
      </div>
      <p className="text-xs text-subtle">
        Dev-only route.{" "}
        <Button variant="secondary" size="sm" onClick={() => window.print()}>
          Print / screenshot
        </Button>
      </p>
    </div>
  );
}
