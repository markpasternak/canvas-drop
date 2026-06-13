import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { lazy } from "react";
import { AppLayout } from "./app-layout.js";

// Route components are lazy-loaded so the initial bundle stays small (§13.4
// LCP / route-transition budgets — area E, U2).
const IndexRoute = lazy(() => import("./routes/index.js"));
const ArchivedRoute = lazy(() => import("./routes/archived.js"));
const NewRoute = lazy(() => import("./routes/new.js"));
const OnboardingRoute = lazy(() => import("./routes/onboarding.js"));
const CanvasLayout = lazy(() => import("./routes/canvas.js"));
const OverviewRoute = lazy(() => import("./routes/canvas.overview.js"));
const EditorRoute = lazy(() => import("./routes/canvas.editor.js"));
const VersionsRoute = lazy(() => import("./routes/canvas.versions.js"));
const SettingsRoute = lazy(() => import("./routes/canvas.settings.js"));
const CapabilitiesRoute = lazy(() => import("./routes/canvas.capabilities.js"));
const UsageRoute = lazy(() => import("./routes/canvas.usage.js"));

const rootRoute = createRootRoute({ component: AppLayout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: IndexRoute,
});
const archivedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/archived",
  component: ArchivedRoute,
});
const newRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/new",
  validateSearch: (s: Record<string, unknown>): { method?: string } => ({
    method: typeof s.method === "string" ? s.method : undefined,
  }),
  component: NewRoute,
});
const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  component: OnboardingRoute,
});

const canvasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/canvases/$id",
  component: CanvasLayout,
});
const overviewRoute = createRoute({
  getParentRoute: () => canvasRoute,
  path: "/",
  validateSearch: (s: Record<string, unknown>): { live?: boolean } => ({
    live: s.live === true || s.live === "1",
  }),
  component: OverviewRoute,
});
const editorRoute = createRoute({
  getParentRoute: () => canvasRoute,
  path: "/editor",
  component: EditorRoute,
});
const versionsRoute = createRoute({
  getParentRoute: () => canvasRoute,
  path: "/versions",
  component: VersionsRoute,
});
const settingsRoute = createRoute({
  getParentRoute: () => canvasRoute,
  path: "/settings",
  component: SettingsRoute,
});
const capabilitiesRoute = createRoute({
  getParentRoute: () => canvasRoute,
  path: "/capabilities",
  component: CapabilitiesRoute,
});
const usageRoute = createRoute({
  getParentRoute: () => canvasRoute,
  path: "/usage",
  component: UsageRoute,
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  archivedRoute,
  newRoute,
  onboardingRoute,
  canvasRoute.addChildren([
    overviewRoute,
    editorRoute,
    versionsRoute,
    settingsRoute,
    capabilitiesRoute,
    usageRoute,
  ]),
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
