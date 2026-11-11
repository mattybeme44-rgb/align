/*
 * Magnitude targets the live curve can be read against: flat, a gentle tilt
 * above 1 kHz, a room curve with a low-frequency rise, or a curve the operator
 * draws by hand. 0 dB is the level the app normalises to, so a target never
 * moves the measurement itself.
 */

export const TARGET_CURVES = [
  { id: 'flat', label: 'Flat' },
  { id: 'tilt', label: '−1 dB/oct above 1 kHz' },
  { id: 'room', label: 'Room curve (+6 dB low end)' },
];

export const CUSTOM_TARGET_KEY = 'align.customTargets.v1';
export const TARGET_START_FREQUENCIES = [20, 63, 250, 1000, 4000, 20000];

const CUSTOM_PREFIX = 'custom:';
const TARGET_LIMIT = 40;

export function customTargetId() {
  return 't' + Date.now().toString(36) + '-' + Math.random().toString(16).slice(2);
}

/** "63 Hz" or "1.25 kHz", the way the app writes a frequency. */
export function frequencyText(frequency) {
  const value = Number(frequency);
  if (!Number.isFinite(value)) return '—';
  if (value >= 1000) {
    const thousands = value / 1000;
    const text = Math.abs(thousands - Math.round(thousands)) < 1e-9
      ? thousands.toFixed(0)
      : thousands.toFixed(2);
    return text + ' kHz';
  }
  return Math.abs(value - Math.round(value)) < 1e-9
    ? value.toFixed(0) + ' Hz'
    : value.toFixed(1) + ' Hz';
}

/** The target in dB, 0 dB being the app's normalised reference level. */
export function builtInTargetDb(id, frequency) {
  const f = Math.max(Number(frequency) || 0, 1);
  if (id === 'tilt') {
    if (f <= 1000) return 0;
    return -Math.log2(f / 1000);
  }
  if (id === 'room') {
    if (f >= 200) return 0;
    const t = Math.log2(200 / f) / Math.log2(200 / 30);
    return 6 * Math.min(1, Math.max(0, t));
  }
  return 0;
}

export function sortedTargetPoints(target) {
  const points = target && Array.isArray(target.points) ? target.points : [];
  return points
    .filter((point) => point && Number.isFinite(Number(point.frequency)) && Number.isFinite(Number(point.db)))
    .map((point) => ({ frequency: Number(point.frequency), db: Number(point.db) }))
    .sort((a, b) => a.frequency - b.frequency);
}

/** Straight lines in dB between the points, on a log axis, flat beyond the ends. */
export function customTargetDb(target, frequency) {
  const points = sortedTargetPoints(target);
  if (!points.length) return 0;

  const first = points[0];
  const last = points[points.length - 1];
  const f = Math.max(Number(frequency) || 0, 1);
  if (f <= first.frequency) return first.db;
  if (f >= last.frequency) return last.db;

  const lf = Math.log(f);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (!(b.frequency > a.frequency)) continue;
    if (f > b.frequency) continue;
    const span = Math.log(b.frequency) - Math.log(a.frequency);
    if (!(span > 1e-9)) return b.db;
    const t = Math.min(1, Math.max(0, (lf - Math.log(a.frequency)) / span));
    return a.db + (b.db - a.db) * t;
  }
  return last.db;
}

/** Built-in id, `custom:<id>` or null, resolved to dB at a frequency. */
export function targetDb(ref, frequency, customs) {
  if (!ref) return 0;
  if (typeof ref === 'string' && ref.indexOf(CUSTOM_PREFIX) === 0) {
    const id = ref.slice(CUSTOM_PREFIX.length);
    const target = (customs || []).find((item) => item.id === id);
    return target ? customTargetDb(target, frequency) : 0;
  }
  return builtInTargetDb(ref, frequency);
}

export function isCustomTargetRef(ref) {
  return typeof ref === 'string' && ref.indexOf(CUSTOM_PREFIX) === 0;
}

export function customTargetRef(id) {
  return CUSTOM_PREFIX + id;
}

export function customTargetIdFromRef(ref) {
  return isCustomTargetRef(ref) ? ref.slice(CUSTOM_PREFIX.length) : null;
}

/** Sorted, de-duplicated and clamped, so a drawn target cannot break a chart. */
export function normalizeTarget(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const name = typeof source.name === 'string' && source.name.trim()
    ? source.name.trim().slice(0, 40)
    : 'My target';
  const id = typeof source.id === 'string' && source.id ? source.id : customTargetId();

  const list = Array.isArray(source.points) ? source.points : [];
  const cleaned = list
    .map((point) => ({
      frequency: Number(point && point.frequency),
      db: Number(point && point.db),
    }))
    .filter((point) => Number.isFinite(point.frequency) && Number.isFinite(point.db))
    .map((point) => ({
      frequency: Math.min(20000, Math.max(20, point.frequency)),
      db: Math.min(24, Math.max(-24, point.db)),
    }))
    .sort((a, b) => a.frequency - b.frequency);

  const points = [];
  for (const point of cleaned) {
    const last = points[points.length - 1];
    if (last && point.frequency / last.frequency < 1.02) {
      points[points.length - 1] = point;
      continue;
    }
    points.push(point);
    if (points.length === TARGET_LIMIT) break;
  }

  return { id, name, points };
}

export function loadCustomTargets() {
  try {
    const raw = window.localStorage.getItem(CUSTOM_TARGET_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeTarget)
      .filter((target) => target.points.length >= 2);
  } catch (err) {
    return [];
  }
}

export function persistCustomTargets(items) {
  try {
    window.localStorage.setItem(CUSTOM_TARGET_KEY, JSON.stringify(items || []));
    return true;
  } catch (err) {
    return false;
  }
}

export function starterTarget(name) {
  return normalizeTarget({
    name: name || 'My target',
    points: TARGET_START_FREQUENCIES.map((frequency) => ({ frequency, db: 0 })),
  });
}

/** A point in the widest gap between the existing ones, at their level. */
export function targetPointInWidestGap(target) {
  const points = sortedTargetPoints(target);
  if (points.length < 2) return { frequency: 1000, db: 0 };

  let bestGap = 0;
  let frequency = 1000;
  for (let i = 1; i < points.length; i++) {
    const gap = Math.log(points[i].frequency / points[i - 1].frequency);
    if (gap > bestGap) {
      bestGap = gap;
      frequency = Math.sqrt(points[i].frequency * points[i - 1].frequency);
    }
  }
  return { frequency, db: customTargetDb(target, frequency) };
}

export function targetRangeText(target) {
  const points = sortedTargetPoints(target);
  if (!points.length) return '—';
  return frequencyText(points[0].frequency) + ' – ' + frequencyText(points[points.length - 1].frequency);
}

export function targetSummaryText(target) {
  const count = sortedTargetPoints(target).length;
  return count + (count === 1 ? ' point · ' : ' points · ') + targetRangeText(target);
}

/* ---------- moving a curve between devices ---------- */

/** One target as portable JSON text, or null when it cannot be written. */
export function serializeTarget(target) {
  const points = sortedTargetPoints(target);
  if (points.length < 2) return null;
  return JSON.stringify({
    kind: 'align-target',
    version: 1,
    name: target && target.name ? target.name : 'My target',
    points,
  }, null, 2);
}

/**
 * Read a portable target file back, rejecting anything malformed rather
 * than half-importing it.
 */
export function parseTargetFile(text) {
  let envelope = null;
  try { envelope = JSON.parse(text); } catch (err) { /* not JSON */ }
  if (!envelope || typeof envelope !== 'object') {
    return { ok: false, message: 'That file is not a target curve — a JSON file with a name and points was expected.' };
  }
  if (envelope.kind !== 'align-target') {
    return { ok: false, message: 'That file is not an Align target curve.' };
  }

  const name = typeof envelope.name === 'string' ? envelope.name.trim() : '';
  if (!name) {
    return { ok: false, message: "The curve's name is missing — it was rejected rather than half-imported." };
  }

  const rawPoints = Array.isArray(envelope.points) ? envelope.points : [];
  if (rawPoints.length < 2) {
    return { ok: false, message: 'The curve needs at least two frequency and dB points — it was rejected rather than half-imported.' };
  }

  const points = [];
  for (const raw of rawPoints) {
    const frequency = Number(raw && raw.frequency);
    const db = Number(raw && raw.db);
    if (!Number.isFinite(frequency) || !Number.isFinite(db)
        || frequency < 5 || frequency > 40000 || Math.abs(db) > 60) {
      return { ok: false, message: 'A point in the file sits outside the measurable range — it was rejected rather than half-imported.' };
    }
    points.push({ frequency, db });
  }

  return { ok: true, target: normalizeTarget({ name, points }) };
}
