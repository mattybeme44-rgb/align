/*
 * The capture library as a file: every stored entry with its sampled
 * magnitude, phase, coherence, delay, settings, note, name and date, in one
 * JSON document. An import validates the whole file before anything is added,
 * never deletes or overwrites what is stored, and reports what it did.
 */

export const LIBRARY_KIND = 'align-capture-library';
export const LIBRARY_VERSION = 1;

export function buildLibraryFile(items) {
  return {
    kind: LIBRARY_KIND,
    version: LIBRARY_VERSION,
    exported: new Date().toISOString(),
    items: Array.isArray(items) ? items : [],
  };
}

export function serializeLibrary(items) {
  return JSON.stringify(buildLibraryFile(items), null, 2);
}

function libraryKey(name, date) {
  return String(name || '').trim().toLowerCase() + '|' + String(date || '');
}

/**
 * Read a library document. The envelope is checked strictly, so a truncated or
 * foreign file is refused as a whole with a message rather than half-applied.
 */
export function parseLibrary(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      message: 'That is not an Align library file — the JSON could not be read.',
      items: [],
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: 'That is not an Align library file.', items: [] };
  }
  if (parsed.kind !== LIBRARY_KIND) {
    return { ok: false, message: 'That file does not hold an Align capture library.', items: [] };
  }

  const version = Number(parsed.version);
  if (!Number.isFinite(version) || version > LIBRARY_VERSION) {
    return { ok: false, message: 'That library was written by a newer version of Align.', items: [] };
  }
  if (!Array.isArray(parsed.items)) {
    return { ok: false, message: 'That library file is malformed.', items: [] };
  }
  if (!parsed.items.length) {
    return { ok: false, message: 'That library holds no captures.', items: [] };
  }
  if (parsed.items.length > 5000) {
    return { ok: false, message: 'That library holds too many captures to import.', items: [] };
  }

  return { ok: true, message: '', items: parsed.items };
}

/**
 * Add what is not already stored, matching on name and date. `normalize` fills
 * in an entry's missing fields; `makeId` gives a duplicate id a fresh one.
 */
export function mergeLibrary(current, incoming, normalize, makeId) {
  const merged = (current || []).slice();
  const known = new Set(merged.map((item) => libraryKey(item.name, item.date)));
  let added = 0;
  let skipped = 0;

  for (const raw of incoming || []) {
    let item;
    try {
      item = normalize(raw);
    } catch (err) {
      skipped += 1;
      continue;
    }
    if (!item || !Array.isArray(item.curve) || item.curve.length < 2) {
      skipped += 1;
      continue;
    }

    const key = libraryKey(item.name, item.date);
    if (known.has(key)) {
      skipped += 1;
      continue;
    }
    known.add(key);

    if (merged.some((entry) => entry.id === item.id)) item.id = makeId();
    merged.push(item);
    added += 1;
  }

  return { items: merged, added, skipped };
}
