import { createViewPersistence, type LayoutView } from "./view-persistence.js";

/** Shared layout preference. Independent from Your canvases and Gallery. */
export type SharedView = LayoutView;

const sharedView = createViewPersistence("canvas-drop:shared-view", "grid");

export const resolveSharedView = sharedView.resolve;
export const readStoredSharedView = sharedView.readStored;
export const persistSharedView = sharedView.persist;
