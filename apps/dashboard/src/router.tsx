import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { lazy } from "react";
import { AppLayout } from "./app-layout.js";
import { DashboardNotFoundState, DashboardRouteErrorState } from "./components/ErrorState.js";

// Route components are lazy-loaded so the initial bundle stays small (§13.4
// LCP / route-transition budgets — area E, U2).
const IndexRoute = lazy(() => import("./routes/index.js"));
const ArchivedRoute = lazy(() => import("./routes/archived.js"));
const GalleryRoute = lazy(() => import("./routes/gallery.js"));
const NewRoute = lazy(() => import("./routes/new.js"));
const OnboardingRoute = lazy(() => import("./routes/onboarding.js"));
const CanvasLayout = lazy(() => import("./routes/canvas.js"));
const OverviewRoute = lazy(() => import("./routes/canvas.overview.js"));
const EditorRoute = lazy(() => import("./routes/canvas.editor.js"));
const VersionsRoute = lazy(() => import("./routes/canvas.versions.js"));
const SettingsRoute = lazy(() => import("./routes/canvas.settings.js"));
const CapabilitiesRoute = lazy(() => import("./routes/canvas.capabilities.js"));
const UsageRoute = lazy(() => import("./routes/canvas.usage.js"));
const AdminRoute = lazy(() => import("./routes/admin.js"));
const AdminSettingsRoute = lazy(() => import("./routes/admin.settings.js"));

const rootRoute = createRootRoute({
  component: AppLayout,
  errorComponent: DashboardRouteErrorState,
  notFoundComponent: DashboardNotFoundState,
});

/** Your-canvases filter/search/sort params (plan 004). Filtering is client-side
 *  over the already-loaded owned list. The state lives in the URL so a filtered view
 *  is shareable and back-button-able. The index route is left UN-validated on
 *  purpose: typing a fourth search route tips TanStack's un-anchored `navigate`
 *  inference into whole-router union mode (which breaks the gallery's updaters), so
 *  the view reads `useSearch` loosely and coerces these params itself. */
export type CanvasesSortParam = "updated" | "created" | "title";
export interface CanvasesSearch {
  q?: string;
  sort?: CanvasesSortParam;
  shared?: boolean;
  protected?: boolean;
  listed?: boolean;
  template?: boolean;
  undeployed?: boolean;
}
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
/** Gallery browse search params (shared with the gallery view). Filters + sort
 *  (plan 004) live here too so a filtered view is shareable and back-button-able. */
export type GallerySortParam = "published" | "updated" | "title";
export interface GallerySearch {
  q?: string;
  tag?: string;
  owner?: string;
  templatable?: boolean;
  sort?: GallerySortParam;
  page?: number;
}
const galleryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/gallery",
  validateSearch: (s: Record<string, unknown>): GallerySearch => ({
    q: typeof s.q === "string" && s.q.length > 0 ? s.q : undefined,
    tag: typeof s.tag === "string" && s.tag.length > 0 ? s.tag : undefined,
    owner: typeof s.owner === "string" && s.owner.length > 0 ? s.owner : undefined,
    // Only the literal `true` flips it on, so a junk value just means "off".
    templatable: s.templatable === true || s.templatable === "true" || undefined,
    sort: s.sort === "updated" || s.sort === "title" || s.sort === "published" ? s.sort : undefined,
    page: typeof s.page === "number" ? s.page : Number(s.page) || undefined,
  }),
  component: GalleryRoute,
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

// Admin surface (§6.10, M7). Top-level routes (NOT under /c/, /api/, /v1/, /auth/
// — those are reserved, dashboard-spa-patterns). The server 404s non-admins; the
// nav entry is hidden for non-admins, but the routes exist for everyone.
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: AdminRoute,
});
const adminSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/settings",
  component: AdminSettingsRoute,
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
  galleryRoute,
  newRoute,
  onboardingRoute,
  adminRoute,
  adminSettingsRoute,
  canvasRoute.addChildren([
    overviewRoute,
    editorRoute,
    versionsRoute,
    settingsRoute,
    capabilitiesRoute,
    usageRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultErrorComponent: DashboardRouteErrorState,
  defaultNotFoundComponent: DashboardNotFoundState,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
