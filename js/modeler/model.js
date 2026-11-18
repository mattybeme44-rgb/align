/*
 * The modelling engine: what a system of loudspeakers actually sums to.
 *
 * A response is kept as a complex pressure on one log frequency grid. Gain,
 * delay and polarity rotate and scale it; a DSP chain multiplies it; a sum adds
 * the complex values, never the decibel magnitudes. That is the whole point of
 * this module: two curves that read the same in dB can add to +6 dB, cancel, or
 * anything in between, and only the complex arithmetic knows which.
 *
 * Where a curve carries no measured phase, the prediction assumes zero phase at
 * that source and says so — it never pretends the sum of two magnitudes is an
 * answer.
 */

import {
  GRID_POINTS,
  SPEED_OF_SOUND,
  compareCurves,
  curveStatistics,
  fractionalOctaveSmooth,
  gridFrequencies,
  gridFrequency,
  resampleResponse,
  wrapDegrees,
} from './curve.js';
import { chainResponse, normalizeFilter } from './filters.js';
import { emptyRoom, normalizeRoom, SOURCE_ROLES } from './room.js';
import { normalizeRevision, normalizeSpec } from './speaker-builder.js';
import { FFT } from '../fft.js';

export const MODEL_TYPES = ['Subwoofer', 'Full-range', 'Top / main', 'Monitor', 'Custom'];

export const PROVENANCES = [
  { id: 'manufacturer', label: 'Manufacturer data' },
  { id: 'measured', label: 'Measured' },
  { id: 'theoretical', label: 'Theoretical model' },
];

export const OBJECTIVES = [
  { id: 'sum', label: 'Broadband coherent summation' },
  { id: 'crossover', label: 'Best crossover-region summation' },
  { id: 'worst', label: 'Minimum cancellation' },
  { id: 'phase', label: 'Minimum phase difference' },
  { id: 'smooth', label: 'Smoothest combined response' },
  { id: 'custom', label: 'Weighted (low / mid / high)' },
];

function clamp(value, low, high, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(high, Math.max(low, number));
}

function text(value, limit) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, limit);
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function makeId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(16).slice(2, 6);
}

export function provenanceLabel(id) {
  const found = PROVENANCES.find((entry) => entry.id === id);
  return found ? found.label : 'Imported';
}

/* ---------- the catalogue ---------- */

export function newModel(fields = {}) {
  const now = new Date().toISOString();
  return {
    id: makeId('m-'),
    name: text(fields.name, 80) || 'Unnamed loudspeaker',
    manufacturer: text(fields.manufacturer, 60),
    model: text(fields.model, 60),
    type: MODEL_TYPES.includes(fields.type) ? fields.type : 'Custom',
    impedanceOhm: clamp(fields.impedanceOhm, 0.5, 64, 8),
    sensitivityDb: clamp(fields.sensitivityDb, 50, 150, 96),
    distanceM: clamp(fields.distanceM, 0, 200, 1),
    referenceDelayMs: clamp(fields.referenceDelayMs, -100, 100, 0),
    crossoverText: text(fields.crossoverText, 120),
    directivityText: text(fields.directivityText, 120),
    specs: text(fields.specs, 400),
    notes: text(fields.notes, 400),
    provenance: PROVENANCES.some((entry) => entry.id === fields.provenance)
      ? fields.provenance
      : 'measured',
    datasets: [],
    // The specification a generic loudspeaker was built from, and the versions it
    // has been through. Both are kept beside the datasets: attaching measured data
    // later never overwrites what the operator entered.
    generic: normalizeSpec(fields.generic),
    revisions: (Array.isArray(fields.revisions) ? fields.revisions : [])
      .map(normalizeRevision).filter(Boolean).slice(0, 12),
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeCurve(raw, count = GRID_POINTS) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const values = Array.from(source.magDb || []).map(Number);
  const usable = values.filter((value) => Number.isFinite(value));
  if (usable.length < 2) return null;

  if (values.length === count && usable.length === count) {
    return {
      magDb: values.slice(),
      phaseDeg: Array.isArray(source.phaseDeg) && source.phaseDeg.length === count
        ? source.phaseDeg.map(Number).map((value) => (Number.isFinite(value) ? value : 0))
        : null,
      coherence: Array.isArray(source.coherence) && source.coherence.length === count
        ? source.coherence.map((value) => clamp(value, 0, 1, 0))
        : null,
    };
  }

  const frequencies = values.map((value, index) => gridFrequency(index, values.length));
  const resampled = resampleResponse({
    frequencies,
    magDb: values,
    phaseDeg: Array.isArray(source.phaseDeg) ? source.phaseDeg : null,
    coherence: Array.isArray(source.coherence) ? source.coherence : null,
  }, count);
  if (!resampled.ok) return null;
  return {
    magDb: Array.from(resampled.magDb),
    phaseDeg: resampled.phaseDeg ? Array.from(resampled.phaseDeg) : null,
    coherence: resampled.coherence ? Array.from(resampled.coherence) : null,
  };
}

function normalizeConditions(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const mic = source.micPosition && typeof source.micPosition === 'object' ? source.micPosition : {};
  return {
    venue: text(source.venue, 80),
    event: text(source.event, 80),
    micLabel: text(source.micLabel, 80),
    micDistanceM: finiteOrNull(source.micDistanceM),
    micHeightM: finiteOrNull(source.micHeightM),
    device: text(source.device, 120),
    channels: text(source.channels, 40),
    reference: text(source.reference, 60),
    calibrationName: text(source.calibrationName, 120),
    calibrationOffsetDb: finiteOrNull(source.calibrationOffsetDb),
    phaseCompensated: source.phaseCompensated === true,
    measuredAt: text(source.measuredAt, 40),
    mic,
  };
}

function normalizeOrigin(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind === 'capture' || raw.kind === 'speaker' || raw.kind === 'sent' ? raw.kind : 'capture';
  const id = text(raw.id, 80);
  if (!id) return null;
  return {
    kind,
    id,
    name: text(raw.name, 80),
    date: text(raw.date, 40),
  };
}

export function normalizeDataset(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const curve = normalizeCurve(source.curve || source);
  if (!curve) return null;
  const hasPhase = !!curve.phaseDeg;
  return {
    id: text(source.id, 60) || makeId('d-'),
    label: text(source.label || source.name, 80) || 'Imported response',
    provenance: PROVENANCES.some((entry) => entry.id === source.provenance)
      ? source.provenance
      : 'measured',
    importedFrom: text(source.importedFrom, 120),
    curve,
    points: GRID_POINTS,
    hasPhase,
    phaseOrigin: hasPhase ? (text(source.phaseOrigin, 40) || 'measured') : 'none',
    fMin: clamp(source.fMin, 1, 20000, 20),
    fMax: clamp(source.fMax, 20, 20000, 20000),
    sampleRate: clamp(source.sampleRate, 0, 384000, 0),
    fftSize: clamp(source.fftSize, 0, 262144, 0),
    delayMs: clamp(source.delayMs, -1000, 1000, 0),
    conditions: normalizeConditions(source.conditions),
    origin: normalizeOrigin(source.origin),
    directivity: Array.isArray(source.directivity)
      ? source.directivity
          .filter((entry) => entry && Number.isFinite(Number(entry.frequency)) &&
            Number.isFinite(Number(entry.widthDeg)))
          .slice(0, 64)
          .map((entry) => {
            const point = {
              frequency: Number(entry.frequency),
              widthDeg: Number(entry.widthDeg),
            };
            // A generic model carries horizontal and vertical widths separately;
            // an imported CLF file carries the single published width.
            if (Number(entry.widthHDeg) > 0) point.widthHDeg = Number(entry.widthHDeg);
            if (Number(entry.widthVDeg) > 0) point.widthVDeg = Number(entry.widthVDeg);
            if (typeof entry.profile === 'string' && entry.profile) {
              point.profile = text(entry.profile, 20);
            }
            return point;
          })
      : [],
    directivityProfile: text(source.directivityProfile, 20),
    generated: source.generated === true,
    sectionId: text(source.sectionId, 60),
    note: text(source.note, 200),
    importedAt: text(source.importedAt, 40) || new Date().toISOString(),
  };
}

export function normalizeModel(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const model = newModel(source);
  const datasets = Array.isArray(source.datasets) ? source.datasets : [];
  model.id = text(source.id, 60) || model.id;
  model.generic = normalizeSpec(source.generic);
  model.revisions = (Array.isArray(source.revisions) ? source.revisions : [])
    .map(normalizeRevision).filter(Boolean).slice(0, 12);
  model.createdAt = text(source.createdAt, 40) || model.createdAt;
  model.updatedAt = text(source.updatedAt, 40) || model.updatedAt;
  if (Number.isFinite(Number(source.impedanceOhm))) model.impedanceOhm = clamp(source.impedanceOhm, 0.5, 64, 8);
  if (Number.isFinite(Number(source.sensitivityDb))) model.sensitivityDb = clamp(source.sensitivityDb, 50, 150, 96);
  model.datasets = datasets.map(normalizeDataset).filter(Boolean).slice(0, 24);
  return model;
}

export function normalizeGroup(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    id: text(source.id, 60) || makeId('g-'),
    name: text(source.name, 60) || 'Group',
    gainDb: clamp(source.gainDb, -24, 24, 0),
    delayMs: clamp(source.delayMs, -100, 100, 0),
    polarity: source.polarity === 'inverted' ? 'inverted' : 'normal',
    muted: source.muted === true,
    // Linked channels: a group's DSP chain applies to every source in it, on
    // top of what that source carries itself.
    filters: Array.isArray(source.filters) ? source.filters.map(normalizeFilter).slice(0, 24) : [],
  };
}

/**
 * Where a source stands in the room, when it has been placed. A source that has
 * never been placed carries `null`, so the Room Designer can list it as waiting
 * rather than pretending it sits at the origin.
 */
function normalizeRoomPlacement(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const x = finiteOrNull(raw.x);
  const y = finiteOrNull(raw.y);
  if (x === null || y === null) return null;
  return {
    x: clamp(x, -200, 400, 0),
    y: clamp(y, -200, 600, 0),
    z: clamp(raw.z, 0, 60, 0),
    aimH: clamp(raw.aimH, -180, 180, 0),
    aimV: clamp(raw.aimV, -90, 90, 0),
    roll: clamp(raw.roll, -180, 180, 0),
    role: SOURCE_ROLES.some((entry) => entry.id === raw.role) ? raw.role : 'custom',
    timing: raw.timing === 'measured' ? 'measured' : 'geometric',
    timingOffsetMs: clamp(raw.timingOffsetMs, -50, 50, 0),
  };
}

export function normalizeSource(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const positionDatasets = {};
  if (source.positionDatasets && typeof source.positionDatasets === 'object') {
    for (const [key, value] of Object.entries(source.positionDatasets)) {
      if (typeof value === 'string' && value) positionDatasets[String(key).slice(0, 40)] = value.slice(0, 60);
    }
  }
  return {
    id: text(source.id, 60) || makeId('s-'),
    modelId: text(source.modelId, 60),
    datasetId: text(source.datasetId, 60),
    name: text(source.name, 60) || 'Source',
    groupId: text(source.groupId, 60),
    gainDb: clamp(source.gainDb, -30, 30, 0),
    delayMs: clamp(source.delayMs, -50, 100, 0),
    polarity: source.polarity === 'inverted' ? 'inverted' : 'normal',
    muted: source.muted === true,
    soloed: source.soloed === true,
    reference: source.reference === true,
    filters: Array.isArray(source.filters)
      ? source.filters.map(normalizeFilter).slice(0, 24)
      : [],
    positionDatasets,
    distanceM: finiteOrNull(source.distanceM),
    note: text(source.note, 200),
    room: normalizeRoomPlacement(source.room),
  };
}

export function normalizePosition(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    id: text(source.id, 60) || makeId('p-'),
    label: text(source.label, 40) || 'Position',
    weight: clamp(source.weight, 0, 1, 1),
  };
}

export function normalizeSnapshot(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const name = text(source.name, 60);
  if (!name) return null;
  const data = source.data && typeof source.data === 'object' ? source.data : {};
  return {
    id: text(source.id, 60) || makeId('snap-'),
    name,
    savedAt: text(source.savedAt, 40) || new Date().toISOString(),
    data: {
      sources: (Array.isArray(data.sources) ? data.sources : []).map(normalizeSource).filter(Boolean),
      groups: (Array.isArray(data.groups) ? data.groups : []).map(normalizeGroup).filter(Boolean),
      positions: (Array.isArray(data.positions) ? data.positions : []).map(normalizePosition).filter(Boolean),
      settings: data.settings && typeof data.settings === 'object' ? data.settings : {},
      optimizer: data.optimizer && typeof data.optimizer === 'object' ? data.optimizer : null,
    },
  };
}

export function emptyProject() {
  return {
    models: [],
    sources: [],
    groups: [],
    positions: [{ id: 'centre', label: 'Centre', weight: 1 }],
    snapshots: [],
    room: emptyRoom('New room'),
    settings: {
      positionId: 'centre',
      view: 'transfer',
      phaseMode: 'wrapped',
      smoothing: 1 / 12,
      dbSpan: 0,
      showIndividual: true,
      showSum: true,
      propagation: { enabled: false, referenceDistanceM: 1, speedOfSound: SPEED_OF_SOUND },
      coherenceThreshold: 0.35,
      nullDepthDb: 20,
      crossoverRegion: null,
      compareDatasetId: '',
      compareLabel: '',
    },
  };
}

export function normalizeProject(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const base = emptyProject();
  return {
    ...base,
    models: (Array.isArray(source.models) ? source.models : []).map(normalizeModel).filter(Boolean),
    sources: (Array.isArray(source.sources) ? source.sources : []).map(normalizeSource).filter(Boolean),
    groups: (Array.isArray(source.groups) ? source.groups : []).map(normalizeGroup).filter(Boolean),
    positions: (Array.isArray(source.positions) && source.positions.length
      ? source.positions.map(normalizePosition).filter(Boolean)
      : base.positions),
    snapshots: (Array.isArray(source.snapshots) ? source.snapshots : [])
      .map(normalizeSnapshot).filter(Boolean).slice(0, 30),
    room: normalizeRoom(source.room || base.room),
    settings: { ...base.settings, ...(source.settings && typeof source.settings === 'object' ? source.settings : {}) },
  };
}

/* ---------- evaluating one source ---------- */

export function datasetTrace(dataset) {
  if (!dataset || !dataset.curve || !Array.isArray(dataset.curve.magDb)) return null;
  const count = dataset.curve.magDb.length;
  const frequencies = gridFrequencies(count);
  const magDb = Float64Array.from(dataset.curve.magDb.map(Number));
  const phaseDeg = Array.isArray(dataset.curve.phaseDeg)
    ? Float64Array.from(dataset.curve.phaseDeg.map(Number))
    : null;
  const coherence = Array.isArray(dataset.curve.coherence)
    ? Float64Array.from(dataset.curve.coherence.map(Number))
    : null;
  return { frequencies, magDb, phaseDeg, coherence, count, datasetId: '', label: '', provenance: dataset.provenance || '', directivity: dataset.directivity || [], directivityProfile: dataset.directivityProfile || '' };
}

export function findDataset(project, modelId, datasetId) {
  const model = (project.models || []).find((entry) => entry.id === modelId);
  if (!model) return { model: null, dataset: null };
  // A named dataset is the one that is used; only a source without a named
  // dataset falls back to the loudspeaker's first response.
  const dataset = datasetId
    ? (model.datasets || []).find((entry) => entry.id === datasetId) || null
    : (model.datasets && model.datasets[0]) || null;
  return { model, dataset };
}

export function sourceFilters(source, group) {
  const list = source && Array.isArray(source.filters) ? source.filters : [];
  // A group carries gain, delay and polarity; the filters stay on the source so
  // nothing about one cabinet is destroyed by a change to its group.
  return list;
}

/**
 * The effective settings of one source once its group is applied. Nothing stored
 * on the source is changed: the group is added on top, so removing the group
 * restores exactly what the source carried.
 */
export function effectiveSettings(source, group, propagation) {
  const groupGain = group ? group.gainDb : 0;
  const groupDelay = group ? group.delayMs : 0;
  const groupInverted = !!(group && group.polarity === 'inverted');

  let freeFieldGain = 0;
  let freeFieldDelay = 0;
  if (propagation && propagation.enabled && Number(source.distanceM) > 0 && propagation.referenceDistanceM > 0) {
    const reference = Number(propagation.referenceDistanceM);
    const distance = Number(source.distanceM);
    const speed = Number(propagation.speedOfSound) > 0 ? Number(propagation.speedOfSound) : SPEED_OF_SOUND;
    freeFieldGain = 20 * Math.log10(reference / distance);
    freeFieldDelay = ((distance - reference) / speed) * 1000;
  }

  return {
    gainDb: Number(source.gainDb) + groupGain + freeFieldGain,
    delayMs: Number(source.delayMs) + groupDelay + freeFieldDelay,
    inverted: (source.polarity === 'inverted') !== groupInverted,
    ownGainDb: Number(source.gainDb),
    groupGainDb: groupGain,
    freeFieldGainDb: freeFieldGain,
    freeFieldDelayMs: freeFieldDelay,
  };
}

export function effectiveFilters(source, group) {
  const own = source && Array.isArray(source.filters) ? source.filters : [];
  const linked = group && Array.isArray(group.filters) ? group.filters : [];
  // Linked channels apply in addition to the source's own chain, as an EQ
  // overlay does; neither list is overwritten.
  return linked.length ? own.concat(linked).slice(0, 48) : own;
}

/**
 * One source as a complex response on the grid: its own curve, its gain, delay
 * and polarity, and its DSP chain multiplied in. With `bypassFilters` the chain
 * is left out, which is how SER mode shows the response before the channel's
 * DSP. A magnitude-only curve is summed with zero phase and flagged, so the
 * caller can say so.
 */
export function sourceResponse(source, trace, group, options = {}) {
  const count = trace.magDb.length;
  const frequencies = trace.frequencies;
  const settings = effectiveSettings(source, group, options.propagation);
  const chain = options.bypassFilters
    ? { magDb: new Float64Array(count), phaseRad: new Float64Array(count) }
    : chainResponse(effectiveFilters(source, group), frequencies, options.sampleRate || 48000);
  const polarityRad = settings.inverted ? Math.PI : 0;
  const delaySeconds = settings.delayMs / 1000;

  const magDb = new Float64Array(count);
  const phaseDeg = new Float64Array(count);
  const re = new Float64Array(count);
  const im = new Float64Array(count);

  for (let i = 0; i < count; i += 1) {
    const f = frequencies[i];
    const magnitude = trace.magDb[i] + settings.gainDb + chain.magDb[i];
    const measuredPhase = trace.phaseDeg ? (trace.phaseDeg[i] * Math.PI) / 180 : 0;
    const phase = measuredPhase + chain.phaseRad[i] - 2 * Math.PI * f * delaySeconds + polarityRad;
    const linear = Math.pow(10, magnitude / 20);
    magDb[i] = magnitude;
    phaseDeg[i] = (phase * 180) / Math.PI;
    re[i] = linear * Math.cos(phase);
    im[i] = linear * Math.sin(phase);
  }

  return {
    id: source.id,
    name: source.name,
    frequencies,
    magDb,
    phaseDeg,
    re,
    im,
    filters: effectiveFilters(source, group),
    settings,
    phaseValid: !!trace.phaseDeg,
    coherence: trace.coherence,
    datasetId: trace.datasetId || '',
    label: trace.label || source.name,
    provenance: trace.provenance || '',
    directivity: trace.directivity || [],
    directivityProfile: trace.directivityProfile || '',
  };
}

/** Add complex responses; the result is null when nothing is active. */
export function sumResponses(list) {
  const active = (list || []).filter(Boolean);
  if (!active.length) return null;
  const count = active[0].magDb.length;
  const frequencies = active[0].frequencies;
  const re = new Float64Array(count);
  const im = new Float64Array(count);
  let assumedPhase = 0;

  for (const response of active) {
    if (!response.phaseValid) assumedPhase += 1;
    for (let i = 0; i < count; i += 1) {
      re[i] += response.re[i];
      im[i] += response.im[i];
    }
  }

  const magDb = new Float64Array(count);
  const phaseDeg = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    const magnitude = Math.hypot(re[i], im[i]);
    magDb[i] = magnitude > 0 ? 20 * Math.log10(magnitude) : -240;
    phaseDeg[i] = (Math.atan2(im[i], re[i]) * 180) / Math.PI;
  }

  return {
    frequencies,
    re,
    im,
    magDb,
    phaseDeg,
    activeIds: active.map((response) => response.id),
    assumedPhase,
  };
}

/**
 * Evaluate the whole system for one measuring position: every source resolved,
 * muted and soloed as set, summed in the complex domain.
 */
export function evaluateSystem(project, options = {}) {
  const positionId = options.positionId || (project.settings && project.settings.positionId) || 'centre';
  const anySolo = (project.sources || []).some((source) => source.soloed);
  const responses = [];
  const computed = [];
  const missing = [];
  const warnings = [];
  const sampleRates = new Set();
  const references = new Set();
  let compensated = null;
  let mixedCompensation = false;

  for (const source of project.sources || []) {
    if (source.muted) continue;
    if (anySolo && !source.soloed) continue;
    const datasetId = (source.positionDatasets && source.positionDatasets[positionId]) || source.datasetId;
    const found = findDataset(project, source.modelId, datasetId);
    const trace = found.dataset ? datasetTrace(found.dataset) : null;
    if (!trace) {
      missing.push(source.name);
      continue;
    }
    trace.datasetId = found.dataset.id;
    trace.label = found.dataset.label;
    const group = (project.groups || []).find((entry) => entry.id === source.groupId) || null;
    if (group && group.muted) continue;

    const conditions = found.dataset.conditions || {};
    if (Number(found.dataset.sampleRate) > 0) sampleRates.add(Number(found.dataset.sampleRate));
    if (conditions.reference) references.add(String(conditions.reference));
    if (typeof conditions.phaseCompensated === 'boolean') {
      if (compensated === null) compensated = conditions.phaseCompensated;
      else if (compensated !== conditions.phaseCompensated) mixedCompensation = true;
    }
    responses.push(sourceResponse(source, trace, group, options));
    computed.push({ source, trace, group });
  }

  // Two datasets that cannot be meaningfully summed together are said so,
  // rather than quietly producing a curve that means nothing.
  if (sampleRates.size > 1) {
    warnings.push('These responses were taken at different sample rates (' +
      [...sampleRates].join(', ') + ' Hz). A model is computed at one rate; check that the ' +
      'curves being compared really belong to the same measurement chain.');
  }
  if (references.size > 1) {
    warnings.push('These responses name different timing references (' +
      [...references].join(', ') + '), so their arrivals may not be comparable.');
  }
  if (mixedCompensation) {
    warnings.push('Some captures were taken with delay compensation on and some off. ' +
      'Their phase references differ; turn compensation off before comparing arrivals.');
  }
  for (const name of missing) {
    warnings.push('“' + name + '” has no measured response for this position and is left out of the sum.');
  }

  const sum = sumResponses(responses);
  // SER mode shows the response before the channel DSP as well as after it.
  const sumBefore = options.mode === 'ser'
    ? sumResponses(computed.map((entry) =>
        sourceResponse(entry.source, entry.trace, entry.group, { ...options, bypassFilters: true })))
    : null;

  // A manufacturer model and a measured response rest on different references;
  // they may be summed, but each is used exactly as stored and said so.
  const provenances = new Set(responses.map((response) => response.provenance).filter(Boolean));
  if (provenances.has('manufacturer') && provenances.has('measured')) {
    warnings.push('A manufacturer model and a measured response are being summed. Each is used ' +
      'exactly as stored: no manufacturer processing is applied on top, and their phase references ' +
      'may differ — check both before trusting the sum.');
  }

  return { responses, sum, sumBefore, missing, warnings, positionId };
}

/**
 * One measured response per measuring position, averaged into a single trace.
 *
 * Power averaging is the default because levels from different positions add as
 * energy; the dB average and coherence-weighted average are offered for
 * comparison. Phase is left absent unless every position carries it, and a
 * magnitude-only position makes the average magnitude-only — a phase is never
 * invented for it.
 */
export function spatialAverageResponses(list, options = {}) {
  const mode = options.mode === 'db' || options.mode === 'coherence' ? options.mode : 'power';
  const entries = (list || []).filter((entry) => entry && entry.trace && entry.trace.magDb);
  if (!entries.length) {
    return { ok: false, message: 'No measured position is available to average.' };
  }
  const count = entries[0].trace.magDb.length;
  const magDb = new Float64Array(count);
  const phaseDeg = new Float64Array(count);
  const everyPhase = entries.every((entry) => Array.isArray(entry.trace.phaseDeg));
  let phaseValid = everyPhase;

  for (let i = 0; i < count; i += 1) {
    let power = 0;
    let levelSum = 0;
    let weight = 0;
    let cosSum = 0;
    let sinSum = 0;
    let phaseWeight = 0;
    for (const entry of entries) {
      const w = Number(entry.weight) > 0 ? Number(entry.weight) : 1;
      const level = Number(entry.trace.magDb[i]);
      if (!Number.isFinite(level)) continue;
      const coherence = entry.trace.coherence ? Number(entry.trace.coherence[i]) : NaN;
      const used = mode === 'coherence' && Number.isFinite(coherence)
        ? w * Math.max(0, Math.min(1, coherence)) : w;
      power += Math.pow(10, level / 10) * used;
      levelSum += level * used;
      weight += used;
      if (everyPhase) {
        const phase = (Number(entry.trace.phaseDeg[i]) * Math.PI) / 180;
        if (Number.isFinite(phase)) {
          cosSum += Math.cos(phase) * used;
          sinSum += Math.sin(phase) * used;
          phaseWeight += used;
        } else phaseValid = false;
      }
    }
    magDb[i] = weight > 0
      ? (mode === 'power' ? 10 * Math.log10(Math.max(1e-24, power / weight)) : levelSum / weight)
      : -240;
    phaseDeg[i] = phaseValid && phaseWeight > 0
      ? (Math.atan2(sinSum, cosSum) * 180) / Math.PI
      : NaN;
  }

  return {
    ok: true,
    message: 'Averaged ' + entries.length + ' measured position' + (entries.length === 1 ? '' : 's') +
      (phaseValid ? ' with phase.' : ' — the average is magnitude-only.'),
    curve: {
      magDb: Array.from(magDb),
      phaseDeg: phaseValid ? Array.from(phaseDeg) : null,
      coherence: null,
    },
    positions: entries.length,
    mode,
  };
}

/* ---------- timing views of the sum ---------- */

/**
 * Group delay from the slope of the unwrapped phase: τ = −(dφ/df) / 360 s.
 *
 * A slope is taken over a small band of neighbours, in milliseconds, and left
 * blank where the coherence is below the threshold or where the sum sits in a
 * deep cancellation null — the phase there says nothing about timing.
 */
export function groupDelay(frequencies, phaseDeg, magDb, options = {}) {
  const count = frequencies.length;
  const threshold = Number.isFinite(Number(options.coherenceThreshold))
    ? Number(options.coherenceThreshold)
    : 0.35;
  const coherence = options.coherence || null;
  const nullDepthDb = Number.isFinite(Number(options.nullDepthDb))
    ? Number(options.nullDepthDb)
    : 20;
  const span = Math.max(1, Math.round(Number(options.span) || 3));

  let maxMag = -Infinity;
  for (let i = 0; i < count; i += 1) {
    if (Number.isFinite(magDb[i])) maxMag = Math.max(maxMag, magDb[i]);
  }

  const out = new Float64Array(count).fill(NaN);
  const phaseRad = new Float64Array(count);
  for (let i = 0; i < count; i += 1) phaseRad[i] = (phaseDeg[i] * Math.PI) / 180;

  for (let i = 0; i < count; i += 1) {
    if (coherence && Number(coherence[i]) < threshold) continue;
    if (Number.isFinite(maxMag) && magDb[i] < maxMag - nullDepthDb) continue;
    const lo = Math.max(0, i - span);
    const hi = Math.min(count - 1, i + span);
    if (hi === lo) continue;
    const slope = (phaseRad[hi] - phaseRad[lo]) / (frequencies[hi] - frequencies[lo]);
    const value = (-slope / (2 * Math.PI)) * 1000;
    out[i] = Math.max(-100, Math.min(100, value));
  }
  return out;
}

/**
 * The impulse response of the summed model, by inverse transform of its complex
 * response. This is a derived curve, not a measurement: the band edges are
 * tapered, so the result is labelled as derived wherever it is shown.
 */
export function synthesizeImpulse(sum, options = {}) {
  if (!sum) return { ok: false, message: 'There is no summed response to transform.' };
  const sampleRate = clamp(options.sampleRate, 8000, 192000, 48000);
  const bins = Math.max(1024, Math.min(65536, Math.round(options.bins || 8192)));
  const size = bins;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const frequencies = sum.frequencies;
  const count = frequencies.length;
  const fMin = frequencies[0];
  const fMax = frequencies[count - 1];
  const low = Math.log(fMin);
  const high = Math.log(fMax);

  // A raised-cosine taper at both edges: no invented DC term, no invented
  // bandwidth above the modelled band.
  const taper = (logF) => {
    if (!Number.isFinite(logF) || logF < low || logF > high) return 0;
    const t = (logF - low) / (high - low);
    const edge = 0.08;
    if (t < edge) return 0.5 * (1 - Math.cos((Math.PI * t) / edge));
    if (t > 1 - edge) return 0.5 * (1 - Math.cos((Math.PI * (1 - t)) / edge));
    return 1;
  };

  const complexAt = (frequency) => {
    // Interpolate the complex parts on the log axis; a fractional index.
    const logF = Math.log(frequency);
    const t = ((logF - low) / (high - low)) * (count - 1);
    if (t <= 0) return { re: sum.re[0], im: sum.im[0] };
    if (t >= count - 1) return { re: sum.re[count - 1], im: sum.im[count - 1] };
    const lo = Math.floor(t);
    const hi = Math.min(count - 1, lo + 1);
    const frac = t - lo;
    return {
      re: sum.re[lo] * (1 - frac) + sum.re[hi] * frac,
      im: sum.im[lo] * (1 - frac) + sum.im[hi] * frac,
    };
  };

  for (let k = 1; k < size / 2; k += 1) {
    const frequency = (k * sampleRate) / size;
    const weight = taper(Math.log(frequency));
    if (!(weight > 0)) continue;
    const value = complexAt(frequency);
    re[k] = value.re * weight;
    im[k] = value.im * weight;
    re[size - k] = re[k];
    im[size - k] = -im[k];
  }

  const fft = new FFT(size);
  fft.inverse(re, im);

  let peak = 0;
  let peakIndex = 0;
  for (let i = 0; i < size; i += 1) {
    const value = Math.hypot(re[i], im[i]);
    if (value > peak) { peak = value; peakIndex = i; }
  }
  if (!(peak > 0)) return { ok: false, message: 'That response transformed to silence.' };

  const beforeMs = clamp(options.beforeMs, 0, 20, 5);
  const afterMs = clamp(options.afterMs, 10, 200, 100);
  const stepMs = clamp(options.stepMs, 0.1, 5, 1);
  const stepSamples = Math.max(1, Math.round((stepMs / 1000) * sampleRate));
  const start = peakIndex - Math.round((beforeMs / 1000) * sampleRate);
  const buckets = Math.round((beforeMs + afterMs) / stepMs) + 1;

  const values = [];
  for (let b = 0; b < buckets; b += 1) {
    let largest = 0;
    for (let s = 0; s < stepSamples; s += 1) {
      const index = start + b * stepSamples + s;
      if (index < 0 || index >= size) continue;
      largest = Math.max(largest, Math.hypot(re[index], im[index]));
    }
    values.push(largest > 0 ? 20 * Math.log10(largest / peak) : -120);
  }

  return {
    ok: true,
    message: 'Derived by inverse transform of the modelled sum; edges tapered.',
    envelope: { startMs: -beforeMs, stepMs, peakMs: 0, values },
    sampleRate,
    bins: size,
  };
}

/**
 * Align a target to a reference: the delay and polarity at which the two sum
 * best, and honestly what that choice costs elsewhere in the band.
 *
 * No single delay is universally best. The result carries the best delay, the
 * runner-up solutions, the nulls the choice leaves behind and how far the result
 * can be trusted from the data it was computed from.
 */
export function optimizeAlignment(options = {}) {
  const reference = options.reference;
  const target = options.target;
  if (!reference || !target) {
    return { ok: false, message: 'Aligning needs both a reference and a target source.' };
  }
  if (options.objective === 'phase' && (!reference.phaseValid || !target.phaseValid)) {
    return {
      ok: false,
      message: 'A phase objective needs measured phase on both sources; one of them is magnitude-only.',
    };
  }

  const frequencies = reference.frequencies;
  const band = {
    min: clamp(options.band && options.band.min, 20, 20000, 1000),
    max: clamp(options.band && options.band.max, 20, 20000, 2000),
  };
  if (!(band.max > band.min)) band.max = Math.min(20000, band.min * 2);

  const delayMin = clamp(options.delay && options.delay.min, -50, 50, -20);
  const delayMax = clamp(options.delay && options.delay.max, -50, 50, 20);
  const step = clamp(options.step && options.step.stepMs, 0.005, 1, 0.05);
  const low = Math.min(delayMin, delayMax);
  const high = Math.max(delayMin, delayMax);
  const objective = OBJECTIVES.some((entry) => entry.id === options.objective)
    ? options.objective
    : 'sum';

  const focus = clamp(options.focusFrequency, 20, 20000, Math.sqrt(band.min * band.max));
  const crossoverBand = { min: focus / Math.pow(2, 1 / 3), max: focus * Math.pow(2, 1 / 3) };

  const indices = [];
  let referenceSum = 0;
  let targetSum = 0;
  let referenceCount = 0;
  let targetCount = 0;
  for (let i = 0; i < frequencies.length; i += 1) {
    const f = frequencies[i];
    if (f < band.min || f > band.max) continue;
    indices.push(i);
    const refMag = 20 * Math.log10(Math.max(1e-12, Math.hypot(reference.re[i], reference.im[i])));
    const targetMag = 20 * Math.log10(Math.max(1e-12, Math.hypot(target.re[i], target.im[i])));
    referenceSum += refMag;
    targetSum += targetMag;
    referenceCount += 1;
    targetCount += 1;
  }
  if (!indices.length) {
    return { ok: false, message: 'The chosen band holds no modelled points.' };
  }

  const referenceMean = referenceSum / Math.max(1, referenceCount);
  const targetMean = targetSum / Math.max(1, targetCount);

  const weights = indices.map((index) => {
    const f = frequencies[index];
    if (objective === 'crossover') {
      return f >= crossoverBand.min && f <= crossoverBand.max ? 1 : 0;
    }
    if (objective === 'custom') {
      const anchors = options.weights || { low: 1, mid: 1, high: 1 };
      if (f < 250) return clamp(anchors.low, 0, 1, 1);
      if (f <= 2000) return clamp(anchors.mid, 0, 1, 1);
      return clamp(anchors.high, 0, 1, 1);
    }
    return 1;
  });

  const polarities = options.polarity === 'normal'
    ? ['normal']
    : options.polarity === 'inverted'
      ? ['inverted']
      : ['normal', 'inverted'];

  const candidates = [];

  const evaluate = (delayMs, polarity) => {
    const sign = polarity === 'inverted' ? -1 : 1;
    const sums = [];
    const phases = [];
    let worst = Infinity;
    let phaseError = 0;
    let phaseCount = 0;
    for (let k = 0; k < indices.length; k += 1) {
      const index = indices[k];
      const f = frequencies[index];
      const rotation = (-2 * Math.PI * f * delayMs) / 1000;
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      const targetRe = sign * (target.re[index] * cos - target.im[index] * sin);
      const targetIm = sign * (target.re[index] * sin + target.im[index] * cos);
      const re = reference.re[index] + targetRe;
      const im = reference.im[index] + targetIm;
      const magnitude = Math.hypot(re, im);
      const value = magnitude > 0 ? 20 * Math.log10(magnitude) : -240;
      sums.push(value);
      phases.push((Math.atan2(im, re) * 180) / Math.PI);
      worst = Math.min(worst, value);
      if (target.phaseValid && reference.phaseValid) {
        const phaseTarget = Math.atan2(targetIm, targetRe);
        const phaseReference = Math.atan2(reference.im[index], reference.re[index]);
        phaseError += Math.abs(wrapDegrees(((phaseTarget - phaseReference) * 180) / Math.PI));
        phaseCount += 1;
      }
    }

    let objectiveValue = 0;
    const baseline = Math.max(referenceMean, targetMean);
    if (objective === 'sum' || objective === 'crossover' || objective === 'custom') {
      let weighted = 0;
      let weight = 0;
      for (let k = 0; k < sums.length; k += 1) {
        weighted += sums[k] * weights[k];
        weight += weights[k];
      }
      objectiveValue = weight > 0 ? (weighted / weight) - baseline : -240;
    } else if (objective === 'worst') {
      objectiveValue = worst - baseline;
    } else if (objective === 'phase') {
      objectiveValue = phaseCount ? -(phaseError / phaseCount) : -360;
    } else if (objective === 'smooth') {
      const mean = sums.reduce((a, b) => a + b, 0) / Math.max(1, sums.length);
      let variance = 0;
      for (const value of sums) variance += (value - mean) * (value - mean);
      objectiveValue = -Math.sqrt(variance / Math.max(1, sums.length));
    }

    const nulls = [];
    const sumMean = sums.reduce((a, b) => a + b, 0) / Math.max(1, sums.length);
    for (let k = 1; k < sums.length - 1; k += 1) {
      const value = sums[k];
      if (value > sums[k - 1] || value > sums[k + 1]) continue;
      if (value > sumMean - 6) continue;
      nulls.push({ hz: frequencies[indices[k]], depthDb: value - sumMean });
    }
    nulls.sort((a, b) => a.depthDb - b.depthDb);

    return {
      delayMs,
      polarity,
      objectiveValue,
      sumMeanDb: sumMean,
      gainDb: sumMean - baseline,
      worstDb: worst - baseline,
      phaseErrorDeg: phaseCount ? phaseError / phaseCount : NaN,
      nulls: nulls.slice(0, 4),
      sums,
      frequencies: indices.map((index) => frequencies[index]),
      phaseDeg: phases,
      phaseValid: !!(target.phaseValid && reference.phaseValid),
    };
  };

  const steps = Math.min(4000, Math.max(2, Math.round((high - low) / step) + 1));
  const actualStep = (high - low) / (steps - 1);

  for (let i = 0; i < steps; i += 1) {
    const delayMs = low + i * actualStep;
    for (const polarity of polarities) candidates.push(evaluate(delayMs, polarity));
  }

  candidates.sort((a, b) => b.objectiveValue - a.objectiveValue);
  const best = candidates[0];
  const alternatives = [];
  for (const candidate of candidates.slice(1)) {
    if (alternatives.length >= 3) break;
    if (Math.abs(candidate.delayMs - best.delayMs) < 0.1) continue;
    if (alternatives.some((entry) => Math.abs(entry.delayMs - candidate.delayMs) < 0.1)) continue;
    alternatives.push(candidate);
  }

  // The arrangement as it stands, so the recommended one can be compared with
  // it instead of being reported in isolation.
  const currentPolarity = target.settings && target.settings.inverted ? 'inverted' : 'normal';
  const before = evaluate(0, currentPolarity);

  // The sweep the chart draws: the answer at each delay, for the polarity the
  // optimizer chose, thinned so it can be drawn at once.
  const sweepCandidates = candidates
    .filter((candidate) => candidate.polarity === best.polarity)
    .sort((a, b) => a.delayMs - b.delayMs);
  const stride = Math.max(1, Math.ceil(sweepCandidates.length / 240));
  const sweep = sweepCandidates
    .filter((candidate, index) => index % stride === 0 || candidate === best)
    .map((candidate) => ({
      delayMs: candidate.delayMs,
      objectiveValue: candidate.objectiveValue,
      gainDb: candidate.gainDb,
    }));

  // Data quality decides how far the answer can be trusted.
  let coherence = NaN;
  if (target.coherence) {
    let sum = 0;
    let count = 0;
    for (const index of indices) {
      const value = Number(target.coherence[index]);
      if (!Number.isFinite(value)) continue;
      sum += value;
      count += 1;
    }
    if (count) coherence = sum / count;
  }
  const phaseKnown = !!target.phaseValid;
  const coverage = (band.max - band.min) / (20000 - 20);

  let confidence = 'good';
  let confidenceNote = 'Both curves cover the band and carry measured phase.';
  if (!phaseKnown) {
    confidence = 'limited';
    confidenceNote = 'One curve carries no measured phase: the sum assumes its phase at ' +
      'zero delay, so this delay is a starting point, not a verified alignment.';
  } else if (Number.isFinite(coherence) && coherence < 0.5) {
    confidence = 'limited';
    confidenceNote = 'The target curve’s coherence is low in this band, so the prediction ' +
      'is only as good as that data.';
  } else if (coverage > 0.9) {
    confidenceNote = 'The band spans nearly the whole model; a narrower band around the ' +
      'crossover is usually the more meaningful choice.';
  }

  const tradeoff = 'The best delay for the chosen band is not automatically best for the ' +
    'whole system: lifting the crossover can deepen a null elsewhere. Check the nulls below ' +
    'and take a new measurement with both cabinets running before committing anything.';

  return {
    ok: true,
    message: '',
    best,
    alternatives,
    before,
    sweep,
    improvement: {
      objective: best.objectiveValue - before.objectiveValue,
      summationDb: best.gainDb - before.gainDb,
    },
    confidence: { level: confidence, note: confidenceNote, coherence, phaseKnown },
    tradeoff,
    band,
    objective,
    evaluated: candidates.length,
  };
}

/**
 * Align one target against one reference across several measuring positions at
 * once: one delay and one polarity that serve every position, weighted by how
 * much each position matters. It is still a prediction, and each position keeps
 * its own curve.
 */
export function optimizeMultiPosition(options = {}) {
  const pairs = (options.pairs || [])
    .filter((pair) => pair && pair.reference && pair.target)
    .map((pair, index) => ({
      index,
      weight: Number(pair.weight) > 0 ? Number(pair.weight) : 1,
      reference: pair.reference,
      target: pair.target,
      label: pair.label || 'Position ' + (index + 1),
    }));
  if (!pairs.length) {
    return { ok: false, message: 'Multi-position alignment needs at least one measured position.' };
  }

  const results = pairs.map((pair) => optimizeAlignment({
    ...options,
    reference: pair.reference,
    target: pair.target,
  }));
  const failed = results.find((result) => !result.ok);
  if (failed) {
    return { ok: false, message: failed.message };
  }

  // The delay grid is the same for every pair, so candidates can be matched by
  // delay and polarity and combined with the position weights.
  const combined = new Map();
  for (let k = 0; k < pairs.length; k += 1) {
    const pair = pairs[k];
    for (const entry of results[k].sweep) {
      const entryKey = entry.delayMs.toFixed(3) + '|' + results[k].best.polarity;
      const slot = combined.get(entryKey) || {
        delayMs: entry.delayMs,
        polarity: results[k].best.polarity,
        objectiveValue: 0,
        gainDb: 0,
        weight: 0,
      };
      slot.objectiveValue += entry.objectiveValue * pair.weight;
      slot.gainDb += entry.gainDb * pair.weight;
      slot.weight += pair.weight;
      combined.set(entryKey, slot);
    }
  }
  if (!combined.size) {
    return { ok: false, message: 'No candidate delay could be compared across the positions.' };
  }

  const candidates = [...combined.values()]
    .map((slot) => ({
      delayMs: slot.delayMs,
      polarity: slot.polarity,
      objectiveValue: slot.weight > 0 ? slot.objectiveValue / slot.weight : -240,
      gainDb: slot.weight > 0 ? slot.gainDb / slot.weight : -240,
    }))
    .sort((a, b) => b.objectiveValue - a.objectiveValue);

  const best = candidates[0];
  const weakest = results.reduce((worst, result) =>
    (result.confidence.level === 'limited' && worst !== 'limited' ? 'limited' : worst), 'good');

  const perPosition = results.map((result, index) => {
    const gain = result.best.gainDb;
    return {
      label: pairs[index].label,
      weight: pairs[index].weight,
      ownBestDelayMs: result.best.delayMs,
      ownBestPolarity: result.best.polarity,
      gainAtCommonDelayDb: gain,
      confidence: result.confidence.level,
      note: result.confidence.note,
    };
  });

  return {
    ok: true,
    message: '',
    best,
    candidates: candidates.length,
    alternatives: candidates.slice(1, 4),
    perPosition,
    confidence: {
      level: weakest,
      note: weakest === 'good'
        ? 'Every position carries measured phase and usable coherence.'
        : 'At least one position carries no measured phase or low coherence: ' +
          'the common delay is only as good as that position.',
    },
    tradeoff: 'One delay is applied to every position at once. A position that is improved ' +
      'may be made worse; the per-position lines below show which. Nothing is written to a ' +
      'processor — apply it by hand and confirm with a new measurement.',
  };
}

/** A saved scenario evaluated as a project of its own, for comparing two. */
export function evaluateSnapshot(snapshot, models, options = {}) {
  if (!snapshot || !snapshot.data) return null;
  const data = snapshot.data;
  const project = {
    models: models || [],
    sources: data.sources || [],
    groups: data.groups || [],
    positions: data.positions && data.positions.length
      ? data.positions
      : [{ id: 'centre', label: 'Centre', weight: 1 }],
    settings: { ...(data.settings || {}), ...(options.settings || {}) },
  };
  return evaluateSystem(project, options);
}

/** Compare a predicted sum with a measured response, for the verification card. */
export function compareSum(sum, measured, band, options = {}) {
  if (!sum) return null;
  const measuredTrace = datasetTrace(measured);
  if (!measuredTrace) return null;
  return compareCurves(
    {
      frequencies: sum.frequencies,
      magDb: sum.magDb,
      // A sum that rests on an assumed phase is compared in level only.
      phaseDeg: sum.assumedPhase ? null : sum.phaseDeg,
    },
    {
      frequencies: measuredTrace.frequencies,
      magDb: measuredTrace.magDb,
      phaseDeg: measuredTrace.phaseDeg,
      coherence: measuredTrace.coherence,
    },
    band,
    options,
  );
}

/** Third-octave band levels of a curve, with the levels of a comparison. */
export function bandTable(frequencies, magDb, other, band) {
  const rows = [];
  for (let centre = 25; centre <= 16000; centre *= Math.pow(2, 1 / 3)) {
    const min = centre / Math.pow(2, 1 / 6);
    const max = centre * Math.pow(2, 1 / 6);
    const level = [];
    let sum = 0;
    let count = 0;
    for (let i = 0; i < frequencies.length; i += 1) {
      if (frequencies[i] < min || frequencies[i] > max) continue;
      const value = magDb[i];
      if (!Number.isFinite(value)) continue;
      sum += value;
      count += 1;
    }
    const mean = count ? sum / count : NaN;
    let difference = NaN;
    if (other) {
      let otherSum = 0;
      let otherCount = 0;
      for (let i = 0; i < frequencies.length; i += 1) {
        if (frequencies[i] < min || frequencies[i] > max) continue;
        const value = other[i];
        if (!Number.isFinite(value)) continue;
        otherSum += value;
        otherCount += 1;
      }
      if (otherCount) difference = mean - otherSum / otherCount;
    }
    rows.push({ centre, meanDb: mean, differenceDb: difference });
    if (band && centre > band.max) break;
  }
  return rows;
}
