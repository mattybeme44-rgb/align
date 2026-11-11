/*
 * A measurement microphone's own response, read from the calibration file its
 * maker ships: frequency and dB on each line. The correction is taken off the
 * displayed magnitude, so what is read is the loudspeaker rather than the
 * microphone in front of it. Phase, coherence and the impulse response are
 * left exactly as measured.
 */

export const CALIBRATION_KEY = 'align.micCalibration.v1';

function calibrationId() {
  return 'c' + Date.now().toString(36) + '-' + Math.random().toString(16).slice(2);
}

/** "63 Hz" or "1.25 kHz", the way the app writes a frequency. */
export function calibrationFrequencyText(frequency) {
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

export function calibrationRangeText(cal) {
  const points = cal && Array.isArray(cal.points) ? cal.points : [];
  if (!points.length) return '—';
  return calibrationFrequencyText(points[0].frequency) + ' – ' +
    calibrationFrequencyText(points[points.length - 1].frequency);
}

export function calibrationCountText(cal) {
  const count = cal && Array.isArray(cal.points) ? cal.points.length : 0;
  return count + (count === 1 ? ' point' : ' points');
}

export function calibrationSummaryText(cal) {
  if (!cal) return '';
  return cal.name + ' · ' + calibrationRangeText(cal) + ' · ' + calibrationCountText(cal);
}

/** One number from a token, tolerating kHz and stray unit characters. */
function parseNumber(token) {
  let text = String(token).toLowerCase();
  let scale = 1;
  if (text.indexOf('khz') >= 0) {
    scale = 1000;
  } else if (text.indexOf('k') >= 0 && text.indexOf('hz') < 0 && text.indexOf('db') < 0) {
    scale = 1000;
  }
  text = text.replace(/[^0-9+\-.eE]/g, '');
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value * scale : null;
}

/**
 * Read a vendor calibration file: one frequency and dB pair per line, with
 * commas, tabs, semicolons or spaces between the two, comment lines and a
 * header line both tolerated.
 */
export function parseCalibration(text, name) {
  const source = typeof text === 'string' ? text : '';
  const points = [];

  for (const rawLine of source.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (line.indexOf('#') === 0 || line.indexOf('//') === 0 || line.indexOf('*') === 0) continue;

    const hash = line.indexOf('#');
    if (hash >= 0) line = line.slice(0, hash).trim();
    if (!line) continue;

    const fields = line.split(/[\s,;]+/).filter(Boolean);
    if (fields.length < 2) continue;

    const frequency = parseNumber(fields[0]);
    const gain = parseNumber(fields[1]);
    if (frequency === null || gain === null) continue;
    if (!Number.isFinite(frequency) || !Number.isFinite(gain)) continue;
    if (frequency < 5 || frequency > 40000) continue;
    if (Math.abs(gain) > 60) continue;

    points.push({ frequency, db: gain });
  }

  if (points.length < 3) return null;
  points.sort((a, b) => a.frequency - b.frequency);

  return {
    id: calibrationId(),
    name: (name && String(name).trim()) || 'Calibration file',
    loaded: new Date().toISOString(),
    points,
  };
}

export function loadCalibration() {
  try {
    const raw = window.localStorage.getItem(CALIBRATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.points) || parsed.points.length < 2) return null;
    const points = parsed.points
      .map((point) => ({ frequency: Number(point.frequency), db: Number(point.db) }))
      .filter((point) => Number.isFinite(point.frequency) && Number.isFinite(point.db) && point.frequency > 0)
      .sort((a, b) => a.frequency - b.frequency);
    if (points.length < 2) return null;
    return {
      id: typeof parsed.id === 'string' && parsed.id ? parsed.id : calibrationId(),
      name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : 'Calibration file',
      loaded: typeof parsed.loaded === 'string' ? parsed.loaded : new Date().toISOString(),
      points,
    };
  } catch (err) {
    return null;
  }
}

export function persistCalibration(cal) {
  if (!cal) return false;
  try {
    window.localStorage.setItem(CALIBRATION_KEY, JSON.stringify(cal));
    return true;
  } catch (err) {
    return false;
  }
}

export function clearCalibration() {
  try {
    window.localStorage.removeItem(CALIBRATION_KEY);
    return true;
  } catch (err) {
    return false;
  }
}

/** The correction in dB at a frequency, zero outside the file's range. */
export function correctionDb(cal, frequency) {
  if (!cal || !Array.isArray(cal.points) || cal.points.length < 2) return 0;
  const f = Number(frequency);
  if (!Number.isFinite(f) || f <= 0) return 0;

  const points = cal.points;
  const first = points[0];
  const last = points[points.length - 1];
  if (!(f > first.frequency) || !(f < last.frequency)) return 0;

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
  return 0;
}

/**
 * The measured result with the microphone's own response taken out of the
 * displayed magnitude. Everything else is left as measured.
 */
export function applyCalibration(res, cal) {
  if (!res || !cal || !Array.isArray(cal.points) || cal.points.length < 2) return res;
  if (!(res.df > 0) || !res.magDb || res.magDb.length < 3) return res;

  const magDb = Float32Array.from(res.magDb);
  let corrected = false;
  for (let k = 1; k < magDb.length; k++) {
    const value = magDb[k];
    if (!Number.isFinite(value)) continue;
    const correction = correctionDb(cal, k * res.df);
    if (correction !== 0) {
      magDb[k] = value - correction;
      corrected = true;
    }
  }
  if (!corrected) return res;

  return Object.assign({}, res, {
    magDb,
    calibrated: true,
    calibrationName: cal.name,
  });
}
