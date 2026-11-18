/*
 * Room Designer and direct-sound prediction checks, run with Node:
 *
 *   node tests/room.mjs
 *
 * Every case here has an answer that can be worked out on paper: a distance in
 * milliseconds, a level against distance, two coherent sources adding to
 * +6.02 dB, a half-wavelength path difference cancelling, a 6 dB beamwidth
 * costing 6 dB at its edge. Nothing here is a measurement or a loudspeaker.
 *
 * No check in this file is evidence about a room: the engine models the direct
 * sound only, and that is what is tested.
 */

import {
  GRID_POINTS,
  SPEED_OF_SOUND,
  gridFrequencies,
} from '../js/modeler/curve.js';
import { normalizeDataset, normalizeSource } from '../js/modeler/model.js';
import {
  FEET_PER_METRE,
  WAREHOUSE_DIMENSIONS,
  ceilingHeightAt,
  displayToMetres,
  earHeightAt,
  emptyRoom,
  floorHeightAt,
  formatArea,
  generateOutline,
  listenerZ,
  metresToDisplay,
  normalizeRoom,
  polygonArea,
  pointInPolygon,
  roomMetrics,
  warehouseRoom,
  warehouseSources,
} from '../js/modeler/room.js';
import {
  arrayLayout,
  arrivalTable,
  beamwidthAt,
  buildContext,
  computeHeatmap,
  contributionAt,
  directivityAttenuationDb,
  distance3,
  inverseDistanceDb,
  offAxisAngles,
  predictResponse,
  propagationDelayMs,
  aimVector,
} from '../js/modeler/acoustics.js';

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

/* ---------- synthetic projects with known answers ---------- */

function flatDataset(options = {}) {
  const magDb = new Array(GRID_POINTS).fill(options.magDb === undefined ? 0 : options.magDb);
  const phaseDeg = options.phase === false ? null : new Array(GRID_POINTS).fill(0);
  return normalizeDataset({
    id: options.id || ('d-' + Math.random().toString(36).slice(2, 8)),
    label: options.label || 'flat test response',
    provenance: options.provenance || 'measured',
    curve: { magDb, phaseDeg, coherence: null },
    fMin: 20,
    fMax: 20000,
    directivity: options.directivity || [],
  });
}

function projectWith(speakers, options = {}) {
  const dataset = flatDataset({ directivity: options.directivity || [], phase: options.phase });
  const model = {
    id: 'm-test',
    name: 'Test loudspeaker',
    manufacturer: '',
    model: '',
    type: 'Custom',
    impedanceOhm: 8,
    sensitivityDb: 96,
    distanceM: options.distanceM || 1,
    referenceDelayMs: 0,
    crossoverText: '',
    directivityText: '',
    specs: '',
    notes: '',
    provenance: 'measured',
    datasets: [dataset],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const sources = speakers.map((entry, index) => normalizeSource({
    id: 's-' + index,
    modelId: model.id,
    datasetId: dataset.id,
    name: entry.name || ('Source ' + (index + 1)),
    gainDb: entry.gainDb || 0,
    delayMs: entry.delayMs || 0,
    polarity: entry.polarity || 'normal',
    muted: entry.muted === true,
    room: {
      x: entry.x,
      y: entry.y,
      z: entry.z || 0,
      aimH: entry.aimH || 0,
      aimV: entry.aimV || 0,
      roll: entry.roll || 0,
      role: entry.role || 'main',
      timing: 'geometric',
      timingOffsetMs: 0,
    },
  }));
  const room = normalizeRoom({
    name: 'Test room',
    shape: 'rect',
    size: { widthM: 20, lengthM: 30 },
    wallHeightM: 8,
    ceiling: 'flat',
    audience: [{
      id: 'au-1', name: 'Audience', x0: 0, y0: 5, x1: 20, y1: 28,
      earHeightM: 1.2, raked: false, risePerMetre: 0,
    }],
    mics: [{
      id: 'mic-1', name: 'Reference', x: 10, y: 15, z: 1.2,
      captureId: '', captureName: '', note: '',
    }],
    settings: { refMicId: 'mic-1', frequencyHz: 1000, speedOfSound: 343 },
  });
  return {
    models: [model],
    sources,
    groups: [],
    positions: [{ id: 'centre', label: 'Centre', weight: 1 }],
    snapshots: [],
    room,
    settings: {
      positionId: 'centre',
      propagation: { enabled: false, referenceDistanceM: 1, speedOfSound: 343 },
    },
  };
}

function levelAt(project, receiver, options = {}) {
  const context = buildContext(project, project.room);
  return predictResponse(context, receiver, {
    frequencies: options.frequencies || [1000],
    band: options.band || { min: 1000, max: 1000 },
    onlyIds: options.onlyIds,
  });
}

/* ---------- geometry ---------- */

{
  const rect = normalizeRoom({
    shape: 'rect', size: { widthM: 20, lengthM: 30 },
    wallHeightM: 8, ceiling: 'flat',
  });
  report('rectangle area', close(polygonArea(rect.outline), 600, 1e-6),
    polygonArea(rect.outline).toFixed(2) + ' m² for 20 × 30 m');

  const inside = pointInPolygon(rect.outline, 10, 15);
  const outside = pointInPolygon(rect.outline, 25, 15);
  report('point in polygon', inside && !outside,
    'centre inside, a point beyond the wall outside');

  const lShape = normalizeRoom({
    shape: 'l', size: { widthM: 20, lengthM: 30, notchWidthM: 7, notchLengthM: 10 },
    wallHeightM: 8,
  });
  const lArea = polygonArea(generateOutline(lShape));
  report('L-shape area', close(lArea, 600 - 70, 1e-6),
    lArea.toFixed(2) + ' m² for 20 × 30 m less a 7 × 10 m notch');

  const custom = normalizeRoom({
    shape: 'custom',
    outline: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 6 }, { x: 4, y: 6 }, { x: 4, y: 10 }, { x: 0, y: 10 }],
  });
  report('custom polygon kept', custom.outline.length === 6 &&
    close(polygonArea(custom.outline), 100 - 24, 1e-6),
    custom.outline.length + ' points, ' + polygonArea(custom.outline).toFixed(1) + ' m²');

  const flat = normalizeRoom({ shape: 'rect', size: { widthM: 20, lengthM: 30 }, wallHeightM: 8, ceiling: 'flat' });
  report('flat ceiling height', close(ceilingHeightAt(flat, 3, 22), 8, 1e-9) &&
    close(ceilingHeightAt(flat, 19, 2), 8, 1e-9), '8 m everywhere');

  const sloped = normalizeRoom({
    shape: 'rect', size: { widthM: 20, lengthM: 30 }, wallHeightM: 6, ceiling: 'sloped', riseM: 9,
  });
  const front = ceilingHeightAt(sloped, 10, 0);
  const rear = ceilingHeightAt(sloped, 10, 30);
  report('sloped ceiling', close(front, 6, 1e-6) && close(rear, 15, 1e-6) && close(ceilingHeightAt(sloped, 10, 15), 10.5, 1e-6),
    'front ' + front.toFixed(2) + ' m, middle 10.5 m, rear ' + rear.toFixed(2) + ' m');

  const aFrame = normalizeRoom({
    shape: 'rect', size: { widthM: 20, lengthM: 30 }, wallHeightM: 6,
    ceiling: 'aframe', riseM: 9, ridgeX: 10,
  });
  report('A-frame ceiling', close(ceilingHeightAt(aFrame, 10, 15), 15, 1e-6) &&
    close(ceilingHeightAt(aFrame, 0, 15), 6, 1e-6) && close(ceilingHeightAt(aFrame, 5, 15), 10.5, 1e-6),
    'ridge ' + ceilingHeightAt(aFrame, 10, 15).toFixed(2) + ' m, eaves 6 m, half way 10.5 m');

  const staged = normalizeRoom({
    shape: 'rect', size: { widthM: 20, lengthM: 30 }, wallHeightM: 8,
    stages: [{ id: 'st-1', name: 'Stage', x0: 2, y0: 0.5, x1: 18, y1: 5, heightM: 1.2 }],
    audience: [{ id: 'au-1', name: 'Audience', x0: 0, y0: 6, x1: 20, y1: 28, earHeightM: 1.2 }],
    settings: { earHeightM: 1.2 },
  });
  report('stage raises the floor', close(floorHeightAt(staged, 10, 3), 1.2, 1e-9) &&
    close(floorHeightAt(staged, 10, 10), 0, 1e-9),
    '1.20 m on the stage, 0 m on the floor');

  report('listener height', close(listenerZ(staged, 10, 3), 2.4, 1e-6) &&
    close(listenerZ(staged, 10, 10), 1.2, 1e-6),
    '2.40 m on the stage, 1.20 m in front of it');

  const raked = normalizeRoom({
    shape: 'rect', size: { widthM: 20, lengthM: 30 }, wallHeightM: 8,
    audience: [{ id: 'au-1', name: 'Raked', x0: 0, y0: 10, x1: 20, y1: 28, earHeightM: 1.1, raked: true, risePerMetre: 0.1 }],
  });
  report('raked audience', close(earHeightAt(raked, 10, 10), 1.1, 1e-6) &&
    close(earHeightAt(raked, 10, 20), 2.1, 1e-6),
    '1.10 m at the front row, 2.10 m ten metres back');

  const metrics = roomMetrics(flat);
  report('room volume estimate', close(metrics.volumeM3, 4800, 1),
    metrics.volumeM3.toFixed(1) + ' m³ for 600 m² under an 8 m ceiling');

  report('unit conversion', close(metresToDisplay(12.192, 'imperial'), 40, 1e-6) &&
    close(displayToMetres(41, 'imperial'), 41 / FEET_PER_METRE, 1e-9),
    '40 ft and 41 ft convert both ways');

  report('area formatting', formatArea(600, 'metric') === '600 m²' &&
    formatArea(100, 'imperial').startsWith('1076'), formatArea(100, 'imperial') + ' for 100 m²');
}

/* ---------- the Pioneer warehouse example ---------- */

{
  const warehouse = warehouseRoom('metric');
  const width = WAREHOUSE_DIMENSIONS.widthFt / FEET_PER_METRE;
  const eave = WAREHOUSE_DIMENSIONS.eaveFt / FEET_PER_METRE;
  const peak = WAREHOUSE_DIMENSIONS.peakFt / FEET_PER_METRE;
  report('warehouse dimensions', close(warehouse.size.widthM, width, 0.001) &&
    close(warehouse.size.lengthM, 110 / FEET_PER_METRE, 0.001),
    warehouse.size.widthM.toFixed(3) + ' × ' + warehouse.size.lengthM.toFixed(3) + ' m for 41 × 110 ft');
  report('warehouse A-frame', warehouse.ceiling === 'aframe' &&
    close(ceilingHeightAt(warehouse, width / 2, warehouse.size.lengthM / 2), peak, 0.01) &&
    close(ceilingHeightAt(warehouse, 0, warehouse.size.lengthM / 2), eave, 0.01),
    'peak ' + (peak * FEET_PER_METRE).toFixed(1) + ' ft, eaves ' + (eave * FEET_PER_METRE).toFixed(1) + ' ft');

  const speakers = warehouseSources(warehouse);
  const subs = speakers.filter((entry) => entry.role === 'sub');
  const mains = speakers.filter((entry) => entry.role === 'main');
  const mids = speakers.filter((entry) => entry.role === 'mids');
  const rears = speakers.filter((entry) => entry.role === 'rear');
  report('warehouse cabinet counts', subs.length === 8 && mains.length === 4 && mids.length === 2 && rears.length === 2,
    subs.length + ' subs, ' + mains.length + ' mains, ' + mids.length + ' mid delays, ' +
    rears.length + ' rear delays');

  const byNumber = new Map(subs.map((entry) => [entry.number, entry]));
  const rightmost = Math.min(byNumber.get(1).x, byNumber.get(2).x);
  const leftmost = Math.max(byNumber.get(7).x, byNumber.get(8).x);
  report('warehouse sub numbering', rightmost > leftmost &&
    byNumber.get(1).note.includes('far right') && byNumber.get(8).note.includes('far left'),
    '1 and 2 at x ' + rightmost.toFixed(2) + ' m (far right), 7 and 8 at x ' +
    leftmost.toFixed(2) + ' m (far left)');
  report('warehouse has no acoustic data', speakers.every((entry) => !entry.dataset && !entry.directivity),
    'positions and names only; no manufacturer dataset was invented');
}

/* ---------- propagation ---------- */

{
  const a = { x: 0, y: 0, z: 0 };
  const b = { x: 343, y: 0, z: 0 };
  report('distance and delay', close(distance3(a, b), 343, 1e-9) &&
    close(propagationDelayMs(343, 343), 1000, 1e-9),
    '343 m is ' + propagationDelayMs(343, SPEED_OF_SOUND).toFixed(3) + ' ms');

  report('10 m delay', close(propagationDelayMs(10, 343), 29.1545, 1e-3),
    propagationDelayMs(10, 343).toFixed(4) + ' ms for 10 m');

  report('inverse distance', close(inverseDistanceDb(2, 1), -6.0206, 1e-3) &&
    close(inverseDistanceDb(10, 1), -20, 1e-9) && close(inverseDistanceDb(4, 2), -6.0206, 1e-3),
    'doubling the distance is ' + inverseDistanceDb(2, 1).toFixed(2) + ' dB');

  report('directivity attenuation', close(directivityAttenuationDb(0, 90), 0, 1e-9) &&
    close(directivityAttenuationDb(45, 90), -6, 1e-9) &&
    close(directivityAttenuationDb(90, 90), -24, 0.1),
    '0 dB on axis, −6.0 dB at the 90° beam edge, ' + directivityAttenuationDb(90, 90).toFixed(1) + ' dB at 90° off');

  report('beamwidth interpolation', close(
    beamwidthAt([{ frequency: 100, widthDeg: 100 }, { frequency: 1000, widthDeg: 50 }], Math.sqrt(100 * 1000)),
    75, 0.2,
  ), '75° half way in log frequency between 100° at 100 Hz and 50° at 1 kHz');

  report('aim vector', close(aimVector({ aimH: 90, aimV: 0 }).x, 1, 1e-9) &&
    close(aimVector({ aimH: 0, aimV: 90 }).z, -1, 1e-9),
    'aiming right points along +x; aiming down points along −z');

  const angles = offAxisAngles({ aimH: 0, aimV: 0, roll: 0 }, { x: 1, y: 1, z: 0 });
  report('off-axis angles', close(angles.total, 45, 1e-6) && close(angles.horizontal, 45, 1e-6) &&
    close(angles.vertical, 0, 1e-6),
    '45° to the side reads 45° horizontal, 0° vertical');
}

/* ---------- the complex sum ---------- */

{
  const project = projectWith([
    { x: 9, y: 10, z: 0 },
    { x: 11, y: 10, z: 0 },
  ]);
  const receiver = { x: 10, y: 10, z: 1.2 };
  const one = levelAt(project, receiver, { onlyIds: ['s-0'] });
  const both = levelAt(project, receiver);
  const gain = both.levelDb - one.levelDb;
  report('coherent sum of two equal sources', close(gain, 6.0206, 0.05),
    one.levelDb.toFixed(2) + ' dB alone, ' + both.levelDb.toFixed(2) +
    ' dB together — +' + gain.toFixed(2) + ' dB');

  const samePhase = both.phaseValid;
  report('the sum keeps phase', samePhase,
    'both datasets carry phase, so the sum reports a phase');
}

{
  const project = projectWith([
    { x: 9, y: 10, z: 0, polarity: 'inverted' },
    { x: 11, y: 10, z: 0 },
  ]);
  const receiver = { x: 10, y: 10, z: 1.2 };
  const one = levelAt(project, receiver, { onlyIds: ['s-0'] });
  const both = levelAt(project, receiver);
  report('polarity inversion cancels', both.levelDb - one.levelDb < -60,
    'inverting one cabinet drops the sum by ' + (both.levelDb - one.levelDb).toFixed(1) + ' dB');
}

{
  // A half wavelength of extra path at 1 kHz: 343 / 1000 / 2 = 0.1715 m.
  const base = Math.hypot(1, 1.2);
  const target = base + 343 / 1000 / 2;
  const dx = Math.sqrt(Math.max(0, target * target - 1.44));
  const project = projectWith([
    { x: 9, y: 10, z: 0 },
    { x: 10 + dx, y: 10, z: 0 },
  ]);
  const receiver = { x: 10, y: 10, z: 1.2 };
  const one = levelAt(project, receiver, { onlyIds: ['s-0'] });
  const both = levelAt(project, receiver);
  report('half-wavelength cancellation at 1 kHz', both.levelDb - one.levelDb < -15,
    'path difference ' + (343 / 1000 / 2).toFixed(4) + ' m gives ' +
    (both.levelDb - one.levelDb).toFixed(1) + ' dB against one cabinet');

  const table = arrivalTable(buildContext(project, project.room), receiver);
  report('arrivals follow the path', table.ok && close(table.spanMs,
    (propagationDelayMs(target, 343) - propagationDelayMs(base, 343)), 0.01),
    'span ' + table.spanMs.toFixed(3) + ' ms between the two arrivals');
}

{
  // 1 ms of delay is 360° at 1 kHz: the sum is unchanged. At 500 Hz it is 180°.
  const project = projectWith([
    { x: 9, y: 10, z: 0, delayMs: 1 },
    { x: 11, y: 10, z: 0 },
  ]);
  const receiver = { x: 10, y: 10, z: 1.2 };
  const reference = projectWith([
    { x: 9, y: 10, z: 0 },
    { x: 11, y: 10, z: 0 },
  ]);
  const atOneK = levelAt(project, receiver, { frequencies: [1000], band: { min: 1000, max: 1000 } });
  const atOneKReference = levelAt(reference, receiver, { frequencies: [1000], band: { min: 1000, max: 1000 } });
  const atFiveHundred = levelAt(project, receiver, { frequencies: [500], band: { min: 500, max: 500 } });
  const atFiveHundredReference = levelAt(reference, receiver, { frequencies: [500], band: { min: 500, max: 500 } });
  report('delay is frequency dependent', close(atOneK.levelDb, atOneKReference.levelDb, 0.01) &&
    atFiveHundred.levelDb - atFiveHundredReference.levelDb < -20,
    '1 ms leaves 1 kHz alone (' + (atOneK.levelDb - atOneKReference.levelDb).toFixed(2) +
    ' dB) and cancels 500 Hz (' + (atFiveHundred.levelDb - atFiveHundredReference.levelDb).toFixed(1) + ' dB)');
}

{
  const project = projectWith([
    { x: 9, y: 10, z: 0 },
    { x: 11, y: 10, z: 0, gainDb: -6 },
  ]);
  const receiver = { x: 10, y: 10, z: 1.2 };
  const one = levelAt(project, receiver, { onlyIds: ['s-0'] });
  const both = levelAt(project, receiver);
  const expected = 20 * Math.log10(Math.abs(1 + Math.pow(10, -6 / 20)));
  report('gain is applied before the sum', close(both.levelDb - one.levelDb, expected, 0.02),
    '−6 dB on one cabinet gives ' + (both.levelDb - one.levelDb).toFixed(2) + ' dB, as ' +
    expected.toFixed(2) + ' dB expects');
}

/* ---------- directivity in the prediction ---------- */

{
  const project = projectWith([
    { x: 10, y: 5, z: 2, aimH: 0, aimV: 0 },
  ], { directivity: [{ frequency: 1000, widthDeg: 90 }] });
  const context = buildContext(project, project.room);
  const onAxis = predictResponse(context, { x: 10, y: 15, z: 2 }, { frequencies: [1000], band: { min: 1000, max: 1000 } });
  const edge = predictResponse(context, { x: 10 + 7.071, y: 5 + 7.071, z: 2 },
    { frequencies: [1000], band: { min: 1000, max: 1000 } });
  report('beamwidth costs 6 dB at its edge', close(onAxis.levelDb - edge.levelDb, 6, 0.05),
    'on axis ' + onAxis.levelDb.toFixed(2) + ' dB, at 45° off ' + edge.levelDb.toFixed(2) +
    ' dB — ' + (onAxis.levelDb - edge.levelDb).toFixed(2) + ' dB');

  const contribution = contributionAt(context.speakers[0], { x: 10 + 7.071, y: 5 + 7.071, z: 2 }, [1000], {});
  report('off-axis angle reported', close(contribution.angles.total, 45, 0.2) &&
    contribution.hasDirectivity,
    contribution.angles.total.toFixed(2) + '° off axis, beamwidth ' + contribution.beamwidthDeg + '°');
}

/* ---------- the heat map ---------- */

{
  const project = projectWith([
    { x: 4, y: 0, z: 0, role: 'main' },
    { x: 16, y: 0, z: 0, role: 'main' },
  ]);
  const context = buildContext(project, project.room);
  const reference = { x: 10, y: 15, z: 1.2, name: 'Reference' };
  const map = computeHeatmap(context, {
    metric: 'level', bandMode: 'third', frequencyHz: 1000,
    normalizeTo: 'reference', reference, uniformityDb: 3,
  });
  report('heat map covers the audience', map.ok && map.cols >= 16 && map.computed > 100,
    map.cols + ' × ' + map.rows + ' cells, ' + map.computed + ' inside the audience');

  let finite = true;
  let outsideMarked = true;
  for (let index = 0; index < map.values.length; index += 1) {
    if (map.inside[index] && !Number.isFinite(map.values[index])) finite = false;
    if (!map.inside[index] && Number.isFinite(map.values[index])) outsideMarked = false;
  }
  report('heat map values only where there is audience', finite && outsideMarked,
    'every audience cell has a value and no other cell does');

  report('reference normalisation', close(map.offsetDb, map.statistics.referenceDb, 1e-9),
    'the map is normalised to the reference point at ' + map.offsetDb.toFixed(2) + ' dB');

  // A point between the two cabinets is louder than a point outside them.
  const middle = predictResponse(context, { x: 10, y: 6, z: 1.2 }, { frequencies: [1000], band: { min: 1000, max: 1000 } });
  const side = predictResponse(context, { x: 1, y: 6, z: 1.2 }, { frequencies: [1000], band: { min: 1000, max: 1000 } });
  report('coverage falls away from the pair', middle.levelDb > side.levelDb + 3,
    'centre ' + middle.levelDb.toFixed(1) + ' dB, edge ' + side.levelDb.toFixed(1) + ' dB');

  const deviation = computeHeatmap(context, {
    metric: 'deviation', bandMode: 'octave', frequencyHz: 1000, reference, uniformityDb: 3,
  });
  let meanOfDeviation = 0;
  let count = 0;
  for (const value of deviation.values) {
    if (!Number.isFinite(value)) continue;
    meanOfDeviation += value;
    count += 1;
  }
  meanOfDeviation /= Math.max(1, count);
  report('deviation map has a zero mean', close(meanOfDeviation, 0, 0.2),
    'mean ' + meanOfDeviation.toFixed(3) + ' dB across ' + count + ' cells');

  const arrival = computeHeatmap(context, { metric: 'arrival', bandMode: 'third', frequencyHz: 1000, reference });
  let minArrival = Infinity;
  let maxArrival = -Infinity;
  for (const value of arrival.values) {
    if (!Number.isFinite(value)) continue;
    minArrival = Math.min(minArrival, value);
    maxArrival = Math.max(maxArrival, value);
  }
  report('arrival map is in milliseconds', minArrival > 10 && maxArrival < 200 && minArrival < maxArrival,
    minArrival.toFixed(1) + '–' + maxArrival.toFixed(1) + ' ms across the audience');
}

{
  const project = projectWith([
    { x: 8, y: 1, z: 0, role: 'sub' },
    { x: 12, y: 1, z: 0, role: 'sub' },
  ]);
  const context = buildContext(project, project.room);
  const map = computeHeatmap(context, { metric: 'interference', bandMode: 'third', frequencyHz: 80 });
  let any = false;
  let min = Infinity;
  for (const value of map.values) {
    if (!Number.isFinite(value)) continue;
    any = true;
    min = Math.min(min, value);
  }
  report('sub interference map', map.ok && any && min < 0,
    'coherent against incoherent: as much as ' + min.toFixed(1) + ' dB of cancellation between the two subwoofers');

  const mains = projectWith([
    { x: 4, y: 2, z: 4, role: 'main' },
    { x: 16, y: 2, z: 4, role: 'main' },
  ]);
  const difference = computeHeatmap(buildContext(mains, mains.room), {
    metric: 'difference', bandMode: 'third', frequencyHz: 1000,
  });
  let differenceAny = false;
  let leftLouder = false;
  let rightLouder = false;
  let index = 0;
  for (const value of difference.values) {
    if (Number.isFinite(value)) {
      differenceAny = true;
      const col = index % difference.cols;
      const x = difference.bounds.minX + ((col + 0.5) * (difference.bounds.maxX - difference.bounds.minX)) / difference.cols;
      if (x < 5 && value > 3) leftLouder = true;
      if (x > 15 && value < -3) rightLouder = true;
    }
    index += 1;
  }
  report('left/right difference map', difference.ok && differenceAny && leftLouder && rightLouder,
    'split by the room centre into “' + difference.labels.left + '” and “' +
    difference.labels.right + '”, louder under each cabinet');
}

/* ---------- arrivals and delays ---------- */

{
  const project = projectWith([
    { x: 10, y: 0, z: 0 },
    { x: 10, y: 10, z: 0 },
  ]);
  const context = buildContext(project, project.room);
  const table = arrivalTable(context, { x: 10, y: 20, z: 0 });
  report('arrival table', table.ok && table.rows.length === 2 &&
    close(table.rows[0].distanceM, 10, 1e-9) && close(table.rows[1].distanceM, 20, 1e-9),
    '10 m and 20 m to the receiver');
  report('delay suggestion', close(table.rows[0].suggestedAddMs, propagationDelayMs(20, 343) - propagationDelayMs(10, 343), 1e-6) &&
    table.rows[1].suggestedAddMs < 1e-9,
    'the nearer cabinet wants +' + table.rows[0].suggestedAddMs.toFixed(2) + ' ms');
  report('the suggestion is labelled geometric', table.message.includes('geometric'),
    'the note says the delay is geometric, not an acoustic alignment');
}

/* ---------- the array tools ---------- */

{
  const broadside = arrayLayout('broadside', { count: 4, spacingM: 1.5, speedOfSound: 343, frequencyHz: 80 });
  report('broadside layout', broadside.entries.length === 4 &&
    close(broadside.entries[0].xM, -2.25, 1e-9) && close(broadside.entries[3].xM, 2.25, 1e-9) &&
    broadside.entries.every((entry) => entry.delayMs === 0),
    'four boxes 1.5 m apart, centred, all in phase');

  const endfire = arrayLayout('endfire', { count: 4, spacingM: 1, speedOfSound: 343, frequencyHz: 80 });
  report('end-fire delays', close(endfire.entries[0].delayMs, 0, 1e-9) &&
    close(endfire.entries[3].delayMs, (3 * 1000) / 343, 1e-6) &&
    close(endfire.entries[3].yM, 3, 1e-9),
    'each cabinet 1 m further back carries ' + ((1000 / 343)).toFixed(2) + ' ms more delay');

  const cardioid = arrayLayout('cardioid', { count: 4, spacingM: 1, speedOfSound: 343, frequencyHz: 80 });
  const fronts = cardioid.entries.filter((entry) => entry.index % 2 === 0);
  const backs = cardioid.entries.filter((entry) => entry.index % 2 === 1);
  report('cardioid pairs', fronts.every((entry) => entry.polarity === 'normal' && entry.delayMs === 0) &&
    backs.every((entry) => entry.polarity === 'inverted' && entry.delayMs > 0),
    'the rear cabinet of each pair is delayed ' + backs[0].delayMs.toFixed(2) + ' ms and inverted');

  const lr = arrayLayout('lr', { count: 4, spacingM: 1, halfWidthM: 5, speedOfSound: 343, frequencyHz: 80 });
  report('left / right stacks', lr.entries.filter((entry) => entry.xM < 0).length === 2 &&
    lr.entries.filter((entry) => entry.xM > 0).length === 2,
    'two boxes each side, 5 m out');

  const quarter = arrayLayout('endfire', { count: 2, speedOfSound: 343, frequencyHz: 80 });
  report('quarter-wave default spacing', close(quarter.spacingM, 343 / 80 / 4, 0.01),
    'at 80 Hz the quarter wave is ' + quarter.spacingM.toFixed(3) + ' m');
}

/* ---------- the shared DSP engine ---------- */

{
  const project = projectWith([
    { x: 10, y: 2, z: 0 },
  ]);
  const receiver = { x: 10, y: 20, z: 1.2 };
  const before = levelAt(project, receiver).levelDb;
  project.sources[0].gainDb = -6;
  const after = levelAt(project, receiver).levelDb;
  report('gain changes the prediction', close(after - before, -6, 1e-6),
    'the modeler’s source gain moves the predicted level by ' + (after - before).toFixed(2) + ' dB');
}

/* ---------- performance ---------- */

{
  const speakers = [];
  for (let i = 0; i < 8; i += 1) {
    speakers.push({ name: 'Sub ' + (i + 1), role: 'sub', x: 2 + i * 2.2, y: 1.5, z: 0.4 });
  }
  for (let i = 0; i < 8; i += 1) {
    speakers.push({
      name: 'Main ' + (i + 1), role: 'main', x: 2 + i * 2.2, y: 2.5, z: 5,
      aimH: 0, aimV: -10,
    });
  }
  const project = projectWith(speakers);
  const start = performance.now();
  const context = buildContext(project, project.room);
  const mid = performance.now();
  const response = predictResponse(context, { x: 10, y: 15, z: 1.2 },
    { frequencies: gridFrequencies(GRID_POINTS) });
  const afterResponse = performance.now();
  const map = computeHeatmap(context, {
    metric: 'level', bandMode: 'third', frequencyHz: 1000, cols: 56,
    reference: { x: 10, y: 15, z: 1.2 },
  });
  const afterMap = performance.now();
  report('sixteen sources predict without stalling',
    context.speakers.length === 16 && response.ok && map.ok &&
    (afterMap - start) < 1500,
    'context ' + (mid - start).toFixed(1) + ' ms, 400-point response ' +
    (afterResponse - mid).toFixed(1) + ' ms, ' + map.cols + '×' + map.rows +
    ' map ' + (afterMap - afterResponse).toFixed(0) + ' ms');
}

/* ---------- what the engine refuses to claim ---------- */

{
  const room = emptyRoom('Empty');
  const project = projectWith([]);
  const context = buildContext(project, room);
  report('no sources, no prediction', !context.ok,
    'a room with no placed source reports nothing rather than an empty map');

  const unplaced = projectWith([{ x: 0, y: 0, z: 0 }]);
  unplaced.sources[0].room = null;
  const unplacedContext = buildContext(unplaced, unplaced.room);
  report('an unplaced source is named', unplacedContext.unplaced.length === 1 &&
    unplacedContext.warnings[0].includes('not placed'),
    unplacedContext.warnings[0]);
}

console.log('');
console.log(passed + ' passed · ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
