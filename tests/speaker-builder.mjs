/*
 * The Custom Speaker Builder checks, run with Node:
 *
 *   node tests/speaker-builder.mjs
 *
 * Every case has an answer that can be worked out on paper: a millimetre in
 * metres, 2.83 V into 4 Ω against 1 W, −6 dB at half a stated beamwidth, a 24
 * dB/oct rolloff one octave below its corner, +3.01 dB where two sections of the
 * same level meet in power, and a −20 dB level at ten metres. Then the Pioneer
 * XY-3B generic example is taken end to end: built, saved, reloaded, exported,
 * placed in a room, aimed, processed by the shared DSP engine and included in a
 * coverage calculation.
 *
 * None of this is a measurement: the engine produces theoretical curves, and the
 * checks below test the arithmetic and the integration, not a loudspeaker.
 */

import { GRID_POINTS, gridFrequency } from '../js/modeler/curve.js';
import {
  GENERIC_CAVEAT,
  accuracyBadge,
  accuracyOf,
  applySpecToModel,
  buildDatasets,
  crossoversComplete,
  dataSourcesOf,
  defaultDatasetId,
  directivityEntries,
  equivalentSixDbWidth,
  exportDefinition,
  generateCabinetResponse,
  generateSectionResponse,
  lengthToMetres,
  metresToLength,
  modelFieldsFromSpec,
  newCustomSpeakerModel,
  normalizeSpec,
  parseBeamwidthTable,
  parseDefinition,
  pioneerExample,
  profileAttenuationDb,
  sensitivityAt1W,
  sensitivityFromVolts,
  sensitivityFromWatts,
  splFromPower,
  validateSpec,
  widthsAt,
} from '../js/modeler/speaker-builder.js';
import { normalizeDataset, normalizeModel, normalizeProject, evaluateSystem } from '../js/modeler/model.js';
import {
  buildContext,
  computeHeatmap,
  directivityAttenuationDb,
  predictResponse,
} from '../js/modeler/acoustics.js';
import { normalizeRoom } from '../js/modeler/room.js';
import { newFilter } from '../js/modeler/filters.js';

let passed = 0;
let failed = 0;

function report(name, pass, detail) {
  if (pass) passed += 1;
  else failed += 1;
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + ' — ' + detail);
}

function close(value, expected, tolerance) {
  return Number.isFinite(value) && Math.abs(value - expected) <= tolerance;
}

/* ---------- fixtures ---------- */

function baseSpec(overrides = {}) {
  return normalizeSpec({
    name: 'Test main',
    type: 'full-range',
    band: { fMin: 100, fMax: 10000 },
    sensitivity: { at1W: 100, impedanceOhm: 8 },
    directivity: { model: 'constant', hDeg: 50, vDeg: 35, referenceDb: 6, profile: 'quadratic' },
    sections: [{ id: 'sec-1', label: 'Full range', band: { fMin: 100, fMax: 10000 }, sensitivityDb: 100 }],
    ...overrides,
  });
}

function measuredDataset(label) {
  return normalizeDataset({
    label: label || 'Measured response',
    provenance: 'measured',
    curve: {
      magDb: new Array(GRID_POINTS).fill(96),
      phaseDeg: new Array(GRID_POINTS).fill(0),
      coherence: null,
    },
    fMin: 20,
    fMax: 20000,
  });
}

function projectFor(model, sourceFields = {}) {
  const normalized = normalizeModel(JSON.parse(JSON.stringify(model)));
  const dataset = normalized.datasets[0];
  return normalizeProject({
    models: [normalized],
    sources: [{
      modelId: normalized.id,
      datasetId: dataset.id,
      name: 'Main',
      gainDb: sourceFields.gainDb || 0,
      delayMs: sourceFields.delayMs || 0,
      polarity: sourceFields.polarity || 'normal',
      filters: sourceFields.filters || [],
      room: {
        x: 0,
        y: 0,
        z: 2,
        aimH: 0,
        aimV: 0,
        roll: 0,
        role: 'main',
        timing: 'geometric',
        timingOffsetMs: 0,
        ...(sourceFields.room || {}),
      },
    }],
    room: normalizeRoom({
      name: 'Builder test room',
      shape: 'rect',
      size: { widthM: 20, lengthM: 30 },
      wallHeightM: 8,
      ceiling: 'flat',
      audience: [{
        id: 'au-1', name: 'Audience', x0: 0, y0: 5, x1: 20, y1: 28,
        earHeightM: 1.2, raked: false, risePerMetre: 0,
      }],
      settings: { speedOfSound: 343, frequencyHz: 1000 },
    }),
  });
}

function levelAt(project, receiver) {
  const context = buildContext(project, project.room);
  const result = predictResponse(context, receiver, {
    frequencies: [1000],
    band: { min: 1000, max: 1000 },
  });
  return { context, result };
}

/* ---------- units ---------- */

{
  report('millimetres convert to metres', close(lengthToMetres(530, 'mm'), 0.53, 1e-12),
    lengthToMetres(530, 'mm') + ' m');
  report('centimetres convert to metres', close(lengthToMetres(54, 'cm'), 0.54, 1e-12),
    lengthToMetres(54, 'cm') + ' m');
  report('inches convert to metres', close(lengthToMetres(21, 'in'), 0.5334, 1e-12),
    lengthToMetres(21, 'in') + ' m');
  report('feet convert to metres', close(lengthToMetres(3, 'ft'), 0.9144, 1e-12),
    lengthToMetres(3, 'ft') + ' m');
  report('metres convert back to millimetres', close(metresToLength(0.53, 'mm'), 530, 1e-9),
    metresToLength(0.53, 'mm') + ' mm');
  report('an unknown length unit is refused', Number.isNaN(lengthToMetres(1, 'furlong')),
    'NaN for "furlong"');
  const roundTrip = ['mm', 'cm', 'm', 'in', 'ft'].every((unit) =>
    close(lengthToMetres(metresToLength(0.53, unit), unit), 0.53, 1e-12) &&
    close(metresToLength(lengthToMetres(20.5, unit), unit), 20.5, 1e-9));
  report('length conversion round-trips in every unit', roundTrip, 'mm, cm, m, in, ft');
}

/* ---------- sensitivity ---------- */

{
  report('at 8 Ω, 2.83 V and 1 W agree', close(sensitivityFromVolts(90, 8), 90, 0.01),
    sensitivityFromVolts(90, 8).toFixed(3) + ' dB at 1 W');
  report('at 4 Ω, the voltage rating reads 3.01 dB higher',
    close(sensitivityFromVolts(90, 4), 86.985, 0.01),
    sensitivityFromVolts(90, 4).toFixed(3) + ' dB at 1 W');
  report('at 16 Ω, the voltage rating reads 3.00 dB lower',
    close(sensitivityFromVolts(90, 16), 93.005, 0.01),
    sensitivityFromVolts(90, 16).toFixed(3) + ' dB at 1 W');
  report('the 1 W conversion is reversible',
    close(sensitivityFromWatts(sensitivityFromVolts(97, 4), 4), 97, 1e-9),
    sensitivityFromWatts(sensitivityFromVolts(97, 4), 4).toFixed(3) + ' dB at 2.83 V');
  report('a sensitivity without an impedance is refused',
    Number.isNaN(sensitivityFromVolts(90, 0)), 'NaN for 0 Ω');
  report('a power rating adds 10 log10 P', close(splFromPower(100, 400), 126.0206, 1e-3),
    splFromPower(100, 400).toFixed(2) + ' dB from 400 W');
  report('with no sensitivity at all the placeholder is 96 dB',
    close(sensitivityAt1W(baseSpec({
      sensitivity: { at1W: null },
      sections: [{ id: 's', label: 'S', band: { fMin: 100, fMax: 10000 } }],
    }), 0), 96, 1e-9),
    '96 dB placeholder, flagged by validation');
}

/* ---------- directivity ---------- */

{
  report('the quadratic taper reaches −6 dB at half the width',
    close(profileAttenuationDb(25, 50, 'quadratic', 6), -6, 1e-9),
    profileAttenuationDb(25, 50, 'quadratic', 6).toFixed(3) + ' dB at 25° of 50°');
  report('the quadratic taper at a quarter of the width',
    close(profileAttenuationDb(12.5, 50, 'quadratic', 6), -1.5, 1e-9),
    profileAttenuationDb(12.5, 50, 'quadratic', 6).toFixed(3) + ' dB');
  report('the cosine taper also reaches −6 dB at half the width',
    close(profileAttenuationDb(25, 50, 'cosine', 6), -6, 1e-9),
    profileAttenuationDb(25, 50, 'cosine', 6).toFixed(3) + ' dB');
  report('the steep taper holds closer to the axis',
    close(profileAttenuationDb(12.5, 50, 'steep', 6), -0.375, 1e-9),
    profileAttenuationDb(12.5, 50, 'steep', 6).toFixed(3) + ' dB');
  report('behind the pattern the attenuation is floored at −40 dB',
    close(profileAttenuationDb(120, 50, 'quadratic', 6), -40, 1e-9),
    profileAttenuationDb(120, 50, 'quadratic', 6).toFixed(1) + ' dB');
  report('a width stated at −10 dB converts to its 6 dB equivalent',
    close(equivalentSixDbWidth(50, 'quadratic', 10), 38.73, 0.01),
    equivalentSixDbWidth(50, 'quadratic', 10).toFixed(2) + '°');
  report('a width stated at −6 dB is unchanged',
    close(equivalentSixDbWidth(50, 'quadratic', 6), 50, 1e-9), '50°');
  report('the builder and the room use the same taper',
    [0, 10, 25, 40, 80].every((angle) =>
      close(profileAttenuationDb(angle, 50, 'quadratic', 6), directivityAttenuationDb(angle, 50), 1e-12)),
    'five angles agree to 1e-12 dB');

  const frequencySpec = normalizeSpec({
    ...baseSpec(),
    directivity: {
      model: 'frequency',
      hDeg: 50,
      vDeg: 35,
      referenceDb: 6,
      profile: 'quadratic',
      points: [
        { hz: 250, hDeg: 60, vDeg: 40 },
        { hz: 1000, hDeg: 120, vDeg: 80 },
      ],
    },
  });
  const midway = widthsAt(frequencySpec, 500);
  report('frequency-dependent beamwidth interpolates in log frequency',
    close(midway.hDeg, 90, 1e-6) && close(midway.vDeg, 60, 1e-6),
    midway.hDeg.toFixed(2) + '° × ' + midway.vDeg.toFixed(2) + '° at 500 Hz, the geometric mean');
  const ends = widthsAt(frequencySpec, 8000);
  report('the ends of a beamwidth list are held',
    close(ends.hDeg, 120, 1e-9), ends.hDeg + '° above the last point');

  const omni = normalizeSpec({ ...baseSpec(), directivity: { model: 'omni', hDeg: 90, vDeg: 60 } });
  report('an omnidirectional model claims no beamwidths', directivityEntries(omni).length === 0,
    'no directivity entries, so aim does not change the level');

  const entries = directivityEntries(pioneerExample());
  report('a constant-directivity model carries a width at every band',
    entries.length > 8 && entries.every((entry) => close(entry.widthHDeg, 50, 1e-9) && close(entry.widthVDeg, 35, 1e-9)),
    entries.length + ' bands, 50° horizontal and 35° vertical');
  report('beamwidth entries are in ascending frequency',
    entries.every((entry, index) => index === 0 || entry.frequency > entries[index - 1].frequency),
    entries[0].frequency + '–' + entries[entries.length - 1].frequency + ' Hz');

  const table = parseBeamwidthTable('# Hz, H°, V°\n250, 90, 60\n1000, 60, 40\n4000, 40, 30\n');
  report('a beamwidth table is read with its header', table.ok && table.points.length === 3,
    table.message);
  const symmetrical = parseBeamwidthTable('100, 90\n1000, 60');
  report('a two-column table is read as a symmetrical pattern',
    symmetrical.ok && symmetrical.points[1].hDeg === 60 && symmetrical.points[1].vDeg === 60,
    symmetrical.message);
  const impossible = parseBeamwidthTable('100, 400, 60\n1000, 60, 40');
  report('an impossible width refuses the whole table', impossible.ok === false,
    impossible.message);
  const oneBand = parseBeamwidthTable('100, 90, 60');
  report('a one-band table is refused', oneBand.ok === false, oneBand.message);
  const duplicate = parseBeamwidthTable('100, 90, 60\n100, 80, 50');
  report('a duplicate band is refused', duplicate.ok === false, duplicate.message);
}

/* ---------- the generated response ---------- */

{
  const spec = baseSpec();
  const values = generateSectionResponse(spec, 0, { frequencies: [50, 100, 1000, 10000, 20000] });
  report('inside the band the curve is the entered sensitivity', close(values[2], 100, 1e-9),
    values[2].toFixed(2) + ' dB at 1 kHz');
  report('the band edges are flat', close(values[1], 100, 1e-9) && close(values[3], 100, 1e-9),
    values[1].toFixed(2) + ' dB at 100 Hz, ' + values[3].toFixed(2) + ' dB at 10 kHz');
  report('one octave below the range costs the entered 24 dB', close(values[0], 76, 1e-9),
    values[0].toFixed(2) + ' dB at 50 Hz');
  report('one octave above the range costs the entered 18 dB', close(values[4], 82, 1e-9),
    values[4].toFixed(2) + ' dB at 20 kHz');
  report('every grid point is a finite level',
    Array.from(generateSectionResponse(spec, 0), Number).every(Number.isFinite),
    GRID_POINTS + ' points');

  const shaped = normalizeSpec({
    ...baseSpec(),
    response: { mode: 'points', points: [{ hz: 1000, db: 3 }] },
  });
  const shapedValues = generateSectionResponse(shaped, 0, { frequencies: [500, 1000, 4000] });
  report('a deviation point moves the curve by its entered dB',
    close(shapedValues[1], 103, 1e-9), shapedValues[1].toFixed(2) + ' dB at 1 kHz');
  report('a single point is held across the band',
    close(shapedValues[0], 103, 1e-9) && close(shapedValues[2], 103, 1e-9),
    '+3 dB held at 500 Hz and 4 kHz');

  const blankCrossover = normalizeSpec({
    name: 'Blank crossover',
    band: { fMin: 55, fMax: 17000 },
    sections: [{ id: 'a', label: 'LF' }, { id: 'b', label: 'HF' }],
    crossovers: [{ hz: null, slopeDbPerOct: 24 }],
  });
  report('an empty crossover stays empty instead of becoming 10 Hz',
    !Number.isFinite(blankCrossover.crossovers[0].hz) && !crossoversComplete(blankCrossover),
    'no crossover, so the sections are not combined');
  const blankPoint = normalizeSpec({
    ...baseSpec(),
    response: { mode: 'points', points: [{ hz: null, db: null }] },
  });
  report('an empty response point is dropped, not turned into 10 Hz / 0 dB',
    blankPoint.response.points.length === 0, blankPoint.response.points.length + ' points');
}

/* ---------- multi-way ---------- */

{
  const twoWay = normalizeSpec({
    name: 'Two way',
    type: 'multi-way',
    band: { fMin: 100, fMax: 10000 },
    crossovers: [{ hz: 1000, slopeDbPerOct: 24 }],
    sensitivity: { at1W: 100, impedanceOhm: 8 },
    directivity: { model: 'constant', hDeg: 90, vDeg: 60 },
    sections: [
      { id: 'sec-lf', label: 'LF', band: { fMin: 100, fMax: 10000 }, sensitivityDb: 100 },
      { id: 'sec-hf', label: 'HF', band: { fMin: 100, fMax: 10000 }, sensitivityDb: 100 },
    ],
  });
  report('a crossover makes the section bands contiguous', crossoversComplete(twoWay),
    'one crossover at 1 kHz for two sections');
  const atCrossover = generateCabinetResponse(twoWay, { frequencies: [1000] });
  report('two equal sections meet flat at the crossover',
    atCrossover.ok && atCrossover.magDb && close(atCrossover.magDb[0], 100, 0.01),
    atCrossover.ok && atCrossover.magDb
      ? atCrossover.magDb[0].toFixed(3) + ' dB at 1 kHz, power sum'
      : atCrossover.message);
  const built = buildDatasets(twoWay);
  report('a multi-way produces a dataset per section plus the cabinet', built.datasets.length === 3,
    built.datasets.map((entry) => entry.sectionId).join(', '));
  report('the cabinet dataset says how it was summed',
    /power/.test(built.datasets[2].note) && built.datasets[2].sectionId === 'cabinet',
    built.datasets[2].note);

  const noCrossover = normalizeSpec({ ...twoWay, crossovers: [] });
  const refused = generateCabinetResponse(noCrossover);
  report('without a crossover the sections are not combined', refused.ok === false,
    refused.message.slice(0, 60) + '…');
  report('and only the sections are offered', buildDatasets(noCrossover).datasets.length === 2,
    'two section datasets, no cabinet sum');
}

/* ---------- the Pioneer XY-3B example ---------- */

{
  const spec = pioneerExample();
  report('the example keeps every supplied figure',
    spec.band.fMin === 55 && spec.band.fMax === 17000 &&
    spec.directivity.hDeg === 50 && spec.directivity.vDeg === 35 &&
    spec.sections[0].sensitivityDb === 102 && spec.sections[1].sensitivityDb === 107 &&
    spec.sections[0].maxPeakDb === 139 && spec.sections[1].maxPeakDb === 136,
    '55 Hz–17 kHz, 50° × 35°, LF 102/139 dB, MHF 107/136 dB');
  report('the dimensions are stored in metres',
    close(spec.physical.widthM, 0.53, 1e-12) && close(spec.physical.heightM, 1.08, 1e-12) &&
    close(spec.physical.depthM, 0.54, 1e-12),
    '0.53 × 1.08 × 0.54 m');
  report('the model is labelled an approximation',
    spec.labelCaveat === GENERIC_CAVEAT && /Not an official EASE or GLL dataset/i.test(spec.description),
    spec.labelCaveat);
  report('the sections are never added without a crossover',
    !crossoversComplete(spec) && buildDatasets(spec).datasets.length === 2,
    'LF and mid/high offered separately');

  const datasets = buildDatasets(spec).datasets;
  const lf = datasets[0];
  const nearest = (() => {
    let best = 0;
    for (let i = 1; i < GRID_POINTS; i += 1) {
      if (Math.abs(gridFrequency(i) - 1000) < Math.abs(gridFrequency(best) - 1000)) best = i;
    }
    return best;
  })();
  report('a generated dataset is on the model grid',
    lf.curve.magDb.length === GRID_POINTS && lf.points === GRID_POINTS,
    lf.curve.magDb.length + ' points');
  report('no phase is invented for the generic model',
    lf.curve.phaseDeg === null && lf.hasPhase === false && lf.provenance === 'theoretical',
    'magnitude only, theoretical');
  report('the generated curve carries the LF sensitivity',
    close(lf.curve.magDb[nearest], 102, 1e-6),
    lf.curve.magDb[nearest].toFixed(2) + ' dB at ~1 kHz');
  report('the model fields take the reference section',
    close(modelFieldsFromSpec(spec).sensitivityDb, 102, 1e-9),
    modelFieldsFromSpec(spec).sensitivityDb + ' dB');

  const validation = validateSpec(spec);
  report('the example validates', validation.errors.length === 0,
    validation.errors.length + ' errors');
  report('the warnings name the missing phase and acoustic centre',
    validation.warnings.some((line) => /phase/i.test(line)) &&
    validation.warnings.some((line) => /acoustic centre/i.test(line)),
    validation.warnings.length + ' warnings');
}

/* ---------- validation ---------- */

{
  const broken = validateSpec({
    name: '',
    sections: [],
    band: { fMin: 100, fMax: 50 },
    sensitivity: {},
    directivity: { model: 'constant', hDeg: 0, vDeg: 0 },
    physical: { widthM: 0, heightM: 0, depthM: 0 },
  });
  report('validation refuses an empty name', broken.errors.some((line) => /name/i.test(line)),
    broken.errors[0]);
  report('validation refuses an inverted range', broken.errors.some((line) => /above/i.test(line)),
    broken.errors.find((line) => /above/i.test(line)) || 'none');
  report('validation requires a section', broken.errors.some((line) => /section/i.test(line)),
    broken.errors.find((line) => /section/i.test(line)) || 'none');
  report('validation refuses impossible coverage',
    broken.errors.some((line) => /horizontal coverage/i.test(line)),
    broken.errors.find((line) => /coverage/i.test(line)) || 'none');
  report('validation refuses a cabinet with no size',
    broken.errors.filter((line) => /greater than zero/i.test(line)).length === 3,
    'width, height and depth');
}

/* ---------- accuracy, data sources, revisions ---------- */

{
  const generic = newCustomSpeakerModel(pioneerExample());
  report('a built speaker is a generic model', accuracyOf(generic).id === 'generic',
    accuracyBadge(generic));
  report('the generic badge keeps the caveat', accuracyBadge(generic) === GENERIC_CAVEAT,
    accuracyBadge(generic));

  const mixed = newCustomSpeakerModel(pioneerExample());
  const measured = measuredDataset('Venue measurement');
  mixed.datasets.push(measured);
  report('measured data beside a specification makes it hybrid',
    accuracyOf(mixed).id === 'hybrid', accuracyOf(mixed).note.slice(0, 50) + '…');
  const mixedRows = dataSourcesOf(mixed);
  report('the data-source hierarchy lists measured data first',
    mixedRows[0].kind === 'measured' && mixedRows.some((row) => row.kind === 'generic'),
    mixedRows.map((row) => row.kind).join(' → '));
  report('attaching measured data does not move the preferred dataset',
    mixedRows.find((row) => row.preferred) && mixedRows.find((row) => row.preferred).kind === 'generic',
    'the generic dataset is still the one used');
  report('the measured dataset is not marked as generated', measured.generated === false,
    'a real measured dataset stays measured');

  const measuredOnly = { id: 'm-measured', name: 'Measured', datasets: [measuredDataset()] };
  report('a measured library entry stays measured', accuracyOf(measuredOnly).id === 'measured',
    accuracyBadge(measuredOnly));
  const manufacturerOnly = {
    id: 'm-maker',
    name: 'Manufacturer',
    datasets: [normalizeDataset({
      label: 'CLF',
      provenance: 'manufacturer',
      curve: { magDb: new Array(GRID_POINTS).fill(96), phaseDeg: null, coherence: null },
      fMin: 20,
      fMax: 20000,
    })],
  };
  report('a manufacturer entry is labelled manufacturer',
    accuracyOf(manufacturerOnly).id === 'manufacturer', accuracyBadge(manufacturerOnly));
  report('an entry with no response is incomplete', accuracyOf({}).id === 'incomplete',
    accuracyBadge({}));

  const model = newCustomSpeakerModel(baseSpec());
  const rows = dataSourcesOf(model);
  report('the dataset used for prediction is marked',
    rows.length === 1 && rows[0].preferred && defaultDatasetId(model) === model.datasets[0].id,
    rows[0] ? rows[0].label : 'none');

  const before = model.generic.sections[0].sensitivityDb;
  const revised = normalizeSpec({
    ...model.generic,
    sections: model.generic.sections.map((section, index) =>
      (index === 0 ? { ...section, sensitivityDb: 104 } : section)),
  });
  applySpecToModel(model, revised, { note: 'Changed the LF sensitivity' });
  report('regenerating replaces the generic datasets', model.datasets.filter((entry) => entry.generated).length === 1,
    'one generated dataset, no duplicate');
  report('the revision count rises', model.generic.revision === 2,
    'revision ' + model.generic.revision);
  report('the previous specification is kept',
    model.revisions.length === 1 && model.revisions[0].spec.sections[0].sensitivityDb === before,
    'the old ' + before + ' dB is in the revision');
  report('the updated curve uses the new figure',
    close(model.datasets[0].curve.magDb[200], 104, 0.01),
    model.datasets[0].curve.magDb[200].toFixed(2) + ' dB near 632 Hz');

  model.datasets.push(measured);
  const storedMeasured = measured.id;
  applySpecToModel(model, normalizeSpec(model.generic), { note: 'No change' });
  report('a regeneration keeps attached measured data',
    model.datasets.some((entry) => entry.id === storedMeasured),
    'the measured dataset survives the update');
  report('revisions are capped', (() => {
    for (let index = 0; index < 20; index += 1) applySpecToModel(model, normalizeSpec(model.generic), { note: 'Pass ' + index });
    return model.revisions.length === 12;
  })(), model.revisions.length + ' revisions kept');
}

/* ---------- export and import ---------- */

{
  const model = newCustomSpeakerModel(pioneerExample());
  const text = exportDefinition(model);
  const parsed = parseDefinition(text);
  report('a definition exports as JSON with the schema',
    JSON.parse(text).schema === 'align.custom-speaker/1', 'align.custom-speaker/1');
  report('an exported definition reads back', parsed.ok && parsed.model && parsed.model.name === model.name,
    parsed.message);
  const reloaded = parsed.ok && parsed.model
    ? normalizeModel(parsed.model)
    : { datasets: [], generic: null };
  report('the entered specification survives the round trip',
    !!reloaded.generic && reloaded.generic.sections.length === 2 &&
    reloaded.generic.sections[1].sensitivityDb === 107,
    'two sections, mid/high at 107 dB');
  report('the generated datasets survive the round trip',
    reloaded.datasets.length === 2 &&
    reloaded.datasets.every((entry) => entry.generated && entry.curve.magDb.length === GRID_POINTS),
    reloaded.datasets.length + ' datasets of ' + GRID_POINTS + ' points');

  report('malformed JSON is refused whole', parseDefinition('{not json').ok === false,
    parseDefinition('{not json').message);
  report('a foreign schema is refused',
    parseDefinition(JSON.stringify({ schema: 'something/else', speaker: { name: 'x' } })).ok === false,
    parseDefinition(JSON.stringify({ schema: 'something/else', speaker: { name: 'x' } })).message);
  const truncated = JSON.parse(text);
  truncated.speaker.datasets[0].curve.magDb = [96, 96, 96];
  const refused = parseDefinition(JSON.stringify(truncated));
  report('a truncated dataset is refused whole', refused.ok === false,
    refused.message);
  report('a definition with no curves and no specification is refused',
    parseDefinition(JSON.stringify({ schema: 'align.custom-speaker/1', speaker: { name: 'Empty' } })).ok === false,
    'nothing to model');
}

/* ---------- into the room ---------- */

{
  const model = newCustomSpeakerModel(pioneerExample());
  const project = projectFor(model);
  const receiver = { x: 0, y: 10, z: 2 };
  const { context, result } = levelAt(project, receiver);
  const speaker = context.speakers[0] || {};
  const contribution = result.contributions[0] || {};

  report('the built speaker is placed and predicted',
    context.ok && context.speakers.length === 1,
    context.speakers.length + ' placed speaker');
  report('the specification is the reference distance',
    close(speaker.referenceDistanceM, 1, 1e-9),
    speaker.referenceDistanceM + ' m');
  report('on axis the level is the sensitivity less distance',
    close(result.levelDb, 82, 0.01),
    result.levelDb.toFixed(2) + ' dB at 10 m from a 102 dB / 1 m section');
  report('the prediction says its phase is not measured',
    result.phaseValid === false && contribution.phaseValid === false,
    'phase assumed, not measured');

  project.sources[0].room.aimH = 90;
  const rotated = levelAt(project, receiver).result;
  report('aiming the cabinet changes the predicted level',
    result.levelDb - rotated.levelDb > 35,
    (result.levelDb - rotated.levelDb).toFixed(1) + ' dB lost at 90° off axis');

  const offAxisProject = projectFor(model);
  offAxisProject.sources[0].room.aimH = 0;
  const angle = 25;
  // Ten metres away along a ray 25° off the aiming axis, so the distance level
  // is exactly −20 dB and the angle is exactly 25°.
  const offAxis = levelAt(offAxisProject, {
    x: 10 * Math.sin((angle * Math.PI) / 180),
    y: 10 * Math.cos((angle * Math.PI) / 180),
    z: 2,
  }).result;
  report('a receiver outside the pattern loses the taper’s dB',
    close(offAxis.levelDb, 82 - 6, 0.05),
    offAxis.levelDb.toFixed(2) + ' dB at 25°, 6 dB below axis');

  const processedProject = projectFor(model, { gainDb: -6, delayMs: 1.5 });
  const processed = levelAt(processedProject, receiver).result;
  report('gain and delay reach the prediction',
    close(processed.levelDb, 76, 0.01),
    processed.levelDb.toFixed(2) + ' dB with −6 dB and 1.5 ms');
  const evaluation = evaluateSystem(processedProject);
  report('the shared complex engine sums the built speaker',
    evaluation.sum !== null && evaluation.responses.length === 1,
    'one response in the sum');
  report('a magnitude-only sum is flagged as assuming phase',
    !!evaluation.sum && evaluation.sum.assumedPhase === 1,
    evaluation.sum ? evaluation.sum.assumedPhase + ' assumed phase' : 'no sum');

  const filterProject = projectFor(model);
  const filter = newFilter('peaking', 1000);
  filter.gainDb = -6;
  filterProject.sources[0].filters = [filter];
  const filtered = levelAt(filterProject, receiver).result;
  report('the DSP chain filters the built speaker',
    close(filtered.levelDb, 76, 0.4),
    filtered.levelDb.toFixed(2) + ' dB with a −6 dB peaking filter at 1 kHz');

  const coverageProject = projectFor(model);
  const coverage = computeHeatmap(buildContext(coverageProject, coverageProject.room), {
    cols: 8,
    metric: 'level',
    frequencyHz: 1000,
    bandMode: 'third',
  });
  report('the built speaker is included in a coverage calculation',
    coverage.ok && coverage.statistics.points > 0 && Number.isFinite(coverage.statistics.meanDb),
    coverage.statistics.points + ' audience points, mean ' +
      (Number.isFinite(coverage.statistics.meanDb) ? coverage.statistics.meanDb.toFixed(1) : '—') + ' dB');
  report('the coverage map uses the speaker’s beamwidth',
    coverage.computed > 0 && Array.isArray(coverage.frequencies) && coverage.frequencies.length === 3,
    'three third-octave points per receiver');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
