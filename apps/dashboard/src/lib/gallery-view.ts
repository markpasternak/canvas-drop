import { createViewPersistence, type LayoutView } from "./view-persistence.js";

/** The gallery layout. Parallel to the owner list (same precedence) but with its
 *  own localStorage key so the two surfaces persist independently. `grid` default. */
export type GalleryView = LayoutView;

const galleryView = createViewPersistence("canvas-drop:gallery-view", "grid");

export const resolveGalleryView = galleryView.resolve;
export const readStoredGalleryView = galleryView.readStored;
export const persistGalleryView = galleryView.persist;
