/*
 * Named parametric filter sets kept beside the one being designed, newest
 * first, so a correction can be recalled rather than rebuilt.
 */

export const EQ_SET_LIMIT = 20;

const STORAGE_KEY = 'align.eqFilterSets.v1';

function normalizeSet(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim().slice(0, 40);
  if (!name) return null;
  const filters = Array.isArray(raw.filters)
    ? raw.filters.filter((filter) => filter && typeof filter === 'object').slice(0, 8)
    : [];
  return {
    id: String(raw.id || 's' + Math.random().toString(16).slice(2)),
    name,
    date: String(raw.date || new Date().toISOString()),
    filters: filters.map((filter) => ({
      id: String(filter.id || 'f' + Math.random().toString(16).slice(2)),
      kind: filter.kind || 'peaking',
      frequency: Number(filter.frequency) || 1000,
      gainDb: Number(filter.gainDb) || 0,
      q: Number(filter.q) || 1,
      enabled: filter.enabled !== false,
    })),
  };
}

export function loadEqSets() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeSet).filter(Boolean).slice(0, EQ_SET_LIMIT);
  } catch (err) {
    return [];
  }
}

/** Writes the sets, or reports that the browser refused the write. */
export function persistEqSets(items) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    return true;
  } catch (err) {
    return false;
  }
}

export function newEqSet(name, filters) {
  return {
    id: 's' + Date.now().toString(36) + '-' + Math.random().toString(16).slice(2),
    name: String(name || '').trim().slice(0, 40),
    date: new Date().toISOString(),
    filters: Array.isArray(filters) ? filters.map((filter) => ({ ...filter })) : [],
  };
}
