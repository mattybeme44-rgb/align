/*
 * The DSP chain of one modelled loudspeaker.
 *
 * Every filter is a real digital biquad (or a plain gain), and its effect on
 * the model is the exact complex response of that biquad at the measuring
 * sample rate — not a drawn EQ shape. Peaking and shelving coefficients come
 * from the same routine the EQ designer uses, so the two screens cannot
 * disagree about what a filter does.
 *
 * Crossover sections are designed the way a processor designs them: a
 * Butterworth, Linkwitz-Riley or Bessel cascade, each section a biquad with a
 * known Q, and every section stays in the chain so the operator can see and
 * trim what the design did.
 */

import { biquadCoefficients } from '../parametric-eq.js';

export const FILTER_LIMIT = 24;

export const FILTER_KINDS = [
  { id: 'peaking', label: 'Peaking', gain: true, q: true },
  { id: 'lowShelf', label: 'Low shelf', gain: true, q: true },
  { id: 'highShelf', label: 'High shelf', gain: true, q: true },
  { id: 'highPass', label: 'High-pass', gain: false, q: true },
  { id: 'lowPass', label: 'Low-pass', gain: false, q: true },
  { id: 'bandPass', label: 'Band-pass', gain: false, q: true },
  { id: 'notch', label: 'Notch', gain: false, q: true },
  { id: 'allPass2', label: 'All-pass 2nd', gain: false, q: true },
  { id: 'allPass1', label: 'All-pass 1st', gain: false, q: false },
  { id: 'highPass1', label: 'High-pass 1st', gain: false, q: false },
  { id: 'lowPass1', label: 'Low-pass 1st', gain: false, q: false },
  { id: 'gain', label: 'Gain', gain: true, q: false },
];

export const CROSSOVER_FAMILIES = ['Butterworth', 'Linkwitz-Riley', 'Bessel'];
export const CROSSOVER_SLOPES = [6, 12, 18, 24, 36, 48];

/** Bessel sections by order: a first-order section plus these Qs. */
const BESSEL_Q = {
  2: [0.5774],
  3: [0.6910],
  4: [0.5219, 0.8055],
  6: [0.5103, 0.6112, 1.0233],
  8: [0.5060, 0.5611, 0.7108, 1.2250],
};

function clamp(value, low, high, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(high, Math.max(low, number));
}

export function filterKind(id) {
  const wanted = String(id || '');
  for (const kind of FILTER_KINDS) if (kind.id === wanted) return kind;
  return FILTER_KINDS[0];
}

/** A filter with sensible defaults for the frequency chosen. */
export function newFilter(kind = 'peaking', frequency = 1000) {
  const info = filterKind(kind);
  return {
    id: 'f' + Date.now().toString(36) + Math.random().toString(16).slice(2, 6),
    kind: info.id,
    frequency: clamp(frequency, 10, 20000, 1000),
    gainDb: info.gain ? 0 : 0,
    q: info.q ? (info.id === 'peaking' ? 1 : 0.7071) : 0.7071,
    enabled: true,
  };
}

export function normalizeFilter(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const info = filterKind(source.kind);
  return {
    id: typeof source.id === 'string' && source.id
      ? source.id
      : 'f' + Date.now().toString(36) + Math.random().toString(16).slice(2, 6),
    kind: info.id,
    frequency: clamp(source.frequency, 10, 20000, 1000),
    gainDb: clamp(source.gainDb, -24, 24, 0),
    q: clamp(source.q, 0.1, 10, 0.7071),
    enabled: source.enabled !== false,
  };
}

/**
 * Normalised biquad coefficients for one filter at the sample rate the model is
 * processed at. A first-order section and a plain gain are written as biquads
 * with a zero b2/a2, so one response routine reads every filter.
 */
export function filterCoefficients(filter, sampleRate) {
  const info = filterKind(filter && filter.kind);
  const fs = clamp(sampleRate, 8000, 384000, 48000);
  const frequency = clamp(filter && filter.frequency, 10, fs * 0.49, 1000);
  const quality = clamp(filter && filter.q, 0.1, 10, 0.7071);
  const gainDb = clamp(filter && filter.gainDb, -24, 24, 0);

  if (info.id === 'gain') {
    const scale = Math.pow(10, gainDb / 20);
    return { b0: scale, b1: 0, b2: 0, a1: 0, a2: 0 };
  }

  if (info.id === 'highPass1' || info.id === 'lowPass1') {
    const k = Math.tan((Math.PI * frequency) / fs);
    const norm = 1 / (1 + k);
    if (info.id === 'highPass1') {
      return { b0: k * norm, b1: -k * norm, b2: 0, a1: (k - 1) * norm, a2: 0 };
    }
    return { b0: k * norm, b1: k * norm, b2: 0, a1: (k - 1) * norm, a2: 0 };
  }

  if (info.id === 'allPass1') {
    const k = Math.tan((Math.PI * frequency) / fs);
    const norm = (1 - k) / (1 + k);
    return { b0: norm, b1: -1, b2: 0, a1: -norm, a2: 0 };
  }

  if (['peaking', 'lowShelf', 'highShelf', 'highPass'].includes(info.id)) {
    return biquadCoefficients(
      { kind: info.id, frequency, gainDb, q: quality },
      fs,
    );
  }

  const w0 = (2 * Math.PI * frequency) / fs;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  const alpha = sinW / (2 * quality);

  if (info.id === 'lowPass') {
    const a0 = 1 + alpha;
    return {
      b0: ((1 - cosW) / 2) / a0,
      b1: (1 - cosW) / a0,
      b2: ((1 - cosW) / 2) / a0,
      a1: (-2 * cosW) / a0,
      a2: (1 - alpha) / a0,
    };
  }
  if (info.id === 'bandPass') {
    const a0 = 1 + alpha;
    return { b0: alpha / a0, b1: 0, b2: -alpha / a0, a1: (-2 * cosW) / a0, a2: (1 - alpha) / a0 };
  }
  if (info.id === 'notch') {
    const a0 = 1 + alpha;
    return { b0: 1 / a0, b1: (-2 * cosW) / a0, b2: 1 / a0, a1: (-2 * cosW) / a0, a2: (1 - alpha) / a0 };
  }
  // All-pass, second order: unity magnitude everywhere.
  const a0 = 1 + alpha;
  return {
    b0: (1 - alpha) / a0,
    b1: (-2 * cosW) / a0,
    b2: 1,
    a1: (-2 * cosW) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** The exact complex response of one biquad at one frequency. */
export function biquadResponse(filter, frequency, sampleRate) {
  const c = filterCoefficients(filter, sampleRate);
  const fs = clamp(sampleRate, 8000, 384000, 48000);
  const f = clamp(frequency, 0.01, fs * 0.5, 1000);
  const w = (2 * Math.PI * f) / fs;
  const cos1 = Math.cos(w);
  const sin1 = Math.sin(w);
  const cos2 = Math.cos(2 * w);
  const sin2 = Math.sin(2 * w);

  const reN = c.b0 + c.b1 * cos1 + c.b2 * cos2;
  const imN = -(c.b1 * sin1 + c.b2 * sin2);
  const reD = 1 + c.a1 * cos1 + c.a2 * cos2;
  const imD = -(c.a1 * sin1 + c.a2 * sin2);

  const magnitude = Math.hypot(reN, imN) / Math.max(1e-12, Math.hypot(reD, imD));
  const phase = Math.atan2(imN, reN) - Math.atan2(imD, reD);
  return { mag: magnitude, phaseRad: phase };
}

/**
 * The whole chain at every frequency: the product of the enabled filters, so a
 * bypassed filter contributes nothing and the order of the chain does not change
 * the answer.
 */
export function chainResponse(filters, frequencies, sampleRate) {
  const list = (filters || []).filter((filter) => filter && filter.enabled !== false);
  const magDb = new Float64Array(frequencies.length);
  const phaseRad = new Float64Array(frequencies.length);

  for (let i = 0; i < frequencies.length; i += 1) {
    let magnitude = 1;
    let phase = 0;
    for (const filter of list) {
      const response = biquadResponse(filter, frequencies[i], sampleRate);
      magnitude *= response.mag;
      phase += response.phaseRad;
    }
    magDb[i] = magnitude > 0 ? 20 * Math.log10(magnitude) : -240;
    phaseRad[i] = phase;
  }
  return { magDb, phaseRad };
}

/** Butterworth Q values for a cascade of the given order. */
export function butterworthQs(order) {
  const n = Math.max(1, Math.round(Number(order) || 1));
  const sections = Math.floor(n / 2);
  const qs = [];
  for (let k = 0; k < sections; k += 1) {
    qs.push(1 / (2 * Math.cos((Math.PI * (2 * k + 1)) / (2 * n))));
  }
  return { firstOrder: n % 2 === 1, qs };
}

/** The slope, in dB per octave, that a family's order gives. */
function orderForSlope(family, slope) {
  const value = Number(slope);
  if (family === 'Linkwitz-Riley') {
    if (![12, 24, 36, 48].includes(value)) return null;
    return value / 12;
  }
  if (![6, 12, 18, 24, 36, 48].includes(value)) return null;
  return value / 6;
}

/**
 * Design a crossover section set. The sections are ordinary filters, so the
 * operator can trim the frequency of each and see the summed response at once.
 * Linkwitz-Riley is two cascaded Butterworth sections at the same frequency,
 * which is what gives its 6 dB dip at the crossover point.
 */
export function designCrossover(options = {}) {
  const family = CROSSOVER_FAMILIES.includes(options.family) ? options.family : 'Linkwitz-Riley';
  const type = options.type === 'lowPass' || options.type === 'bandPass' ? options.type : 'highPass';
  const frequency = clamp(options.frequency, 10, 20000, 80);
  const order = orderForSlope(family, options.slope);
  if (!order) {
    return {
      ok: false,
      message: family + ' is designed at ' + (family === 'Linkwitz-Riley'
        ? '12, 24, 36 or 48 dB per octave'
        : '6, 12, 18, 24, 36 or 48 dB per octave') + '.',
      filters: [],
    };
  }

  const filters = [];
  const addSection = (kind, q) => {
    filters.push({
      id: 'x' + Date.now().toString(36) + Math.random().toString(16).slice(2, 8),
      kind,
      frequency,
      gainDb: 0,
      q,
      enabled: true,
    });
  };

  const stopBand = type === 'lowPass' ? 'lowPass' : 'highPass';
  const firstBand = type === 'lowPass' ? 'lowPass1' : 'highPass1';

  function addButterworth(n) {
    if (family === 'Bessel') {
      const qs = BESSEL_Q[n];
      if (!qs) return false;
      if (n % 2 === 1) addSection(firstBand, 0.7071);
      for (const q of qs) addSection(stopBand, q);
      return true;
    }
    const { firstOrder, qs } = butterworthQs(n);
    if (firstOrder) addSection(firstBand, 0.7071);
    for (const q of qs) addSection(stopBand, q);
    return true;
  }

  if (family === 'Linkwitz-Riley') {
    if (!addButterworth(order)) {
      return { ok: false, message: 'Bessel is not designed at that order.', filters: [] };
    }
    // The second half of the cascade: same sections again.
    const firstHalf = filters.slice();
    for (const section of firstHalf) addSection(section.kind, section.q);
  } else if (!addButterworth(order)) {
    return {
      ok: false,
      message: 'Bessel is offered at 2nd, 3rd, 4th, 6th and 8th order here.',
      filters: [],
    };
  }

  if (type === 'bandPass') {
    // A band-pass is a high-pass followed by a low-pass at the upper edge.
    const other = clamp(options.lowFrequency, frequency * 1.01, 20000, frequency * 10);
    const bandFilters = filters.map((filter) => ({
      ...filter,
      id: 'x' + Date.now().toString(36) + Math.random().toString(16).slice(2, 8),
      kind: filter.kind.replace('highPass', 'lowPass'),
      frequency: other,
    }));
    filters.push(...bandFilters);
  }

  if (filters.length > FILTER_LIMIT) {
    return {
      ok: true,
      message: 'The design needs ' + filters.length + ' sections; only the first ' +
        FILTER_LIMIT + ' are kept — trim the chain or design a shallower slope.',
      filters: filters.slice(0, FILTER_LIMIT),
    };
  }
  return { ok: true, message: '', filters };
}

const EXPORT_TYPES = {
  peaking: 'PK',
  lowShelf: 'LS',
  highShelf: 'HS',
  highPass: 'HP',
  highPass1: 'HP',
  lowPass: 'LP',
  lowPass1: 'LP',
  bandPass: 'BP',
  notch: 'NO',
  allPass1: 'AP',
  allPass2: 'AP',
  gain: 'None',
};

/**
 * The chain as one text file a DSP or a room-correction tool can read: a
 * REW-style list and the same filters as biquad coefficients.
 */
export function chainExportText(filters, sampleRate) {
  const enabled = (filters || []).filter((filter) => filter && filter.enabled !== false);
  if (!enabled.length) return '';

  const fs = Math.round(Number(sampleRate) || 48000);
  const lines = ['Align System Data Modeler — DSP chain', 'sample rate ' + fs + ' Hz', '', 'REW style'];

  enabled.forEach((filter, index) => {
    const info = filterKind(filter.kind);
    const type = EXPORT_TYPES[info.id] || 'PK';
    const gain = info.gain ? Number(filter.gainDb).toFixed(1) : '0.0';
    lines.push('Filter ' + (index + 1) + ': ON ' + type +
      ' Fc ' + Number(filter.frequency).toFixed(0) + ' Hz' +
      ' Gain ' + gain + ' dB' +
      ' Q ' + Number(filter.q).toFixed(2));
  });

  lines.push('', 'Biquads (normalised, 48 kHz)', 'b0,b1,b2,a1,a2');
  for (const filter of enabled) {
    const c = filterCoefficients(filter, fs);
    lines.push([c.b0, c.b1, c.b2, c.a1, c.a2].map((value) => value.toFixed(8)).join(','));
  }

  lines.push('', 'Predicted from the modelled filter set — check every change against a measurement.');
  return lines.join('\n');
}

/** Plain words for one filter, used in the chain list and in reports. */
export function filterText(filter) {
  const info = filterKind(filter && filter.kind);
  const parts = [info.label];
  if (info.id === 'gain') return info.label + ' ' + signed(Number(filter.gainDb)) + ' dB';
  parts.push(formatHz(Number(filter.frequency)));
  if (info.gain) parts.push(signed(Number(filter.gainDb)) + ' dB');
  if (info.q) parts.push('Q ' + Number(filter.q).toFixed(2));
  return parts.join(' · ');
}

export function signed(value) {
  const number = Number(value) || 0;
  return (number >= 0 ? '+' : '') + number.toFixed(1);
}

export function formatHz(frequency) {
  const f = Number(frequency);
  if (!Number.isFinite(f)) return '—';
  if (f >= 1000) {
    const k = f / 1000;
    return (k >= 10 ? k.toFixed(1) : k.toFixed(k >= 2 ? 1 : 2)).replace(/\.0+$/, '') + ' kHz';
  }
  return f.toFixed(0) + ' Hz';
}
