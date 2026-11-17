import { correctionDb } from './calibration.js';

/*
 * Relative microphone matching.
 *
 * Two microphones side by side in the same sound field should report the same
 * curve. The difference between them is the correction that brings B (or C) onto
 * the reference microphone A. This is relative matching — it says nothing about
 * either microphone's absolute accuracy, and it is not laboratory calibration.
 *
 * Manufacturer calibration files stay a separate correction: one per microphone,
 * from the maker, holding the microphone's own deviation from a reference.
 */

export const MATCH_LETTERS = ['A', 'B', 'C'];
export const MATCH_REFERENCE = 'A';

export const MATCH_DEFAULTS = {
  smoothing: 1 / 6,
  fMin: 40,
  fMax: 16000,
  maxDb: 6,
  coherence: 0.6,
  minCoverage: 0.35,
  minOctaves: 2,
};

const MATCH_KEY = 'align.multiMicMatch.v1';
const MIC_CAL_KEY = 'align.multiMicCalibration.v1';

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value, limit) {
  return Math.max(-limit, Math.min(limit, value));
}

function readStore(key) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function writeStore(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Fractional-octave smoothing of a dB curve, done in the dB domain because the
 * input is already a difference between two responses.
 */
export function smoothDbCurve(values, df, octaves) {
  const bins = values.length;
  const out = new Float64Array(bins);
  if (!(bins > 2) || !(df > 0)) {
    out.set(values);
    return out;
  }

  const cum = new Float64Array(bins + 1);
  for (let k = 0; k < bins; k++) cum[k + 1] = cum[k] + (finite(values[k]) ? values[k] : 0);

  const ratio = Math.pow(2, Math.max(0, octaves) / 2);
  for (let k = 0; k < bins; k++) {
    const f = Math.max(k * df, df);
    const k0 = Math.max(1, Math.floor(f / ratio / df));
    const k1 = Math.min(bins - 1, Math.ceil((f * ratio) / df));
    if (k1 < k0) {
      out[k] = finite(values[k]) ? values[k] : 0;
      continue;
    }
    out[k] = (cum[k1 + 1] - cum[k0]) / (k1 - k0 + 1);
  }
  return out;
}

/**
 * Match `target` onto `reference` and return the correction in dB per bin.
 *
 * Rejects the measurement outright when too little of the band is coherent —
 * three microphones in a room always disagree where the room cancels, and
 * correcting for a cancellation would bake a room artefact into every later
 * measurement.
 */
export function relativeMatch(reference, target, options) {
  const opts = Object.assign({}, MATCH_DEFAULTS, options || {});
  const reject = (reason) => ({
    accepted: false,
    reason,
    correction: new Float32Array(0),
    difference: new Float64Array(0),
    residual: 0,
    coverage: 0,
    usableBins: 0,
    firstHz: 0,
    lastHz: 0,
  });

  if (!reference || !target) return reject('both microphones need a measurement');
  if (!(reference.bins > 2) || reference.bins !== target.bins) {
    return reject('the two measurements are not on the same frequency grid');
  }
  if (!(reference.df > 0) || reference.df !== target.df) {
    return reject('the two measurements do not share a sample rate');
  }

  const bins = reference.bins;
  const df = reference.df;
  const usable = new Uint8Array(bins);
  const diff = new Float64Array(bins);

  let count = 0;
  let inRange = 0;
  let first = -1;
  let last = -1;

  for (let k = 1; k < bins; k++) {
    const f = k * df;
    if (f < opts.fMin || f > opts.fMax) continue;
    inRange += 1;

    const refCoh = finite(reference.coh[k]) ? reference.coh[k] : 0;
    const targetCoh = finite(target.coh[k]) ? target.coh[k] : 0;
    const coherence = Math.min(refCoh, targetCoh);

    const a = reference.magDb[k];
    const b = target.magDb[k];
    if (!finite(refCoh) || !finite(targetCoh) || !finite(a) || !finite(b)) continue;
    if (coherence < opts.coherence) continue;

    // The correction is what has to be ADDED to this microphone to arrive at the
    // reference microphone: reference minus target.
    diff[k] = reference.magDb[k] - target.magDb[k];
    usable[k] = 1;
    count += 1;
    if (first < 0) first = k;
    last = k;
  }

  const coverage = inRange > 0 ? count / inRange : 0;
  if (count < 8 || first < 0) {
    return reject('no usable overlap — the microphones did not hear the same signal');
  }
  if (coverage < opts.minCoverage) {
    return reject('only ' + Math.round(coverage * 100) +
      '% of the band is coherent — this is not a stable capture to match from');
  }

  const firstHz = first * df;
  const lastHz = last * df;
  if (Math.log2(lastHz / firstHz) < opts.minOctaves) {
    return reject('the usable band is too narrow to match over');
  }

  // Straight-line fill between the usable bins, and hold the end values beyond
  // them, so the smoothing has a continuous curve to work on.
  let previous = first;
  for (let k = first + 1; k <= last; k++) {
    if (!usable[k]) continue;
    if (k - previous > 1) {
      const a = diff[previous];
      const b = diff[k];
      const span = k - previous;
      for (let step = 1; step < span; step++) {
        diff[previous + step] = a + ((b - a) * step) / span;
      }
    }
    previous = k;
  }
  for (let k = 1; k < first; k++) diff[k] = diff[first];
  for (let k = last + 1; k < bins; k++) diff[k] = diff[last];

  const smoothed = smoothDbCurve(diff, df, opts.smoothing);
  const correction = new Float32Array(bins);
  let residualPower = 0;
  let residualCount = 0;

  for (let k = 1; k < bins; k++) {
    const f = k * df;
    if (f < opts.fMin || f > opts.fMax) {
      correction[k] = 0;
      continue;
    }
    const value = clamp(smoothed[k], opts.maxDb);
    correction[k] = value;
    if (usable[k]) {
      const left = diff[k] - value;
      residualPower += left * left;
      residualCount += 1;
    }
  }

  return {
    accepted: true,
    reason: '',
    correction,
    difference: diff,
    residual: residualCount ? Math.sqrt(residualPower / residualCount) : 0,
    coverage,
    usableBins: count,
    firstHz,
    lastHz,
  };
}

/** Add a correction curve to a magnitude curve, returning a new array. */
export function applyCorrection(magDb, correction) {
  if (!correction || correction.length !== magDb.length) return magDb;
  const out = new Float32Array(magDb.length);
  for (let k = 0; k < magDb.length; k++) {
    const value = magDb[k];
    out[k] = finite(value) && finite(correction[k]) ? value + correction[k] : value;
  }
  return out;
}

/** Two corrections added, for a microphone with a file and a match. */
export function combineCorrections(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const bins = Math.min(a.length, b.length);
  const out = new Float32Array(bins);
  for (let k = 0; k < bins; k++) {
    out[k] = (finite(a[k]) ? a[k] : 0) + (finite(b[k]) ? b[k] : 0);
  }
  return out;
}

/** A correction curve from a manufacturer calibration file, over the bins. */
export function calibrationCurve(cal, bins, df) {
  if (!cal || !Array.isArray(cal.points) || !cal.points.length) return null;
  const out = new Float32Array(bins);
  for (let k = 1; k < bins; k++) {
    out[k] = correctionDb(cal, k * df) || 0;
  }
  return out;
}

/** Everything needed to rebuild a stored correction: log-spaced points. */
export function decimateCurve(correction, bins, df, points) {
  const want = Math.max(24, Math.min(720, points || 360));
  const out = [];
  const low = Math.log(20);
  const high = Math.log(20000);
  for (let i = 0; i < want; i++) {
    const frequency = Math.exp(low + ((high - low) * i) / (want - 1));
    const position = frequency / df;
    const lower = Math.max(0, Math.min(bins - 1, Math.floor(position)));
    const upper = Math.min(bins - 1, lower + 1);
    const t = Math.min(1, Math.max(0, position - lower));
    const value = (correction[lower] || 0) * (1 - t) + (correction[upper] || 0) * t;
    out.push({ frequency: Math.round(frequency * 10) / 10, db: Math.round(value * 100) / 100 });
  }
  return out;
}

/** Rebuild a stored correction onto the live bins. */
export function curveFromPoints(points, bins, df) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const out = new Float32Array(bins);
  // Positive frequencies only: the interpolation is in log frequency, the same
  // axis the vendor curves use and the one the chart draws.
  const values = points
    .filter((point) => point && finite(Number(point.frequency)) && finite(Number(point.db))
      && Number(point.frequency) > 0)
    .map((point) => ({ frequency: Number(point.frequency), db: Number(point.db) }))
    .sort((a, b) => a.frequency - b.frequency);
  if (values.length < 2) return null;

  for (let k = 1; k < bins; k++) {
    const frequency = k * df;
    if (frequency <= values[0].frequency) {
      out[k] = values[0].db;
      continue;
    }
    if (frequency >= values[values.length - 1].frequency) {
      out[k] = values[values.length - 1].db;
      continue;
    }
    let index = 0;
    while (index < values.length - 2 && values[index + 1].frequency < frequency) index += 1;
    const a = values[index];
    const b = values[index + 1];
    const logA = Math.log(a.frequency);
    const span = Math.max(1e-9, Math.log(b.frequency) - logA);
    const t = (Math.log(frequency) - logA) / span;
    out[k] = a.db * (1 - t) + b.db * t;
  }
  return out;
}

/* ---------- stored profiles ---------- */

export function loadMatchProfiles() {
  const stored = readStore(MATCH_KEY);
  return Array.isArray(stored) ? stored.filter((item) => item && Array.isArray(item.points)) : [];
}

export function persistMatchProfiles(profiles) {
  const list = Array.isArray(profiles) ? profiles : [];
  return writeStore(MATCH_KEY, list);
}

export function newMatchProfile(mic, points, detail) {
  return {
    id: 'mm' + Date.now().toString(36) + '-' + Math.random().toString(16).slice(2),
    mic,
    reference: MATCH_REFERENCE,
    points,
    name: 'Match ' + mic + ' to ' + MATCH_REFERENCE,
    coverage: detail && finite(detail.coverage) ? detail.coverage : 0,
    residual: detail && finite(detail.residual) ? detail.residual : 0,
    firstHz: detail && finite(detail.firstHz) ? detail.firstHz : 0,
    lastHz: detail && finite(detail.lastHz) ? detail.lastHz : 0,
    created: new Date().toISOString(),
  };
}

/* ---------- manufacturer calibration per microphone ---------- */

export function loadMicCalibrations() {
  const stored = readStore(MIC_CAL_KEY);
  const map = {};
  for (const letter of MATCH_LETTERS) {
    const item = stored && stored[letter];
    if (item && Array.isArray(item.points) && item.points.length) {
      map[letter] = { name: String(item.name || 'Calibration'), points: item.points };
    }
  }
  return map;
}

export function persistMicCalibrations(map) {
  return writeStore(MIC_CAL_KEY, map || {});
}
