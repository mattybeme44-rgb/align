/*
 * Where the modeler's library, project and panel layout are kept.
 *
 * Everything is browser-local, like the capture library: a failure is reported
 * to the caller so the screen can say a save did not happen, and a blocked or
 * full storage never leaves the screen claiming success.
 */

import { emptyProject, normalizeProject } from './model.js';

export const MODEL_LIBRARY_KEY = 'align.modeler.library.v1';
export const MODEL_PROJECT_KEY = 'align.modeler.project.v1';
export const MODEL_LAYOUT_KEY = 'align.modeler.layout.v1';

export function readJson(key) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

export function writeJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    return false;
  }
}

export function loadProject() {
  const stored = readJson(MODEL_PROJECT_KEY);
  return normalizeProject(stored && stored.project ? stored.project : stored || emptyProject());
}

export function persistProject(project) {
  return writeJson(MODEL_PROJECT_KEY, { version: 1, saved: new Date().toISOString(), project });
}

export function loadLayout() {
  const stored = readJson(MODEL_LAYOUT_KEY);
  return stored && typeof stored === 'object' ? stored : { docks: {}, collapsed: {}, colors: {} };
}

export function persistLayout(layout) {
  return writeJson(MODEL_LAYOUT_KEY, layout || {});
}
