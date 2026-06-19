import { createViewPersistence, type LayoutView } from "./view-persistence.js";

/** The owner Your-canvases layout. `grid` is the default; the choice persists
 *  per-device under its own localStorage key (separate from the gallery's). */
export type CanvasView = LayoutView;

const ownerView = createViewPersistence("canvas-drop:owner-view", "grid");

export const resolveOwnerView = ownerView.resolve;
export const readStoredOwnerView = ownerView.readStored;
export const persistOwnerView = ownerView.persist;
