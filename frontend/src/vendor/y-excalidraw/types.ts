/**
 * Local patch, not upstream code.
 *
 * Upstream imported element types from a deep path that no longer exists in current
 * Excalidraw builds. The binding only ever reads `id` and `version` from an element and
 * carries the rest opaquely, so these structural types replace the deep import without
 * changing behaviour.
 */

export type ExcalidrawElement = { id: string; version: number } & Record<string, unknown>;
export type NonDeletedExcalidrawElement = ExcalidrawElement;
