/*
 * Direct-sound acoustic prediction for the Room Designer.
 *
 * What this module computes, and nothing more:
 *   - the straight-line distance from every placed loudspeaker to a receiver,
 *   - the travel time that distance means at the chosen speed of sound,
 *   - the inverse-distance level change against the distance the response was
 *     measured or specified at,
 *   - the on/off-axis angle in the cabinet's own frame and, where the dataset
 *     carries 6 dB beamwidths, the level that angle costs,
 *   - the complex sum of every contribution, with the phase from the modeler's
 *     own engine rotated by the travel time.
 *
 * It reuses `evaluateSystem` from the modeler, so gain, delay, polarity, EQ,
 * crossover and group linking are the same arithmetic in both workspaces. There
 * is no second DSP engine here.
 *
 * What it does not compute: reflections, absorption, room gain, modes,
 * reverberation, diffraction, air absorption or any higher-order path. A result
 * from here is a direct-sound prediction and is labelled as one wherever it is
 * shown. `ROOM_MODES` states that plainly so the screen cannot imply otherwise.
 */

import { GRID_POINTS, SPEED_OF_SOUND, gridFrequencies, interpolateAt } from './curve.js';
import { evaluateSystem, findDataset } from './model.js';
import { heatBounds, insideAudience, listenerZ } from './room.js';

export const BAND_MODES = [
  { id: 'third', label: '1/3 octave' },
  { id: 'octave', label: 'Octave' },
  { id: 'broadband', label: 'Broadband' },
];

export const HEAT_METRICS = [
  { id: 'level', label: 'Predicted level' },
  { id: 'arrival', label: 'First arrival' },
  { id: 'deviation', label: 'Deviation from the mean' },
  { id: 'difference', label: 'Left − right' },
  { id: 'interference', label: 'Sub interference' },
];

export const HEAT_FREQUENCIES = [
  31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
  1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000,
];

/** Octave centres used for a broadband evaluation. */
const OCTAVE_CENTRES = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/**
 * The prediction modes, stated as the screen states them. Only the direct
 * field is implemented; the room-inclusive mode is named as not implemented so
 * no curve can be mistaken for a room simulation.
 */
export const PREDICTION_MODES = [
  {
    id: 'direct',
    label: 'Direct sound',
    implemented: true,
    note: 'Free-field propagation from each cabinet to each point: distance, travel time, ' +
      'inverse-distance level, aiming and beamwidth, and the complex sum. No reflections.',
  },
  {
    id: 'room',
    label: 'Room-inclusive',
    implemented: false,
    note: 'Reflections, absorption, modes and reverberation are not implemented. No image-source, ' +
      'ray-tracing or modal solver is present, so no room-inclusive result is offered.',
  },
];

function clamp(value, low, high, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(high, Math.max(low, number));
}

function finite(value) {
  return Number.isFinite(Number(value));
}

/* ---------- vectors ---------- */

export function aimVector(placement) {
  const h = ((Number(placement && placement.aimH) || 0) * Math.PI) / 180;
  const v = ((Number(placement && placement.aimV) || 0) * Math.PI) / 180;
  return {
    x: Math.cos(v) * Math.sin(h),
    y: Math.cos(v) * Math.cos(h),
    z: -Math.sin(v),
  };
}

function normalizeVector(vector) {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (!(length > 0)) return { x: 0, y: 1, z: 0 };
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/** The cabinet's right and up axes, with the roll applied about its aim. */
export function aimFrame(placement) {
  const forward = aimVector(placement);
  let right = { x: Math.cos(((Number(placement && placement.aimH) || 0) * Math.PI) / 180),
    y: -Math.sin(((Number(placement && placement.aimH) || 0) * Math.PI) / 180), z: 0 };
  right = normalizeVector(right);
  let up = normalizeVector(cross(right, forward));
  const roll = ((Number(placement && placement.roll) || 0) * Math.PI) / 180;
  if (roll) {
    // Rotate the pattern axes about the aim axis. The stored 6 dB widths are
    // symmetrical, so a roll turns the drawn pattern but cannot change the
    // predicted level: that limitation is stated on the screen as well.
    const cos = Math.cos(roll);
    const sin = Math.sin(roll);
    const right2 = {
      x: right.x * cos + up.x * sin,
      y: right.y * cos + up.y * sin,
      z: right.z * cos + up.z * sin,
    };
    const up2 = {
      x: up.x * cos - right.x * sin,
      y: up.y * cos - right.y * sin,
      z: up.z * cos - right.z * sin,
    };
    right = right2;
    up = up2;
  }
  return { forward, right, up };
}

/** The angle from the aiming axis to a direction, split into the cabinet's frame. */
export function offAxisAngles(placement, direction) {
  const frame = aimFrame(placement);
  const v = normalizeVector(direction);
  const forward = dot(v, frame.forward);
  const horizontal = (Math.atan2(dot(v, frame.right), forward) * 180) / Math.PI;
  const vertical = (Math.atan2(dot(v, frame.up), forward) * 180) / Math.PI;
  const total = (Math.acos(Math.min(1, Math.max(-1, forward))) * 180) / Math.PI;
  return { horizontal, vertical, total, behind: forward < 0 };
}

export function distance3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function propagationDelayMs(distance, speedOfSound) {
  const speed = Number(speedOfSound) > 0 ? Number(speedOfSound) : SPEED_OF_SOUND;
  return (Math.max(0, Number(distance) || 0) / speed) * 1000;
}

/** The level change from the reference distance to the listening distance. */
export function inverseDistanceDb(distance, referenceDistance) {
  const reference = Number(referenceDistance) > 0 ? Number(referenceDistance) : 1;
  const far = Math.max(1e-3, Number(distance) || 0);
  return 20 * Math.log10(reference / far);
}

/* ---------- directivity ---------- */

/** The 6 dB beamwidth at a frequency, interpolated over log frequency. */
export function beamwidthAt(directivity, frequency) {
  return seriesWidthAt(directivity, 'widthDeg', frequency);
}

function seriesWidthAt(directivity, key, frequency) {
  const list = Array.isArray(directivity) ? directivity : [];
  if (!list.length) return NaN;
  const points = list
    .filter((entry) => entry && Number(entry.frequency) > 0 && Number(entry[key]) > 0)
    .sort((a, b) => a.frequency - b.frequency);
  if (!points.length) return NaN;
  const f = Number(frequency);
  if (!(f > 0)) return NaN;
  if (points.length === 1) return Number(points[0][key]);
  if (f <= points[0].frequency) return Number(points[0][key]);
  if (f >= points[points.length - 1].frequency) return Number(points[points.length - 1][key]);
  const logs = points.map((entry) => Math.log(entry.frequency));
  const widths = points.map((entry) => Number(entry[key]));
  return interpolateAt(logs, widths, Math.log(f));
}

/**
 * The widths at one frequency: the single published width and, when the dataset
 * carries them, the horizontal and vertical widths separately. A generic model
 * built from a 50° × 35° figure has both; a manufacturer file usually has one.
 */
export function beamwidthsAt(directivity, frequency) {
  const widthDeg = beamwidthAt(directivity, frequency);
  const widthHDeg = seriesWidthAt(directivity, 'widthHDeg', frequency);
  const widthVDeg = seriesWidthAt(directivity, 'widthVDeg', frequency);
  let profile = '';
  if (Array.isArray(directivity)) {
    const match = directivity.find((entry) => entry && typeof entry.profile === 'string' && entry.profile);
    if (match) profile = match.profile;
  }
  return { widthDeg, widthHDeg, widthVDeg, profile };
}

/**
 * The level a given off-axis angle costs, from a 6 dB beamwidth.
 *
 * The model is a quadratic in angle that reaches exactly −6 dB at half the
 * stated width and is floored at −40 dB behind the pattern. A beamwidth is not
 * a directivity balloon: it carries no sidelobe or lobe-shape information, and
 * the screen says so. `profile` selects the taper a generic model was built with
 * (quadratic, cosine or steep); all three reach −6 dB at the half-width.
 */
export function directivityAttenuationDb(offAxisDeg, widthDeg, profile) {
  const width = Number(widthDeg);
  if (!(width > 0)) return 0;
  const ratio = (2 * Math.abs(Number(offAxisDeg) || 0)) / width;
  const shape = profile === 'cosine'
    ? 1 - Math.cos((Math.PI * Math.min(ratio, 2)) / 2)
    : profile === 'steep'
      ? ratio * ratio * ratio * ratio
      : ratio * ratio;
  return Math.max(-40, -6 * shape);
}

/**
 * The attenuation of a cabinet in its own frame. Where the dataset carries two
 * widths, the horizontal and vertical patterns are applied to the two angles and
 * their dB attenuations add — the separable approximation of a rectangular
 * pattern. With one width, the total off-axis angle is used, as before.
 */
export function patternAttenuationDb(angles, widths, fallbackProfile) {
  const profile = (widths && widths.profile) || fallbackProfile || '';
  if (widths && widths.widthHDeg > 0 && widths.widthVDeg > 0) {
    const horizontal = directivityAttenuationDb(angles.horizontal, widths.widthHDeg, profile);
    const vertical = directivityAttenuationDb(angles.vertical, widths.widthVDeg, profile);
    return Math.max(-80, horizontal + vertical);
  }
  if (widths && widths.widthDeg > 0) {
    return directivityAttenuationDb(angles.total, widths.widthDeg, profile);
  }
  return 0;
}

/* ---------- the response grid ---------- */

function complexAtGrid(frequencies, re, im, frequency) {
  const n = frequencies.length;
  if (!n) return { re: 0, im: 0 };
  const f = Number(frequency);
  if (!(f > frequencies[0])) return { re: re[0], im: im[0] };
  if (f >= frequencies[n - 1]) return { re: re[n - 1], im: im[n - 1] };
  const low = Math.log(frequencies[0]);
  const high = Math.log(frequencies[n - 1]);
  const t = ((Math.log(f) - low) / (high - low)) * (n - 1);
  const lo = Math.floor(t);
  const hi = Math.min(n - 1, lo + 1);
  const frac = t - lo;
  return {
    re: re[lo] * (1 - frac) + re[hi] * frac,
    im: im[lo] * (1 - frac) + im[hi] * frac,
  };
}

/* ---------- the context ---------- */

function referenceDistanceOf(dataset, model) {
  const conditions = (dataset && dataset.conditions) || {};
  if (finite(conditions.micDistanceM) && Number(conditions.micDistanceM) > 0) {
    return Number(conditions.micDistanceM);
  }
  if (model && finite(model.distanceM) && Number(model.distanceM) > 0) return Number(model.distanceM);
  return 1;
}

/**
 * Everything a prediction needs, read once from the modeler's project.
 *
 * The project is not copied: the same source objects are used, so a gain, delay,
 * polarity or EQ change is seen here on the next evaluation and there is never a
 * second set of settings to keep in step.
 */
export function buildContext(project, room, options = {}) {
  const speed = Number(room && room.settings && room.settings.speedOfSound) > 0
    ? Number(room.settings.speedOfSound)
    : Number(options.speedOfSound) > 0 ? Number(options.speedOfSound) : SPEED_OF_SOUND;
  const evaluation = evaluateSystem(project || { sources: [], models: [], groups: [] }, options);
  const responseById = new Map(evaluation.responses.map((response) => [response.id, response]));
  const speakers = [];
  const unplaced = [];
  const noData = [];
  const unaimed = [];

  for (const source of (project && project.sources) || []) {
    if (source.muted) continue;
    const placement = source.room;
    if (!placement || !Number.isFinite(Number(placement.x)) || !Number.isFinite(Number(placement.y))) {
      unplaced.push(source.name);
      continue;
    }
    const response = responseById.get(source.id);
    if (!response) {
      noData.push(source.name);
      continue;
    }
    const group = (project.groups || []).find((entry) => entry.id === source.groupId) || null;
    if (group && group.muted) continue;
    const found = findDataset(project, source.modelId, source.datasetId);
    const directivity = (found.dataset && found.dataset.directivity) || [];
    if (!directivity.length) unaimed.push(source.name);
    speakers.push({
      id: source.id,
      name: source.name,
      source,
      group,
      model: found.model,
      dataset: found.dataset,
      response,
      position: {
        x: Number(placement.x),
        y: Number(placement.y),
        z: clamp(placement.z, 0, 60, 0),
      },
      placement,
      role: placement.role || 'custom',
      referenceDistanceM: referenceDistanceOf(found.dataset, found.model),
      directivity,
      directivityProfile: (found.dataset && found.dataset.directivityProfile) || '',
      logFrequencies: Array.from(response.frequencies, (value) => Math.log(value)),
      timing: placement.timing === 'measured' ? 'measured' : 'geometric',
      timingOffsetMs: Number(placement.timingOffsetMs) || 0,
    });
  }

  const warnings = [];
  if (unplaced.length) {
    warnings.push(unplaced.length + ' source' + (unplaced.length === 1 ? ' is' : 's are') +
      ' not placed in the room and are left out: ' + unplaced.join(', ') + '.');
  }
  if (noData.length) {
    warnings.push(noData.length + ' placed source' + (noData.length === 1 ? ' has' : 's have') +
      ' no acoustic data yet and are left out: ' + noData.join(', ') + '.');
  }
  if (unaimed.length && speakers.length) {
    warnings.push(unaimed.length + ' of ' + speakers.length + ' source' +
      (speakers.length === 1 ? '' : 's') + ' carry no directivity data, so their aim changes ' +
      'the position but not the predicted level.');
  }

  const phaseComplete = speakers.length > 0 && speakers.every((speaker) => speaker.response.phaseValid);
  return {
    ok: speakers.length > 0,
    project,
    room,
    speed,
    speakers,
    unplaced,
    noData,
    warnings,
    evaluation,
    frequencies: gridFrequencies(GRID_POINTS),
    phaseComplete,
  };
}

/* ---------- one contribution, one receiver ---------- */

/**
 * One cabinet's contribution at one receiver, on the given frequency list.
 *
 * The magnitude and phase come from the modeler's source response — so gain,
 * delay, polarity and the whole DSP chain are already in them — and only the
 * propagation (level against distance, travel-time rotation) and the directivity
 * attenuation are added here.
 */
export function contributionAt(speaker, receiver, frequencies, options = {}) {
  const dx = receiver.x - speaker.position.x;
  const dy = receiver.y - speaker.position.y;
  const dz = receiver.z - speaker.position.z;
  const distance = Math.max(1e-3, Math.hypot(dx, dy, dz));
  const speed = Number(options.speedOfSound) > 0 ? Number(options.speedOfSound) : SPEED_OF_SOUND;
  const travelMs = (distance / speed) * 1000;
  const distanceDb = inverseDistanceDb(distance, speaker.referenceDistanceM);
  const timingMs = speaker.timing === 'measured' ? speaker.timingOffsetMs : 0;
  const angles = offAxisAngles(speaker.placement, { x: dx, y: dy, z: dz });
  const count = frequencies.length;
  const re = new Float64Array(count);
  const im = new Float64Array(count);
  const levelDb = new Float64Array(count);
  const directivityDb = new Float64Array(count);
  let widest = 0;

  for (let i = 0; i < count; i += 1) {
    const f = frequencies[i];
    const widths = beamwidthsAt(speaker.directivity, f);
    const attenuation = patternAttenuationDb(angles, widths, speaker.directivityProfile);
    if (Number.isFinite(widths.widthDeg) && widths.widthDeg > widest) widest = widths.widthDeg;
    directivityDb[i] = attenuation;
    const base = interpolateAt(speaker.logFrequencies, speaker.response.magDb, Math.log(f));
    const complex = complexAtGrid(speaker.response.frequencies, speaker.response.re,
      speaker.response.im, f);
    const scale = Math.pow(10, (distanceDb + attenuation) / 20);
    const rotation = (-2 * Math.PI * f * (travelMs + timingMs)) / 1000;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    re[i] = (complex.re * cos - complex.im * sin) * scale;
    im[i] = (complex.re * sin + complex.im * cos) * scale;
    levelDb[i] = base + distanceDb + attenuation;
  }

  return {
    id: speaker.id,
    name: speaker.name,
    role: speaker.role,
    distanceM: distance,
    travelMs,
    dspDelayMs: (Number(speaker.source.delayMs) || 0) +
      (speaker.group ? Number(speaker.group.delayMs) || 0 : 0),
    arriveMs: travelMs + (Number(speaker.source.delayMs) || 0) +
      (speaker.group ? Number(speaker.group.delayMs) || 0 : 0) + timingMs,
    distanceDb,
    angles,
    beamwidthDeg: widest,
    hasDirectivity: widest > 0,
    levelDb,
    directivityDb,
    re,
    im,
    phaseValid: !!speaker.response.phaseValid,
    referenceDistanceM: speaker.referenceDistanceM,
  };
}

/** Power sum of a magnitude array inside a band. */
export function bandLevel(magDb, frequencies, min, max) {
  let power = 0;
  let count = 0;
  for (let i = 0; i < frequencies.length; i += 1) {
    const f = frequencies[i];
    if (f < min || f > max) continue;
    const value = Number(magDb[i]);
    if (!Number.isFinite(value)) continue;
    power += Math.pow(10, value / 10);
    count += 1;
  }
  if (!count) return NaN;
  return 10 * Math.log10(power / count);
}

/**
 * The predicted transfer function at one receiver: every contribution, their
 * complex sum, the first arrival and the level over the requested band.
 */
export function predictResponse(context, receiver, options = {}) {
  const frequencies = options.frequencies || context.frequencies;
  const contributions = [];
  for (const speaker of context.speakers) {
    if (options.onlyIds && !options.onlyIds.includes(speaker.id)) continue;
    if (options.excludeIds && options.excludeIds.includes(speaker.id)) continue;
    contributions.push(contributionAt(speaker, receiver, frequencies, options));
  }
  const count = frequencies.length;
  const re = new Float64Array(count);
  const im = new Float64Array(count);
  for (const contribution of contributions) {
    for (let i = 0; i < count; i += 1) {
      re[i] += contribution.re[i];
      im[i] += contribution.im[i];
    }
  }
  const magDb = new Float64Array(count);
  const phaseDeg = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    const magnitude = Math.hypot(re[i], im[i]);
    magDb[i] = magnitude > 0 ? 20 * Math.log10(magnitude) : -240;
    phaseDeg[i] = (Math.atan2(im[i], re[i]) * 180) / Math.PI;
  }
  let arrivalMs = NaN;
  for (const contribution of contributions) {
    if (!Number.isFinite(arrivalMs) || contribution.arriveMs < arrivalMs) {
      arrivalMs = contribution.arriveMs;
    }
  }
  const band = options.band || { min: frequencies[0], max: frequencies[frequencies.length - 1] };
  return {
    ok: contributions.length > 0,
    receiver,
    frequencies,
    contributions,
    sum: { re, im, magDb, phaseDeg },
    arrivalMs,
    levelDb: bandLevel(magDb, frequencies, band.min, band.max),
    phaseValid: contributions.length > 0 && contributions.every((entry) => entry.phaseValid),
    message: contributions.length
      ? ''
      : 'No placed source with acoustic data covers this position.',
  };
}

/* ---------- bands and heat maps ---------- */

/** The frequencies a band evaluation uses, for one centre or for broadband. */
export function bandFrequencies(centreHz, mode) {
  const centre = clamp(centreHz, 20, 20000, 1000);
  if (mode === 'broadband') return OCTAVE_CENTRES.slice();
  if (mode === 'octave') return [centre / Math.SQRT2, centre, centre * Math.SQRT2];
  return [centre / Math.pow(2, 1 / 6), centre, centre * Math.pow(2, 1 / 6)];
}

/**
 * The coherent power of a group of contributions across a set of band points:
 * the complex values are added first, then squared. Adding the powers instead
 * would answer a question nobody asked — what the group would sound like if its
 * cabinets did not interfere.
 */
function coherentPowerOf(contributions, indices) {
  let power = 0;
  for (const index of indices) {
    let re = 0;
    let im = 0;
    for (const contribution of contributions) {
      re += contribution.re[index];
      im += contribution.im[index];
    }
    power += re * re + im * im;
  }
  return power;
}

function incoherentPowerOf(contributions, indices) {
  let power = 0;
  for (const contribution of contributions) {
    for (const index of indices) {
      power += contribution.re[index] * contribution.re[index] +
        contribution.im[index] * contribution.im[index];
    }
  }
  return power;
}

/**
 * A heat map over the audience (or the whole room when no audience area is
 * defined).
 *
 * Every value is computed at a receiver position with its own listening height;
 * nothing is drawn as a ring around a cabinet. `values` is normalised for
 * display (the reference position or the maximum, as requested) while
 * `valuesDb` keeps the model's own numbers.
 */
export function computeHeatmap(context, options = {}) {
  const room = context.room;
  const bounds = options.bounds || heatBounds(room);
  const cols = clamp(options.cols || (room.settings && room.settings.resolution) || 56, 8, 160);
  const width = Math.max(1e-3, bounds.maxX - bounds.minX);
  const depth = Math.max(1e-3, bounds.maxY - bounds.minY);
  const rows = clamp(Math.round((cols * depth) / width), 8, 160);
  const metric = options.metric || 'level';
  const mode = options.bandMode || 'third';
  const frequencies = bandFrequencies(options.frequencyHz, mode);
  const speed = context.speed;

  const speakers = context.speakers;
  const subSpeakers = speakers.filter((speaker) => speaker.role === 'sub');
  const mainSpeakers = speakers.filter((speaker) => speaker.role !== 'sub');
  let leftSpeakers = mainSpeakers;
  let rightSpeakers = [];
  let leftLabel = 'All mains';
  let rightLabel = '—';
  if (metric === 'difference') {
    // The comparison is between the mains by default; a room with no cabinet
    // named as a main is split as it stands, so the view still answers.
    const pool = mainSpeakers.length ? mainSpeakers : speakers;
    const groups = (context.project && context.project.groups) || [];
    const leftGroup = groups.find((group) => group.id === options.leftGroupId);
    const rightGroup = groups.find((group) => group.id === options.rightGroupId);
    if (leftGroup && rightGroup) {
      leftSpeakers = speakers.filter((speaker) => speaker.source.groupId === leftGroup.id);
      rightSpeakers = speakers.filter((speaker) => speaker.source.groupId === rightGroup.id);
      leftLabel = leftGroup.name;
      rightLabel = rightGroup.name;
    } else {
      const centreX = (bounds.minX + bounds.maxX) / 2;
      leftSpeakers = pool.filter((speaker) => speaker.position.x < centreX);
      rightSpeakers = pool.filter((speaker) => speaker.position.x >= centreX);
      leftLabel = 'Left of centre';
      rightLabel = 'Right of centre';
    }
  }

  const cells = cols * rows;
  const valuesDb = new Float64Array(cells).fill(NaN);
  const arrivals = new Float64Array(cells).fill(NaN);
  const inside = new Uint8Array(cells);
  let computed = 0;

  for (let row = 0; row < rows; row += 1) {
    const y = bounds.minY + ((row + 0.5) * depth) / rows;
    for (let col = 0; col < cols; col += 1) {
      const x = bounds.minX + ((col + 0.5) * width) / cols;
      const index = row * cols + col;
      if (!insideAudience(room, x, y)) continue;
      inside[index] = 1;
      const z = listenerZ(room, x, y);
      const receiver = { x, y, z };
      computed += 1;

      if (metric === 'arrival') {
        let first = Infinity;
        for (const speaker of speakers) {
          const distance = distance3(speaker.position, receiver);
          const arrive = (distance / speed) * 1000 +
            (Number(speaker.source.delayMs) || 0) +
            (speaker.group ? Number(speaker.group.delayMs) || 0 : 0) +
            (speaker.timing === 'measured' ? speaker.timingOffsetMs : 0);
          if (arrive < first) first = arrive;
        }
        arrivals[index] = Number.isFinite(first) ? first : NaN;
        valuesDb[index] = arrivals[index];
        continue;
      }

      const list = metric === 'difference' ? leftSpeakers.concat(rightSpeakers)
        : metric === 'interference' ? subSpeakers
          : speakers;
      if (!list.length) continue;

      const contributions = list.map((speaker) =>
        contributionAt(speaker, receiver, frequencies, { speedOfSound: speed }));
      const indices = frequencies.map((value, i2) => i2);

      if (metric === 'interference') {
        const coherent = coherentPowerOf(contributions, indices);
        const incoherent = incoherentPowerOf(contributions, indices);
        const difference = coherent > 0 && incoherent > 0
          ? 10 * Math.log10(coherent / incoherent)
          : NaN;
        valuesDb[index] = difference;
        let first = Infinity;
        for (const contribution of contributions) {
          if (contribution.arriveMs < first) first = contribution.arriveMs;
        }
        arrivals[index] = Number.isFinite(first) ? first : NaN;
        continue;
      }

      if (metric === 'difference') {
        const leftList = contributions.slice(0, leftSpeakers.length);
        const rightList = contributions.slice(leftSpeakers.length);
        const leftPower = coherentPowerOf(leftList, indices);
        const rightPower = coherentPowerOf(rightList, indices);
        const leftDb = leftPower > 0 ? 10 * Math.log10(leftPower) : -240;
        const rightDb = rightPower > 0 ? 10 * Math.log10(rightPower) : -240;
        valuesDb[index] = leftDb - rightDb;
        let first = Infinity;
        for (const contribution of contributions) {
          if (contribution.arriveMs < first) first = contribution.arriveMs;
        }
        arrivals[index] = Number.isFinite(first) ? first : NaN;
        continue;
      }

      // The coherent level at the point: the complex sum, in power over the band.
      let totalPower = 0;
      for (const index2 of indices) {
        let sumRe = 0;
        let sumIm = 0;
        for (const contribution of contributions) {
          sumRe += contribution.re[index2];
          sumIm += contribution.im[index2];
        }
        totalPower += sumRe * sumRe + sumIm * sumIm;
      }
      valuesDb[index] = totalPower > 0 ? 10 * Math.log10(totalPower / indices.length) : -240;

      let first = Infinity;
      for (const contribution of contributions) {
        if (contribution.arriveMs < first) first = contribution.arriveMs;
      }
      arrivals[index] = Number.isFinite(first) ? first : NaN;
    }
  }

  // The mean of the modelled points, used for the deviation view and the
  // uniformity figure. Points outside the audience are never averaged in.
  let sum = 0;
  let count = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let index = 0; index < cells; index += 1) {
    if (!inside[index]) continue;
    const value = valuesDb[index];
    if (!Number.isFinite(value)) continue;
    sum += value;
    count += 1;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const mean = count ? sum / count : NaN;

  if (metric === 'deviation' && count) {
    for (let index = 0; index < cells; index += 1) {
      if (!inside[index] || !Number.isFinite(valuesDb[index])) continue;
      valuesDb[index] -= mean;
    }
  }

  let referenceDb = NaN;
  if (options.reference) {
    const reference = options.reference;
    const row = Math.min(rows - 1, Math.max(0, Math.floor(((reference.y - bounds.minY) / depth) * rows)));
    const col = Math.min(cols - 1, Math.max(0, Math.floor(((reference.x - bounds.minX) / width) * cols)));
    const index = row * cols + col;
    if (inside[index] && Number.isFinite(valuesDb[index])) referenceDb = valuesDb[index];
  }

  // Normalisation: a level map is drawn relative to a stated reference point,
  // or to its own maximum. Deviation, difference and interference are already
  // relative and are never shifted again.
  const normalise = metric === 'level';
  let offset = 0;
  if (normalise) {
    if (options.normalizeTo === 'max') {
      offset = Number.isFinite(max) ? max : 0;
    } else if (Number.isFinite(referenceDb)) {
      offset = referenceDb;
    } else if (Number.isFinite(max)) {
      offset = max;
    }
  }

  const values = new Float64Array(cells).fill(NaN);
  let variance = 0;
  let inTolerance = 0;
  const tolerance = clamp(options.uniformityDb, 0.5, 12, 3);
  for (let index = 0; index < cells; index += 1) {
    if (!inside[index] || !Number.isFinite(valuesDb[index])) continue;
    values[index] = valuesDb[index] - offset;
    const spread = values[index] - (metric === 'deviation' ? 0 : (mean - offset));
    variance += spread * spread;
    if (Math.abs(spread) <= tolerance) inTolerance += 1;
  }

  const spreadDb = count ? Math.sqrt(variance / count) : NaN;
  const rangeDb = count ? (max - min) : NaN;

  return {
    ok: count > 0,
    cols,
    rows,
    bounds,
    metric,
    mode,
    frequencyHz: clamp(options.frequencyHz, 20, 20000, 1000),
    frequencies,
    values,
    valuesDb,
    arrivals,
    inside,
    computed,
    offsetDb: offset,
    normalised: normalise,
    statistics: {
      meanDb: mean,
      minDb: min,
      maxDb: max,
      rangeDb,
      spreadDb,
      toleranceDb: tolerance,
      withinTolerance: count ? inTolerance / count : NaN,
      referenceDb,
      points: count,
    },
    labels: { left: leftLabel, right: rightLabel },
    message: count
      ? ''
      : 'Nothing could be predicted over the audience area: no placed source has acoustic data, ' +
        'or no audience area covers a point.',
  };
}

/* ---------- arrivals and delays ---------- */

/**
 * Every cabinet's arrival at one receiver, with the delay that would bring it
 * onto the latest one.
 *
 * The suggestion is geometric. A geometric alignment is not an acoustic one:
 * the phase of the measured response, the cabinet's own processing and the room
 * all move the real arrival, so the screen presents this as a starting point and
 * says how it was computed.
 */
export function arrivalTable(context, receiver) {
  const rows = context.speakers.map((speaker) => {
    const distance = distance3(speaker.position, receiver);
    const travelMs = propagationDelayMs(distance, context.speed);
    const dspDelayMs = (Number(speaker.source.delayMs) || 0) +
      (speaker.group ? Number(speaker.group.delayMs) || 0 : 0);
    const timingMs = speaker.timing === 'measured' ? speaker.timingOffsetMs : 0;
    const totalMs = travelMs + dspDelayMs + timingMs;
    return {
      id: speaker.id,
      name: speaker.name,
      role: speaker.role,
      distanceM: distance,
      travelMs,
      dspDelayMs,
      timingMs,
      totalMs,
      timing: speaker.timing,
    };
  }).sort((a, b) => a.totalMs - b.totalMs);

  if (!rows.length) return { ok: false, rows: [], message: 'No placed source with acoustic data.' };
  const first = rows[0].totalMs;
  const last = rows[rows.length - 1].totalMs;
  for (const row of rows) {
    row.deltaToFirstMs = row.totalMs - first;
    row.suggestedAddMs = last - row.totalMs;
  }
  return {
    ok: true,
    rows,
    firstMs: first,
    lastMs: last,
    spanMs: last - first,
    message: 'Delays are geometric: distance ÷ speed of sound plus the delay already set on ' +
      'the source and its group. They ignore the phase of the measured response, ' +
      'processing latency and anything the room does.',
  };
}

/** The subwoofer array tools. */
export const ARRAY_PRESETS = [
  { id: 'broadside', label: 'Broadside line', note: 'A line across the stage, all boxes in phase.' },
  { id: 'endfire', label: 'End-fire line', note: 'A line front to back, each box behind delayed by its spacing.' },
  { id: 'cardioid', label: 'Cardioid pairs', note: 'A front and a rear box per pair: rear delayed and inverted.' },
  { id: 'centre', label: 'Centre cluster', note: 'Boxes stacked at the centre, all in phase.' },
  { id: 'lr', label: 'Left / right stacks', note: 'Half the boxes each side of the stage.' },
  { id: 'custom', label: 'Custom arrangement', note: 'Leaves every position exactly where it is.' },
];

export function speedOfSoundFor(temperatureC) {
  return 331.3 + 0.606 * (Number(temperatureC) || 20);
}

/**
 * A layout for one array preset: positions relative to the array's centre, and
 * the delay and polarity each box needs for that arrangement.
 *
 * `count` is how many cabinets take part. The numbers are relative to the array
 * centre so the operator can put the array wherever it belongs.
 */
export function arrayLayout(preset, params = {}) {
  const count = clamp(params.count, 1, 32, 8);
  const speed = Number(params.speedOfSound) > 0 ? Number(params.speedOfSound) : SPEED_OF_SOUND;
  const frequency = clamp(params.frequencyHz, 20, 200, 80);
  const quarterWave = speed / frequency / 4;
  const spacing = clamp(params.spacingM, 0.1, 10,
    preset === 'endfire' || preset === 'cardioid' ? quarterWave : 1.2);
  const gainDb = clamp(params.gainDb, -24, 24, 0);
  const polarity = params.polarity === 'inverted' ? 'inverted' : 'normal';
  const entries = [];

  for (let index = 0; index < count; index += 1) {
    if (preset === 'broadside' || preset === 'centre') {
      const step = preset === 'centre' ? Math.min(spacing, 0.6) : spacing;
      entries.push({
        index,
        xM: (index - (count - 1) / 2) * step,
        yM: 0,
        delayMs: 0,
        polarity,
        gainDb,
      });
    } else if (preset === 'endfire') {
      // Box 0 is nearest the audience. Each box further back is delayed so its
      // wavefront meets the one in front of it: the array fires forwards.
      entries.push({
        index,
        xM: 0,
        yM: index * spacing,
        delayMs: (index * spacing * 1000) / speed,
        polarity,
        gainDb,
      });
    } else if (preset === 'cardioid') {
      // Pairs: one box forward, one behind it, the rear one delayed by the
      // spacing and reversed. A cardioid pair needs both, so the count is
      // rounded to whole pairs.
      const pair = Math.floor(index / 2);
      const front = index % 2 === 0;
      const pairs = Math.max(1, Math.floor(count / 2));
      entries.push({
        index,
        xM: (pair - (pairs - 1) / 2) * Math.max(1.2, spacing * 2),
        yM: front ? 0 : spacing,
        delayMs: front ? 0 : (spacing * 1000) / speed,
        polarity: front ? polarity : (polarity === 'inverted' ? 'normal' : 'inverted'),
        gainDb,
      });
    } else if (preset === 'lr') {
      const perSide = Math.max(1, Math.ceil(count / 2));
      const side = index < perSide ? -1 : 1;
      const within = index < perSide ? index : index - perSide;
      const offset = clamp(params.halfWidthM, 0.5, 40, 3);
      entries.push({
        index,
        xM: side * offset,
        yM: within * spacing,
        delayMs: 0,
        polarity,
        gainDb,
      });
    } else {
      entries.push({ index, xM: 0, yM: 0, delayMs: 0, polarity, gainDb });
    }
  }
  return {
    preset,
    count: entries.length,
    spacingM: spacing,
    speedOfSound: speed,
    frequencyHz: frequency,
    quarterWaveM: speed / frequency / 4,
    entries,
  };
}

/**
 * Turn a layout into the settings each source should carry. The caller applies
 * them through the modeler's own commit path, so an array move is one undo step
 * and never a second copy of the source.
 */
export function arrayAssignments(sources, layout, options = {}) {
  const originX = Number(options.originX) || 0;
  const originY = Number(options.originY) || 0;
  const originZ = Number(options.originZ) || 0;
  const list = (sources || []).slice(0, layout.entries.length);
  return list.map((source, index) => {
    const entry = layout.entries[index];
    return {
      id: source.id,
      name: source.name,
      x: originX + entry.xM,
      y: originY + entry.yM,
      z: originZ,
      delayMs: entry.delayMs,
      polarity: entry.polarity,
      gainDb: entry.gainDb,
      note: layout.preset,
    };
  });
}

/** The reference the prediction is normalised to, if the room has one. */
export function referenceReceiver(room) {
  const id = room && room.settings ? room.settings.refMicId : '';
  const mic = (room.mics || []).find((entry) => entry.id === id);
  if (mic) return { x: mic.x, y: mic.y, z: mic.z, name: mic.name };
  if (room && room.mics && room.mics.length) {
    const first = room.mics[0];
    return { x: first.x, y: first.y, z: first.z, name: first.name };
  }
  return null;
}
