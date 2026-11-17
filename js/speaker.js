/*
 * Individual speaker captures: the catalogue of speakers in the system, the
 * extra metadata a speaker capture carries (venue, event, microphone position,
 * interface and calibration), the impulse envelope stored with each capture,
 * and the trace adapter that lets two saved captures be summed as a prediction.
 *
 * Everything here is pure so the synthetic tests can exercise it without a
 * browser: no DOM, no storage, no analyser.
 */

export const CURVE_FMIN = 20;
export const CURVE_FMAX = 20000;

/** The speakers a rig has until the operator adds their own names. */
export const DEFAULT_SPEAKERS = [
  { id: 'sub-1', name: 'Subwoofer 1', group: 'Subwoofers' },
  { id: 'sub-2', name: 'Subwoofer 2', group: 'Subwoofers' },
  { id: 'sub-3', name: 'Subwoofer 3', group: 'Subwoofers' },
  { id: 'sub-4', name: 'Subwoofer 4', group: 'Subwoofers' },
  { id: 'sub-5', name: 'Subwoofer 5', group: 'Subwoofers' },
  { id: 'sub-6', name: 'Subwoofer 6', group: 'Subwoofers' },
  { id: 'sub-7', name: 'Subwoofer 7', group: 'Subwoofers' },
  { id: 'sub-8', name: 'Subwoofer 8', group: 'Subwoofers' },
  { id: 'main-l-inner', name: 'Main L Inner', group: 'Mains' },
  { id: 'main-l-outer', name: 'Main L Outer', group: 'Mains' },
  { id: 'main-r-inner', name: 'Main R Inner', group: 'Mains' },
  { id: 'main-r-outer', name: 'Main R Outer', group: 'Mains' },
  { id: 'mid-delay-l', name: 'Mid Delay L', group: 'Delays' },
  { id: 'mid-delay-r', name: 'Mid Delay R', group: 'Delays' },
  { id: 'rear-delay-l', name: 'Rear Delay L', group: 'Delays' },
  { id: 'rear-delay-r', name: 'Rear Delay R', group: 'Delays' },
];

function text(value, limit) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, limit);
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampNumber(value, low, high, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(high, Math.max(low, number));
}

/** The frequency of one point on the library's log grid (20 Hz – 20 kHz). */
export function curveFrequency(index, count) {
  const points = Math.max(2, Math.floor(Number(count) || 2));
  const t = Math.min(1, Math.max(0, index / (points - 1)));
  return CURVE_FMIN * Math.exp(t * Math.log(CURVE_FMAX / CURVE_FMIN));
}

/** A list of {id, name, group} speakers, with junk dropped. */
export function normalizeSpeakerList(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const list = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const name = text(entry.name, 80);
    if (!name) continue;
    const id = text(entry.id, 60) || name.toLocaleLowerCase();
    const key = id.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ id, name, group: text(entry.group, 40) || 'Custom' });
  }
  return list;
}

/**
 * Add a custom speaker by name. A name already in the list is refused rather
 * than duplicated, so the catalogue stays unambiguous.
 */
export function addCustomSpeaker(list, name, group = 'Custom') {
  const cleanName = text(name, 80);
  if (!cleanName) return { ok: false, message: 'Speaker name cannot be empty.', speakers: list };
  const existing = normalizeSpeakerList(list);
  const key = cleanName.toLocaleLowerCase();
  for (const entry of existing) {
    if (entry.name.toLocaleLowerCase() === key) {
      return { ok: false, message: '“' + entry.name + '” is already in the list.', speakers: list };
    }
  }
  const id = 'custom-' + Date.now().toString(36) + '-' + Math.random().toString(16).slice(2, 6);
  return {
    ok: true,
    message: '',
    speakers: normalizeSpeakerList([...existing, { id, name: cleanName, group: text(group, 40) || 'Custom' }]),
  };
}

export function speakerById(list, id) {
  const wanted = String(id || '');
  if (!wanted) return null;
  for (const entry of normalizeSpeakerList(list)) {
    if (entry.id === wanted) return entry;
  }
  return null;
}

/**
 * The impulse response as an envelope in dB, one value per time bucket, used
 * for the stored ETC view of a capture. The IR from the analyser is circular,
 * so a bucket that runs past the end wraps; the peak is found by scanning, and
 * buckets are counted relative to it. An IR with nothing above the -120 dB
 * floor returns null — there is no honest envelope to show.
 */
export function impulseEnvelope(irDb, sampleRate, fftSize, options = {}) {
  if (!irDb || irDb.length < 2 || !(sampleRate > 0) || !(fftSize > 0)) return null;
  const n = Math.min(irDb.length, Math.round(fftSize));
  if (n < 8) return null;

  let peak = -Infinity;
  let peakIndex = 0;
  for (let i = 0; i < n; i += 1) {
    const value = irDb[i];
    if (Number.isFinite(value) && value > peak) {
      peak = value;
      peakIndex = i;
    }
  }
  if (!(peak > -119)) return null;

  const beforeMs = clampNumber(options.beforeMs, 0, 50, 5);
  const afterMs = clampNumber(options.afterMs, 10, 500, 150);
  const stepMs = clampNumber(options.stepMs, 0.1, 10, 1);
  const stepSamples = Math.max(1, Math.round((sampleRate * stepMs) / 1000));
  const beforeSamples = Math.round((sampleRate * beforeMs) / 1000);
  const count = Math.ceil((beforeMs + afterMs) / stepMs) + 1;

  const values = new Array(count);
  for (let b = 0; b < count; b += 1) {
    const start = peakIndex - beforeSamples + b * stepSamples;
    let max = -Infinity;
    for (let s = 0; s < stepSamples; s += 1) {
      const index = ((start + s) % n + n) % n;
      const value = irDb[index];
      if (Number.isFinite(value) && value > max) max = value;
    }
    values[b] = Number.isFinite(max) ? Math.max(-120, max) : -120;
  }

  // The peak's time within the analysis window, wrapped to ±half a window.
  const wrappedIndex = peakIndex > n / 2 ? peakIndex - n : peakIndex;
  return {
    startMs: -beforeMs,
    stepMs: (stepSamples * 1000) / sampleRate,
    peakMs: (wrappedIndex * 1000) / sampleRate,
    values,
  };
}

/** A stored envelope, read back safely from storage or an imported file. */
export function normalizeImpulseEnvelope(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.values)) return null;
  if (raw.values.length < 2) return null;
  const values = [];
  for (const value of raw.values) {
    const number = Number(value);
    values.push(Number.isFinite(number) ? Math.max(-120, Math.min(40, number)) : -120);
  }
  return {
    startMs: clampNumber(raw.startMs, -50, 0, -5),
    stepMs: clampNumber(raw.stepMs, 0.1, 10, 1),
    peakMs: clampNumber(raw.peakMs, -10000, 10000, 0),
    values,
  };
}

function normalizeSpeakerInfo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = text(raw.name, 80);
  if (!name) return null;
  return {
    id: text(raw.id, 60) || name.toLocaleLowerCase(),
    name,
    group: text(raw.group, 40) || 'Custom',
  };
}

function normalizeMicPosition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const label = text(raw.label, 80);
  const distanceM = finite(raw.distanceM);
  const heightM = finite(raw.heightM);
  const cleanDistance = distanceM !== null && distanceM >= 0 ? distanceM : null;
  const cleanHeight = heightM !== null && heightM >= 0 ? heightM : null;
  if (!label && cleanDistance === null && cleanHeight === null) return null;
  return { label, distanceM: cleanDistance, heightM: cleanHeight };
}

function normalizeInputs(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const device = text(raw.device, 120);
  const sampleRate = finite(raw.sampleRate);
  const micChannel = Number(raw.micChannel);
  const refChannel = Number(raw.refChannel);
  const cleanMic = Number.isInteger(micChannel) && micChannel >= 0 ? micChannel : null;
  const cleanRef = Number.isInteger(refChannel) && refChannel >= 0 ? refChannel : null;
  if (!device && sampleRate === null && cleanMic === null && cleanRef === null) return null;
  return {
    device,
    micChannel: cleanMic,
    refChannel: cleanRef,
    channelsDetected: text(raw.channelsDetected, 40),
    sampleRate: sampleRate !== null && sampleRate > 0 ? sampleRate : null,
  };
}

function normalizeCalibrationInfo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = text(raw.name, 120);
  const offsetDb = finite(raw.offsetDb);
  if (!name && offsetDb === null) return null;
  return { name, offsetDb };
}

function normalizeTags(raw) {
  if (!Array.isArray(raw)) return [];
  const tags = [];
  for (const tag of raw) {
    const clean = text(tag, 40);
    if (clean) tags.push(clean);
    if (tags.length >= 12) break;
  }
  return tags;
}

/**
 * The speaker-capture fields of a stored entry, validated on the way in so a
 * corrupt or foreign file never produces a half-read capture. Used by the
 * capture library's normalizer and by the import path.
 */
export function normalizeSpeakerCapture(item) {
  const source = item && typeof item === 'object' ? item : {};
  return {
    speaker: normalizeSpeakerInfo(source.speaker),
    venue: text(source.venue, 80),
    event: text(source.event, 80),
    micPosition: normalizeMicPosition(source.micPosition),
    inputs: normalizeInputs(source.inputs),
    calibration: normalizeCalibrationInfo(source.calibration),
    impulse: normalizeImpulseEnvelope(source.impulse),
    tags: normalizeTags(source.tags),
  };
}

/** True when the entry carries a speaker identity. */
export function isSpeakerCapture(item) {
  return !!(item && item.speaker && typeof item.speaker === 'object' && item.speaker.name);
}

/**
 * A saved capture laid out as a prediction trace: magnitude and phase on the
 * library's log frequency grid, so the sum prediction can resample two saved
 * speakers onto one axis. Phase is null unless it matches the curve length.
 */
export function libraryTrace(item) {
  if (!item || !Array.isArray(item.curve) || item.curve.length < 2) return null;
  const count = item.curve.length;
  const curve = [];
  for (const value of item.curve) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    curve.push(number);
  }
  const frequencies = new Float64Array(count);
  for (let i = 0; i < count; i += 1) frequencies[i] = curveFrequency(i, count);

  let phase = null;
  if (Array.isArray(item.phase) && item.phase.length === count) {
    phase = [];
    for (const value of item.phase) {
      const number = Number(value);
      if (!Number.isFinite(number)) { phase = null; break; }
      phase.push(number);
    }
  }

  return {
    frequencies,
    magDb: curve,
    phaseDeg: phase,
    bins: count,
    fftSize: Number(item.fftSize) > 0 ? Number(item.fftSize) : 0,
    sampleRate: Number(item.sampleRate) > 0 ? Number(item.sampleRate) : 0,
  };
}
