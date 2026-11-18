/*
 * Generic loudspeaker models from published specifications.
 *
 * A sound engineer usually has the specification sheet, not an EASE/GLL dataset
 * and not a measurement. This module turns the sheet into something the existing
 * modeler and Room Designer can use: a magnitude curve on the same 400-point grid
 * and a set of 6 dB beamwidths on the same dataset shape an imported CLF file
 * produces. There is no second prediction engine here — the generated dataset is
 * read by `model.js` and `acoustics.js` exactly as a measured one is.
 *
 * What it refuses to do, because the information is not on a specification sheet:
 *   - no phase is invented, so a generated curve is magnitude-only and every sum
 *     that rests on it is labelled as assuming phase;
 *   - no acoustic offsets or crossover phase behaviour are invented; a multi-way
 *     cabinet is only combined when its crossover frequencies were entered, and
 *     then as a power sum whose phase is unknown;
 *   - a nominal 50° × 35° coverage figure is turned into an explicitly labelled
 *     directivity approximation, never into a polar balloon;
 *   - 1 W and 2.83 V sensitivity are converted through the nominal impedance, never
 *     treated as interchangeable.
 *
 * The entered specification is kept on the model as `model.generic`, so attaching
 * manufacturer or measured data later never destroys what the operator typed.
 */

import {
  CURVE_FMAX,
  CURVE_FMIN,
  GRID_POINTS,
  gridFrequencies,
  interpolateAt,
} from './curve.js';

export const SPEAKER_SCHEMA = 'align.custom-speaker/1';
export const GENERIC_CAVEAT = 'GENERIC — APPROXIMATE DIRECTIVITY';
/** The voltage the industry calls "2.83 V"; sqrt(8) = 2.8284, so 2.83 is used as written. */
export const VOLT_REFERENCE = 2.83;

/* ---------- small numeric helpers ---------- */

function clamp(value, low, high, fallback) {
  // An empty field is missing, not zero: `Number('')` is 0, which would turn a
  // blank crossover into a 10 Hz one and a blank width into a 5° one.
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(high, Math.max(low, number));
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value, limit) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, limit);
}

function round(value, places) {
  const factor = Math.pow(10, places || 0);
  return Math.round(value * factor) / factor;
}

function makeId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(16).slice(2, 6);
}

/* ---------- speaker types ---------- */

/**
 * The type decides which parts of the builder are offered. `sections` is the
 * number of independently defined sections a new speaker of that type starts
 * with; `modelType` keeps the existing library's own type list in step.
 */
export const SPEAKER_TYPES = [
  {
    id: 'subwoofer',
    label: 'Subwoofer',
    modelType: 'Subwoofer',
    sections: 1,
    sectionLabel: 'Sub',
    sub: true,
    note: 'Low-frequency cabinet. Coverage is often approximated as omnidirectional at the frequencies it plays.',
  },
  {
    id: 'full-range',
    label: 'Full-range main',
    modelType: 'Full-range',
    sections: 1,
    sectionLabel: 'Full range',
    note: 'One cabinet covering the whole band; enter its published range and coverage.',
  },
  {
    id: 'mid-high',
    label: 'Mid/high loudspeaker',
    modelType: 'Top / main',
    sections: 1,
    sectionLabel: 'Mid/high',
    note: 'A cabinet used above a subwoofer or low cabinet.',
  },
  {
    id: 'low-cabinet',
    label: 'Low-frequency cabinet',
    modelType: 'Subwoofer',
    sections: 1,
    sectionLabel: 'Low',
    note: 'A bass cabinet that is not necessarily used as a subwoofer.',
  },
  {
    id: 'point-source',
    label: 'Point-source loudspeaker',
    modelType: 'Full-range',
    sections: 1,
    sectionLabel: 'Point source',
    note: 'Treated as a point at the acoustic centre for every frequency; directivity still applies where widths are entered.',
  },
  {
    id: 'horn-loaded',
    label: 'Horn-loaded loudspeaker',
    modelType: 'Top / main',
    sections: 1,
    sectionLabel: 'Horn',
    note: 'A horn cabinet whose coverage is set by the horn; a rotatable horn can be noted here.',
  },
  {
    id: 'line-array',
    label: 'Line-array element',
    modelType: 'Top / main',
    sections: 1,
    sectionLabel: 'Element',
    note: 'One element. The element is modelled as a cabinet; array coupling between elements is not predicted.',
  },
  {
    id: 'multi-way',
    label: 'Multi-way loudspeaker',
    modelType: 'Top / main',
    sections: 2,
    sectionLabel: 'Section',
    note: 'Several independently specified sections in one cabinet. Each section is its own dataset.',
  },
  {
    id: 'custom',
    label: 'Custom enclosure',
    modelType: 'Custom',
    sections: 1,
    sectionLabel: 'Section',
    note: 'Anything that does not fit the list above.',
  },
];

export function speakerType(id) {
  return SPEAKER_TYPES.find((entry) => entry.id === id) || SPEAKER_TYPES[SPEAKER_TYPES.length - 1];
}

/* ---------- units ---------- */

export const LENGTH_UNITS = [
  { id: 'mm', label: 'mm', metres: 0.001 },
  { id: 'cm', label: 'cm', metres: 0.01 },
  { id: 'm', label: 'm', metres: 1 },
  { id: 'in', label: 'in', metres: 0.0254 },
  { id: 'ft', label: 'ft', metres: 0.3048 },
];

const LENGTH_ALIASES = {
  mm: 'mm', millimetre: 'mm', millimetres: 'mm', millimeter: 'mm', millimeters: 'mm',
  cm: 'cm', centimetre: 'cm', centimetres: 'cm', centimeter: 'cm', centimeters: 'cm',
  m: 'm', metre: 'm', metres: 'm', meter: 'm', meters: 'm',
  in: 'in', inch: 'in', inches: 'in', '"': 'in',
  ft: 'ft', foot: 'ft', feet: 'ft', "'": 'ft',
};

export function lengthUnit(id) {
  const key = String(id || '').trim().toLowerCase();
  const canonical = LENGTH_ALIASES[key] || 'm';
  return LENGTH_UNITS.find((entry) => entry.id === canonical) || LENGTH_UNITS[2];
}

/** Convert a length in the given unit to metres. Unknown units are refused. */
export function lengthToMetres(value, unit) {
  const number = Number(value);
  const entry = LENGTH_UNITS.find((item) => item.id === String(unit || '').toLowerCase());
  if (!entry || !Number.isFinite(number)) return NaN;
  return number * entry.metres;
}

export function metresToLength(metres, unit) {
  const number = Number(metres);
  const entry = lengthUnit(unit);
  if (!Number.isFinite(number)) return NaN;
  return number / entry.metres;
}

export function formatLengthValue(metres, unit, places) {
  const value = metresToLength(metres, unit);
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(Number.isFinite(places) ? places : (Math.abs(value) >= 100 ? 0 : 1)) + ' ' + lengthUnit(unit).id;
}

/* ---------- sensitivity ---------- */

/**
 * dB SPL at 1 W / 1 m from a dB SPL at 2.83 V / 1 m rating and the nominal
 * impedance. The two are only interchangeable at 8 Ω; at 4 Ω the voltage rating
 * describes twice the power and reads about 3 dB higher.
 */
export function sensitivityFromVolts(voltsDb, impedanceOhm, volts = VOLT_REFERENCE) {
  const z = Number(impedanceOhm);
  const v = Number(volts) > 0 ? Number(volts) : VOLT_REFERENCE;
  if (!(z > 0) || !Number.isFinite(Number(voltsDb))) return NaN;
  return Number(voltsDb) - 10 * Math.log10((v * v) / z);
}

/** dB SPL at 2.83 V / 1 m from a dB SPL at 1 W / 1 m rating and the impedance. */
export function sensitivityFromWatts(wattDb, impedanceOhm, volts = VOLT_REFERENCE) {
  const z = Number(impedanceOhm);
  const v = Number(volts) > 0 ? Number(volts) : VOLT_REFERENCE;
  if (!(z > 0) || !Number.isFinite(Number(wattDb))) return NaN;
  return Number(wattDb) + 10 * Math.log10((v * v) / z);
}

/** The level a power rating adds to a sensitivity, in dB. A calculation, not a rating. */
export function splFromPower(sensitivityDb, powerW) {
  const gain = Number(powerW);
  if (!(gain > 0) || !Number.isFinite(Number(sensitivityDb))) return NaN;
  return Number(sensitivityDb) + 10 * Math.log10(gain);
}

/* ---------- directivity ---------- */

export const COVERAGE_MODELS = [
  {
    id: 'omni',
    label: 'Omnidirectional approximation',
    note: 'No level change with angle. Aim is stored and drawn, but it does not change the predicted level.',
  },
  {
    id: 'constant',
    label: 'Constant directivity',
    note: 'One horizontal and one vertical width across the whole band.',
  },
  {
    id: 'frequency',
    label: 'Frequency-dependent beamwidth',
    note: 'Widths entered per band, interpolated in log frequency and held beyond the ends.',
  },
];

export const ANGLE_PROFILES = [
  {
    id: 'quadratic',
    label: 'Quadratic taper',
    note: 'Attenuation rises with the square of the angle and reaches the reference at the stated half-width.',
  },
  {
    id: 'cosine',
    label: 'Cosine taper',
    note: 'Flatter on axis and quicker at the edge; the reference is still reached at the half-width.',
  },
  {
    id: 'steep',
    label: 'Steep taper',
    note: 'A narrow sweet spot: the level holds only close to the axis.',
  },
];

export const BEAMWIDTH_REFERENCES = [6, 10, 12];

function profileShape(profile, x) {
  const t = Math.max(0, Number(x) || 0);
  if (profile === 'cosine') return 1 - Math.cos((Math.PI * Math.min(t, 2)) / 2);
  if (profile === 'steep') return t * t * t * t;
  return t * t;
}

/**
 * The level an off-axis angle costs, from a width and the profile selected.
 * The profile reaches `referenceDb` at exactly half the stated width; everything
 * is floored at −40 dB, behind which nothing here is claimed.
 */
export function profileAttenuationDb(offAxisDeg, widthDeg, profile, referenceDb) {
  const width = Number(widthDeg);
  if (!(width > 0)) return 0;
  const reference = Math.abs(Number(referenceDb) > 0 ? Number(referenceDb) : 6);
  const ratio = (2 * Math.abs(Number(offAxisDeg) || 0)) / width;
  return Math.max(-40, -reference * profileShape(profile, ratio));
}

/**
 * The 6 dB width equivalent to a width stated at another reference. The room
 * prediction's own attenuation model is a 6 dB width, so a width published at,
 * say, −10 dB is converted instead of being used as if it were the same figure.
 */
export function equivalentSixDbWidth(widthDeg, profile, referenceDb) {
  const width = Number(widthDeg);
  if (!(width > 0)) return NaN;
  const reference = Math.abs(Number(referenceDb) > 0 ? Number(referenceDb) : 6);
  const ratio = clamp(6 / reference, 0.01, profile === 'cosine' ? 1.9 : 4, 1);
  let x;
  if (profile === 'cosine') x = (2 / Math.PI) * Math.acos(1 - ratio);
  else if (profile === 'steep') x = Math.pow(ratio, 0.25);
  else x = Math.sqrt(ratio);
  return clamp(width * x, 5, 360, width);
}

/* ---------- the specification ---------- */

export const ENCLOSURE_TYPES = [
  { id: 'sealed', label: 'Sealed' },
  { id: 'ported', label: 'Ported / bass reflex' },
  { id: 'bandpass', label: 'Band-pass' },
  { id: 'horn', label: 'Horn-loaded' },
  { id: 'tapped-horn', label: 'Tapped horn' },
  { id: 'cardioid', label: 'Cardioid cabinet' },
  { id: 'custom', label: 'Custom enclosure' },
];

export const MOUNTINGS = [
  { id: 'free', label: 'Free-standing' },
  { id: 'flown', label: 'Flown / suspended' },
  { id: 'stacked', label: 'Stacked' },
  { id: 'wall', label: 'Wall-mounted' },
  { id: 'soffit', label: 'Soffit-mounted' },
  { id: 'custom', label: 'Other' },
];

function verdict(items, fallback) {
  return items.some((entry) => entry.id === fallback) ? fallback : items[0].id;
}

function normalizeBand(raw, fallbackLow, fallbackHigh) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const low = clamp(source.fMin, 10, 20000, fallbackLow);
  const high = clamp(source.fMax, 10, 20000, fallbackHigh);
  return {
    fMin: round(Math.min(low, high), 1),
    fMax: round(Math.max(low, high), 1),
    toleranceDb: num(source.toleranceDb),
  };
}

function normalizeResponsePoints(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((entry) => ({
      hz: clamp(entry && entry.hz, 10, 20000, NaN),
      db: clamp(entry && entry.db, -40, 40, NaN),
    }))
    .filter((entry) => Number.isFinite(entry.hz) && Number.isFinite(entry.db))
    .sort((a, b) => a.hz - b.hz)
    .slice(0, 40);
}

function normalizeBeamPoints(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((entry) => ({
      hz: clamp(entry && entry.hz, 10, 20000, NaN),
      hDeg: clamp(entry && (entry.hDeg !== undefined ? entry.hDeg : entry.widthH), 5, 360, NaN),
      vDeg: clamp(entry && (entry.vDeg !== undefined ? entry.vDeg : entry.widthV), 5, 360, NaN),
    }))
    .filter((entry) => Number.isFinite(entry.hz) && Number.isFinite(entry.hDeg) && Number.isFinite(entry.vDeg))
    .sort((a, b) => a.hz - b.hz)
    .slice(0, 32);
}

function normalizeSection(raw, index) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const type = speakerType(source.type);
  return {
    id: text(source.id, 60) || 'sec-' + (index + 1),
    label: text(source.label, 40) || (type.sectionLabel + ' ' + (index + 1)),
    band: normalizeBand(source.band, 55, 17000),
    sensitivityDb: num(source.sensitivityDb),
    maxContinuousDb: num(source.maxContinuousDb),
    maxPeakDb: num(source.maxPeakDb),
    powerW: num(source.powerW),
    impedanceOhm: num(source.impedanceOhm),
    offsetMs: num(source.offsetMs),
    phase: source.phase === 'measured' ? 'measured' : 'unknown',
    note: text(source.note, 160),
  };
}

export function defaultSpec(overrides = {}) {
  const now = new Date().toISOString();
  const source = overrides || {};
  const type = speakerType(source.type);
  return {
    schema: SPEAKER_SCHEMA,
    id: text(source.id, 60) || makeId('sp-'),
    name: text(source.name, 80) || 'New loudspeaker',
    manufacturer: text(source.manufacturer, 60),
    modelNumber: text(source.modelNumber, 60),
    type: type.id,
    description: text(source.description, 300),
    driverCount: clamp(source.driverCount, 1, 64, 1),
    enclosure: {
      type: ENCLOSURE_TYPES.some((entry) => entry.id === (source.enclosure && source.enclosure.type))
        ? source.enclosure.type : 'sealed',
      drivers: text(source.enclosure && source.enclosure.drivers, 120),
      portTuningHz: num(source.enclosure && source.enclosure.portTuningHz),
    },
    band: normalizeBand(source.band, 80, 18000),
    crossovers: [],
    sensitivity: {
      at1W: num(source.sensitivity && source.sensitivity.at1W),
      atVolts: num(source.sensitivity && source.sensitivity.atVolts),
      volts: clamp(source.sensitivity && source.sensitivity.volts, 1, 20, VOLT_REFERENCE),
      impedanceOhm: clamp(source.sensitivity && source.sensitivity.impedanceOhm, 0.5, 64, 8),
    },
    output: {
      maxContinuousDb: num(source.output && source.output.maxContinuousDb),
      maxPeakDb: num(source.output && source.output.maxPeakDb),
      powerW: num(source.output && source.output.powerW),
    },
    directivity: {
      model: COVERAGE_MODELS.some((entry) => entry.id === (source.directivity && source.directivity.model))
        ? source.directivity.model : 'constant',
      hDeg: clamp(source.directivity && source.directivity.hDeg, 5, 360, 90),
      vDeg: clamp(source.directivity && source.directivity.vDeg, 5, 360, 60),
      referenceDb: clamp(source.directivity && source.directivity.referenceDb, 3, 15, 6),
      profile: ANGLE_PROFILES.some((entry) => entry.id === (source.directivity && source.directivity.profile))
        ? source.directivity.profile : 'quadratic',
      referenceBand: text(source.directivity && source.directivity.referenceBand, 60),
      points: normalizeBeamPoints(source.directivity && source.directivity.points),
    },
    response: {
      mode: source.response && source.response.mode === 'points' ? 'points' : 'flat',
      lowSlope: clamp(source.response && source.response.lowSlope, 6, 48, 24),
      highSlope: clamp(source.response && source.response.highSlope, 6, 48, 18),
      points: normalizeResponsePoints(source.response && source.response.points),
    },
    physical: {
      widthM: clamp(source.physical && source.physical.widthM, 0.01, 20, 0.5),
      heightM: clamp(source.physical && source.physical.heightM, 0.01, 20, 0.7),
      depthM: clamp(source.physical && source.physical.depthM, 0.01, 20, 0.4),
      weightKg: num(source.physical && source.physical.weightKg),
      acousticCenter: source.physical && source.physical.acousticCenter
        ? {
            xM: clamp(source.physical.acousticCenter.xM, -10, 10, 0),
            yM: clamp(source.physical.acousticCenter.yM, -10, 10, 0),
            zM: clamp(source.physical.acousticCenter.zM, -10, 10, 0),
          }
        : null,
      mounting: MOUNTINGS.some((entry) => entry.id === (source.physical && source.physical.mounting))
        ? source.physical.mounting : 'free',
      rotatableHorn: !!(source.physical && source.physical.rotatableHorn),
      colour: /^#[0-9a-fA-F]{6}$/.test(String(source.physical && source.physical.colour || ''))
        ? String(source.physical.colour) : '#3a4652',
    },
    sections: [],
    notes: text(source.notes, 400),
    labelCaveat: text(source.labelCaveat, 80) || GENERIC_CAVEAT,
    preferredDatasetId: text(source.preferredDatasetId, 60),
    revision: clamp(source.revision, 1, 999, 1),
    createdAt: text(source.createdAt, 40) || now,
    updatedAt: text(source.updatedAt, 40) || now,
  };
}

/**
 * Bring an entered or imported specification into a known shape. Everything is
 * clamped to a range the computation can use; nothing is rejected here, because
 * the validation pass is what tells the operator what is wrong.
 */
export function normalizeSpec(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const spec = defaultSpec(raw);
  const sections = (Array.isArray(raw.sections) ? raw.sections : [])
    .map(normalizeSection)
    .slice(0, 6);
  spec.sections = sections.length ? sections : [normalizeSection({}, 0)];
  if (!sections.length) spec.sections[0].band = normalizeBand(raw.band, 80, 18000);

  const wanted = Math.max(0, spec.sections.length - 1);
  const crossovers = (Array.isArray(raw.crossovers) ? raw.crossovers : [])
    .map((entry) => ({
      hz: clamp(entry && entry.hz, 10, 20000, NaN),
      slopeDbPerOct: clamp(entry && entry.slopeDbPerOct, 6, 48, 24),
      family: text(entry && entry.family, 30) || 'Linkwitz-Riley',
    }))
    .filter((entry) => Number.isFinite(entry.hz))
    .slice(0, wanted);
  while (crossovers.length < wanted) {
    crossovers.push({ hz: NaN, slopeDbPerOct: 24, family: 'Linkwitz-Riley' });
  }
  spec.crossovers = crossovers;
  return spec;
}

/**
 * The user-supplied Pioneer XY-3B figures, as editable starting values. It is
 * not an official dataset: no crossover, phase, acoustic offset or polar data
 * was supplied, so none is modelled.
 */
export function pioneerExample() {
  return normalizeSpec({
    id: 'pioneer-xy-3b',
    name: 'Pioneer XY-3B — Generic Specification Model',
    manufacturer: 'Pioneer',
    modelNumber: 'XY-3B',
    type: 'multi-way',
    description: 'Two-section main loudspeaker built from user-supplied published figures. ' +
      'Not an official EASE or GLL dataset and not independently verified manufacturer data.',
    driverCount: 2,
    enclosure: { type: 'custom', drivers: 'LF section + mid/high section', portTuningHz: null },
    band: { fMin: 55, fMax: 17000 },
    crossovers: [],
    sensitivity: { at1W: null, atVolts: null, volts: VOLT_REFERENCE, impedanceOhm: 8 },
    output: { maxContinuousDb: null, maxPeakDb: null, powerW: null },
    directivity: {
      model: 'constant',
      hDeg: 50,
      vDeg: 35,
      referenceDb: 6,
      profile: 'quadratic',
      referenceBand: '',
      points: [],
    },
    response: { mode: 'flat', lowSlope: 24, highSlope: 18, points: [] },
    physical: {
      widthM: 0.53,
      heightM: 1.08,
      depthM: 0.54,
      weightKg: null,
      acousticCenter: null,
      mounting: 'free',
      rotatableHorn: true,
      colour: '#33414d',
    },
    sections: [
      {
        id: 'sec-lf',
        label: 'LF section',
        band: { fMin: 55, fMax: 17000 },
        sensitivityDb: 102,
        maxPeakDb: 139,
        note: 'LF sensitivity 102 dB SPL (1 W / 1 m); LF maximum peak SPL 139 dB.',
      },
      {
        id: 'sec-mhf',
        label: 'Mid/high section',
        band: { fMin: 55, fMax: 17000 },
        sensitivityDb: 107,
        maxPeakDb: 136,
        note: 'MHF sensitivity 107 dB SPL (1 W / 1 m); MHF maximum peak SPL 136 dB.',
      },
    ],
    notes: 'Nominal coverage 50° horizontal × 35° vertical. Frequency range 55 Hz – 17 kHz. ' +
      'Dimensions 530 × 1080 × 540 mm. The crossover frequency was not supplied, so the two sections ' +
      'are offered separately and are never added together. No phase, acoustic offset or polar data exists ' +
      'for this model, so a prediction from it is an estimate.',
    labelCaveat: GENERIC_CAVEAT,
  });
}

/* ---------- directivity from the entered figures ---------- */

/** The horizontal and vertical width at one frequency, interpolated in log f. */
export function widthsAt(spec, frequency) {
  const directivity = (spec && spec.directivity) || {};
  const hNominal = clamp(directivity.hDeg, 5, 360, 90);
  const vNominal = clamp(directivity.vDeg, 5, 360, 60);
  if (directivity.model === 'omni') return { hDeg: 0, vDeg: 0 };
  const points = normalizeBeamPoints(directivity.points);
  if (directivity.model !== 'frequency' || points.length < 1) {
    return { hDeg: hNominal, vDeg: vNominal };
  }
  const f = clamp(frequency, 10, 20000, 1000);
  const logs = points.map((entry) => Math.log(entry.hz));
  const widthH = interpolateAt(logs, points.map((entry) => entry.hDeg), Math.log(f));
  const widthV = interpolateAt(logs, points.map((entry) => entry.vDeg), Math.log(f));
  return {
    hDeg: clamp(widthH, 5, 360, hNominal),
    vDeg: clamp(widthV, 5, 360, vNominal),
  };
}

function beamBandFrequencies(spec) {
  const low = clamp(spec && spec.band && spec.band.fMin, 20, 20000, 55);
  const high = clamp(spec && spec.band && spec.band.fMax, 20, 20000, 17000);
  const fMin = Math.min(low, high);
  const fMax = Math.max(low, high);
  const out = [round(fMin, 1)];
  for (let centre = 25; centre <= 16000; centre *= Math.pow(2, 1 / 3)) {
    if (centre > fMin * 1.03 && centre < fMax * 0.97) out.push(round(centre, 2));
  }
  out.push(round(fMax, 1));
  return out;
}

/**
 * The dataset's directivity: the equivalent 6 dB width at each band, horizontal
 * and vertical separately. The room prediction uses each axis where both are
 * present; a single width is kept as well so the existing polar view and the
 * coverage wedge keep working.
 */
export function directivityEntries(spec) {
  const directivity = (spec && spec.directivity) || {};
  if (directivity.model === 'omni') return [];
  const profile = directivity.profile;
  const reference = directivity.referenceDb;
  return beamBandFrequencies(spec).map((frequency) => {
    const widths = widthsAt(spec, frequency);
    const widthH = equivalentSixDbWidth(widths.hDeg, profile, reference);
    const widthV = equivalentSixDbWidth(widths.vDeg, profile, reference);
    return {
      frequency,
      widthDeg: round(widthH, 2),
      widthHDeg: round(widthH, 2),
      widthVDeg: round(widthV, 2),
      profile,
    };
  });
}

/**
 * Read a beamwidth table: one band per row, `Hz, horizontal°, vertical°` (or
 * `Hz, width°` for a symmetrical pattern). Comma, tab, semicolon or whitespace
 * separated, with comment and header lines tolerated. The whole file is refused
 * if any row is unusable, so a half-read table never becomes a coverage claim.
 *
 * This is a table of widths, not a polar measurement: it says how wide the
 * pattern is per band, not the level at every angle. A full balloon is a
 * different dataset and is not read here.
 */
export function parseBeamwidthTable(textValue) {
  const source = String(textValue || '');
  if (!source.trim()) return { ok: false, message: 'That file is empty.' };
  const points = [];
  let skipped = 0;
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^\s*(#|\/\/|;|\*|')/.test(line)) { skipped += 1; continue; }
    const tokens = line.split(/[\s,;\t]+/).filter((token) => token !== '');
    const values = tokens.map(Number);
    if (!values.length || values.some((value) => !Number.isFinite(value))) {
      // A header or a stray line. It is not a band, so it is not used.
      skipped += 1;
      continue;
    }
    const hz = values[0];
    const horizontal = values[1];
    const vertical = values.length > 2 ? values[2] : values[1];
    if (!(hz >= 10 && hz <= 20000)) {
      return { ok: false, message: 'A beamwidth row names ' + hz + ' Hz, which is outside 10 Hz – 20 kHz.' };
    }
    if (!(horizontal >= 5 && horizontal <= 360) || !(vertical >= 5 && vertical <= 360)) {
      return {
        ok: false,
        message: 'The beamwidth row at ' + hz + ' Hz is not between 5° and 360°, so the whole file is refused.',
      };
    }
    points.push({ hz, hDeg: horizontal, vDeg: vertical });
  }
  if (points.length < 2) {
    return {
      ok: false,
      message: 'A beamwidth table needs at least two bands; that file holds ' + points.length + '.',
    };
  }
  points.sort((a, b) => a.hz - b.hz);
  for (let index = 1; index < points.length; index += 1) {
    if (Math.abs(points[index].hz - points[index - 1].hz) < 1e-6) {
      return {
        ok: false,
        message: 'Two rows name ' + points[index].hz + ' Hz, so the table is ambiguous and is refused.',
      };
    }
  }
  return {
    ok: true,
    points,
    message: 'Read ' + points.length + ' band widths from ' + points[0].hz + ' Hz to ' +
      points[points.length - 1].hz + ' Hz' + (skipped ? '; ' + skipped + ' line' +
      (skipped === 1 ? ' was' : 's were') + ' skipped as header or comment' : '') +
      '. Widths are an approximation of the pattern, not a polar measurement.',
  };
}

/* ---------- the frequency response ---------- */

/** The sensitivity at 1 W / 1 m for one section, converted through the impedance. */
export function sensitivityAt1W(spec, index = 0) {
  const section = (spec.sections || [])[index] || {};
  const own = num(section.sensitivityDb);
  if (own !== null) return own;
  const sensitivity = (spec && spec.sensitivity) || {};
  const cabinet = num(sensitivity.at1W);
  if (cabinet !== null) return cabinet;
  const volts = num(sensitivity.atVolts);
  const z = num(section.impedanceOhm) !== null ? num(section.impedanceOhm) : num(sensitivity.impedanceOhm);
  if (volts !== null && z !== null && z > 0) {
    const converted = sensitivityFromVolts(volts, z, sensitivity.volts);
    if (Number.isFinite(converted)) return converted;
  }
  // A plain placeholder so a curve can still be drawn; validation says so.
  return 96;
}

/** True when the operator actually entered a sensitivity, rather than the placeholder. */
export function hasSensitivity(spec) {
  if (!spec) return false;
  if ((spec.sections || []).some((section) => num(section.sensitivityDb) !== null)) return true;
  const sensitivity = spec.sensitivity || {};
  if (num(sensitivity.at1W) !== null) return true;
  return num(sensitivity.atVolts) !== null && Number(sensitivity.impedanceOhm) > 0;
}

/**
 * Where each section starts and ends, and whether that edge is a crossover or
 * the cabinet's published band limit. A crossover edge is a −3 dB knee at the
 * crossover frequency; a published limit is the corner of the entered slope.
 */
export function sectionBands(spec) {
  const sections = (spec && spec.sections) || [];
  const crossovers = (spec && spec.crossovers) || [];
  return sections.map((section, index) => {
    const lowCrossover = index > 0 ? num(crossovers[index - 1] && crossovers[index - 1].hz) : null;
    const highCrossover = index < sections.length - 1
      ? num(crossovers[index] && crossovers[index].hz) : null;
    const sectionLow = num(section.band && section.band.fMin);
    const sectionHigh = num(section.band && section.band.fMax);
    const cabinetLow = num(spec.band && spec.band.fMin);
    const cabinetHigh = num(spec.band && spec.band.fMax);
    const lowHz = lowCrossover !== null ? lowCrossover : (sectionLow !== null ? sectionLow : cabinetLow);
    const highHz = highCrossover !== null ? highCrossover : (sectionHigh !== null ? sectionHigh : cabinetHigh);
    return {
      index,
      lowHz: Math.min(Number(lowHz) || 55, Number(highHz) || 17000),
      highHz: Math.max(Number(lowHz) || 55, Number(highHz) || 17000),
      lowIsCrossover: lowCrossover !== null,
      highIsCrossover: highCrossover !== null,
      lowSlope: clamp(index > 0 ? crossovers[index - 1] && crossovers[index - 1].slopeDbPerOct : null,
        6, 48, clamp(spec.response && spec.response.lowSlope, 6, 48, 24)),
      highSlope: clamp(index < sections.length - 1 ? crossovers[index] && crossovers[index].slopeDbPerOct : null,
        6, 48, clamp(spec.response && spec.response.highSlope, 6, 48, 18)),
    };
  });
}

function lowRollDb(frequency, edge, slope) {
  if (!(frequency > 0) || !(edge > 0) || frequency >= edge) return 0;
  return -Math.abs(slope) * Math.log2(edge / frequency);
}

function highRollDb(frequency, edge, slope) {
  if (!(frequency > 0) || !(edge > 0) || frequency <= edge) return 0;
  return -Math.abs(slope) * Math.log2(frequency / edge);
}

function crossoverLowPassDb(frequency, edge, slope) {
  const order = Math.max(1, Math.abs(slope) / 6);
  return -10 * Math.log10(1 + Math.pow(frequency / edge, 2 * order));
}

function crossoverHighPassDb(frequency, edge, slope) {
  const order = Math.max(1, Math.abs(slope) / 6);
  return -10 * Math.log10(1 + Math.pow(edge / frequency, 2 * order));
}

function responseOffsets(spec) {
  const points = normalizeResponsePoints(spec && spec.response && spec.response.points);
  if (spec && spec.response && spec.response.mode !== 'points') return null;
  if (!points.length) return null;
  return {
    logs: points.map((entry) => Math.log(entry.hz)),
    values: points.map((entry) => entry.db),
  };
}

function offsetAt(offsets, frequency) {
  if (!offsets) return 0;
  return interpolateAt(offsets.logs, offsets.values, Math.log(frequency));
}

/**
 * One section's approximate magnitude on the frequency grid.
 *
 * Inside its band the response is the entered sensitivity plus any deviation
 * the operator typed; outside it, the entered slope rolls it away from the
 * published limit, or a −3 dB crossover knee hands over to the neighbouring
 * section. Nothing here is measured, and no phase is produced.
 */
export function generateSectionResponse(spec, index, options = {}) {
  const frequencies = options.frequencies || gridFrequencies(GRID_POINTS);
  const bands = sectionBands(spec);
  const band = bands[index] || bands[0] || {
    lowHz: 55, highHz: 17000, lowIsCrossover: false, highIsCrossover: false, lowSlope: 24, highSlope: 18,
  };
  const sensitivity = sensitivityAt1W(spec, index);
  const offsets = responseOffsets(spec);
  const magDb = new Float64Array(frequencies.length);

  for (let i = 0; i < frequencies.length; i += 1) {
    const f = frequencies[i];
    let value = sensitivity;
    value += band.lowIsCrossover
      ? crossoverHighPassDb(f, band.lowHz, band.lowSlope)
      : lowRollDb(f, band.lowHz, band.lowSlope);
    value += band.highIsCrossover
      ? crossoverLowPassDb(f, band.highHz, band.highSlope)
      : highRollDb(f, band.highHz, band.highSlope);
    value += offsetAt(offsets, f);
    magDb[i] = Math.max(-200, value);
  }
  return magDb;
}

/** True when every boundary between the sections has a crossover frequency. */
export function crossoversComplete(spec) {
  const sections = (spec && spec.sections) || [];
  if (sections.length < 2) return false;
  const crossovers = (spec && spec.crossovers) || [];
  if (crossovers.length !== sections.length - 1) return false;
  return crossovers.every((entry) => Number(entry && entry.hz) > 0);
}

/**
 * The whole cabinet, only when the sections' crossover frequencies were entered.
 * The sections are combined by power, not by complex pressure: a generic model
 * has no crossover phase, and inventing one would invent the summation.
 */
export function generateCabinetResponse(spec, options = {}) {
  const frequencies = options.frequencies || gridFrequencies(GRID_POINTS);
  const sections = (spec && spec.sections) || [];
  if (sections.length < 2) {
    return { ok: true, magDb: generateSectionResponse(spec, 0, options), message: 'One section.' };
  }
  if (!crossoversComplete(spec)) {
    return {
      ok: false,
      magDb: null,
      message: 'The sections are not combined: a crossover frequency is missing for at least one ' +
        'section boundary, and the relative phase of two sections cannot be invented. Use a section on its own.',
    };
  }
  const power = new Float64Array(frequencies.length);
  for (let index = 0; index < sections.length; index += 1) {
    const section = generateSectionResponse(spec, index, options);
    for (let i = 0; i < frequencies.length; i += 1) {
      power[i] += Math.pow(10, section[i] / 10);
    }
  }
  const magDb = new Float64Array(frequencies.length);
  for (let i = 0; i < frequencies.length; i += 1) {
    magDb[i] = power[i] > 0 ? 10 * Math.log10(power[i]) : -200;
  }
  return {
    ok: true,
    magDb,
    message: 'The sections are summed as power, not as complex pressure: the crossover phase is unknown.',
  };
}

/* ---------- validation ---------- */

export function validateSpec(spec) {
  const errors = [];
  const warnings = [];
  if (!spec || typeof spec !== 'object') {
    return { errors: ['There is no speaker specification to save.'], warnings: [] };
  }
  if (!text(spec.name, 80)) errors.push('The loudspeaker needs a name.');

  const fMin = num(spec.band && spec.band.fMin);
  const fMax = num(spec.band && spec.band.fMax);
  if (fMin === null || fMax === null) errors.push('The frequency range needs both a lower and an upper limit.');
  else if (!(fMax > fMin)) errors.push('The upper frequency limit must be above the lower one.');
  else if (fMax / fMin < 1.01) errors.push('The frequency range is too narrow to model.');
  if (fMin !== null && fMin < CURVE_FMIN) {
    warnings.push('The range starts below ' + CURVE_FMIN + ' Hz; the model grid begins there, so lower ' +
      'frequencies are not modelled.');
  }
  if (fMax !== null && fMax > CURVE_FMAX) {
    warnings.push('The range ends above ' + CURVE_FMAX + ' Hz; the model grid stops there.');
  }

  const sections = Array.isArray(spec.sections) ? spec.sections : [];
  if (!sections.length) errors.push('A loudspeaker needs at least one section.');

  const crossovers = Array.isArray(spec.crossovers) ? spec.crossovers : [];
  let previous = 0;
  for (let index = 0; index < sections.length - 1; index += 1) {
    const crossover = crossovers[index];
    const hz = num(crossover && crossover.hz);
    if (hz === null) {
      warnings.push('No crossover frequency between section ' + (index + 1) + ' and section ' +
        (index + 2) + ': the two sections are offered separately and are not combined.');
      continue;
    }
    if (!(hz > previous)) {
      errors.push('Crossover frequencies must rise from the first section to the last.');
      break;
    }
    previous = hz;
  }

  const sensitivity = spec.sensitivity || {};
  const at1W = num(sensitivity.at1W);
  const atVolts = num(sensitivity.atVolts);
  const impedance = num(sensitivity.impedanceOhm);
  if (at1W === null && atVolts === null && !sections.some((section) => num(section.sensitivityDb) !== null)) {
    warnings.push('No sensitivity was entered. A 96 dB placeholder is used, so the absolute level of the ' +
      'curve means nothing until a real figure is typed.');
  }
  if (at1W !== null && (at1W < 40 || at1W > 160)) {
    warnings.push('Sensitivity ' + at1W + ' dB is outside 40–160 dB; check the figure.');
  }
  if (atVolts !== null && !(impedance > 0)) {
    errors.push('A dB SPL at 2.83 V rating needs the nominal impedance to be converted to 1 W.');
  }
  if (at1W !== null && atVolts !== null && impedance > 0) {
    const converted = sensitivityFromWatts(at1W, impedance, sensitivity.volts);
    if (Math.abs(converted - atVolts) > 1.5) {
      warnings.push('The 1 W and 2.83 V ratings differ by ' + (atVolts - converted).toFixed(1) +
        ' dB more than the impedance explains. Both were stored as entered; the curve uses the 1 W figure.');
    }
  }

  for (const [index, section] of sections.entries()) {
    const low = num(section.band && section.band.fMin);
    const high = num(section.band && section.band.fMax);
    if (low === null || high === null || !(high > low)) {
      errors.push('Section ' + (index + 1) + ' needs a usable frequency band.');
    }
    if (num(section.maxContinuousDb) !== null && num(section.maxPeakDb) !== null &&
      Number(section.maxPeakDb) < Number(section.maxContinuousDb)) {
      warnings.push('Section ' + (index + 1) + ' has a peak SPL below its continuous SPL.');
    }
  }

  const directivity = spec.directivity || {};
  if (directivity.model !== 'omni') {
    if (!(Number(directivity.hDeg) >= 5 && Number(directivity.hDeg) <= 360)) {
      errors.push('The horizontal coverage must be between 5° and 360°.');
    }
    if (!(Number(directivity.vDeg) >= 5 && Number(directivity.vDeg) <= 360)) {
      errors.push('The vertical coverage must be between 5° and 360°.');
    }
    if (directivity.model === 'frequency' &&
      !(Array.isArray(directivity.points) && directivity.points.length)) {
      warnings.push('Frequency-dependent beamwidth is selected but no band widths were entered, so the ' +
        'nominal figures are used at every frequency.');
    }
  }

  const physical = spec.physical || {};
  for (const [key, label] of [['widthM', 'width'], ['heightM', 'height'], ['depthM', 'depth']]) {
    if (!(Number(physical[key]) > 0)) errors.push('The cabinet ' + label + ' must be greater than zero.');
  }

  if (!hasSensitivity(spec)) {
    warnings.push('The curve’s level is not a calibrated SPL: it rests on a published sensitivity figure at ' +
      '1 m, not on a measurement.');
  }
  warnings.push('A generic model carries no phase, so any summation that uses it assumes phase and is a ' +
    'prediction, not an alignment.');
  if (directivity.model === 'omni') {
    warnings.push('Omnidirectional approximation: aim is stored and drawn but does not change the predicted level.');
  }
  if (!physical.acousticCenter) {
    warnings.push('The acoustic centre is unknown and is taken as the cabinet’s reference point.');
  }
  if (num(spec.band && spec.band.toleranceDb) === null) {
    warnings.push('No frequency-response tolerance was entered, so the generated curve inside the band is a ' +
      'nominal shape, not a guarantee of flatness.');
  }

  return { errors, warnings };
}

/* ---------- accuracy and data hierarchy ---------- */

export const ACCURACY_LEVELS = [
  {
    id: 'generic',
    label: 'Generic model',
    note: 'Approximate response and coverage based on manually entered specifications.',
  },
  {
    id: 'manufacturer',
    label: 'Manufacturer model',
    note: 'Prediction based on imported manufacturer acoustic data.',
  },
  {
    id: 'measured',
    label: 'Measured model',
    note: 'Prediction based on actual measurements with documented conditions.',
  },
  {
    id: 'hybrid',
    label: 'Hybrid model',
    note: 'More than one kind of data is attached. The prediction uses exactly the dataset chosen for the ' +
      'source; nothing is replaced automatically.',
  },
  {
    id: 'incomplete',
    label: 'No acoustic data',
    note: 'This loudspeaker has no response attached yet, so it cannot be predicted.',
  },
];

function datasetKind(dataset) {
  if (!dataset) return 'unknown';
  if (dataset.generated) return 'generic';
  // A theoretical dataset that was not generated by this builder (a room
  // prediction sent back to the modeler, say) is still an estimate, not
  // manufacturer data.
  if (dataset.provenance === 'theoretical') return 'generic';
  if (dataset.provenance === 'manufacturer') return 'manufacturer';
  if (dataset.provenance === 'measured') return 'measured';
  return 'imported';
}

/**
 * Which accuracy label a model carries. A generic model is never presented as a
 * measured one, and attaching measured data beside the entered specifications
 * makes the model hybrid rather than silently upgrading the generic curve.
 */
export function accuracyOf(model) {
  const datasets = (model && model.datasets) || [];
  const kinds = new Set();
  for (const dataset of datasets) {
    const kind = datasetKind(dataset);
    if (kind !== 'unknown') kinds.add(kind);
  }
  if (!datasets.length && model && model.generic) kinds.add('generic');
  const list = [...kinds];

  if (!list.length) {
    return { id: 'incomplete', ...ACCURACY_LEVELS.find((entry) => entry.id === 'incomplete'), kinds: [] };
  }
  if (list.length > 1) {
    const entry = ACCURACY_LEVELS.find((item) => item.id === 'hybrid');
    const named = list.map((kind) => (kind === 'generic' ? 'generic specification'
      : kind === 'manufacturer' ? 'manufacturer data'
        : kind === 'measured' ? 'measured data' : 'imported data'));
    return { ...entry, kinds: list, note: entry.note + ' This model carries ' + named.join(', ') + '.' };
  }
  const id = list[0] === 'imported' ? 'manufacturer' : list[0];
  const entry = ACCURACY_LEVELS.find((item) => item.id === id) || ACCURACY_LEVELS[0];
  return { ...entry, kinds: list };
}

/** The short badge the library shows, keeping the required caveat on a generic model. */
export function accuracyBadge(model) {
  const accuracy = accuracyOf(model);
  if (accuracy.id === 'generic') {
    return (model && model.generic && model.generic.labelCaveat) || GENERIC_CAVEAT;
  }
  if (accuracy.id === 'incomplete') return 'NO ACOUSTIC DATA';
  return accuracy.label.toUpperCase();
}

/**
 * The datasets attached to a model, with what each one rests on. The first row
 * is the one the engine would use for a source with no dataset named; the chosen
 * dataset is kept in the specification so a save does not lose the choice.
 */
export function dataSourcesOf(model) {
  const datasets = (model && model.datasets) || [];
  const preferred = model && model.generic ? model.generic.preferredDatasetId : '';
  const fallback = datasets.length ? datasets[0].id : '';
  // The list is ordered by the data-source hierarchy — measured, manufacturer,
  // imported, then the generic estimate — but no dataset is selected or replaced
  // by that order: the preferred one is whatever the operator chose, or the
  // engine's fallback when nothing was chosen.
  const rank = { measured: 0, manufacturer: 1, imported: 2, generic: 3 };
  return datasets.map((dataset) => ({
    id: dataset.id,
    label: dataset.label,
    kind: datasetKind(dataset),
    provenance: dataset.provenance || '',
    hasPhase: !!dataset.hasPhase,
    directivity: (dataset.directivity || []).length,
    preferred: preferred ? dataset.id === preferred : dataset.id === fallback,
    note: dataset.note || '',
  })).sort((a, b) => (rank[a.kind] ?? 4) - (rank[b.kind] ?? 4));
}

export function defaultDatasetId(model) {
  const datasets = (model && model.datasets) || [];
  if (!datasets.length) return '';
  const preferred = model && model.generic ? model.generic.preferredDatasetId : '';
  return datasets.some((entry) => entry.id === preferred) ? preferred : datasets[0].id;
}

/* ---------- turning a specification into datasets ---------- */

function datasetLabel(spec, suffix) {
  return (spec.name || 'Loudspeaker') + ' · ' + suffix + ' (generic)';
}

function datasetFor(spec, band, frequencies, directivity, sectionId, label, note, range) {
  const low = range && Number.isFinite(Number(range.fMin)) ? Number(range.fMin) : spec.band.fMin;
  const high = range && Number.isFinite(Number(range.fMax)) ? Number(range.fMax) : spec.band.fMax;
  return {
    id: 'gen-' + sectionId,
    label,
    provenance: 'theoretical',
    generated: true,
    sectionId,
    importedFrom: 'Custom speaker builder · published specifications',
    curve: {
      magDb: Array.from(band, (value) => round(value, 3)),
      phaseDeg: null,
      coherence: null,
    },
    points: frequencies.length,
    hasPhase: false,
    phaseOrigin: 'none',
    fMin: clamp(low, CURVE_FMIN, CURVE_FMAX, 55),
    fMax: clamp(high, CURVE_FMIN, CURVE_FMAX, 17000),
    sampleRate: 0,
    fftSize: 0,
    delayMs: 0,
    conditions: {
      micDistanceM: 1,
      micLabel: '1 m · published specification',
      reference: 'published specifications',
      phaseCompensated: false,
      measuredAt: '',
    },
    origin: null,
    directivity,
    directivityProfile: spec.directivity.profile,
    note: [note, spec.labelCaveat].filter(Boolean).join(' · '),
    importedAt: new Date().toISOString(),
  };
}

/**
 * Build the datasets a specification describes: one per section, plus the whole
 * cabinet when its crossovers are known. Every one is magnitude-only and marked
 * as generated, so attaching measured data later cannot overwrite them.
 */
export function buildDatasets(spec) {
  const frequencies = gridFrequencies(GRID_POINTS);
  const directivity = directivityEntries(spec);
  const datasets = [];
  const messages = [];
  const sections = (spec && spec.sections) || [];

  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    const curve = generateSectionResponse(spec, index, { frequencies });
    const band = sectionBands(spec)[index];
    datasets.push(datasetFor(
      spec,
      curve,
      frequencies,
      directivity,
      section.id,
      datasetLabel(spec, section.label),
      'Theoretical estimate from the entered specifications: magnitude only, no phase.' +
        (spec.directivity.model === 'omni' ? ' Omnidirectional approximation.' : ''),
      { fMin: band.lowHz, fMax: band.highHz }
    ));
  }

  if (sections.length > 1) {
    const combined = generateCabinetResponse(spec, { frequencies });
    if (combined.ok && combined.magDb) {
      datasets.push(datasetFor(
        spec,
        combined.magDb,
        frequencies,
        directivity,
        'cabinet',
        datasetLabel(spec, 'cabinet power sum'),
        combined.message,
        { fMin: spec.band.fMin, fMax: spec.band.fMax }
      ));
    }
    messages.push(combined.message);
  }

  return { datasets, messages, directivity, frequencies };
}

/* ---------- model fields ---------- */

export function modelTypeFor(spec) {
  const type = speakerType(spec && spec.type);
  return type.modelType;
}

export function crossoverTextOf(spec) {
  const crossovers = (spec && spec.crossovers) || [];
  return crossovers
    .filter((entry) => Number(entry && entry.hz) > 0)
    .map((entry) => Math.round(entry.hz) + ' Hz · ' + (entry.slopeDbPerOct || 24) + ' dB/oct ' +
      (entry.family || 'Linkwitz-Riley'))
    .join('; ')
    .slice(0, 120);
}

export function directivityTextOf(spec) {
  const directivity = (spec && spec.directivity) || {};
  if (directivity.model === 'omni') return 'Omnidirectional approximation (no directivity data)';
  return directivity.hDeg + '° × ' + directivity.vDeg + '° nominal, ' + directivity.referenceDb +
    ' dB reference, ' + directivity.profile + ' taper';
}

export function specsTextOf(spec) {
  const parts = [];
  if (spec.description) parts.push(spec.description);
  const sensitivity = (spec && spec.sensitivity) || {};
  if (num(sensitivity.at1W) !== null) parts.push('Sensitivity ' + sensitivity.at1W + ' dB (1 W / 1 m)');
  if (num(sensitivity.atVolts) !== null) {
    parts.push('Sensitivity ' + sensitivity.atVolts + ' dB (2.83 V / 1 m, ' +
      sensitivity.impedanceOhm + ' Ω)');
  }
  for (const section of spec.sections || []) {
    const bits = [];
    if (num(section.sensitivityDb) !== null) bits.push(section.sensitivityDb + ' dB (1 W / 1 m)');
    if (num(section.maxPeakDb) !== null) bits.push('peak ' + section.maxPeakDb + ' dB');
    if (num(section.maxContinuousDb) !== null) bits.push('continuous ' + section.maxContinuousDb + ' dB');
    if (num(section.powerW) !== null) bits.push(section.powerW + ' W');
    if (bits.length) parts.push(section.label + ': ' + bits.join(', '));
  }
  if (num(spec.output && spec.output.maxPeakDb) !== null) {
    parts.push('Cabinet peak ' + spec.output.maxPeakDb + ' dB');
  }
  return parts.join(' · ').slice(0, 400);
}

export function modelFieldsFromSpec(spec) {
  const reference = sensitivityAt1W(spec, 0);
  return {
    name: text(spec.name, 80) || 'Unnamed loudspeaker',
    manufacturer: text(spec.manufacturer, 60),
    model: text(spec.modelNumber, 60),
    type: modelTypeFor(spec),
    impedanceOhm: clamp(spec.sensitivity && spec.sensitivity.impedanceOhm, 0.5, 64, 8),
    sensitivityDb: clamp(reference, 40, 160, 96),
    distanceM: 1,
    referenceDelayMs: 0,
    crossoverText: crossoverTextOf(spec),
    directivityText: directivityTextOf(spec).slice(0, 120),
    specs: specsTextOf(spec),
    notes: [spec.notes, spec.labelCaveat].filter(Boolean).join(' ').slice(0, 400),
    provenance: 'theoretical',
  };
}

/* ---------- revisions ---------- */

export function revisionEntry(spec, note) {
  if (!spec) return null;
  return {
    id: makeId('rev-'),
    savedAt: text(spec.updatedAt, 40) || new Date().toISOString(),
    note: text(note, 120) || 'Previous specification',
    summary: [spec.name, speakerType(spec.type).label,
      spec.band ? (spec.band.fMin + ' Hz – ' + spec.band.fMax + ' Hz') : '',
      spec.sections && spec.sections.length ? spec.sections.length + ' section' +
        (spec.sections.length === 1 ? '' : 's') : ''].filter(Boolean).join(' · '),
    spec: JSON.parse(JSON.stringify(spec)),
  };
}

export function normalizeRevision(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const spec = normalizeSpec(source.spec);
  if (!spec) return null;
  return {
    id: text(source.id, 60) || makeId('rev-'),
    savedAt: text(source.savedAt, 40) || new Date().toISOString(),
    note: text(source.note, 120),
    summary: text(source.summary, 160) || [spec.name, spec.band.fMin + ' Hz – ' + spec.band.fMax + ' Hz'].join(' · '),
    spec,
  };
}

/**
 * Write a specification onto a model: the fields the rest of the library reads,
 * the generated datasets (replacing only generated ones), and a revision of what
 * was there before. Datasets that were imported are never touched.
 */
export function applySpecToModel(model, spec, options = {}) {
  if (!model) return { ok: false, message: 'There is no loudspeaker to update.' };
  const clean = normalizeSpec(spec);
  if (!clean) return { ok: false, message: 'That specification could not be read.' };
  const now = new Date().toISOString();
  const previous = model.generic && typeof model.generic === 'object' ? model.generic : null;
  const previousInUse = (previous && previous.preferredDatasetId) || model.generic?.preferredDatasetId || '';

  Object.assign(model, modelFieldsFromSpec(clean));
  const built = buildDatasets(clean);

  const retained = Array.isArray(model.datasets)
    ? model.datasets.filter((dataset) => dataset && !dataset.generated)
    : [];
  model.datasets = built.datasets.concat(retained).slice(0, 24);

  const revision = previous ? (Number(previous.revision) || 0) + 1 : 1;
  model.generic = {
    ...clean,
    revision,
    updatedAt: now,
    preferredDatasetId: model.datasets.some((dataset) => dataset.id === previousInUse)
      ? previousInUse
      : (built.datasets[0] ? built.datasets[0].id : (retained[0] ? retained[0].id : '')),
  };

  const entry = revisionEntry(previous, options.note);
  model.revisions = (entry ? [entry] : []).concat(Array.isArray(model.revisions) ? model.revisions : [])
    .slice(0, 12);
  model.updatedAt = now;
  return {
    ok: true,
    message: 'Saved “' + model.name + '”: ' + built.datasets.length + ' generated dataset' +
      (built.datasets.length === 1 ? '' : 's') + '. ' + built.messages.filter(Boolean).join(' '),
    datasets: built.datasets,
  };
}

export function newCustomSpeakerModel(spec) {
  const now = new Date().toISOString();
  const model = {
    id: makeId('m-'),
    name: 'Unnamed loudspeaker',
    manufacturer: '',
    model: '',
    type: 'Custom',
    impedanceOhm: 8,
    sensitivityDb: 96,
    distanceM: 1,
    referenceDelayMs: 0,
    crossoverText: '',
    directivityText: '',
    specs: '',
    notes: '',
    provenance: 'theoretical',
    datasets: [],
    generic: null,
    revisions: [],
    createdAt: now,
    updatedAt: now,
  };
  applySpecToModel(model, spec, { note: 'First saved from the specification sheet' });
  return model;
}

/* ---------- export and import ---------- */

export function exportDefinition(model) {
  if (!model || typeof model !== 'object') return '';
  return JSON.stringify({
    schema: SPEAKER_SCHEMA,
    app: 'Align web · System Data Modeler',
    exportedAt: new Date().toISOString(),
    note: 'A custom speaker definition: the entered specification, the datasets generated from it and ' +
      'any measured or manufacturer data attached to the same loudspeaker.',
    speaker: {
      name: model.name,
      manufacturer: model.manufacturer,
      model: model.model,
      type: model.type,
      impedanceOhm: model.impedanceOhm,
      sensitivityDb: model.sensitivityDb,
      distanceM: model.distanceM,
      crossoverText: model.crossoverText,
      directivityText: model.directivityText,
      specs: model.specs,
      notes: model.notes,
      generic: model.generic || null,
      datasets: (model.datasets || []).map((dataset) => ({ ...dataset })),
      revisions: model.revisions || [],
    },
  }, null, 2);
}

function usableCurve(dataset) {
  const values = dataset && dataset.curve && Array.isArray(dataset.curve.magDb)
    ? dataset.curve.magDb : null;
  // The schema is this app's own: a dataset is one response on the 400-point
  // model grid. Anything shorter is a truncated file, not a curve to import.
  if (!values || values.length !== GRID_POINTS) return false;
  return values.every((value) => Number.isFinite(Number(value)));
}

/**
 * Read a definition file back. The whole file is validated before anything is
 * offered to the library: a truncated curve or a foreign schema is refused with
 * a message instead of being half-imported.
 */
export function parseDefinition(textValue) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(textValue || ''));
  } catch (err) {
    return { ok: false, message: 'That file is not JSON, so it is not a speaker definition.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: 'That JSON does not hold a speaker definition.' };
  }
  if (parsed.schema && parsed.schema !== SPEAKER_SCHEMA) {
    return { ok: false, message: 'That file names the schema “' + parsed.schema + '”; this app reads “' +
      SPEAKER_SCHEMA + '”.' };
  }
  const speaker = parsed.speaker || parsed.model || parsed;
  if (!speaker || typeof speaker !== 'object' || Array.isArray(speaker)) {
    return { ok: false, message: 'That file has no speaker object in it.' };
  }
  const name = text(speaker.name, 80);
  if (!name) return { ok: false, message: 'A speaker definition needs a name.' };

  const datasets = Array.isArray(speaker.datasets) ? speaker.datasets : [];
  for (const [index, dataset] of datasets.entries()) {
    if (!usableCurve(dataset)) {
      return {
        ok: false,
        message: 'Dataset ' + (index + 1) + ' in that file has no usable magnitude curve, so the whole ' +
          'file is refused rather than imported in part.',
      };
    }
  }
  const generic = speaker.generic && typeof speaker.generic === 'object'
    ? normalizeSpec(speaker.generic) : null;
  if (!generic && !datasets.length) {
    return { ok: false, message: 'That definition holds neither an entered specification nor any dataset.' };
  }

  const model = {
    ...speaker,
    name,
    generic,
    datasets,
    revisions: (Array.isArray(speaker.revisions) ? speaker.revisions : [])
      .map(normalizeRevision).filter(Boolean).slice(0, 12),
  };
  return {
    ok: true,
    message: 'Read “' + name + '”: ' + (generic ? 'an entered specification' : 'no entered specification') +
      ', ' + datasets.length + ' dataset' + (datasets.length === 1 ? '' : 's') + '.',
    model,
  };
}
