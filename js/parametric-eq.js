/*
 * The filters being designed against the measurement: RBJ biquads, evaluated
 * as a magnitude response so the designer can show what the correction would
 * do before anyone types a number into a DSP.
 */

export const EQ_FILTER_LIMIT = 8;

export const EQ_FILTER_KINDS = [
  { id: 'peaking', title: 'Peaking', allowsGain: true },
  { id: 'lowShelf', title: 'Low shelf', allowsGain: true },
  { id: 'highShelf', title: 'High shelf', allowsGain: true },
  { id: 'highPass', title: 'High-pass', allowsGain: false },
];

export const EQ_FILTER_KEY = 'align.eqFilters.v1';

export const EQ_FREQUENCY_RANGE = { min: 20, max: 20000 };
export const EQ_GAIN_RANGE = { min: -18, max: 18 };
export const EQ_Q_RANGE = { min: 0.3, max: 10 };

export function eqFilterKind(id) {
  return EQ_FILTER_KINDS.find((kind) => kind.id === id) || EQ_FILTER_KINDS[0];
}

function clamp(value, low, high, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(high, Math.max(low, number));
}

export function filterFrequencyText(frequency) {
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

/** "63 Hz · +3.0 dB · Q 0.9", or "40 Hz · Q 0.7" for a high-pass. */
export function filterDetailText(filter) {
  const kind = eqFilterKind(filter.kind);
  const frequency = filterFrequencyText(filter.frequency);
  if (!kind.allowsGain) return frequency + ' · Q ' + Number(filter.q).toFixed(1);
  return frequency + ' · ' + (filter.gainDb >= 0 ? '+' : '') +
    Number(filter.gainDb).toFixed(1) + ' dB · Q ' + Number(filter.q).toFixed(1);
}

/** The filter in one line, as it would be typed into a DSP. */
export function filterListText(filter) {
  const kind = eqFilterKind(filter.kind);
  const gain = kind.allowsGain
    ? (filter.gainDb >= 0 ? '+' : '') + Number(filter.gainDb).toFixed(1) + ' dB'
    : '—';
  return kind.title.padEnd(10) + filterFrequencyText(filter.frequency).padEnd(8) +
    gain.padEnd(8) + ' Q ' + Number(filter.q).toFixed(2);
}

/** The filter's own magnitude response in dB at a frequency. */
export function filterResponseDb(filter, frequency, sampleRate) {
  const f = Number(frequency);
  const fsInput = Number(sampleRate);
  if (!(fsInput > 0) || !Number.isFinite(f) || !(f > 0)) return 0;

  const fs = Math.max(fsInput, 8000);
  const f0 = Math.min(Math.max(Number(filter.frequency) > 0 ? Number(filter.frequency) : 20, 10), fs / 2 * 0.98);
  const w0 = 2 * Math.PI * f0 / fs;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  const gainDb = Number(filter.gainDb) || 0;
  const a = Math.pow(10, gainDb / 40);
  const quality = Math.min(Math.max(Number(filter.q) || 0, 0.1), 10);
  const kind = eqFilterKind(filter.kind).id;

  let b0 = 1, b1 = 0, b2 = 0;
  let a0 = 1, a1 = 0, a2 = 0;

  if (kind === 'peaking') {
    const alpha = sinW / (2 * quality);
    b0 = 1 + alpha * a;
    b1 = -2 * cosW;
    b2 = 1 - alpha * a;
    a0 = 1 + alpha / a;
    a1 = -2 * cosW;
    a2 = 1 - alpha / a;
  } else if (kind === 'lowShelf' || kind === 'highShelf') {
    // S = 1 gives the usual shelf shape; Q bends its shoulder.
    const slope = Math.min(Math.max(quality, 0.1), 2);
    const root = Math.max(0.01, (a + 1 / a) * (1 / slope - 1) + 2);
    const alpha = sinW / 2 * Math.sqrt(root);
    const twoSqrtAAlpha = 2 * Math.sqrt(a) * alpha;

    if (kind === 'lowShelf') {
      b0 = a * ((a + 1) - (a - 1) * cosW + twoSqrtAAlpha);
      b1 = 2 * a * ((a - 1) - (a + 1) * cosW);
      b2 = a * ((a + 1) - (a - 1) * cosW - twoSqrtAAlpha);
      a0 = (a + 1) + (a - 1) * cosW + twoSqrtAAlpha;
      a1 = -2 * ((a - 1) + (a + 1) * cosW);
      a2 = (a + 1) + (a - 1) * cosW - twoSqrtAAlpha;
    } else {
      b0 = a * ((a + 1) + (a - 1) * cosW + twoSqrtAAlpha);
      b1 = -2 * a * ((a - 1) + (a + 1) * cosW);
      b2 = a * ((a + 1) + (a - 1) * cosW - twoSqrtAAlpha);
      a0 = (a + 1) - (a - 1) * cosW + twoSqrtAAlpha;
      a1 = 2 * ((a - 1) - (a + 1) * cosW);
      a2 = (a + 1) - (a - 1) * cosW - twoSqrtAAlpha;
    }
  } else {
    const alpha = sinW / (2 * quality);
    b0 = (1 + cosW) / 2;
    b1 = -(1 + cosW);
    b2 = (1 + cosW) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cosW;
    a2 = 1 - alpha;
  }

  // |H(e^jw)| with the complex arithmetic written out.
  const w = 2 * Math.PI * Math.min(Math.max(f, 1), fs / 2) / fs;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const c2w = Math.cos(2 * w);
  const s2w = Math.sin(2 * w);

  const numeratorReal = b0 + b1 * cw + b2 * c2w;
  const numeratorImag = -(b1 * sw + b2 * s2w);
  const denominatorReal = a0 + a1 * cw + a2 * c2w;
  const denominatorImag = -(a1 * sw + a2 * s2w);

  const numerator = Math.hypot(numeratorReal, numeratorImag);
  const denominator = Math.hypot(denominatorReal, denominatorImag);
  if (!(numerator > 0) || !(denominator > 0)) return 0;

  return 20 * Math.log10(numerator / denominator);
}

/** The summed correction of every enabled filter, in dB. */
export function bankResponseDb(filters, frequency, sampleRate) {
  let total = 0;
  for (const filter of filters || []) {
    if (!filter || filter.enabled === false) continue;
    total += filterResponseDb(filter, frequency, sampleRate);
  }
  return total;
}

/** The filter list as text, for the clipboard. */
export function filterBankText(filters, sampleRate) {
  const enabled = (filters || []).filter((filter) => filter.enabled !== false);
  if (!enabled.length) return 'Align EQ — no filters enabled.';

  const lines = [
    'Align EQ — ' + enabled.length + (enabled.length === 1 ? ' filter' : ' filters'),
    'sample rate ' + Math.round(Number(sampleRate) || 48000) + ' Hz',
  ];
  for (const filter of enabled) lines.push(filterListText(filter));
  lines.push('');
  lines.push('Measured suggestion only: check each change against the microphone.');
  return lines.join('\n');
}

export function newFilter(frequency) {
  return normalizeFilter({
    kind: 'peaking',
    frequency: Number.isFinite(Number(frequency)) ? frequency : 1000,
    gainDb: 0,
    q: 1,
    enabled: true,
  });
}

export function normalizeFilter(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const kind = EQ_FILTER_KINDS.some((entry) => entry.id === source.kind) ? source.kind : 'peaking';
  return {
    id: typeof source.id === 'string' && source.id
      ? source.id
      : 'f' + Date.now().toString(36) + '-' + Math.random().toString(16).slice(2),
    kind,
    frequency: clamp(source.frequency, EQ_FREQUENCY_RANGE.min, EQ_FREQUENCY_RANGE.max, 1000),
    gainDb: clamp(source.gainDb, EQ_GAIN_RANGE.min, EQ_GAIN_RANGE.max, 0),
    q: clamp(source.q, EQ_Q_RANGE.min, EQ_Q_RANGE.max, 1),
    enabled: source.enabled !== false,
  };
}

export function loadEqFilters() {
  try {
    const raw = window.localStorage.getItem(EQ_FILTER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, EQ_FILTER_LIMIT).map(normalizeFilter);
  } catch (err) {
    return [];
  }
}

export function persistEqFilters(filters) {
  try {
    window.localStorage.setItem(EQ_FILTER_KEY, JSON.stringify((filters || []).slice(0, EQ_FILTER_LIMIT)));
    return true;
  } catch (err) {
    return false;
  }
}


/** Normalised biquad coefficients (a0 divided out) for one filter. */
export function biquadCoefficients(filter, sampleRate) {
  const fsInput = Number(sampleRate);
  const fs = Math.max(Number.isFinite(fsInput) && fsInput > 0 ? fsInput : 48000, 8000);
  const f0 = Math.min(Math.max(Number(filter.frequency) > 0 ? Number(filter.frequency) : 20, 10),
    fs / 2 * 0.98);
  const w0 = 2 * Math.PI * f0 / fs;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  const gainDb = Number(filter.gainDb) || 0;
  const amplitude = Math.pow(10, gainDb / 40);
  const quality = Math.min(Math.max(Number(filter.q) || 0, 0.1), 10);
  const kind = eqFilterKind(filter.kind).id;

  let b0 = 1, b1 = 0, b2 = 0;
  let a0 = 1, a1 = 0, a2 = 0;

  if (kind === 'peaking') {
    const alpha = sinW / (2 * quality);
    b0 = 1 + alpha * amplitude;
    b1 = -2 * cosW;
    b2 = 1 - alpha * amplitude;
    a0 = 1 + alpha / amplitude;
    a1 = -2 * cosW;
    a2 = 1 - alpha / amplitude;
  } else if (kind === 'lowShelf' || kind === 'highShelf') {
    const slope = Math.min(Math.max(quality, 0.1), 2);
    const root = Math.max(0.01, (amplitude + 1 / amplitude) * (1 / slope - 1) + 2);
    const alpha = sinW / 2 * Math.sqrt(root);
    const twoSqrtAAlpha = 2 * Math.sqrt(amplitude) * alpha;

    if (kind === 'lowShelf') {
      b0 = amplitude * ((amplitude + 1) - (amplitude - 1) * cosW + twoSqrtAAlpha);
      b1 = 2 * amplitude * ((amplitude - 1) - (amplitude + 1) * cosW);
      b2 = amplitude * ((amplitude + 1) - (amplitude - 1) * cosW - twoSqrtAAlpha);
      a0 = (amplitude + 1) + (amplitude - 1) * cosW + twoSqrtAAlpha;
      a1 = -2 * ((amplitude - 1) + (amplitude + 1) * cosW);
      a2 = (amplitude + 1) + (amplitude - 1) * cosW - twoSqrtAAlpha;
    } else {
      b0 = amplitude * ((amplitude + 1) + (amplitude - 1) * cosW + twoSqrtAAlpha);
      b1 = -2 * amplitude * ((amplitude - 1) + (amplitude + 1) * cosW);
      b2 = amplitude * ((amplitude + 1) + (amplitude - 1) * cosW - twoSqrtAAlpha);
      a0 = (amplitude + 1) - (amplitude - 1) * cosW + twoSqrtAAlpha;
      a1 = 2 * ((amplitude - 1) - (amplitude + 1) * cosW);
      a2 = (amplitude + 1) - (amplitude - 1) * cosW - twoSqrtAAlpha;
    }
  } else {
    const alpha = sinW / (2 * quality);
    b0 = (1 + cosW) / 2;
    b1 = -(1 + cosW);
    b2 = (1 + cosW) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cosW;
    a2 = 1 - alpha;
  }

  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

const EQ_EXPORT_TYPES = { peaking: 'PK', lowShelf: 'LS', highShelf: 'HS', highPass: 'HP' };

/**
 * The filter set as one text file: a REW-style list that most room-correction and
 * DSP tools import, then the same filters as miniDSP-style biquads. Empty when
 * there is nothing enabled to write.
 */
export function eqExportText(filters, sampleRate) {
  const enabled = (filters || []).filter((filter) => filter && filter.enabled !== false);
  if (!enabled.length) return '';

  const fs = Math.round(Number(sampleRate) || 48000);
  const lines = ['Align EQ export', 'sample rate ' + fs + ' Hz', '', 'REW style'];

  enabled.forEach((filter, index) => {
    const kind = eqFilterKind(filter.kind);
    const type = EQ_EXPORT_TYPES[kind.id] || 'PK';
    const gain = kind.allowsGain ? Number(filter.gainDb).toFixed(1) : '0.0';
    lines.push('Filter ' + (index + 1) + ': ON ' + type +
      ' Fc ' + Number(filter.frequency).toFixed(0) + ' Hz' +
      ' Gain ' + gain + ' dB' +
      ' Q ' + Number(filter.q).toFixed(2));
  });

  lines.push('', 'miniDSP biquads', 'b0,b1,b2,a1,a2');
  for (const filter of enabled) {
    const c = biquadCoefficients(filter, fs);
    lines.push([c.b0, c.b1, c.b2, c.a1, c.a2].map((value) => value.toFixed(6)).join(','));
  }

  lines.push('', 'Measured suggestion only: check every change against the microphone.');
  return lines.join('\n');
}
