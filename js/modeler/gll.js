/*
 * GLL writer: Align's loudspeaker model as an EASE generic loudspeaker file.
 *
 * GLL is the compiled loudspeaker format of AFMG's EASE family. AFMG does not
 * publish the layout — it is produced by EASE SpeakerLab, is signed through the
 * authorisation (.author) files SpeakerLab compiles in, and no official writer
 * exists outside AFMG's licensing. This writer follows the reverse-engineered
 * layout documented by the MIT-licensed gll-tools project (CWBudde/gll-tools,
 * docs/format.md), and the reader in that project is what checks the bytes here:
 *
 *   gllinfo -v align-speaker.gll        header, metadata, box types, sources
 *   gllinfo acoustic align-speaker.gll  balloon grid and response counts
 *
 * Two limits are therefore stated in the file itself, in its InfoText, and on the
 * screen that writes it:
 *
 *   - the file is NOT authorised. EASE can read its structure, but AFMG only
 *     marks a loudspeaker authorised through SpeakerLab and a licence file;
 *   - the acoustic data is Align's own model, not a measurement: the on-axis
 *     curve is the builder's predicted response carried relative to its own peak,
 *     and the balloon is the same separable 6 dB beamwidth approximation the Room
 *     Designer predicts with — magnitude only, every phase written as zero.
 *
 * What is written: one loudspeaker system (GenSystem), one cabinet (BoxType) with
 * one acoustic source placed at its origin, and one source definition carrying a
 * 5° balloon and the on-axis spectrum, on a third-octave grid.
 */

import { GRID_POINTS, gridFrequency } from './curve.js';
import { patternAttenuationDb } from './acoustics.js';
import {
  directivityEntries,
  generateCabinetResponse,
  generateSectionResponse,
  normalizeSpec,
  sensitivityAt1W,
} from './speaker-builder.js';

export const GLL_CAVEAT =
  'Created by Align. Structure follows the reverse-engineered GLL layout; the file is not ' +
  'AFMG-authorised, and the acoustic data is Align\'s beamwidth model, not a measured balloon.';

export const GLL_BALLOON_STEP = 5;          // degrees, the 5° grid the format documents
export const GLL_BANDS_PER_OCTAVE = 3;      // third-octave bands
export const LEVEL_SCALE = 0.01;            // int16 × 0.01 = dB
export const PHASE_SCALE = 0.001;           // int16 × 0.001 = radians

const HEADER_VERSION = 4;                   // checksum present, hash block absent
const SYSTEM_TYPE_LOUDSPEAKER = 2;
const DATA_TYPE_THIRD_OCTAVE = 1;
const SYMMETRY_VERTICAL_ON_DISK = 2;        // left/right symmetric, 0–180° meridians

const encoder = new TextEncoder();

/* ---------- byte plumbing ---------- */

class Sink {
  constructor() {
    this.parts = [];
    this.length = 0;
  }

  push(part) {
    this.parts.push(part);
    this.length += part.length;
    return this;
  }

  u8(value) {
    return this.push(Uint8Array.of(value & 0xff));
  }

  i16(value) {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setInt16(0, clampInt16(value), true);
    return this.push(bytes);
  }

  u16(value) {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, Math.max(0, Math.min(0xffff, value | 0)), true);
    return this.push(bytes);
  }

  i32(value) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setInt32(0, Number(value) | 0, true);
    return this.push(bytes);
  }

  f64(value) {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, Number.isFinite(value) ? value : 0, true);
    return this.push(bytes);
  }

  /** Length-prefixed UTF-8 string: uint16 byte count, then the bytes. */
  text(value) {
    const bytes = encoder.encode(String(value === undefined || value === null ? '' : value));
    if (bytes.length > 0xffff) throw new Error('a GLL string cannot exceed 65535 bytes');
    this.u16(bytes.length);
    return this.push(bytes);
  }

  bytes() {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}

function clampInt16(value) {
  const rounded = Math.round(Number(value) || 0);
  return Math.max(-32768, Math.min(32767, rounded));
}

/** A length-prefixed block: int32 size (including itself), int16 check, int16 sub-version. */
export function block(subVersion, content) {
  const sink = new Sink();
  sink.i32(content.length + 8);
  sink.i16(0);
  sink.i16(subVersion);
  sink.push(content);
  return sink.bytes();
}

/** An empty buffer, written as the single zero the reader skips over. */
function emptyBuffer() {
  return new Sink().i32(0).bytes();
}

/**
 * The file-integrity checksum documented for version 4 and later, applied to the
 * GenSystem block (the hash block describes the same content as a SHA-256).
 */
export function gllChecksum(bytes, start = 0, end = bytes.length) {
  const checksum = [0, 0, 0, 0];
  for (let i = Math.max(0, start); i < Math.min(bytes.length, end); i += 1) {
    const b = bytes[i];
    checksum[0] = (b ^ (123 + checksum[0])) % 256;
    checksum[1] = ((11 * b) ^ (1433 + checksum[1])) % 256;
    checksum[2] = ((3 * b) ^ (13 + checksum[2])) % 256;
    checksum[3] = ((checksum[0] + checksum[1] + checksum[2]) ^ 0x37) % 256;
  }
  return checksum;
}

/* ---------- the balloon grid ---------- */

export function balloonCounts(step) {
  const meridian = step > 0 ? Math.floor(180 / step) + 1 : 1;
  const parallel = step > 0 ? Math.floor(180 / step) + 1 : 1;
  // The two poles are stored once, on the first meridian.
  const responses = meridian === 1 ? parallel : parallel + (meridian - 1) * (parallel - 2);
  return { meridian, parallel, responses };
}

/**
 * The flat index of the response at a meridian/parallel pair.
 *
 * Mirrors the reader's ResponseIndex: both poles live only on meridian 0, so the
 * first meridian owns every parallel and each later meridian carries the interior
 * parallels only.
 */
export function balloonIndex(meridianIndex, parallelIndex, parallelCount) {
  const last = parallelCount - 1;
  if (parallelIndex === 0 || parallelIndex === last) return parallelIndex;
  if (meridianIndex === 0) return parallelIndex;
  return parallelCount + (meridianIndex - 1) * (parallelCount - 2) + (parallelIndex - 1);
}

/* ---------- spectra ---------- */

/**
 * One response: a CLogSpectrumLP block (uncompressed level/phase pairs).
 *
 * Levels are stored as int16 hundredths of a dB and phases as int16 thousandths
 * of a radian, as the format document specifies.
 */
function spectrumBytes(definition, levels, phases, delay) {
  const sink = new Sink();
  sink.i32(definition.bandsPerOctave);
  sink.f64(definition.startFreq);
  sink.i32(definition.pointCount);
  sink.i32(0); // compression: none
  sink.i32(levels.length);
  for (const level of levels) sink.i16(Math.round(level / LEVEL_SCALE));
  sink.i32(phases.length);
  for (const phase of phases) sink.i16(Math.round(phase / PHASE_SCALE));
  sink.f64(delay || 0);
  return block(0, sink.bytes());
}

function resolutionBytes(step) {
  const sink = new Sink();
  sink.i32(SYMMETRY_VERTICAL_ON_DISK);
  sink.i32(0); // full sphere, not the front half only
  sink.f64(step);
  sink.f64(step);
  // 4 + 4 + 8 + 8 = 24 bytes of content, plus the 8-byte block header = 32.
  return block(0, sink.bytes());
}

/* ---------- the band grid ---------- */

function bandDefinition(band) {
  const low = Math.max(20, Math.min(20000, Number(band && band.fMin) || 50));
  const high = Math.max(low * 2, Math.min(20000, Number(band && band.fMax) || 16000));
  const startFreq = Math.round(low * 10) / 10;
  // Ceiling, so the last band centre lands at or above the top of the band.
  const count = Math.ceil(Math.log2(high / startFreq) * GLL_BANDS_PER_OCTAVE) + 1;
  const pointCount = Math.max(1, Math.min(63, count));
  const frequencies = [];
  for (let i = 0; i < pointCount; i += 1) {
    frequencies.push(startFreq * Math.pow(2, i / GLL_BANDS_PER_OCTAVE));
  }
  return { definition: { bandsPerOctave: GLL_BANDS_PER_OCTAVE, startFreq, pointCount }, frequencies };
}

/** A generated curve as a plain array, whether the builder returned one or a typed array. */
function curveValues(curve) {
  if (!curve || typeof curve.length !== 'number' || curve.length === 0) return null;
  return Array.from(curve);
}

/** The drawn cabinet curve sampled at the band centres, log-frequency between points. */
function curveSampler(magDb) {
  const hz = [];
  for (let i = 0; i < GRID_POINTS; i += 1) hz.push(gridFrequency(i, GRID_POINTS));
  return (frequency) => {
    if (!Number.isFinite(frequency) || !magDb.length) return 0;
    if (frequency <= hz[0]) return magDb[0];
    if (frequency >= hz[hz.length - 1]) return magDb[magDb.length - 1];
    let index = 0;
    while (index < hz.length - 2 && hz[index + 1] < frequency) index += 1;
    const span = Math.log(hz[index + 1] / hz[index]);
    const t = span > 0 ? Math.log(frequency / hz[index]) / span : 0;
    return magDb[index] + (magDb[index + 1] - magDb[index]) * t;
  };
}

function sanitiseFileName(name) {
  const base = String(name || '')
    .replace(/[^a-z0-9._ -]+/gi, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase();
  return (base || 'align-loudspeaker') + '.gll';
}

/* ---------- the file ---------- */

/**
 * Build a GLL from a builder specification.
 *
 * Returns `{ ok: true, bytes, fileName, summary, warnings }`, or `{ ok: false,
 * message }` when the specification carries no response to write. Nothing here
 * invents a measurement: every level comes from `generateCabinetResponse` and
 * from `patternAttenuationDb`, the two model paths the app already draws with.
 */
export function createGllFromSpec(rawSpec, options = {}) {
  const spec = rawSpec ? normalizeSpec(rawSpec) : null;
  if (!spec || !spec.sections || !spec.sections.length) {
    return { ok: false, message: 'There is no loudspeaker specification to write.' };
  }

  const warnings = [];

  // The cabinet response is the one the builder draws. Where the sections cannot
  // be combined — a crossover frequency missing, so the relative phase of two
  // sections is unknown — the first section is written on its own and the file
  // says so, which is the same fallback the screen offers.
  const cabinet = generateCabinetResponse(spec);
  let curve = cabinet && cabinet.ok ? curveValues(cabinet.magDb) : null;
  let sectionOnly = false;
  if (!curve) {
    curve = curveValues(generateSectionResponse(spec, 0));
    if (!curve) {
      return {
        ok: false,
        message: 'The specification has no response to write: ' +
          ((cabinet && cabinet.message) || 'the builder could not generate a curve.'),
      };
    }
    sectionOnly = spec.sections.length > 1;
    if (sectionOnly) {
      warnings.push('the sections could not be combined, so only "' +
        (spec.sections[0].label || 'section 1') + '" is written');
    }
  }
  const label = String(spec.name || '').trim() || 'Align loudspeaker';
  const company = String(spec.manufacturer || '').trim();
  const key = 'align-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'align-speaker';

  const bands = bandDefinition(spec.band);
  const sample = curveSampler(curve);
  const shape = bands.frequencies.map(sample);
  const peak = shape.reduce((max, value) => (value > max ? value : max), shape[0]);

  const sensitivity = sensitivityAt1W(spec, 0);
  const reference = Number.isFinite(sensitivity) ? sensitivity : 0;
  if (!Number.isFinite(sensitivity)) {
    warnings.push('no 1 W sensitivity was entered, so the levels are relative to a 0 dB reference');
  }
  const onAxis = shape.map((value) => reference + (value - peak));

  // The balloon: the same separable beamwidth model the Room Designer predicts with.
  const directivity = directivityEntries(spec);
  const profile = (spec.directivity && spec.directivity.profile) || '';
  const widths = bands.frequencies.map((frequency) => {
    const entry = nearestDirectivity(directivity, frequency);
    return entry || { widthDeg: 0, widthHDeg: 0, widthVDeg: 0 };
  });
  if (!widths.some((entry) => entry.widthDeg > 0 || entry.widthHDeg > 0)) {
    warnings.push('no beamwidth data, so the balloon is omnidirectional');
  }

  const step = GLL_BALLOON_STEP;
  const counts = balloonCounts(step);
  const responses = new Array(counts.responses);
  for (let meridianIndex = 0; meridianIndex < counts.meridian; meridianIndex += 1) {
    const horizontal = meridianIndex * step;
    for (let parallelIndex = 0; parallelIndex < counts.parallel; parallelIndex += 1) {
      const pole = parallelIndex === 0 || parallelIndex === counts.parallel - 1;
      if (pole && meridianIndex > 0) continue;
      const vertical = Math.abs(parallelIndex * step - 90);
      const total = Math.acos(
        Math.max(-1, Math.min(1,
          Math.cos((vertical * Math.PI) / 180) * Math.cos((horizontal * Math.PI) / 180))),
      ) * 180 / Math.PI;
      const angles = { horizontal, vertical, total };
      responses[balloonIndex(meridianIndex, parallelIndex, counts.parallel)] =
        onAxis.map((level, bandIndex) => level + patternAttenuationDb(angles, widths[bandIndex], profile));
    }
  }

  const zeroPhase = new Array(bands.definition.pointCount).fill(0);

  // Balloon
  const balloonSink = new Sink();
  balloonSink.i32(0); // flags: no interpolation hint
  balloonSink.push(resolutionBytes(step));
  balloonSink.i32(responses.length);
  for (const levels of responses) balloonSink.push(spectrumBytes(bands.definition, levels, zeroPhase, 0));
  const balloon = block(0, balloonSink.bytes());

  // Source definition
  const definitionSink = new Sink();
  definitionSink.text(label + ' (Align model)');
  definitionSink.text(company);
  definitionSink.text(GLL_CAVEAT);
  definitionSink.f64(bands.frequencies[0]);
  definitionSink.f64(bands.frequencies[bands.frequencies.length - 1]);
  definitionSink.i32(DATA_TYPE_THIRD_OCTAVE);
  definitionSink.push(balloon);
  definitionSink.i32(0); // no on-axis file reference
  definitionSink.f64(reference);
  definitionSink.push(spectrumBytes(bands.definition, onAxis, zeroPhase, 0));
  const definition = block(0, definitionSink.bytes());

  const itemSink = new Sink();
  itemSink.text(key);
  itemSink.push(definition);
  const sourceItem = block(0, itemSink.bytes());

  const sourceItemsSink = new Sink();
  sourceItemsSink.i32(1);
  sourceItemsSink.push(sourceItem);
  const sourceItems = block(0, sourceItemsSink.bytes());

  // Cabinet and its single source
  const sourcePlacementSink = new Sink();
  sourcePlacementSink.text(key);
  sourcePlacementSink.f64(0).f64(0).f64(0); // position
  sourcePlacementSink.f64(0).f64(0).f64(0); // angles
  sourcePlacementSink.text('Align source');
  sourcePlacementSink.text('src-' + key);
  const placement = block(0, sourcePlacementSink.bytes());

  const placementSink = new Sink();
  placementSink.i32(1);
  placementSink.push(placement);
  const placements = block(0, placementSink.bytes());

  const boxSink = new Sink();
  boxSink.text(label);
  boxSink.text('box-' + key);
  boxSink.push(placements);
  boxSink.push(emptyBuffer()); // no input configuration
  boxSink.push(emptyBuffer()); // no case geometry
  boxSink.f64(0).f64(0).f64(0); // next pivot
  boxSink.f64(0).f64(0).f64(0); // reference point
  boxSink.f64(0).f64(0).f64(0); // centre of mass
  boxSink.f64(0);               // weight (kg), unknown
  const box = block(0, boxSink.bytes());

  const boxesSink = new Sink();
  boxesSink.i32(1);
  boxesSink.push(box);
  const boxes = block(0, boxesSink.bytes());

  // Database: the documented loading order, with the empty buffers in place.
  const databaseSink = new Sink();
  databaseSink.i32(0).i32(0);   // reserved fields
  databaseSink.i32(0);          // data files
  databaseSink.push(boxes);
  databaseSink.push(emptyBuffer()); // frames
  databaseSink.push(emptyBuffer()); // connectors
  databaseSink.push(emptyBuffer()); // limits
  databaseSink.push(sourceItems);
  const database = block(3, databaseSink.bytes());

  // GenSystem
  const systemSink = new Sink();
  systemSink.text(label);
  systemSink.f64(1);            // GLL version
  systemSink.text(key);
  systemSink.i32(SYSTEM_TYPE_LOUDSPEAKER);
  systemSink.text(company);
  systemSink.text(options.infoText || buildInfoText(label, bands, counts, warnings));
  systemSink.text(options.copyright || '');
  systemSink.text(options.support || '');
  systemSink.text(options.website || spec.website || '');
  systemSink.text(options.email || '');
  systemSink.i32(0);            // background colour
  systemSink.push(database);
  const system = block(0, systemSink.bytes());

  const header = new Sink();
  header.push(encoder.encode('EGLL'));
  header.i32(0);
  header.text('EASE_GLL');
  header.i16(HEADER_VERSION);
  header.i16(0);
  for (const byte of gllChecksum(system)) header.u8(byte);

  const head = header.bytes();
  const bytes = new Uint8Array(head.length + system.length);
  bytes.set(head, 0);
  bytes.set(system, head.length);

  return {
    ok: true,
    bytes,
    fileName: sanitiseFileName(options.name || label),
    summary: {
      label,
      bands: bands.definition.pointCount,
      fromHz: Math.round(bands.frequencies[0]),
      toHz: Math.round(bands.frequencies[bands.frequencies.length - 1]),
      responses: responses.length,
      step,
      sections: sectionOnly ? 1 : spec.sections.length,
      bytes: bytes.length,
      authorised: false,
    },
    warnings,
  };
}

function nearestDirectivity(entries, frequency) {
  const list = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && Number(entry.frequency) > 0)
    .sort((a, b) => a.frequency - b.frequency);
  if (!list.length) return null;
  let best = list[0];
  let bestDistance = Infinity;
  for (const entry of list) {
    const distance = Math.abs(Math.log(entry.frequency) - Math.log(frequency));
    if (distance < bestDistance) {
      best = entry;
      bestDistance = distance;
    }
  }
  return {
    widthDeg: Number(best.widthDeg) || 0,
    widthHDeg: Number(best.widthHDeg) || 0,
    widthVDeg: Number(best.widthVDeg) || 0,
    profile: best.profile || '',
  };
}

function buildInfoText(label, bands, counts, warnings) {
  const lines = [
    label + ' written by Align, the loudspeaker measurement app.',
    GLL_CAVEAT,
    'Balloon: ' + counts.responses + ' responses on a ' + GLL_BALLOON_STEP +
      ' degree grid, ' + bands.definition.pointCount + ' third-octave bands from ' +
      Math.round(bands.frequencies[0]) + ' Hz to ' +
      Math.round(bands.frequencies[bands.frequencies.length - 1]) + ' Hz, magnitude only (phase written as zero).',
    'AFMG compiles and authorises GLL files with EASE SpeakerLab; this file was not made by it.',
  ];
  if (warnings && warnings.length) lines.push('Notes: ' + warnings.join('; ') + '.');
  return lines.join('\n');
}
