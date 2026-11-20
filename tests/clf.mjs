/*
 * The GLL → CLF2 converter and the CLF importer, run with Node:
 *
 *   node tests/clf.mjs
 *
 * The GLL side is checked by reading back the file `gll.js` writes, then the CLF
 * it converts to is read by the *other* reader in clf.js — `parseClf`, the same
 * function the Data Modeler's import uses — so the two directions cannot agree
 * with themselves by sharing a bug. CLF2 is a fixed 24-band text grid, so the
 * suite checks the counts the format itself dictates (24 bands, 37 × 37 rows for
 * a 5° left/right-symmetric balloon) rather than the GLL's own 26 bands.
 *
 * The writer's layout follows the MIT-licensed gll-tools CLF writer; no AFMG
 * tooling is involved in either direction, and nothing here proves EASE or a
 * manufacturer tool opens the result.
 */

import {
  CLF2_BANDS,
  clfFromGll,
  clfTextFromGllBytes,
  clfToSpec,
  parseClf,
  parseGll,
} from '../js/modeler/clf.js';
import { createGllFromSpec } from '../js/modeler/gll.js';
import { normalizeSpec, pioneerExample } from '../js/modeler/speaker-builder.js';

let passed = 0;
let failed = 0;

function report(name, pass, detail) {
  if (pass) passed += 1;
  else failed += 1;
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + ' — ' + (detail === undefined ? '' : detail));
}

/* ---------- the GLL side ---------- */

const example = normalizeSpec(pioneerExample());
const built = createGllFromSpec(example, { name: example.name });

report('the GLL writer produces a file to convert', built.ok === true,
  built.ok ? built.bytes.length + ' bytes' : built.message);

const parsed = parseGll(built.ok ? built.bytes : new Uint8Array());
report('Align reads back its own GLL', parsed.ok === true,
  parsed.ok ? 'version ' + parsed.version : parsed.message);
if (parsed.ok) {
  report('the label, key and company come from the file',
    parsed.label === example.name && /^align-/.test(parsed.key) && parsed.company === example.manufacturer,
    parsed.label + ' · ' + parsed.key);

  const source = parsed.sources[0];
  report('one source definition is read', parsed.sources.length === 1 && !!source,
    parsed.sources.length + ' sources');
  report('the source carries its balloon', !!source && !!source.balloon &&
    source.balloon.responses.length === 1297, source && source.balloon ? source.balloon.responses.length : 'none');
  report('the balloon is left/right symmetric on a 5° grid',
    !!source && source.balloon.symmetry === 2 && source.balloon.meridianStep === 5 &&
      source.balloon.parallelStep === 5 && source.balloon.meridians === 37 && source.balloon.parallels === 37,
    source && source.balloon ? source.balloon.meridians + ' × ' + source.balloon.parallels : 'no balloon');
  report('the cabinet in the file points at that source',
    parsed.boxes.length === 1 && parsed.boxes[0].placements.some((entry) => entry.sourceKey === source.key),
    parsed.boxes.length + ' cabinet(s)');

  report('a file that is not a GLL is refused',
    parseGll(new TextEncoder().encode('this is not a gll file at all'))?.ok === false,
    parseGll(new TextEncoder().encode('not a gll')).message);
  report('a truncated GLL is refused rather than half-read',
    parseGll(built.bytes.subarray(0, 200)).ok === false,
    parseGll(built.bytes.subarray(0, 200)).message);
}

/* ---------- the CLF2 file it writes ---------- */

const converted = clfFromGll(parsed);
report('a parsed GLL converts to CLF2', converted.ok === true,
  converted.ok ? converted.text.length + ' characters' : converted.message);

if (converted.ok) {
  const lines = converted.text.split('\n');
  const keyed = new Map();
  for (const line of lines) {
    const match = line.match(/^<([A-Z0-9-]+)>\t?(.*)$/);
    if (match && !keyed.has(match[1])) keyed.set(match[1], match[2]);
  }

  const bandBlocks = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('<BAND>\t')) {
      current = [];
      bandBlocks.push(current);
      continue;
    }
    if (current && /^[-0-9.\t]+$/.test(line) && line.trim() !== '') current.push(line.split('\t'));
    else current = null;
  }

  report('the file is tagged CLF2 and states its version', lines[0] === '<CLF2>' && keyed.get('VERSION') === '2',
    lines[0] + ' / VERSION ' + keyed.get('VERSION'));
  report('the band limits are the CLF2 grid', keyed.get('MINBAND') === '100' && keyed.get('MAXBAND') === '20000',
    keyed.get('MINBAND') + '–' + keyed.get('MAXBAND') + ' Hz');
  report('there are exactly 24 third-octave band blocks', bandBlocks.length === CLF2_BANDS.length,
    bandBlocks.length + ' bands');
  report('every band holds 37 azimuth rows of 37 values',
    bandBlocks.length === 24 && bandBlocks.every((rows) => rows.length === 37 &&
      rows.every((row) => row.length === 37)),
    bandBlocks.length ? bandBlocks[0].length + ' rows × ' + bandBlocks[0][0].length + ' values' : 'no rows');
  report('the symmetry tag and radiation are the file’s own',
    keyed.get('BALLOON-SYMMETRY') === '<vertical>' && keyed.get('RADIATION') === '<fullsphere>',
    keyed.get('BALLOON-SYMMETRY') + ' · ' + keyed.get('RADIATION'));

  const sensitivity = (keyed.get('SENSITIVITY') || '').split('\t');
  const widths = (keyed.get('6DB-WIDTH-HOR') || '').split('\t').map(Number);
  const widthsV = (keyed.get('6DB-WIDTH-VER') || '').split('\t').map(Number);
  report('the per-band sensitivity and on-axis spectrum are the same 24 values',
    sensitivity.length === 24 && keyed.get('AXIAL-SPECTRUM') === keyed.get('SENSITIVITY'),
    sensitivity.length + ' values');
  report('the 6 dB widths are measured from the balloon, in the 5–360° range',
    widths.length === 24 && widthsV.length === 24 &&
      widths.every((value) => value >= 5 && value <= 360) &&
      widthsV.every((value) => value >= 5 && value <= 360) &&
      widths.some((value) => value < 360),
    widths.slice(0, 3).map((value) => value.toFixed(0) + '°').join(', ') + ' …');
  report('the conversion reports the counts it wrote',
    converted.summary.bands === 24 && converted.summary.responses === 1369 &&
      converted.summary.symmetry === 'vertical',
    converted.summary.bands + ' bands, ' + converted.summary.responses + ' grid points');
  report('the file name is a slug with the CLF extension', /^[a-z0-9-]+\.cf2$/.test(converted.fileName),
    converted.fileName);

  /* ---------- and back through the importer ---------- */

  const roundTrip = parseClf(converted.text, converted.fileName);
  report('the converted file is read by the CLF importer', roundTrip.ok === true, roundTrip.message);
  if (roundTrip.ok) {
    report('the importer sees a CLF2 third-octave file',
      roundTrip.manufacturer.thirdOctave === true && roundTrip.manufacturer.version === '2',
      'version ' + roundTrip.manufacturer.version);
    report('the importer reads 24 bands of level',
      roundTrip.readings.length === 24 && roundTrip.readings.every((entry) => Number.isFinite(entry.levelDb)),
      roundTrip.readings.length + ' readings');
    report('the importer carries the widths the converter measured',
      roundTrip.readings.every((entry, index) => Math.abs(entry.beamwidthDeg - widths[index]) < 0.05 &&
        Math.abs(entry.beamwidthVDeg - widthsV[index]) < 0.05),
      roundTrip.readings[0].beamwidthDeg + '° / ' + roundTrip.readings[0].beamwidthVDeg + '°');
    report('the level at each band is the file’s value',
      Math.abs(roundTrip.readings[10].levelDb - Number(sensitivity[10])) < 0.01,
      roundTrip.readings[10].levelDb + ' dB at 1 kHz');
  }

  /* ---------- and into a builder specification ---------- */

  const imported = clfToSpec(roundTrip, { fileName: converted.fileName });
  report('the CLF becomes a builder specification', imported.ok === true,
    imported.ok ? imported.spec.name : imported.message);
  if (imported.ok) {
    const spec = normalizeSpec(imported.spec);
    report('the specification is a normalised speaker', !!spec && spec.sections.length === 1 &&
      /\.cf2$/.test(imported.spec.name) === false, spec ? spec.name : 'no spec');
    report('its band is the CLF2 grid', spec.band.fMin === 100 && spec.band.fMax === 20000,
      spec.band.fMin + '–' + spec.band.fMax + ' Hz');
    const peakLevel = Math.max(...sensitivity.map(Number));
    report('its response carries the 24 band levels relative to the file’s peak',
      spec.response.mode === 'points' && spec.response.points.length === 24 &&
        Math.abs(spec.response.points[10].db - (Number(sensitivity[10]) - peakLevel)) < 0.02 &&
        spec.response.points.every((point) => point.db <= 0.01 && point.db >= -40),
      spec.response.points.length + ' points, peak ' + peakLevel + ' dB absolute');
    report('its directivity is the 24 measured widths',
      spec.directivity.model === 'frequency' && spec.directivity.points.length === 24 &&
        spec.directivity.points.every((point) => point.hDeg >= 5 && point.vDeg >= 5 &&
          point.hDeg <= 360 && point.vDeg <= 360),
      spec.directivity.points.length + ' width points');
    report('its sensitivity comes from the nearest band to 1 kHz',
      Math.abs(spec.sensitivity.at1W - Number(sensitivity[10])) < 0.06,
      spec.sensitivity.at1W + ' dB');
    report('the manufacturer and description come from the file',
      spec.manufacturer === example.manufacturer && spec.description.length > 0,
      spec.manufacturer);
  }
}

/* ---------- the honest refusals ---------- */

report('a GLL that was never read is not converted',
  clfFromGll({ ok: false, message: 'nope' }).ok === false && clfFromGll(null).ok === false,
  clfFromGll(null).message);

const horizontalOnly = parseClf([
  '<CLF2>',
  '<VERSION>\t2',
  '<MODELNAME>\tHorizontal only',
  '<MANUFACTURER>\tTest',
  '<MINBAND>\t100',
  '<MAXBAND>\t1000',
  '<SENSITIVITY>\t90\t91\t92',
  '<6DB-WIDTH-HOR>\t90\t80\t70',
  '<CLF2END>',
].join('\n'), 'horizontal.cf2');
const horizontalSpec = clfToSpec(horizontalOnly, { fileName: 'horizontal.cf2' });
report('a CLF with horizontal widths only leaves the vertical width unguessed',
  horizontalSpec.ok === true && !horizontalSpec.spec.directivity &&
    horizontalSpec.warnings.some((line) => /vertical/.test(line)),
  horizontalSpec.ok ? horizontalSpec.warnings[0] : horizontalSpec.message);

const noLevels = parseClf('<CLF1>\n<MINBAND>\t125\n<MAXBAND>\t4000\n', 'empty.cf1');
report('a CLF with no level is not turned into a specification',
  noLevels.ok === true && clfToSpec(noLevels).ok === false, clfToSpec(noLevels).message);

report('a text file that is not a CLF is still refused',
  parseClf('100 0\n200 0\n400 0', 'not-a-clf.txt').ok === false, 'refused');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
