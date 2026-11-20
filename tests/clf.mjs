/*
 * The GLL → CLF converter (CLF2 and CLF1) and the CLF importer, run with Node:
 *
 *   node tests/clf.mjs
 *
 * The GLL side is checked by reading back the file `gll.js` writes, then the CLF
 * it converts to is read by the *other* reader in clf.js — `parseClf`, the same
 * function the Data Modeler's import uses — so the two directions cannot agree
 * with themselves by sharing a bug. The counts are the ones the format dictates
 * (CLF2: 24 third-octave bands on a 5° grid, CLF1: 8 octave bands on a 10° grid,
 * and 37 or 19 azimuth rows for a left/right-symmetric balloon).
 *
 * The polar <BAND> section is decoded by the reader, so the widths the importer
 * uses can come from the levels themselves when a file states no width keys.
 *
 * There is no third-party CLF reader that can be run here: the CLF Group's viewer
 * and authoring kit are the only real readers and are Windows binaries behind
 * registration, and no package on npm, PyPI or crates.io implements the loudspeaker
 * CLF format (the "clf-parser" crate is a colour-LUT format). The strongest check
 * available is therefore a conformance pass written from the published format rules
 * alone, below: no shared code with the reader or the writer, so a rule broken in
 * common cannot pass. It proves the text is well-formed according to the document;
 * it does not prove a vendor application accepts it.
 */

import {
  CLF1_BANDS,
  CLF2_BANDS,
  clfDiff,
  clfFromGll,
  clfParts,
  clfResponse,
  clfToSpec,
  parseClf,
  parseGll,
} from '../js/modeler/clf.js';
import { datasetBalloon, normalizeModel } from '../js/modeler/model.js';
import { balloonProjection } from '../js/modeler/builder-chart.js';
import { createGllFromSpec } from '../js/modeler/gll.js';
import { normalizeSpec, pioneerExample } from '../js/modeler/speaker-builder.js';

let passed = 0;
let failed = 0;

function report(name, pass, detail) {
  if (pass) passed += 1;
  else failed += 1;
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + ' — ' + (detail === undefined ? '' : detail));
}

/* ---------- helpers over a CLF text file ---------- */

function keyedFields(text) {
  const fields = new Map();
  for (const line of text.split('\n')) {
    const match = line.match(/^<([A-Z0-9-]+)>\t?(.*)$/);
    if (match && !fields.has(match[1])) fields.set(match[1], match[2]);
  }
  return fields;
}

function bandBlocks(text) {
  const blocks = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('<BAND>\t')) {
      current = [];
      blocks.push(current);
      continue;
    }
    if (current && /^[-0-9.\t]+$/.test(line) && line.trim() !== '') current.push(line.split('\t'));
    else current = null;
  }
  return blocks;
}

/* ---------- the GLL side ---------- */

const example = normalizeSpec(pioneerExample());
const built = createGllFromSpec(example, { name: example.name });

report('the GLL writer produces a file to convert', built.ok === true,
  built.ok ? built.bytes.length + ' bytes' : built.message);

const parsed = parseGll(built.ok ? built.bytes : new Uint8Array());
report('Align reads back its own GLL', parsed.ok === true,
  parsed.ok ? 'version ' + parsed.version : parsed.message);

report('a file that is not a GLL is refused',
  parseGll(new TextEncoder().encode('this is not a gll file at all')).ok === false,
  parseGll(new TextEncoder().encode('not a gll')).message);
report('a truncated GLL is refused rather than half-read',
  built.ok && parseGll(built.bytes.subarray(0, 200)).ok === false,
  built.ok ? parseGll(built.bytes.subarray(0, 200)).message : 'no file');

if (parsed.ok) {
  const source = parsed.sources[0];
  report('the source carries its 1297-response balloon', !!source && !!source.balloon &&
    source.balloon.responses.length === 1297,
    source && source.balloon ? source.balloon.responses.length + ' responses' : 'none');
  report('the balloon is left/right symmetric on a 5° grid',
    !!source && source.balloon.symmetry === 2 && source.balloon.meridianStep === 5 &&
      source.balloon.meridians === 37 && source.balloon.parallels === 37,
    source && source.balloon ? source.balloon.meridians + ' × ' + source.balloon.parallels : 'none');
  report('the cabinet in the file points at that source',
    parsed.boxes.length === 1 && parsed.boxes[0].placements.some((entry) => entry.sourceKey === source.key),
    parsed.boxes.length + ' cabinet(s)');
}

/* ---------- CLF2 ---------- */

const converted = clfFromGll(parsed);
report('a parsed GLL converts to CLF2', converted.ok === true,
  converted.ok ? converted.text.length + ' characters' : converted.message);

if (converted.ok) {
  const fields = keyedFields(converted.text);
  const blocks = bandBlocks(converted.text);

  report('the file is tagged CLF2 and states version 2',
    converted.text.split('\n')[0] === '<CLF2>' && fields.get('VERSION') === '2',
    fields.get('VERSION'));
  report('the band limits are the CLF2 grid', fields.get('MINBAND') === '100' && fields.get('MAXBAND') === '20000',
    fields.get('MINBAND') + '–' + fields.get('MAXBAND') + ' Hz');
  report('there are 24 third-octave band blocks', blocks.length === CLF2_BANDS.length, blocks.length + ' bands');
  report('every band holds 37 azimuth rows of 37 polar values',
    blocks.length === 24 && blocks.every((rows) => rows.length === 37 && rows.every((row) => row.length === 37)),
    blocks.length ? blocks[0].length + ' rows × ' + blocks[0][0].length + ' values' : 'none');
  report('the symmetry tag describes the rows written, and radiation is the file’s own',
    fields.get('BALLOON-SYMMETRY') === '<horizontal>' && fields.get('RADIATION') === '<fullsphere>',
    fields.get('BALLOON-SYMMETRY') + ' · ' + fields.get('RADIATION'));

  const sensitivity = (fields.get('SENSITIVITY') || '').split('\t');
  const widths = (fields.get('6DB-WIDTH-HOR') || '').split('\t').map(Number);
  const widthsV = (fields.get('6DB-WIDTH-VER') || '').split('\t').map(Number);
  report('sensitivity and on-axis spectrum are the same 24 values',
    sensitivity.length === 24 && fields.get('AXIAL-SPECTRUM') === fields.get('SENSITIVITY'),
    sensitivity.length + ' values');
  report('the 6 dB widths are measured from the balloon, in range',
    widths.length === 24 && widthsV.length === 24 &&
      widths.every((value) => value >= 5 && value <= 360) &&
      widthsV.every((value) => value >= 5 && value <= 360) && widths.some((value) => value < 360),
    widths.slice(0, 3).map((value) => value.toFixed(0) + '°').join(', ') + ' …');
  report('the summary reports the format and grid',
    converted.summary.format === 'CLF2' && converted.summary.bands === 24 &&
      converted.summary.azimuths === 37 && converted.summary.rows === 37 &&
      converted.summary.responses === 1369 && converted.summary.symmetry === 'horizontal',
    converted.summary.bands + ' bands, ' + converted.summary.azimuths + ' × ' + converted.summary.rows);
  report('the file name is a slug with the CLF2 extension', /^[a-z0-9-]+\.cf2$/.test(converted.fileName),
    converted.fileName);

  /* ---------- back through the importer ---------- */

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
    report('the importer decodes the polar section as written',
      !!roundTrip.polar && roundTrip.polar.bands === 24 && roundTrip.polar.azimuths === 37 &&
        roundTrip.polar.parallels === 37 && roundTrip.polar.span === 180 &&
        roundTrip.polar.azimuthStep === 5 && roundTrip.polar.polarStep === 5,
      roundTrip.polar ? roundTrip.polar.bands + ' × ' + roundTrip.polar.azimuths + ' × ' +
        roundTrip.polar.parallels : 'no balloon');
    report('the decoded balloon keeps the conjugate level it was written with',
      !!roundTrip.polar && Math.abs(roundTrip.polar.vertical[0].widthDeg - widthsV[0]) < 0.6,
      roundTrip.polar ? roundTrip.polar.vertical[0].widthDeg + '° from the balloon' : 'none');
  }

  /* ---------- and into a builder specification ---------- */

  const imported = clfToSpec(roundTrip, { fileName: converted.fileName });
  report('the CLF becomes a builder specification', imported.ok === true,
    imported.ok ? imported.spec.name : imported.message);
  if (imported.ok) {
    const spec = normalizeSpec(imported.spec);
    const peak = Math.max(...sensitivity.map(Number));
    report('its band is the CLF2 grid', spec.band.fMin === 100 && spec.band.fMax === 20000,
      spec.band.fMin + '–' + spec.band.fMax + ' Hz');
    report('its response carries the 24 levels relative to the file’s peak',
      spec.response.mode === 'points' && spec.response.points.length === 24 &&
        Math.abs(spec.response.points[10].db - (Number(sensitivity[10]) - peak)) < 0.02 &&
        spec.response.points.every((point) => point.db <= 0.01 && point.db >= -40),
      spec.response.points.length + ' points, peak ' + peak + ' dB');
    report('its directivity is the 24 measured widths',
      spec.directivity.model === 'frequency' && spec.directivity.points.length === 24 &&
        spec.directivity.points.every((point) => point.hDeg >= 5 && point.vDeg >= 5 &&
          point.hDeg <= 360 && point.vDeg <= 360),
      spec.directivity.points.length + ' width points');
    report('its sensitivity comes from the nearest band to 1 kHz',
      Math.abs(spec.sensitivity.at1W - Number(sensitivity[10])) < 0.06, spec.sensitivity.at1W + ' dB');
    report('the manufacturer and description come from the file',
      spec.manufacturer === example.manufacturer && spec.description.length > 0, spec.manufacturer);
  }
}

/* ---------- CLF1 ---------- */

const converted1 = clfFromGll(parsed, { format: 'clf1' });
report('the same GLL converts to CLF1', converted1.ok === true,
  converted1.ok ? converted1.text.length + ' characters' : converted1.message);

if (converted1.ok) {
  const fields = keyedFields(converted1.text);
  const blocks = bandBlocks(converted1.text);
  report('the file is tagged CLF1 and states version 1',
    converted1.text.split('\n')[0] === '<CLF1>' && fields.get('VERSION') === '1', fields.get('VERSION'));
  report('it carries the 8 octave bands from 125 Hz to 16 kHz',
    blocks.length === CLF1_BANDS.length && fields.get('MINBAND') === '125' && fields.get('MAXBAND') === '16000',
    blocks.length + ' bands, ' + fields.get('MINBAND') + '–' + fields.get('MAXBAND') + ' Hz');
  report('each band holds 19 azimuth rows of 19 polar values at 10°',
    blocks.every((rows) => rows.length === 19 && rows.every((row) => row.length === 19)),
    blocks[0].length + ' rows × ' + blocks[0][0].length + ' values');
  report('the CLF1 file name uses the .cf1 extension', /\.cf1$/.test(converted1.fileName), converted1.fileName);

  const back = parseClf(converted1.text, converted1.fileName);
  const specs = clfToSpec(back, { fileName: converted1.fileName });
  report('the CLF1 file reads back as octave data',
    back.ok && back.manufacturer.thirdOctave === false && back.readings.length === 8,
    back.ok ? back.readings.length + ' octave readings' : back.message);
  report('its decoded balloon is 19 × 19 at 10°',
    back.ok && back.polar && back.polar.azimuths === 19 && back.polar.parallels === 19 &&
      back.polar.azimuthStep === 10 && back.polar.polarStep === 10,
    back.ok && back.polar ? back.polar.azimuths + ' × ' + back.polar.parallels : 'none');
  report('the CLF1 file becomes a specification with 8 bands and 8 widths',
    specs.ok && specs.spec.response.points.length === 8 && specs.spec.directivity &&
      specs.spec.directivity.points.length === 8 && specs.spec.band.fMax === 16000,
    specs.ok ? specs.spec.response.points.length + ' points' : specs.message);
}

/* ---------- conformance against the published format rules ---------- */

/*
 * From gll-tools' docs/clf-format.md (the CLF text format, reverse-engineered and
 * published by that MIT-licensed project): the tag and terminator, the documented
 * key set, the band tables, and the row/column counts each symmetry tag implies.
 * Nothing here calls clf.js.
 */

const DOCUMENTED_KEYS = new Set([
  'CLF1', 'CLF2', 'VERSION', 'MODELNAME', 'INFOFILE', 'MANUFACTURER', 'WEB-SITE', 'DESCRIPTION',
  'COLORS', 'MOUNTING', 'WEIGHT', 'MINBAND', 'MAXBAND', 'MEASUREMENT-CONTACT', 'MEASUREMENT-EMAIL',
  'MEASUREMENT-DATE', 'MEASUREMENT-NOTE', 'MEASUREMENT-ENVIRONMENT', 'MEASUREMENT-DISTANCE',
  'MEASUREMENT-INPUTVOLTAGE', 'TYPE', 'SENSITIVITY', 'SENSITIVITY-INFO', 'IMPEDANCE', 'IMPEDANCE-INFO',
  'TOTMAXINPUT', 'RADIATION', 'AXIAL-SPECTRUM', 'AXIAL-SPECTRUM-INFO', 'BALLOON-SYMMETRY',
  'BALLOON-ARC-ORDER', 'BALLOON-REF', '6DB-WIDTH-HOR', '6DB-WIDTH-VER', '6DB-WIDTH-HOR-INFO',
  '6DB-WIDTH-VER-INFO', 'BAND', 'CABINET', 'CABINET-SYSTEM', 'CLF1END', 'CLF2END',
]);

function conformanceIssues(text, expected) {
  const issues = [];
  const lines = text.split('\n');
  const tag = '<' + expected.format + '>';
  const fields = keyedFields(text);
  if (lines[0] !== tag) issues.push('first line is ' + JSON.stringify(lines[0]));
  const lastLine = [...lines].reverse().find((line) => line.trim() !== '');
  if (lastLine !== '<' + expected.format + 'END>') {
    issues.push('terminator is ' + JSON.stringify(lastLine));
  }
  if (lines[lines.length - 1] !== '') issues.push('the file does not end with a newline');

  for (const key of fields.keys()) if (!DOCUMENTED_KEYS.has(key)) issues.push('undocumented key <' + key + '>');
  for (const key of ['MODELNAME', 'MANUFACTURER', 'MINBAND', 'MAXBAND', 'BALLOON-SYMMETRY', 'BALLOON-REF']) {
    if (!fields.has(key)) issues.push('missing <' + key + '>');
  }
  if (Number(fields.get('MINBAND')) < 50) issues.push('MINBAND is below the 50 Hz the CLF Group requires');

  const blocks = bandBlocks(text);
  if (blocks.length !== expected.bands.length) {
    issues.push(blocks.length + ' band blocks, expected ' + expected.bands.length);
  }
  const frequencies = [];
  for (const line of lines) {
    if (line.startsWith('<BAND>\t')) frequencies.push(Number(line.slice(7)));
  }
  if (frequencies.join(',') !== expected.bands.join(',')) {
    issues.push('band centres are ' + frequencies.slice(0, 4).join(', ') + '…');
  }
  const tabbed = text.split('\n').every((line) => !/^[-0-9.]+ [0-9.]/.test(line));
  if (!tabbed) issues.push('a data row uses spaces instead of TABs');

  for (const rows of blocks) {
    if (rows.length !== expected.azimuths) {
      issues.push(rows.length + ' azimuth rows, expected ' + expected.azimuths);
      break;
    }
    if (rows.some((row) => row.length !== expected.polar)) {
      issues.push('a row does not hold ' + expected.polar + ' polar values');
      break;
    }
    if (rows.flat().map(Number).some((value) => !Number.isFinite(value) || value <= -60 || value >= 200)) {
      issues.push('a level is outside -60…200 dB');
      break;
    }
  }

  if ((fields.get('SENSITIVITY') || '').split('\t').length !== expected.bands.length) {
    issues.push('the sensitivity list does not hold one value per band');
  }
  if ((fields.get('6DB-WIDTH-HOR') || '').split('\t').length !== expected.bands.length) {
    issues.push('the width list does not hold one value per band');
  }
  return issues;
}

const clf2Issues = converted.ok
  ? conformanceIssues(converted.text, { format: 'CLF2', bands: CLF2_BANDS, azimuths: 37, polar: 37 })
  : ['no file'];
report('the CLF2 file conforms to the published format rules', clf2Issues.length === 0,
  clf2Issues.slice(0, 2).join('; ') || 'tag, keys, 24 bands, 37 × 37 rows, TABs, terminator');

const clf1Issues = converted1.ok
  ? conformanceIssues(converted1.text, { format: 'CLF1', bands: CLF1_BANDS, azimuths: 19, polar: 19 })
  : ['no file'];
report('the CLF1 file conforms to the published format rules', clf1Issues.length === 0,
  clf1Issues.slice(0, 2).join('; ') || 'tag, keys, 8 bands, 19 × 19 rows, TABs, terminator');

/* ---------- a file whose widths exist only in its balloon ---------- */

const polarRows = [];
for (let row = 0; row < 19; row += 1) {
  const values = [];
  for (let column = 0; column < 19; column += 1) {
    values.push((90 - 0.5 * (10 * row) - Math.abs(10 * column - 90)).toFixed(1));
  }
  polarRows.push(values.join('\t'));
}
const polarOnlyText = [
  '<CLF2>',
  '<VERSION>\t2',
  '<MODELNAME>\tPolar only',
  '<MANUFACTURER>\tTest',
  '<MINBAND>\t1000',
  '<MAXBAND>\t2000',
  '<SENSITIVITY>\t90\t90',
  '<BALLOON-SYMMETRY>\t<horizontal>',
  '<BAND>\t1000',
  ...polarRows,
  '<BAND>\t2000',
  ...polarRows,
  '<CLF2END>',
].join('\n');

const polarOnly = parseClf(polarOnlyText, 'polar-only.cf2');
const polarSpec = clfToSpec(polarOnly, { fileName: 'polar-only.cf2' });
report('a file with no width keys still yields widths from its balloon',
  polarOnly.ok && polarOnly.polar && polarOnly.polar.horizontal.length === 2 &&
    polarOnly.readings.slice(0, 2).every((entry) => Number.isFinite(entry.beamwidthDeg) &&
      Number.isFinite(entry.beamwidthVDeg)),
  polarOnly.ok && polarOnly.polar ? polarOnly.polar.horizontal.map((entry) =>
    entry.widthDeg.toFixed(0) + '°').join(', ') : 'none');
report('that file still becomes a specification with directivity',
  polarSpec.ok && polarSpec.spec.directivity && polarSpec.spec.directivity.points.length === 2,
  polarSpec.ok ? polarSpec.message.split('.')[1] : polarSpec.message);

/* ---------- the balloon survives a save and a reopen ---------- */

const keptClf = parseClf(converted.text, converted.fileName);
const projected = clfResponse(keptClf);
const keptModel = normalizeModel({
  name: 'CLF import',
  datasets: [{
    label: 'Polar kept',
    provenance: 'manufacturer',
    curve: { magDb: Array.from({ length: 400 }, (_, index) => index * 0.01), phaseDeg: null },
    balloon: projected.balloon,
  }],
});
const kept = keptModel && keptModel.datasets[0] && keptModel.datasets[0].balloon;
report('the dataset keeps the balloon in a compact form', !!kept &&
  typeof kept.levels === 'string' && kept.levels.length > 1000 &&
  kept.azimuths === 37 && kept.parallels === 37 && kept.frequencies.length === 24,
  kept ? kept.frequencies.length + ' bands, ' + kept.levels.length + ' base64 characters' : 'no balloon');

const reopenedModel = normalizeModel(JSON.parse(JSON.stringify(keptModel)));
const decoded = datasetBalloon(reopenedModel.datasets[0]);
report('the balloon survives JSON save and reopen', !!decoded &&
  decoded.levels.length === 24 && decoded.levels[0].length === 37 &&
  decoded.levels[0][0].length === 37 && decoded.levels[0][0][18] > 0,
  decoded ? decoded.levels.length + ' × ' + decoded.levels[0].length + ' × ' +
    decoded.levels[0][0].length : 'none');

let worstKept = 0;
if (decoded) {
  for (let band = 0; band < decoded.levels.length; band += 1) {
    for (let azimuth = 0; azimuth < decoded.levels[band].length; azimuth += 1) {
      for (let parallel = 0; parallel < decoded.levels[band][azimuth].length; parallel += 1) {
        worstKept = Math.max(worstKept, Math.abs(
          decoded.levels[band][azimuth][parallel] - projected.balloon.levels[band][azimuth][parallel],
        ));
      }
    }
  }
}
report('the kept levels are the file’s own within the one-byte quantisation',
  worstKept <= 0.51, worstKept.toFixed(2) + ' dB worst');

/* ---------- import, rebuild the GLL, convert again: no drift ---------- */

const specBack = clfToSpec(keptClf, { fileName: 'back.cf2' });
const rebuilt = specBack.ok
  ? createGllFromSpec(normalizeSpec(specBack.spec), { name: specBack.spec.name })
  : { ok: false, message: specBack.message };
const rebuiltParsed = rebuilt.ok ? parseGll(rebuilt.bytes) : { ok: false, message: rebuilt.message };
const rebuiltClf = rebuiltParsed.ok ? clfFromGll(rebuiltParsed) : { ok: false, message: rebuiltParsed.message };
const secondClf = rebuiltClf.ok ? parseClf(rebuiltClf.text, 'second.cf2') : { ok: false };
const drift = clfDiff(keptClf, secondClf);
report('a CLF that is imported, rebuilt and converted again does not drift',
  drift.ok === true && drift.missing === 0 && drift.maxDriftDb <= 1 && drift.maxWidthDriftDeg <= 5,
  drift.ok ? drift.message : drift.message);

/* ---------- a multi-part GLL is written one part at a time ---------- */

const twoParts = {
  ...parsed,
  sources: [parsed.sources[0], {
    ...parsed.sources[0],
    key: parsed.sources[0].key + '-hf',
    label: parsed.sources[0].label + ' (HF)',
  }],
};
const partTwo = clfFromGll(twoParts, { sourceIndex: 1 });
report('the chosen part is written and says which part it is',
  partTwo.ok && partTwo.summary.part.index === 2 && partTwo.summary.part.count === 2 &&
    /-part2\.cf2$/.test(partTwo.fileName) &&
    /Part 2 of 2/.test(keyedFields(partTwo.text).get('MEASUREMENT-NOTE') || ''),
  partTwo.ok ? partTwo.fileName + ' · part ' + partTwo.summary.part.index + ' of ' +
    partTwo.summary.part.count : partTwo.message);
const listed = clfParts(twoParts);
report('the parts can be listed for a chooser',
  listed.length === 2 && listed[1].label.endsWith('(HF)') && listed[0].responses === 1297,
  listed.map((part) => part.label.slice(0, 26)).join(' | '));

/* ---------- writing part of the band grid ---------- */

const expectedSpan = CLF2_BANDS.filter((frequency) => frequency >= 1000 && frequency <= 4000);
const spanned = clfFromGll(parsed, { bandRange: { minHz: 1000, maxHz: 4000 } });
const bandLines = spanned.ok
  ? Array.from(spanned.text.matchAll(/^<BAND>\t(\d+)/gm), (match) => Number(match[1]))
  : [];
report('a band span writes only the bands inside it',
  spanned.ok && spanned.summary.bands === expectedSpan.length &&
    bandLines.join(',') === expectedSpan.join(',') &&
    /<MINBAND>\t1000/.test(spanned.text) && /<MAXBAND>\t4000/.test(spanned.text),
  spanned.ok ? bandLines.join(', ') + ' Hz' : spanned.message);
const spannedBack = spanned.ok ? parseClf(spanned.text, spanned.fileName) : { ok: false };
report('the written span still reads back as a CLF',
  spannedBack.ok === true && spannedBack.readings.length === expectedSpan.length,
  spannedBack.ok ? spannedBack.readings.length + ' readings' : 'not written');

const outsideSpan = clfFromGll(parsed, { bandRange: { minHz: 21000, maxHz: 40000 } });
report('a span with no band inside it writes the whole grid and says so',
  outsideSpan.ok && outsideSpan.summary.bands === CLF2_BANDS.length &&
    /whole 24-band grid/.test(outsideSpan.warnings.join(' ')),
  outsideSpan.ok ? outsideSpan.warnings.join('; ') : outsideSpan.message);

/* ---------- the balloon as a sphere ---------- */

const sphereParallels = projected.balloon.parallels;
const sphereMiddle = Math.floor(sphereParallels / 2);
const flatSphere = balloonProjection(projected.balloon, 1000, 0);
const axialPoint = flatSphere.ok ? flatSphere.points[0 * sphereParallels + sphereMiddle] : null;
const sidePoint = flatSphere.ok ? flatSphere.points[18 * sphereParallels + sphereMiddle] : null;
report('the balloon projects one point per angle in its 1 kHz band',
  flatSphere.ok && flatSphere.frequency === 1000 &&
    flatSphere.points.length === projected.balloon.azimuths * sphereParallels,
  flatSphere.ok ? flatSphere.frequency + ' Hz · ' + flatSphere.points.length + ' points' : flatSphere.message);
report('the file’s own 90° level is what shrinks its radius',
  !!axialPoint && !!sidePoint && Math.abs(axialPoint.x) < 1e-9 && Math.abs(axialPoint.y) < 1e-9 &&
    axialPoint.depth > 0.99 && sidePoint.x > 0 && sidePoint.x < axialPoint.depth,
  axialPoint && sidePoint
    ? 'on axis ' + axialPoint.x.toFixed(3) + ' / ' + axialPoint.y.toFixed(3) + ' / ' + axialPoint.depth.toFixed(3) +
      ' · 90° ' + sidePoint.x.toFixed(3) + ' / ' + sidePoint.depth.toFixed(3) + ' (attenuated to the floor)'
    : 'not projected');

// A flat balloon gives the geometry itself: every radius is 1, so the angles are
// the only thing under test rather than the cabinet's own directivity.
const uniform = {
  frequencies: [1000],
  stepAzDeg: 10,
  stepPolDeg: 10,
  levels: [Array.from({ length: 19 }, () => new Array(19).fill(0))],
};
const uniformSphere = balloonProjection(uniform, 1000, 0);
const uniformAxial = uniformSphere.ok ? uniformSphere.points[0 * 19 + 9] : null;
const uniformSide = uniformSphere.ok ? uniformSphere.points[9 * 19 + 9] : null;
report('a flat balloon is a unit sphere: on axis at the centre, 90° at the rim',
  !!uniformAxial && !!uniformSide && Math.abs(uniformAxial.x) < 1e-9 && Math.abs(uniformAxial.y) < 1e-9 &&
    Math.abs(uniformAxial.depth - 1) < 1e-9 && Math.abs(uniformSide.x - 1) < 1e-9 &&
    Math.abs(uniformSide.depth) < 1e-9,
  uniformSide ? 'rim ' + uniformSide.x.toFixed(3) + ' / ' + uniformSide.depth.toFixed(3) : 'not projected');
const uniformTurned = balloonProjection(uniform, 1000, 180);
const turnedSide = uniformTurned.ok ? uniformTurned.points[9 * 19 + 9] : null;
report('turning the view by 180° moves that rim point to the left',
  !!turnedSide && Math.abs(turnedSide.x + 1) < 1e-9 && Math.abs(turnedSide.depth) < 1e-9,
  turnedSide ? turnedSide.x.toFixed(3) + ' / ' + turnedSide.depth.toFixed(3) : 'not projected');
const keptSphere = decoded ? balloonProjection(decoded, 1000, 0) : { ok: false };
report('the balloon kept with the dataset projects the same shape as the file it came from',
  keptSphere.ok && Math.abs(keptSphere.points[0 * sphereParallels + sphereMiddle].depth - axialPoint.depth) < 0.05,
  keptSphere.ok
    ? 'radius ' + keptSphere.points[0 * sphereParallels + sphereMiddle].depth.toFixed(3) +
      ' against ' + axialPoint.depth.toFixed(3)
    : 'not projected');
report('a dataset with no balloon has no sphere to draw',
  balloonProjection(null, 1000, 0).ok === false && balloonProjection({ levels: [] }, 1000, 0).ok === false,
  balloonProjection(null, 1000, 0).message);

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
