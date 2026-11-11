/*
 * A magnitude curve brought in from another tool. The whole file is checked
 * before anything is stored: a foreign or broken CSV is refused with a message
 * rather than half-imported.
 */

const POINT_COUNT = 400;
const F_MIN = 20;
const F_MAX = 20000;
const MINIMUM_POINTS = 20;

function frequencyLabel(frequency) {
  if (frequency >= 1000) {
    const thousands = frequency / 1000;
    return (Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(2)) + ' kHz';
  }
  return frequency.toFixed(0) + ' Hz';
}

function isComment(line) {
  return line.startsWith('#') || line.startsWith('//') ||
    line.startsWith('%') || line.startsWith('*') || line.startsWith('--');
}

function numberFrom(text) {
  const cleaned = String(text).replace(/[^0-9+\-.eE]/g, '');
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function splitFields(line) {
  const candidates = [',', '\t', ';'];
  const counts = candidates.map((delimiter) => line.split(delimiter).length - 1);
  let best = 0;
  for (let i = 1; i < counts.length; i += 1) {
    if (counts[i] > counts[best]) best = i;
  }
  if (!counts[best]) {
    return { fields: line.trim().split(/\s+/).map(cleanField) };
  }
  const delimiter = candidates[best];
  return {
    fields: line.split(delimiter).map((value) => cleanField(value, delimiter)),
  };
}

function cleanField(value, delimiter) {
  let text = String(value).trim().replace(/\u00a0/g, ' ');
  if (text.length >= 2 &&
      ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    text = text.slice(1, -1);
  }
  if (delimiter && delimiter !== ',') text = text.replace(/,/g, '.');
  return text.trim();
}

function headerIndices(fields) {
  const lowered = fields.map((value) => value.toLowerCase());
  const frequency = lowered.findIndex((value) =>
    value.includes('freq') || value === 'hz' || value.includes('(hz'));
  const level = lowered.findIndex((value) =>
    !value.includes('phase') &&
    (value.includes('mag') || value.includes('db') || value.includes('level') || value.includes('spl')));
  if (frequency < 0 || level < 0 || frequency === level) return null;
  return { frequency, level };
}

/** Lay the file's points onto the library's 400-point log grid. */
function curveFromPoints(points) {
  const values = new Float32Array(POINT_COUNT);
  const span = Math.log(F_MAX / F_MIN);

  for (let i = 0; i < POINT_COUNT; i += 1) {
    const frequency = F_MIN * Math.exp((i / (POINT_COUNT - 1)) * span);
    if (frequency <= points[0].frequency) {
      values[i] = Math.min(40, Math.max(-140, points[0].db));
      continue;
    }
    const last = points[points.length - 1];
    if (frequency >= last.frequency) {
      values[i] = Math.min(40, Math.max(-140, last.db));
      continue;
    }

    let lower = 0;
    while (lower + 2 < points.length && points[lower + 1].frequency < frequency) lower += 1;
    const a = points[lower];
    const b = points[Math.min(lower + 1, points.length - 1)];
    const spanHz = Math.log(b.frequency) - Math.log(a.frequency);
    const fraction = spanHz > 1e-9 ? (Math.log(frequency) - Math.log(a.frequency)) / spanHz : 0;
    const db = a.db + (b.db - a.db) * Math.min(1, Math.max(0, fraction));
    values[i] = Math.min(40, Math.max(-140, db));
  }

  const smoothed = new Float32Array(POINT_COUNT);
  for (let i = 0; i < POINT_COUNT; i += 1) {
    const a = values[Math.max(0, i - 1)];
    const b = values[i];
    const c = values[Math.min(POINT_COUNT - 1, i + 1)];
    smoothed[i] = (a + 2 * b + c) / 4;
  }
  return Array.from(smoothed);
}

export function parseMeasurementCsv(text, fileName) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, message: 'That file is empty.' };
  }

  let body = text.replace(/^\uFEFF/, '');
  const points = [];
  let frequencyIndex = null;
  let levelIndex = null;
  let sawHeader = false;

  for (const rawLine of body.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!line || isComment(line)) continue;

    const split = splitFields(line);
    const fields = split.fields;
    if (!fields.length) continue;

    if (!sawHeader) {
      const header = headerIndices(fields);
      if (header) {
        frequencyIndex = header.frequency;
        levelIndex = header.level;
        sawHeader = true;
        continue;
      }
    }

    const fp = frequencyIndex === null ? 0 : frequencyIndex;
    const lp = levelIndex === null ? 1 : levelIndex;
    if (fields.length <= Math.max(fp, lp)) continue;

    const frequency = numberFrom(fields[fp]);
    const db = numberFrom(fields[lp]);
    if (frequency === null || db === null || !(frequency > 0)) continue;

    points.push({ frequency, db });
  }

  if (points.length < MINIMUM_POINTS) {
    return {
      ok: false,
      message: 'That file holds ' + points.length + ' frequency and level pairs — at least ' +
        MINIMUM_POINTS + ' are needed.',
    };
  }

  for (let i = 1; i < points.length; i += 1) {
    if (points[i].frequency === points[i - 1].frequency) {
      return { ok: false, message: 'That file lists ' + frequencyLabel(points[i].frequency) + ' twice.' };
    }
    if (points[i].frequency < points[i - 1].frequency) {
      return { ok: false, message: "That file's frequencies are not in ascending order." };
    }
  }

  const trimmedName = String(fileName || '').trim();
  const base = trimmedName.replace(/\.[^.]+$/, '');
  const name = (base || 'Imported measurement').slice(0, 60);
  const lowest = points[0].frequency;
  const highest = points[points.length - 1].frequency;

  return {
    ok: true,
    message: '',
    name,
    sourceName: trimmedName || name + '.csv',
    points,
    pointCount: points.length,
    rangeText: frequencyLabel(lowest) + ' – ' + frequencyLabel(highest),
    curve: curveFromPoints(points),
  };
}
