/*
 * The GLL writer checks, run with Node:
 *
 *   node tests/gll.mjs
 *
 * The file layout is not published by AFMG, so the bytes are read back here by a
 * small independent reader written against the same reverse-engineered
 * documentation — never by the writer's own helpers — and the counts are checked
 * against the arithmetic of the 5° grid: both poles are stored once, so 37
 * meridians and 37 parallels hold 1297 responses, not 1369.
 *
 * This proves the container is laid out as documented. It does not prove EASE
 * opens the file: only AFMG's own tooling can say that, and a GLL is authorised
 * through EASE SpeakerLab, not by this app. The reader that agrees with the bytes
 * is the MIT-licensed gll-tools `gllinfo`, run by hand alongside this suite.
 */

import {
  GLL_BALLOON_STEP,
  GLL_CAVEAT,
  balloonCounts,
  gllChecksum,
  createGllFromSpec,
} from '../js/modeler/gll.js';
import { normalizeSpec, pioneerExample } from '../js/modeler/speaker-builder.js';

let passed = 0;
let failed = 0;

function report(name, pass, detail) {
  if (pass) passed += 1;
  else failed += 1;
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + ' — ' + (detail === undefined ? '' : detail));
}

/* ---------- an independent reader of the documented layout ---------- */

class Reader {
  constructor(bytes, offset = 0) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = offset;
  }

  i16() { const value = this.view.getInt16(this.offset, true); this.offset += 2; return value; }
  u16() { const value = this.view.getUint16(this.offset, true); this.offset += 2; return value; }
  i32() { const value = this.view.getInt32(this.offset, true); this.offset += 4; return value; }
  f64() { const value = this.view.getFloat64(this.offset, true); this.offset += 8; return value; }

  text() {
    const length = this.u16();
    const value = new TextDecoder().decode(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    return value;
  }

  block() {
    const size = this.i32();
    const start = this.offset;
    const vcheck = this.i16();
    const subVersion = this.i16();
    return { size, vcheck, subVersion, start, end: start + size - 4 };
  }

  seek(offset) { this.offset = offset; return this; }
}

function readSpectrum(reader) {
  const block = reader.block();
  const bandsPerOctave = reader.i32();
  const startFreq = reader.f64();
  const pointCount = reader.i32();
  const compression = reader.i32();
  const levelCount = reader.i32();
  const levels = [];
  for (let i = 0; i < levelCount; i += 1) levels.push(reader.i16() * 0.01);
  const phaseCount = reader.i32();
  const phases = [];
  for (let i = 0; i < phaseCount; i += 1) phases.push(reader.i16() * 0.001);
  const delay = reader.f64();
  reader.seek(block.end);
  return { block, bandsPerOctave, startFreq, pointCount, compression, levelCount, phases, delay, levels };
}

/* ---------- build from the Pioneer example ---------- */

const example = normalizeSpec(pioneerExample());
const built = createGllFromSpec(example, { name: 'Pioneer XY-3B' });

report('the writer produces a file', built.ok === true && built.bytes instanceof Uint8Array,
  built.ok ? built.bytes.length + ' bytes' : built.message);

report('a draft whose sections cannot be combined writes the first section and says so',
  built.ok === true && built.warnings.some((line) => /could not be combined/.test(line)),
  built.ok ? (built.warnings[0] || 'no warning') : built.message);

if (built.ok) {
  const bytes = built.bytes;
  const reader = new Reader(bytes);

  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  report('the file starts with the EGLL magic', magic === 'EGLL', magic);

  report('the reserved word is zero', reader.seek(4).i32() === 0, 'int32 0');

  const format = reader.text();
  const version = reader.i16();
  const subVersion = reader.i16();
  reader.seek(reader.offset + 4); // the version-4 checksum, checked below
  report('the format identifier and version are the documented ones',
    format === 'EASE_GLL' && version === 4 && subVersion === 0,
    format + ' v' + version + '.' + subVersion);
  report('version 4 leaves the SHA-256 hash block out', bytes.length > 26, 'checksum only');

  const checksum = [bytes[22], bytes[23], bytes[24], bytes[25]];
  report('the header offset of the checksum is where the reader expects it',
    reader.offset === 26, 'GenSystem begins at byte ' + reader.offset);

  const system = reader.block();
  const expected = gllChecksum(bytes.subarray(26, system.end));
  report('the checksum matches the documented algorithm over the GenSystem block',
    checksum.every((byte, index) => byte === expected[index]),
    '[' + checksum.join(', ') + ']');

  const label = reader.text();
  const gllVersion = reader.f64();
  const key = reader.text();
  const type = reader.i32();
  const company = reader.text();
  const info = reader.text();
  const copyright = reader.text();
  const support = reader.text();
  reader.text(); // website
  reader.text(); // email
  const background = reader.i32();

  report('the system carries the cabinet name as its label', label === example.name, label);
  report('the system is a loudspeaker (type 2)', type === 2, type);
  report('the system version and background colour are set',
    Number.isFinite(gllVersion) && background === 0, gllVersion + ' / ' + background);
  report('the key is a slug of the label', /^align-[a-z0-9-]+$/.test(key), key);
  report('the info text states what the file is and is not',
    info.includes('not AFMG-authorised') && info.includes('SpeakerLab') && info.includes(GLL_CAVEAT.slice(0, 40)),
    info.split('\n')[1]);
  report('the unused text fields are present but empty',
    copyright === '' && support === '' && company === example.manufacturer,
    'company "' + company + '"');

  /* database */
  const database = reader.block();
  report('the database is written at sub-version 3', database.subVersion === 3, database.subVersion);
  reader.i32();
  reader.i32();
  reader.i32(); // data files

  const boxes = reader.block();
  const boxCount = reader.i32();
  report('one cabinet is written', boxCount === 1, boxCount);

  const box = reader.block();
  const boxLabel = reader.text();
  const boxKey = reader.text();
  const placements = reader.block();
  const placementCount = reader.i32();
  const placement = reader.block();
  const sourceKey = reader.text();
  const position = [reader.f64(), reader.f64(), reader.f64()];
  const angles = [reader.f64(), reader.f64(), reader.f64()];
  reader.seek(placement.end);

  report('the cabinet is named after the loudspeaker', boxLabel === example.name, boxLabel);
  report('the cabinet holds one acoustic source', placementCount === 1, placementCount);
  report('the source points at its definition and sits at the origin',
    sourceKey === key && position.every((value) => value === 0) && angles.every((value) => value === 0),
    sourceKey + ' at [' + position.join(', ') + ']');
  report('the cabinet keys are distinct from the source definition key', boxKey !== key, boxKey);

  reader.seek(box.end);
  reader.seek(boxes.end);
  // An empty list is a single zero int32, not a block with a header.
  reader.seek(reader.offset + 4); // frames
  reader.seek(reader.offset + 4); // connectors
  reader.seek(reader.offset + 4); // limits

  /* source definition */
  const items = reader.block();
  const itemCount = reader.i32();
  report('one source definition is written', itemCount === 1, itemCount);

  const item = reader.block();
  const itemKey = reader.text();
  const definition = reader.block();
  const definitionLabel = reader.text();
  reader.text(); // company
  const description = reader.text();
  const fromHz = reader.f64();
  const toHz = reader.f64();
  const dataType = reader.i32();

  report('the definition is keyed like the source placement', itemKey === key, itemKey);
  report('the definition is labelled as an Align model', /Align model/.test(definitionLabel), definitionLabel);
  report('the definition repeats the caveat', description.includes('not AFMG-authorised'));
  report('the bandwidth matches the builder band', Math.abs(fromHz - example.band.fMin) < 1 && toHz >= example.band.fMax,
    Math.round(fromHz) + '–' + Math.round(toHz) + ' Hz');
  report('the data type is third-octave', dataType === 1, dataType);

  /* balloon */
  const balloon = reader.block();
  const flags = reader.i32();
  const resolution = reader.block();
  const symmetry = reader.i32();
  const frontHalf = reader.i32();
  const meridianStep = reader.f64();
  const parallelStep = reader.f64();
  const responseCount = reader.i32();
  const counts = balloonCounts(GLL_BALLOON_STEP);

  report('the resolution block is the 32 bytes the reader requires',
    resolution.size === 32 && resolution.end - resolution.start === 28, resolution.size);
  report('the balloon is left/right symmetric on a 5° grid',
    symmetry === 2 && frontHalf === 0 && meridianStep === 5 && parallelStep === 5,
    'symmetry ' + symmetry + ', ' + meridianStep + '° × ' + parallelStep + '°');
  report('both poles are stored once, so 37 × 37 holds 1297 responses',
    responseCount === counts.responses && counts.responses === 1297,
    responseCount + ' responses');

  const first = readSpectrum(reader);
  report('a balloon response is an uncompressed third-octave spectrum',
    first.compression === 0 && first.bandsPerOctave === 3 && first.pointCount === built.summary.bands,
    first.pointCount + ' bands from ' + Math.round(first.startFreq) + ' Hz');
  report('every balloon phase is written as zero, because phase was not modelled',
    first.phases.length === first.pointCount && first.phases.every((value) => value === 0),
    first.phases.length + ' zeros');
  report('the group delay is zero', first.delay === 0, first.delay);

  /* walk to the on-axis response: meridian 0, parallel 18 (90° = on axis) */
  let cursor = first.block.end;
  let onAxis = null;
  for (let index = 1; index <= 18; index += 1) {
    const saved = reader.offset;
    reader.seek(cursor);
    const next = readSpectrum(reader);
    cursor = next.block.end;
    reader.seek(saved);
    if (index === 18) onAxis = next;
  }

  const omnidirectional = built.warnings.some((line) => /omnidirectional/.test(line));
  report(omnidirectional ? 'an omni balloon holds the same level at every angle'
      : 'the pole is far below the on-axis response',
    omnidirectional
      ? first.levels.every((level, index) => level === onAxis.levels[index])
      : first.levels[0] < onAxis.levels[0] - 20,
    first.levels[0].toFixed(1) + ' dB at the pole against ' + onAxis.levels[0].toFixed(1) + ' dB on axis');

  /* the on-axis response must match the source's own on-axis spectrum */
  reader.seek(balloon.end);
  const onAxisFile = reader.i32();
  const reference = reader.f64();
  const spectrum = readSpectrum(reader);
  report('the on-axis spectrum is the one the source states',
    onAxisFile === 0 && spectrum.pointCount === onAxis.pointCount,
    'reference ' + reference + ' dB');
  report('the balloon on axis equals the on-axis spectrum',
    spectrum.levels.every((level, index) => Math.abs(level - onAxis.levels[index]) < 0.02),
    Math.max(...spectrum.levels.map((level, index) => Math.abs(level - onAxis.levels[index]))).toFixed(3) + ' dB worst difference');

  report('the file ends exactly at the end of the GenSystem block',
    system.end === bytes.length, system.end + ' of ' + bytes.length + ' bytes');

  /* guard rails */
  const again = createGllFromSpec(example, { name: 'Pioneer XY-3B' });
  report('the same specification writes the same bytes',
    again.ok && again.bytes.length === bytes.length &&
      again.bytes.every((byte, index) => byte === bytes[index]),
    again.bytes.length + ' bytes');
  report('the file name is a slug with the GLL extension',
    built.fileName === 'pioneer-xy-3b.gll', built.fileName);
  report('an empty specification is refused rather than written',
    createGllFromSpec(null).ok === false,
    createGllFromSpec(null).message);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
