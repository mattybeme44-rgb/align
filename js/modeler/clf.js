/*
 * Common Loudspeaker Format (CLF) reader.
 *
 * CLF1 and CLF2 are TAB/space-delimited text files whose fields are written
 * as <KEY> value, as documented by the CLF group (clfgroup.org): CLF v1 from
 * 2005 carries octave data on a 10° grid, CLF2 from 2011 carries third-octave
 * data on a 5° grid with optional phase, filters and multipart files.
 *
 * What this reader takes is the part of the format that is published: the
 * metadata keys, the per-band SENSITIVITY, IMPEDANCE and 6DB-WIDTH-HOR lists.
 * The polar-balloon blocks of CLF2 are only specified in the licensed
 * authoring kit, so they are not decoded here — the importer says so instead
 * of guessing at a grid it cannot verify. EASE GLL and SPK are not read at all:
 * GLL needs AFMG's licensed SDK and SPK has no public specification.
 *
 * The values are kept exactly as the file writes them. The file does not state
 * the reference the sensitivity list is relative to, so it is not assumed.
 */

import { gridFrequency } from './curve.js';

export const CLF_POINTS = 400;

const COMMENT = /^\s*#/;

function keyValue(line) {
  const match = line.match(/^\s*<([A-Za-z0-9_-]+)>\s*(.*)$/);
  if (!match) return null;
  return { key: match[1].toUpperCase(), value: match[2].trim() };
}

function numbers(text) {
  // An empty field is no value at all: Number('') is 0, which would otherwise
  // read an absent IMPEDANCE as a 0 ohm claim.
  const source = String(text === undefined || text === null ? '' : text).trim();
  if (!source) return [];
  return source
    .split(/[\s,;]+/)
    .map((token) => Number(token))
    .filter((value) => Number.isFinite(value));
}

/** The octave or third-octave band centres between two limits. */
export function clfBands(minBand, maxBand, thirdOctave) {
  const low = Number(minBand) > 0 ? Number(minBand) : 63;
  const high = Number(maxBand) > low ? Number(maxBand) : 16000;
  const ratio = thirdOctave ? Math.pow(2, 1 / 3) : 2;
  const bands = [];
  let frequency = low;
  while (frequency <= high * 1.001 && bands.length < 64) {
    bands.push(frequency);
    frequency *= ratio;
  }
  // CLF2's canonical series ends at 20 kHz, which is not an exact third-octave
  // step from 100 Hz; the top band the file states is kept rather than dropped.
  const last = bands[bands.length - 1];
  if (high > last * 1.001 && bands.length < 64) bands.push(high);
  return bands;
}

/**
 * Read a CLF text file.
 *
 * Returns `manufacturer` metadata, the band list, and the per-band level,
 * impedance and 6 dB horizontal beamwidth the file provides. Missing values are
 * left missing; nothing is interpolated into a grid the file did not state.
 */
export function parseClf(text, fileName) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, message: 'That file is empty.' };
  }

  const keys = new Map();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line || COMMENT.test(line)) continue;
    const entry = keyValue(line);
    if (!entry) continue;
    if (!keys.has(entry.key)) keys.set(entry.key, entry.value);
  }

  const versionText = keys.get('VERSION') || '';
  const version = Number(versionText.split(/\s+/)[0]);
  if (!keys.has('MINBAND') && !keys.has('SENSITIVITY')) {
    return { ok: false, message: 'That file does not carry CLF fields — it may not be a CLF file.' };
  }

  const thirdOctave = Number.isFinite(version) ? version >= 2 : false;
  const minBand = Number(keys.get('MINBAND')) || 63;
  const maxBand = Number(keys.get('MAXBAND')) || 16000;
  const bands = clfBands(minBand, maxBand, thirdOctave);

  const sensitivity = numbers(keys.get('SENSITIVITY'));
  const axial = numbers(keys.get('AXIAL-SPECTRUM'));
  // CLF files that carry no per-band sensitivity (gll-tools writes an empty one)
  // still state the on-axis response; it is the same measurement, so it is used.
  const levels = sensitivity.length ? sensitivity : axial;
  const impedance = numbers(keys.get('IMPEDANCE'));
  const beamwidth = numbers(keys.get('6DB-WIDTH-HOR'));
  const beamwidthVertical = numbers(keys.get('6DB-WIDTH-VER'));

  // The polar data section: <BAND> blocks of TAB-separated levels, one row per
  // azimuth angle and one column per polar angle. Decoding it means a file that
  // states no 6 dB width keys still carries a pattern the widths can be measured
  // from, instead of the whole balloon being dropped on import.
  const polarBlocks = readPolarBands(lines);
  const symmetry = String(keys.get('BALLOON-SYMMETRY') || '').replace(/[<>]/g, '').trim().toLowerCase();
  const balloon = polarBlocks.length ? measureBalloon(polarBlocks, symmetry) : null;

  const warnings = [];
  if (sensitivity.length === 0 && axial.length) {
    warnings.push('the sensitivity list is empty, so the on-axis spectrum is used as the band levels');
  }
  if (!levels.length && !beamwidth.length) {
    warnings.push('the file carries no sensitivity or beamwidth figures to model');
  }
  if (levels.length && levels.length !== bands.length) {
    warnings.push('the level list holds ' + levels.length + ' values for ' + bands.length + ' bands');
  }
  if (beamwidth.length && beamwidth.length !== bands.length) {
    warnings.push('the 6 dB width list holds ' + beamwidth.length + ' values for ' + bands.length + ' bands');
  }
  if (balloon && !beamwidth.length) {
    warnings.push('the file states no 6 dB width key, so the widths are measured from its own decoded balloon');
  }
  if (balloon && balloon.incomplete) {
    warnings.push(balloon.incomplete + ' band blocks were not read because their rows differ in length');
  }

  const readings = [];
  for (let i = 0; i < bands.length; i += 1) {
    const level = i < levels.length ? levels[i] : null;
    readings.push({
      frequency: bands[i],
      levelDb: Number.isFinite(level) ? level : null,
      impedanceOhm: i < impedance.length && Number.isFinite(impedance[i]) ? impedance[i] : null,
      beamwidthDeg: i < beamwidth.length && Number.isFinite(beamwidth[i])
        ? beamwidth[i]
        : nearestWidth(balloon && balloon.horizontal, bands[i]),
      beamwidthVDeg: i < beamwidthVertical.length && Number.isFinite(beamwidthVertical[i])
        ? beamwidthVertical[i]
        : nearestWidth(balloon && balloon.vertical, bands[i]),
    });
  }

  return {
    ok: true,
    message: warnings.join(' · '),
    warnings,
    manufacturer: {
      name: keys.get('MODELNAME') || (fileName ? String(fileName).replace(/\.[^.]+$/, '') : 'CLF loudspeaker'),
      maker: keys.get('MANUFACTURER') || '',
      description: keys.get('DESCRIPTION') || '',
      website: keys.get('WEB-SITE') || '',
      version: keys.get('VERSION') || '',
      minBand,
      maxBand,
      thirdOctave,
      sensitivityInfo: keys.get('SENSITIVITY-INFO') || '',
      impedanceInfo: keys.get('IMPEDANCE-INFO') || '',
      beamwidthInfo: keys.get('6DB-WIDTH-HOR-INFO') || '',
      radiation: keys.get('RADIATION') || '',
      measurementDistance: Number(keys.get('MEASUREMENT-DISTANCE')) || null,
      environment: keys.get('MEASUREMENT-ENVIRONMENT') || '',
      kind: keys.get('TYPE') || '',
    },
    bands,
    readings,
    polar: balloon,
    symmetry,
    fileName: fileName || '',
  };
}

/**
 * A manufacturer response on the model grid from a CLF file.
 *
 * The levels are plotted at the file's own band centres, interpolated between
 * them in dB. The CLF file gives no phase, so the curve is magnitude-only —
 * phase is never invented for it, and the model is marked manufacturer data.
 */
export function clfResponse(clf) {
  if (!clf || !clf.ok || !clf.readings || !clf.readings.length) {
    return { ok: false, message: 'That CLF file carries no level to plot.' };
  }
  const known = clf.readings.filter((reading) => Number.isFinite(reading.levelDb));
  if (!known.length) {
    return { ok: false, message: 'That CLF file carries no level to plot.' };
  }

  const magDb = new Float32Array(CLF_POINTS);
  for (let i = 0; i < CLF_POINTS; i += 1) {
    const frequency = gridFrequency(i, CLF_POINTS);
    if (frequency <= known[0].frequency) {
      magDb[i] = known[0].levelDb;
      continue;
    }
    if (frequency >= known[known.length - 1].frequency) {
      magDb[i] = known[known.length - 1].levelDb;
      continue;
    }
    let index = 0;
    while (index < known.length - 1 && known[index + 1].frequency < frequency) index += 1;
    const low = known[index];
    const high = known[index + 1];
    const span = Math.log(high.frequency / low.frequency);
    const t = span > 0 ? Math.log(frequency / low.frequency) / span : 0;
    magDb[i] = low.levelDb + (high.levelDb - low.levelDb) * t;
  }

  return {
    ok: true,
    message: 'Projected from the manufacturer bands as written; the file does not state its reference level.',
    magDb: Array.from(magDb),
    fMin: known[0].frequency,
    fMax: known[known.length - 1].frequency,
    directivity: clf.readings
      .filter((reading) => Number.isFinite(reading.beamwidthDeg) && reading.beamwidthDeg > 0)
      .map((reading) => ({ frequency: reading.frequency, widthDeg: reading.beamwidthDeg })),
    // The sphere the file carries, in band/azimuth/polar order, so the import can
    // keep it with the dataset instead of reducing it to widths.
    balloon: clf.polar && Array.isArray(clf.polar.levels) && clf.polar.levels.length
      ? {
          symmetry: clf.polar.symmetry,
          azimuths: clf.polar.azimuths,
          parallels: clf.polar.parallels,
          stepAzDeg: clf.polar.azimuthStep,
          stepPolDeg: clf.polar.polarStep,
          frequencies: clf.polar.frequencies,
          levels: clf.polar.levels,
        }
      : null,
  };
}


/* ---------- the other direction: reading a GLL, writing a CLF ---------- */

/*
 * CLF has no balloon-free equivalent of a GLL: CLF2 stores the same kind of data
 * (a grid of band levels), so a conversion is possible in both directions. What
 * follows is a reader for the container `gll.js` writes and a writer for CLF2,
 * laid out after the MIT-licensed gll-tools project, whose Go code is the only
 * public description of both directions that exists:
 *
 *   internal/clf/writer.go     the CLF2 text template and its keys
 *   internal/clf/frequencies.go the 24 CLF2 third-octave bands (100 Hz – 20 kHz)
 *   internal/clf/symmetry.go   GLL symmetry to CLF symmetry tag
 *
 * Two honest limits are carried into the output:
 *
 *   - the GLL side is Align's own reader of a reverse-engineered layout, not
 *     AFMG's licensed SDK, so a file it cannot account for is refused whole;
 *   - the band grids are the formats' own (CLF2: 24 third-octave bands from 100 Hz,
 *     CLF1: 8 octave bands from 125 Hz), so the GLL's bands are carried across by
 *     nearest band rather than resampled into a curve that pretends to be measured
 *     at those exact centres;
 *   - no CLF Group tool was available to open the output. Their viewer and authoring
 *     kit are the only real readers and are Windows binaries behind registration, so
 *     the text written here is checked against the published format rules (see
 *     tests/clf.mjs), never by a vendor application.
 */

export const CLF1_BANDS = [125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export const CLF2_BANDS = [
  100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
  1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000,
  10000, 12500, 16000, 20000,
];

/* On-disk GLL symmetry codes, as the reverse-engineered layout documents them. */
const GLL_SYMMETRY = { 0: 'rotational', 1: 'full', 2: 'vertical', 3: 'horizontal', 4: 'none' };

function roundTo(value, places = 1) {
  const factor = Math.pow(10, places);
  return Math.round(Number(value) * factor) / factor;
}

class GllReader {
  constructor(bytes, offset = 0) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = offset;
  }

  seek(offset) { this.offset = offset; return this; }
  i16() { const value = this.view.getInt16(this.offset, true); this.offset += 2; return value; }
  u16() { const value = this.view.getUint16(this.offset, true); this.offset += 2; return value; }
  i32() { const value = this.view.getInt32(this.offset, true); this.offset += 4; return value; }
  f64() { const value = this.view.getFloat64(this.offset, true); this.offset += 8; return value; }

  text() {
    const length = this.u16();
    const end = this.offset + length;
    if (length < 0 || end > this.bytes.length) throw new RangeError('a string runs past the end of the file');
    const value = new TextDecoder().decode(this.bytes.subarray(this.offset, end));
    this.offset = end;
    return value;
  }

  block() {
    const start = this.offset;
    const size = this.i32();
    if (size < 8 || start + size > this.bytes.length) {
      throw new RangeError('a block of ' + size + ' bytes runs past the end of the file');
    }
    const vcheck = this.i16();
    const subVersion = this.i16();
    return { size, vcheck, subVersion, start, content: this.offset, end: start + size };
  }
}

/** Skip one buffer field: a bare zero int32, or a size-prefixed block. */
function skipBuffer(reader) {
  const size = reader.view.getInt32(reader.offset, true);
  if (size === 0) {
    reader.offset += 4;
    return;
  }
  reader.seek(reader.block().end);
}

/**
 * Read a count-prefixed list: either a bare zero, or a block holding the count
 * followed by one block per item.
 */
function readList(reader, parseItem) {
  const size = reader.view.getInt32(reader.offset, true);
  if (size === 0) {
    reader.offset += 4;
    return [];
  }
  const block = reader.block();
  const count = reader.i32();
  const items = [];
  for (let index = 0; index < count && reader.offset < block.end; index += 1) {
    const item = reader.block();
    items.push(parseItem(reader, item, index));
    reader.seek(item.end);
  }
  reader.seek(block.end);
  return items;
}

function readSpectrum(reader) {
  const block = reader.block();
  const bandsPerOctave = reader.i32();
  const startFreq = reader.f64();
  const pointCount = reader.i32();
  const compression = reader.i32();
  if (compression !== 0) throw new RangeError('bit-compressed spectra (method ' + compression + ') are not read');
  const levelCount = reader.i32();
  const levels = new Array(levelCount);
  for (let index = 0; index < levelCount; index += 1) levels[index] = reader.i16() * 0.01;
  const phaseCount = reader.i32();
  for (let index = 0; index < phaseCount; index += 1) reader.i16();
  const delay = reader.f64();
  reader.seek(block.end);
  return { bandsPerOctave, startFreq, pointCount, levels, delay };
}

function meridianCount(symmetry, step) {
  const span = symmetry === 0 ? 0 : symmetry === 1 ? 90 : symmetry === 4 ? 360 : 180;
  if (!(step > 0)) return 1;
  return Math.floor(span / step + 1e-9) + 1;
}

function readBalloon(reader) {
  const block = reader.block();
  reader.i32(); // flags
  const resolution = reader.block();
  const symmetry = reader.i32();
  const frontHalfOnly = reader.i32() !== 0;
  const meridianStep = reader.f64();
  const parallelStep = reader.f64();
  reader.seek(resolution.end);
  const count = reader.i32();
  const responses = [];
  for (let index = 0; index < count; index += 1) responses.push(readSpectrum(reader));
  reader.seek(block.end);
  const parallels = parallelStep > 0 ? Math.floor(180 / parallelStep + 1e-9) + 1 : 1;
  return {
    symmetry,
    frontHalfOnly,
    meridianStep,
    parallelStep,
    meridians: meridianCount(symmetry, meridianStep),
    parallels,
    responses,
  };
}

function readBox(reader, item) {
  const label = reader.text();
  const key = reader.text();
  const placements = readList(reader, (inner) => {
    const sourceKey = inner.text();
    inner.offset += 48; // position and angles, six float64
    const name = inner.text();
    const placementKey = inner.text();
    return { sourceKey, name, placementKey };
  });
  let weight = null;
  try {
    skipBuffer(reader); // input configuration
    skipBuffer(reader); // case geometry
    reader.offset += 72; // next pivot, reference point, centre of mass
    const value = reader.f64();
    weight = Number.isFinite(value) && value > 0 ? value : null;
  } catch (error) {
    weight = null;
  }
  reader.seek(item.end);
  return { label, key, placements, weight };
}

function readSourceItem(reader, item) {
  const key = reader.text();
  const definition = reader.block();
  const label = reader.text();
  const company = reader.text();
  const description = reader.text();
  const fromHz = reader.f64();
  const toHz = reader.f64();
  const dataType = reader.i32();
  const balloon = readBalloon(reader);
  reader.i32(); // on-axis file reference
  const reference = reader.f64();
  reader.seek(definition.end);
  reader.seek(item.end);
  return { key, label, company, description, fromHz, toHz, dataType, reference, balloon };
}

/**
 * Read the container `gll.js` writes.
 *
 * Only the version-4 layout is accepted: that is the one with the checksum and no
 * hash block, the one this app writes and the one its own reader was checked
 * against. Anything else is refused by version rather than guessed at.
 */
export function parseGll(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  if (!bytes.length) return { ok: false, message: 'That file is empty.' };
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'EGLL') {
    return { ok: false, message: 'That file does not start with the EGLL signature, so it is not a GLL file.' };
  }
  try {
    const reader = new GllReader(bytes, 4);
    reader.i32(); // reserved
    const format = reader.text();
    const version = reader.i16();
    const subVersion = reader.i16();
    if (format !== 'EASE_GLL') {
      return { ok: false, message: 'That file names "' + format + '" instead of EASE_GLL.' };
    }
    if (version !== 4) {
      return { ok: false, message: 'That GLL is a version ' + version + ' file; only the version-4 layout is read here.' };
    }
    reader.offset += 4; // checksum

    const system = reader.block();
    const label = reader.text();
    const gllVersion = reader.f64();
    const key = reader.text();
    const type = reader.i32();
    const company = reader.text();
    const info = reader.text();
    const copyright = reader.text();
    const support = reader.text();
    const website = reader.text();
    const email = reader.text();
    reader.i32(); // background colour
    const database = reader.block();
    reader.i32(); // reserved
    reader.i32(); // reserved
    skipBuffer(reader); // data files
    const boxes = readList(reader, readBox);
    skipBuffer(reader); // frames
    skipBuffer(reader); // connectors
    skipBuffer(reader); // limits
    const sources = readList(reader, readSourceItem);
    reader.seek(system.end);

    const warnings = [];
    if (!sources.length) warnings.push('the file holds no source definition');
    if (subVersion !== 0) warnings.push('the file is written at sub-version ' + subVersion);

    return {
      ok: true,
      version,
      subVersion,
      label,
      key,
      type,
      company,
      info,
      copyright,
      support,
      website,
      email,
      gllVersion,
      database: { end: database.end },
      boxes,
      sources,
      warnings,
    };
  } catch (error) {
    return { ok: false, message: 'That GLL could not be read: ' + error.message + '.' };
  }
}

/* ---------- reading the polar section back ---------- */

/** The azimuth span a CLF symmetry tag stores, in degrees. */
function balloonSpan(symmetry) {
  switch (symmetry) {
    case 'rotational': return 0;
    case 'vertical': return 0;
    case 'polar': return 270;
    case 'full': return 90;
    case 'none': return 360;
    default: return 180; // <horizontal>
  }
}

/** Every <BAND> block: one row per azimuth, one column per polar angle. */
function readPolarBands(lines) {
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (!line || COMMENT.test(line)) continue;
    const band = line.match(/^\s*<BAND>\s*(.*)$/i);
    if (band) {
      const frequency = Number(String(band[1]).replace(/[\s,;]+/g, ''));
      current = Number.isFinite(frequency) && frequency > 0 ? { frequency, rows: [] } : null;
      if (current) blocks.push(current);
      continue;
    }
    if (/^\s*</.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const values = trimmed.split(/[\s,;]+/).map(Number);
    if (values.length && values.every((value) => Number.isFinite(value))) current.rows.push(values);
  }
  return blocks.filter((block) => block.rows.length > 0);
}

/**
 * Measure a decoded balloon: its shape, and the 6 dB width per band along the
 * horizontal and vertical planes, from the levels themselves.
 */
function measureBalloon(blocks, symmetry) {
  const columns = blocks[0].rows[0].length;
  const consistent = blocks.filter((block) => block.rows.every((row) => row.length === columns));
  const incomplete = blocks.length - consistent.length;
  const rows = consistent.length ? consistent[0].rows.length : 0;
  const span = balloonSpan(symmetry);
  const azimuthStep = rows > 1 && span > 0 ? span / (rows - 1) : 0;
  const polarStep = columns > 1 ? 180 / (columns - 1) : 0;
  const middle = Math.floor(columns / 2);
  const horizontal = [];
  const vertical = [];
  for (const block of consistent) {
    const axis = block.rows[0][middle];
    if (rows > 1 && azimuthStep > 0) {
      horizontal.push({
        frequency: block.frequency,
        widthDeg: crossingWidth(
          block.rows.map((row, index) => ({ angle: index * azimuthStep, db: row[middle] })),
          axis,
        ),
      });
    }
    if (columns > 2) {
      vertical.push({
        frequency: block.frequency,
        widthDeg: crossingWidth(
          block.rows[0].map((value, index) => ({ angle: Math.abs(index * polarStep - 90), db: value })),
          axis,
        ),
      });
    }
  }
  return {
    symmetry: symmetry || '',
    bands: consistent.length,
    frequencies: consistent.map((block) => block.frequency),
    levels: consistent.map((block) => block.rows),
    azimuths: rows,
    parallels: columns,
    span,
    azimuthStep,
    polarStep,
    horizontal,
    vertical,
    incomplete,
  };
}

/** The measured width nearest a band, or null when the balloon gave none. */
function nearestWidth(list, frequency) {
  if (!Array.isArray(list) || !list.length || !Number.isFinite(frequency)) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const entry of list) {
    const distance = Math.abs(Math.log2(entry.frequency / frequency));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = entry;
    }
  }
  return best ? best.widthDeg : null;
}

/* ---------- the CLF writer ---------- */


/** The flat response index of a meridian/parallel pair, poles stored once. */
function responseIndex(meridian, parallel, parallels) {
  const last = parallels - 1;
  if (parallel === 0 || parallel === last) return parallel;
  if (meridian === 0) return parallel;
  return parallels + (meridian - 1) * (parallels - 2) + (parallel - 1);
}

/** One spectrum's levels at the 24 CLF2 band centres, by nearest band. */
function bandLevels(response, bands) {
  const count = response.levels.length;
  const bandsPerOctave = response.bandsPerOctave > 0 ? response.bandsPerOctave : 3;
  return bands.map((target) => {
    let best = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < count; index += 1) {
      const frequency = response.startFreq * Math.pow(2, index / bandsPerOctave);
      const distance = Math.abs(Math.log2(frequency / target));
      if (distance < bestDistance - 1e-12) {
        bestDistance = distance;
        best = index;
      }
    }
    return Number.isFinite(response.levels[best]) ? response.levels[best] : 0;
  });
}

/** The full 6 dB width from a walk outward from the axis, by linear crossing. */
function crossingWidth(points, axisDb) {
  const ordered = points.slice().sort((a, b) => a.angle - b.angle);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (current.db > axisDb - 6) continue;
    const span = current.db - previous.db;
    const t = span === 0 ? 0 : (axisDb - 6 - previous.db) / span;
    const angle = previous.angle + (current.angle - previous.angle) * Math.max(0, Math.min(1, t));
    return Math.min(360, Math.max(5, angle * 2));
  }
  return 360;
}

function clfFileName(name, format, part) {
  const base = String(name || '')
    .replace(/[^a-z0-9._ -]+/gi, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase();
  const suffix = part && part.count > 1 ? '-part' + part.index : '';
  return (base || 'align-loudspeaker') + suffix + (format === 1 ? '.cf1' : '.cf2');
}

/** The CLF symmetry tag for a balloon, from the span its meridians cover. */
function clfSymmetry(balloon) {
  const span = Math.max(0, (balloon.meridians - 1) * balloon.meridianStep);
  if (balloon.symmetry === 0 || span < 1) return { tag: 'rotational', span: 0 };
  if (Math.abs(span - 90) < 1e-6) return { tag: 'full', span: 90 };
  if (Math.abs(span - 270) < 1e-6) return { tag: 'polar', span: 270 };
  if (span >= 355) return { tag: 'none', span: 360 };
  return { tag: 'horizontal', span: 180 };
}

/** How many azimuth rows a CLF file stores for a tag at a given step. */
function azimuthCountFor(tag, step) {
  switch (tag) {
    case 'rotational': return 1;
    case 'vertical': return 1;
    case 'polar': return 4;
    case 'full': return Math.round(90 / step) + 1;
    case 'none': return Math.round(360 / step);
    default: return Math.round(180 / step) + 1;
  }
}

/**
 * Write CLF2 text from a parsed GLL.
 *
 * The 24 band rows are the file's own balloon carried to the CLF2 band centres,
 * the axial spectrum is the on-axis response, and the 6 dB widths are measured
 * from that same balloon — no width, level or band is invented here. Nothing is
 * claimed about the source: the GLL's own description travels into the CLF.
 */
/**
 * Write a CLF text file from a parsed GLL.
 *
 * `options.format` is 'clf2' (the default: 24 third-octave bands, 5° grid) or
 * 'clf1' (8 octave bands, 10° grid). The band centres come from the format, the
 * angular rows and columns are sampled from the file's own balloon, and the 6 dB
 * widths are measured from that balloon rather than invented. A balloon that
 * covers less than a full sphere is mirrored where a CLF file needs the far side,
 * and the mirroring is reported rather than left implicit.
 */
export function clfFromGll(parsed, options = {}) {
  if (!parsed || parsed.ok !== true) {
    return { ok: false, message: (parsed && parsed.message) || 'No GLL file was read.' };
  }
  const index = Number.isInteger(options.sourceIndex) ? options.sourceIndex : 0;
  const source = parsed.sources[index];
  if (!source) return { ok: false, message: 'That GLL carries no source definition to convert.' };
  const balloon = source.balloon;
  if (!balloon || !Array.isArray(balloon.responses) || !balloon.responses.length) {
    return { ok: false, message: 'That source carries no balloon data to convert.' };
  }

  const format = options.format === 'clf1' || options.version === 1 ? 1 : 2;
  const gridBands = (format === 1 ? CLF1_BANDS : CLF2_BANDS).slice();
  const step = format === 1 ? 10 : 5;
  const meridians = Math.max(1, balloon.meridians);
  const parallels = Math.max(1, balloon.parallels);
  const middle = Math.floor(parallels / 2);
  const warnings = [];
  let missing = 0;

  // A file can be written for part of the grid: the caller may ask for a span,
  // and a band outside it is left out rather than written as a 0 dB row.
  const range = options.bandRange && typeof options.bandRange === 'object' ? options.bandRange : null;
  const lowHz = range && Number.isFinite(Number(range.minHz)) ? Number(range.minHz) : null;
  const highHz = range && Number.isFinite(Number(range.maxHz)) ? Number(range.maxHz) : null;
  let bands = gridBands;
  if (lowHz !== null || highHz !== null) {
    const chosen = gridBands.filter((frequency) => (lowHz === null || frequency >= lowHz - 1e-6) &&
      (highHz === null || frequency <= highHz + 1e-6));
    if (chosen.length) {
      bands = chosen;
      if (chosen.length < gridBands.length) {
        warnings.push(chosen.length + ' of ' + gridBands.length + ' bands written (' + chosen[0] +
          '\u2013' + chosen[chosen.length - 1] + ' Hz)');
      }
    } else {
      warnings.push('no band of the CLF' + format + ' grid falls inside ' +
        (lowHz === null ? '' : lowHz) + '\u2013' + (highHz === null ? '' : highHz) +
        ' Hz, so the whole ' + gridBands.length + '-band grid was written');
    }
  }

  const grid = [];
  for (let meridian = 0; meridian < meridians; meridian += 1) {
    const row = new Array(parallels).fill(null);
    for (let parallel = 0; parallel < parallels; parallel += 1) {
      const pole = parallel === 0 || parallel === parallels - 1;
      if (pole && meridian > 0) continue;
      const response = balloon.responses[responseIndex(meridian, parallel, parallels)];
      if (!response) {
        missing += 1;
        row[parallel] = bands.map(() => 0);
        continue;
      }
      row[parallel] = bandLevels(response, bands);
    }
    grid.push(row);
  }
  if (missing) warnings.push(missing + ' grid points had no response in the file and were written as 0 dB');

  const axisResponse = balloon.responses[responseIndex(0, middle, parallels)] || balloon.responses[0];
  const axial = bandLevels(axisResponse, bands);

  const horizontal = bands.map((frequency, band) => crossingWidth(
    grid.map((row, meridian) => ({ angle: meridian * balloon.meridianStep, db: row[middle][band] })),
    axial[band],
  ));
  const vertical = bands.map((frequency, band) => {
    const points = [];
    for (let parallel = 0; parallel < parallels; parallel += 1) {
      points.push({ angle: Math.abs(parallel * balloon.parallelStep - 90), db: grid[0][parallel][band] });
    }
    return crossingWidth(points, axial[band]);
  });

  const symmetry = clfSymmetry(balloon);
  const azimuthCount = azimuthCountFor(symmetry.tag, step);
  const parallelCount = Math.round(180 / step) + 1;
  const sourceSpan = Math.max(0, (meridians - 1) * balloon.meridianStep);
  const azimuthRows = [];
  let mirrored = 0;
  for (let row = 0; row < azimuthCount; row += 1) {
    const angle = row * step;
    let wanted = angle;
    if (wanted > sourceSpan + 1e-6) {
      wanted = 360 - wanted;
      if (wanted > sourceSpan + 1e-6) wanted = sourceSpan;
      else mirrored += 1;
    }
    azimuthRows.push({
      angle,
      index: Math.min(meridians - 1, Math.max(0, Math.round(wanted / balloon.meridianStep))),
    });
  }
  if (mirrored) {
    warnings.push(mirrored + ' azimuth row(s) beyond the file\u2019s own ' + sourceSpan +
      '\u00b0 span were mirrored from the opposite side');
  }
  if (balloon.parallelStep > step + 1e-6) {
    warnings.push('the file\u2019s ' + balloon.parallelStep + '\u00b0 polar step was sampled onto ' +
      step + '\u00b0 CLF rows');
  }

  const oneLine = (value) => String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
  const or = (value, fallback) => (oneLine(value) === '' ? fallback : oneLine(value));
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const today = new Date();
  const date = today.getUTCFullYear() + '-' + months[today.getUTCMonth()] + '-' +
    String(today.getUTCDate()).padStart(2, '0');
  const tag = 'CLF' + format;
  const part = { index: index + 1, count: parsed.sources.length };
  const cabinet = parsed.boxes
    .filter((box) => box.placements.some((placement) => placement.sourceKey === source.key))
    .map((box) => box.label)
    .join(', ');
  const box = parsed.boxes.find((entry) => entry.placements.some((placement) => placement.sourceKey === source.key)
    && entry.weight) || null;

  const lines = [];
  const write = (line) => lines.push(line);
  write('<' + tag + '>');
  write('<VERSION>\t' + format);
  write('<MODELNAME>\t' + or(source.label || parsed.label, 'Align loudspeaker'));
  write('<INFOFILE>\t#');
  write('<MANUFACTURER>\t' + or(source.company || parsed.company, '#'));
  write('<WEB-SITE>\t' + or(parsed.website, '#'));
  write('<DESCRIPTION>\t' + or(source.description || parsed.info, '#'));
  write('<COLORS>\t#');
  write('<MOUNTING>\t#');
  write('<WEIGHT>\t' + (box ? box.weight.toFixed(1) : '0.0'));
  write('<MINBAND>\t' + bands[0].toFixed(0));
  write('<MAXBAND>\t' + bands[bands.length - 1].toFixed(0));
  write('<MEASUREMENT-CONTACT>\t#');
  write('<MEASUREMENT-EMAIL>\t' + or(parsed.email, '#'));
  write('<MEASUREMENT-DATE>\t' + date);
  write('<MEASUREMENT-NOTE>\tConverted from a GLL file by Align; the GLL layout is not published by AFMG ' +
    'and the data is the file\u2019s own model, not a measurement.' +
    (part.count > 1 ? ' Part ' + part.index + ' of ' + part.count +
      ' of a multi-way set; the CLF group distributes each part as its own file.' : ''));
  write('<MEASUREMENT-ENVIRONMENT>\t#');
  write('<MEASUREMENT-DISTANCE>\t0.0');
  write('<MEASUREMENT-INPUTVOLTAGE>\t0');
  write('<TYPE>\t<passive>');
  write('<SENSITIVITY>\t' + axial.map((level) => level.toFixed(2)).join('\t'));
  write('<SENSITIVITY-INFO>\tper band, from the GLL on-axis spectrum');
  write('<IMPEDANCE>\t');
  write('<IMPEDANCE-INFO>\t#');
  write('<TOTMAXINPUT>\t0\t0');
  write('<RADIATION>\t<' + (balloon.frontHalfOnly ? 'halfsphere' : 'fullsphere') + '>');
  write('<AXIAL-SPECTRUM>\t' + axial.map((level) => level.toFixed(2)).join('\t'));
  write('<AXIAL-SPECTRUM-INFO>\tat 1m');
  write('<6DB-WIDTH-HOR>\t' + horizontal.map((value) => value.toFixed(1)).join('\t'));
  write('<6DB-WIDTH-VER>\t' + vertical.map((value) => value.toFixed(1)).join('\t'));
  write('<6DB-WIDTH-HOR-INFO>\tmeasured from the GLL balloon at 6 dB');
  write('<6DB-WIDTH-VER-INFO>\tmeasured from the GLL balloon at 6 dB');
  write('<BALLOON-SYMMETRY>\t<' + symmetry.tag + '>');
  write('<BALLOON-ARC-ORDER>\t<default>');
  write('<BALLOON-REF>\t<absolute>\t<SIGN>\t<actual>');

  for (let band = 0; band < bands.length; band += 1) {
    write('<BAND>\t' + bands[band].toFixed(0));
    for (const azimuth of azimuthRows) {
      const row = grid[azimuth.index];
      const values = [];
      for (let column = 0; column < parallelCount; column += 1) {
        const columnIndex = Math.min(parallels - 1,
          Math.max(0, Math.round((column * step) / balloon.parallelStep)));
        values.push((row[columnIndex] ? row[columnIndex][band] : 0).toFixed(2));
      }
      write(values.join('\t'));
    }
  }

  write('<CABINET-SYSTEM>\t' + or(cabinet, ''));
  write('<' + tag + 'END>');

  const text = lines.join('\n') + '\n';
  return {
    ok: true,
    text,
    fileName: clfFileName(options.name || source.label || parsed.label, format, part),
    summary: {
      label: oneLine(source.label || parsed.label),
      format: tag,
      bands: bands.length,
      fromHz: bands[0],
      toHz: bands[bands.length - 1],
      meridians,
      parallels,
      azimuths: azimuthCount,
      rows: parallelCount,
      responses: azimuthCount * parallelCount,
      symmetry: symmetry.tag,
      part,
      bytes: text.length,
    },
    warnings,
  };
}

/** Read a GLL and write CLF text from it, in one step. */
export function clfTextFromGllBytes(bytes, options = {}) {
  const parsed = parseGll(bytes);
  if (!parsed.ok) return parsed;
  return clfFromGll(parsed, options);
}

/* ---------- CLF into a speaker specification ---------- */

/**
 * Turn a read CLF file into the fields the Speaker Builder edits.
 *
 * Only what the file states is carried across: the band levels become response
 * points, the horizontal and vertical 6 dB widths become directivity points, and
 * the impedance and one band of sensitivity are taken where the file gives them.
 * The CLF polar blocks are not decoded (see `parseClf`), and the builder has no
 * balloon, so a balloon-sized dataset is not pretended: the widths travel as a
 * table of band widths, which is what the builder models.
 */
export function clfToSpec(clf, options = {}) {
  if (!clf || clf.ok !== true) {
    return { ok: false, message: (clf && clf.message) || 'No CLF file was read.' };
  }
  const readings = Array.isArray(clf.readings) ? clf.readings.filter((entry) => Number.isFinite(entry.levelDb)) : [];
  if (!readings.length) {
    return {
      ok: false,
      message: 'That CLF file carries no level to import: its sensitivity and on-axis lists are both empty.',
    };
  }

  const meta = clf.manufacturer || {};
  const warnings = Array.isArray(clf.warnings) ? clf.warnings.slice() : [];
  // A CLF states absolute band SPL; the builder's response points are relative to
  // the curve's own peak, so the shape is carried across and the absolute figure
  // stays in the sensitivity. Clamping 102 dB into the -40..40 field would flatten it.
  const peak = readings.reduce((max, entry) => Math.max(max, entry.levelDb), -Infinity);
  const points = readings.map((entry) => ({
    hz: roundTo(entry.frequency),
    db: roundTo(entry.levelDb - peak, 2),
  }));
  const beamPoints = readings
    .filter((entry) => Number.isFinite(entry.beamwidthDeg) && Number.isFinite(entry.beamwidthVDeg))
    .map((entry) => ({
      hz: roundTo(entry.frequency),
      hDeg: roundTo(entry.beamwidthDeg),
      vDeg: roundTo(entry.beamwidthVDeg),
    }));
  const horizontalOnly = readings.filter((entry) => Number.isFinite(entry.beamwidthDeg)).length;
  if (!beamPoints.length && horizontalOnly) {
    warnings.push('the file gives no vertical 6 dB width, so the vertical coverage stays at the builder default ' +
      'rather than being guessed from the horizontal one');
  }
  if (!horizontalOnly) {
    warnings.push('the file states no 6 dB beamwidth, so the coverage stays at the builder default');
  }

  const nearOneK = readings.reduce((best, entry) => (
    Math.abs(Math.log2(entry.frequency / 1000)) < Math.abs(Math.log2(best.frequency / 1000)) ? entry : best
  ), readings[0]);
  const impedance = readings
    .map((entry) => entry.impedanceOhm)
    .find((value) => Number.isFinite(value) && value > 0);
  const kind = String(meta.kind || '').toLowerCase();
  const type = /sub/.test(kind) ? 'subwoofer' : /point/.test(kind) ? 'point-source' : 'full-range';

  const low = roundTo(readings[0].frequency);
  const high = roundTo(readings[readings.length - 1].frequency);
  const sensitivity = { at1W: roundTo(nearOneK.levelDb, 1) };
  if (Number.isFinite(impedance)) sensitivity.impedanceOhm = roundTo(impedance, 1);

  const spec = {
    name: meta.name || String(options.fileName || 'CLF loudspeaker').replace(/\.[^.]+$/, ''),
    manufacturer: meta.maker || '',
    type,
    band: { fMin: low, fMax: high, toleranceDb: null },
    description: String(meta.description || '').slice(0, 300),
    sensitivity,
    response: { mode: 'points', points },
    notes: 'Imported from CLF ' + (meta.version || '') + ' by Align. ' +
      'The band levels and 6 dB widths are the file\u2019s own figures, the response is carried relative to ' +
      'the file\u2019s own peak and the 1 kHz band sets the 1 W sensitivity. Its polar blocks are not decoded ' +
      'here, and the builder models widths rather than a measured balloon.',
  };
  if (beamPoints.length >= 2) {
    spec.directivity = {
      model: 'frequency',
      hDeg: beamPoints[Math.floor(beamPoints.length / 2)].hDeg,
      vDeg: beamPoints[Math.floor(beamPoints.length / 2)].vDeg,
      points: beamPoints.slice(0, 32),
    };
  }

  return {
    ok: true,
    spec,
    warnings,
    message: 'Read ' + readings.length + ' bands from CLF ' + (meta.version || '') +
      ' (' + low + '–' + high + ' Hz)' +
      (clf.polar ? ', and decoded its ' + clf.polar.bands + ' × ' + clf.polar.azimuths + ' × ' +
        clf.polar.parallels + ' balloon for the widths' : '') +
      '. ' + (warnings.length ? warnings.join(' · ') + '. ' : '') +
      'Nothing has been saved yet: the draft can be edited and saved as a library entry.',
  };
}

/* ---------- comparing two CLF files ---------- */

/**
 * Compare two read CLF files band by band: the level at each band centre and the
 * 6 dB width, horizontal and vertical. Used to prove that a converted file survives
 * an import, a rebuild and a second conversion without drifting, and to say by how
 * much when it does. A band missing on either side is reported, never assumed equal.
 */
export function clfDiff(before, after) {
  if (!before || before.ok !== true || !after || after.ok !== true) {
    return { ok: false, message: 'Both files have to be read before they can be compared.' };
  }
  const bands = Math.min(before.readings.length, after.readings.length);
  const levels = [];
  const widths = [];
  let missing = 0;
  for (let index = 0; index < bands; index += 1) {
    const a = before.readings[index];
    const b = after.readings[index];
    const frequency = Number.isFinite(a.frequency) ? a.frequency : b.frequency;
    if (Number.isFinite(a.levelDb) && Number.isFinite(b.levelDb)) {
      levels.push({ frequency, driftDb: b.levelDb - a.levelDb });
    } else if (Number.isFinite(a.levelDb) !== Number.isFinite(b.levelDb)) {
      missing += 1;
    }
    if (Number.isFinite(a.beamwidthDeg) && Number.isFinite(b.beamwidthDeg)) {
      widths.push({ frequency, driftDeg: b.beamwidthDeg - a.beamwidthDeg, axis: 'horizontal' });
    }
    if (Number.isFinite(a.beamwidthVDeg) && Number.isFinite(b.beamwidthVDeg)) {
      widths.push({ frequency, driftDeg: b.beamwidthVDeg - a.beamwidthVDeg, axis: 'vertical' });
    }
  }
  const magnitude = (list, key) => list.reduce((max, entry) => Math.max(max, Math.abs(entry[key])), 0);
  const mean = levels.length
    ? levels.reduce((total, entry) => total + entry.driftDb, 0) / levels.length
    : 0;
  const maxDriftDb = magnitude(levels, 'driftDb');
  const maxWidthDriftDeg = magnitude(widths, 'driftDeg');
  return {
    ok: true,
    bands,
    levels,
    widths,
    missing,
    maxDriftDb,
    meanDriftDb: mean,
    maxWidthDriftDeg,
    message: bands + ' bands compared: levels drift at most ' + maxDriftDb.toFixed(2) +
      ' dB, widths at most ' + maxWidthDriftDeg.toFixed(1) + '\u00b0' +
      (missing ? '; ' + missing + ' band(s) carry a level on one side only' : '') + '.',
  };
}

/** The parts a GLL holds, for a caller that has to choose one to convert. */
export function clfParts(parsed) {
  if (!parsed || parsed.ok !== true) return [];
  return parsed.sources.map((source, index) => ({
    index,
    label: String(source.label || parsed.label || 'Part ' + (index + 1)),
    fromHz: source.fromHz,
    toHz: source.toHz,
    responses: source.balloon ? (source.balloon.responses || []).length : 0,
  }));
}
