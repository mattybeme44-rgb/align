/*
 * System Data Modeler checks, run with Node:
 *
 *   node tests/modeler.mjs
 *
 * Synthetic data with known answers throughout: two sources that must sum to
 * +6.02 dB, a pair that must cancel, a known delay that must read back as
 * group delay, crossovers that must sit at their documented level, a file that
 * must be read by its columns and refused when it is not a response, and an
 * optimizer that must find a delay it was given. Nothing here is a live
 * measurement or a loudspeaker, and no check here is evidence about a room.
 */

import {
  GRID_POINTS,
  compareCurves,
  fractionalOctaveSmooth,
  gridFrequencies,
  parseResponseText,
  resampleResponse,
  wrapDegrees,
} from '../js/modeler/curve.js';
import { chainResponse, designCrossover } from '../js/modeler/filters.js';
import { parseClf, clfResponse } from '../js/modeler/clf.js';
import { buildLpif, lpifText } from '../js/modeler/lpif.js';
import { analysePair } from '../js/modeler/analysis.js';
import {
  effectiveSettings,
  evaluateSnapshot,
  evaluateSystem,
  groupDelay,
  normalizeDataset,
  optimizeAlignment,
  optimizeMultiPosition,
  spatialAverageResponses,
  sumResponses,
  synthesizeImpulse,
} from '../js/modeler/model.js';
import { impulseToResponse, parseWav } from '../js/modeler/wav.js';

let passed = 0;
let failed = 0;

function report(name, pass, detail) {
  if (pass) passed += 1;
  else failed += 1;
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + ' — ' + detail);
}

function approx(value, expected, tolerance) {
  return Number.isFinite(value) && Math.abs(value - expected) <= tolerance;
}

/** One complex response on the grid, with the level and phase it is given. */
function modelResponse(phaseFn, magDbValue = 0) {
  const frequencies = gridFrequencies(GRID_POINTS);
  const count = frequencies.length;
  const magDb = new Float64Array(count).fill(magDbValue);
  const phaseDeg = new Float64Array(count);
  const re = new Float64Array(count);
  const im = new Float64Array(count);
  const linear = Math.pow(10, magDbValue / 20);
  for (let i = 0; i < count; i += 1) {
    const phase = phaseFn ? phaseFn(frequencies[i]) : 0;
    phaseDeg[i] = (phase * 180) / Math.PI;
    re[i] = linear * Math.cos(phase);
    im[i] = linear * Math.sin(phase);
  }
  return { frequencies, magDb, phaseDeg, re, im, phaseValid: true, id: 'test', name: 'test' };
}

function nearest(response, frequency) {
  let best = 0;
  for (let i = 0; i < response.frequencies.length; i += 1) {
    if (Math.abs(response.frequencies[i] - frequency) <
      Math.abs(response.frequencies[best] - frequency)) best = i;
  }
  return best;
}

/* 1. Two coherent sources add as pressure, not as decibel magnitudes. */
{
  const sum = sumResponses([modelResponse(null, 0), modelResponse(null, 0)]);
  const index = nearest(sum, 1000);
  report('Two coherent sources sum to +6.02 dB', approx(sum.magDb[index], 6.0206, 0.01),
    'sum at 1 kHz ' + sum.magDb[index].toFixed(3) + ' dB');
}

/* 2. Two curves that read the same can cancel completely. */
{
  const a = modelResponse(null, 0);
  const b = modelResponse(() => Math.PI, 0);
  const sum = sumResponses([a, b]);
  const index = nearest(sum, 1000);
  report('Identical levels and opposite phase cancel',
    sum.magDb[index] < -120 && approx(a.magDb[index], b.magDb[index], 1e-9),
    'both read 0.0 dB, the complex sum ' + sum.magDb[index].toFixed(0) + ' dB');
}

/* 3. Polarity turns the phase by 180° and leaves the level alone. */
{
  const normal = modelResponse(null, 0);
  const inverted = modelResponse(() => Math.PI, 0);
  const index = nearest(normal, 1000);
  const turn = Math.abs(wrapDegrees(inverted.phaseDeg[index] - normal.phaseDeg[index]));
  report('Polarity is 180° at the same level',
    approx(turn, 180, 1e-9) && approx(normal.magDb[index], inverted.magDb[index], 1e-9),
    'turned ' + turn.toFixed(3) + '° at the same level');
}

/* 4. A delay in the phase reads back as that delay. */
{
  const response = modelResponse((frequency) => -2 * Math.PI * frequency * 0.002, 0);
  const delays = groupDelay(response.frequencies, response.phaseDeg, response.magDb, {});
  const index = nearest(response, 1000);
  report('A 2 ms delay reads back as 2 ms of group delay', approx(delays[index], 2, 0.01),
    'group delay at 1 kHz ' + delays[index].toFixed(3) + ' ms');
}

/* 5. Timing is left blank where the data cannot support it. */
{
  const response = modelResponse((frequency) => -2 * Math.PI * frequency * 0.002, 0);
  const coherence = new Float64Array(response.frequencies.length).fill(0.9);
  for (let i = 0; i < coherence.length; i += 1) {
    if (response.frequencies[i] > 2000) coherence[i] = 0.1;
  }
  const delays = groupDelay(response.frequencies, response.phaseDeg, response.magDb,
    { coherence, coherenceThreshold: 0.5 });
  const low = nearest(response, 5000);
  const good = nearest(response, 500);
  report('Group delay is blank at low coherence',
    Number.isNaN(delays[low]) && Number.isFinite(delays[good]),
    'low-coherence point blank, usable point ' + delays[good].toFixed(2) + ' ms');
}

/* 6. Linkwitz-Riley is two Butterworth sections: −6 dB at the crossover. */
{
  const design = designCrossover({ family: 'Linkwitz-Riley', slope: 24, frequency: 1000, type: 'highPass' });
  const at = design.ok ? chainResponse(design.filters, new Float64Array([1000]), 48000) : null;
  const below = design.ok ? chainResponse(design.filters, new Float64Array([500]), 48000) : null;
  report('A Linkwitz-Riley 4th-order crossover sits 6 dB down',
    !!design.ok && approx(at.magDb[0], -6.0206, 0.15) && below.magDb[0] < -20,
    design.ok ? 'at crossover ' + at.magDb[0].toFixed(2) + ' dB, an octave below ' +
      below.magDb[0].toFixed(1) + ' dB, ' + design.filters.length + ' sections' : design.message);
}

/* 7. The steeper Linkwitz-Riley falls twice as fast. */
{
  const design = designCrossover({ family: 'Linkwitz-Riley', slope: 48, frequency: 1000, type: 'highPass' });
  const at = design.ok ? chainResponse(design.filters, new Float64Array([1000]), 48000) : null;
  const below = design.ok ? chainResponse(design.filters, new Float64Array([500]), 48000) : null;
  report('A Linkwitz-Riley 8th-order crossover is steeper',
    !!design.ok && approx(at.magDb[0], -6.0206, 0.2) && below.magDb[0] < -40,
    design.ok ? 'at crossover ' + at.magDb[0].toFixed(2) + ' dB, an octave below ' +
      below.magDb[0].toFixed(1) + ' dB, ' + design.filters.length + ' sections' : design.message);
}

/* 8. A Butterworth section is −3 dB at its frequency. */
{
  const design = designCrossover({ family: 'Butterworth', slope: 12, frequency: 1000, type: 'highPass' });
  const at = design.ok ? chainResponse(design.filters, new Float64Array([1000]), 48000) : null;
  const below = design.ok ? chainResponse(design.filters, new Float64Array([500]), 48000) : null;
  report('A 2nd-order Butterworth crossover sits 3 dB down',
    !!design.ok && approx(at.magDb[0], -3.0103, 0.1) && below.magDb[0] < -10,
    design.ok ? 'at crossover ' + at.magDb[0].toFixed(2) + ' dB, an octave below ' +
      below.magDb[0].toFixed(1) + ' dB' : design.message);
}

/* 9. A band-pass passes its band and stops outside it. */
{
  const design = designCrossover({
    family: 'Butterworth', slope: 12, frequency: 100, lowFrequency: 1000, type: 'bandPass',
  });
  const at = design.ok
    ? chainResponse(design.filters, new Float64Array([20, 100, 1000, 5000]), 48000)
    : null;
  report('A band-pass passes its band and stops outside it',
    !!design.ok && approx(at.magDb[1], -3.0103, 0.3) && approx(at.magDb[2], -3.0103, 0.3) &&
      at.magDb[0] < -10 && at.magDb[3] < -10,
    design.ok ? at.magDb.map((value) => value.toFixed(1)).join(' / ') + ' dB' : design.message);
}

/* 10. Bessel is offered only at the orders that have a known section set. */
{
  const good = designCrossover({ family: 'Bessel', slope: 24, frequency: 100, type: 'lowPass' });
  const bad = designCrossover({ family: 'Bessel', slope: 6, frequency: 100, type: 'lowPass' });
  report('Bessel is refused at an order it cannot design',
    good.ok && !bad.ok, good.filters.length + ' sections at 24 dB/oct, refused at 6 dB/oct');
}

/* 11. The optimizer recovers a delay it was given. */
{
  const reference = modelResponse(null, 0);
  const target = modelResponse((frequency) => -2 * Math.PI * frequency * 0.002, 0);
  const result = optimizeAlignment({
    reference, target, band: { min: 200, max: 1000 },
    delay: { min: -10, max: 10, stepMs: 0.05 }, polarity: 'normal', objective: 'sum',
  });
  report('The optimizer finds a known 2 ms delay',
    result.ok && approx(result.best.delayMs, -2, 0.1),
    result.ok ? 'recommended ' + result.best.delayMs.toFixed(2) + ' ms, predicted ' +
      result.best.gainDb.toFixed(2) + ' dB' : result.message);
}

/* 12. A polarity flip is found as readily as a delay. */
{
  const reference = modelResponse(null, 0);
  const target = modelResponse(() => Math.PI, 0);
  const result = optimizeAlignment({
    reference, target, band: { min: 200, max: 1000 },
    delay: { min: -2, max: 2, stepMs: 0.05 }, polarity: 'auto', objective: 'sum',
  });
  report('The optimizer finds an inverted polarity',
    result.ok && result.best.polarity === 'inverted' && result.alternatives.length > 0,
    result.ok ? result.best.polarity + ' at ' + result.best.delayMs.toFixed(2) + ' ms, ' +
      result.alternatives.length + ' alternatives' : result.message);
}

/* 13. A phase objective is refused when a source carries no phase. */
{
  const reference = modelResponse(null, 0);
  const target = modelResponse(null, 0);
  target.phaseValid = false;
  const result = optimizeAlignment({
    reference, target, band: { min: 200, max: 1000 },
    delay: { min: -2, max: 2, stepMs: 0.05 }, polarity: 'normal', objective: 'phase',
  });
  report('A phase objective is refused without measured phase', !result.ok,
    result.message || 'accepted a magnitude-only source');
}

/* 14. Smoothing may not tilt a curve that has no shape. */
{
  const smoothed = fractionalOctaveSmooth(new Float64Array(GRID_POINTS).fill(-12), 1 / 3, GRID_POINTS);
  let worst = 0;
  for (const value of smoothed) worst = Math.max(worst, Math.abs(value + 12));
  report('Fractional-octave smoothing keeps a flat curve flat', worst < 1e-9,
    'largest change ' + worst.toExponential(2) + ' dB');
}

/* 15. A response file is read by its columns, with a comment header. */
{
  const lines = ['# frequency magnitude phase'];
  for (let i = 0; i < 12; i += 1) {
    const frequency = 100 * Math.pow(2, i / 3);
    lines.push(frequency.toFixed(1) + ',' + (-6 + i * 0.5).toFixed(2) + ',' + (i * 10));
  }
  const parsed = parseResponseText(lines.join('\n'));
  report('A response file is read by its columns',
    parsed.ok && parsed.points === 12 && !!parsed.response.phaseDeg && approx(parsed.response.fMin, 100, 0.01),
    parsed.ok ? parsed.points + ' points from ' + parsed.response.fMin.toFixed(1) + ' Hz, phase ' +
      (parsed.response.phaseDeg ? 'kept' : 'dropped') : parsed.message);
}

/* 16. A tab-separated file and a semicolon file are read the same way. */
{
  const tab = [];
  const semicolon = ['Frequency;Magnitude;Phase'];
  for (let i = 0; i < 10; i += 1) {
    const frequency = 200 * Math.pow(2, i / 3);
    tab.push(frequency.toFixed(1) + '\t' + (-2).toFixed(1));
    semicolon.push(frequency.toFixed(1) + ';' + (-2).toFixed(1) + ';' + (i * 5));
  }
  const tabbed = parseResponseText(tab.join('\n'));
  const semicolons = parseResponseText(semicolon.join('\n'));
  report('Tab and semicolon files are read by their own separator',
    tabbed.ok && semicolons.ok && tabbed.points === 10 && semicolons.points === 10 &&
      !!semicolons.response.phaseDeg,
    'tab ' + tabbed.points + ' points, semicolon ' + semicolons.points +
      ' with phase ' + !!semicolons.response.phaseDeg);
}

/* 17. No phase is invented for a magnitude-only file. */
{
  const lines = [];
  for (let i = 0; i < 20; i += 1) {
    lines.push((100 * Math.pow(2, i / 4)).toFixed(1) + ' ' + (-3).toFixed(1));
  }
  const parsed = parseResponseText(lines.join('\n'));
  report('A magnitude-only file stays magnitude-only',
    parsed.ok && parsed.response.phaseDeg === null,
    parsed.response && parsed.response.phaseDeg ? 'phase was invented' : 'magnitude only');
}

/* 18. A file that is not a response is refused whole. */
{
  const parsed = parseResponseText('100 0\n200 0\n400 0');
  report('A file too short to be a response is refused', !parsed.ok,
    parsed.ok ? 'accepted a 3-row file' : parsed.message);
}

/* 19. Phase wrapping stays inside ±180°. */
{
  const wrapped = [370, -190, 180, -180].map(wrapDegrees);
  report('Phase wrapping stays inside ±180°',
    approx(wrapped[0], 10, 1e-9) && approx(wrapped[1], 170, 1e-9) &&
      wrapped[2] === 180 && wrapped[3] === -180,
    wrapped.join('°, ') + '°');
}

/* 20. A phase curve is unwrapped, then interpolated linearly in frequency. */
{
  const resampled = resampleResponse({ frequencies: [100, 1000], magDb: [0, 0], phaseDeg: [170, -170] });
  let index = 0;
  if (resampled.ok) {
    for (let i = 0; i < resampled.grid.length; i += 1) {
      if (Math.abs(resampled.grid[i] - 550) < Math.abs(resampled.grid[index] - 550)) index = i;
    }
  }
  report('Phase is unwrapped before it is interpolated',
    resampled.ok && approx(resampled.phaseDeg[index], 180, 1),
    resampled.ok ? 'phase near 550 Hz ' + resampled.phaseDeg[index].toFixed(1) + '°' : resampled.message);
}

/* 21. The derived impulse is labelled and lands at the window's origin. */
{
  const sum = sumResponses([modelResponse(null, 0)]);
  const transformed = synthesizeImpulse(sum, { sampleRate: 48000, bins: 4096, beforeMs: 5, stepMs: 1 });
  let peakIndex = 0;
  if (transformed.ok) {
    for (let i = 1; i < transformed.envelope.values.length; i += 1) {
      if (transformed.envelope.values[i] > transformed.envelope.values[peakIndex]) peakIndex = i;
    }
  }
  report('The derived impulse sits at the window origin',
    transformed.ok && approx(transformed.envelope.values[peakIndex], 0, 0.5) && peakIndex === 5,
    transformed.ok ? 'peak at ' + (transformed.envelope.startMs + peakIndex * transformed.envelope.stepMs) +
      ' ms, ' + transformed.envelope.values[peakIndex].toFixed(2) + ' dB' : transformed.message);
}

/* 22. A WAV impulse is read and transformed at its own arrival. */
{
  const frames = 48000;
  const arrival = 500;
  const samples = new Float32Array(frames);
  for (let k = -8; k <= 8; k += 1) samples[arrival + k] = Math.exp(-(k * k) / 8);
  const buffer = new ArrayBuffer(44 + frames * 4);
  const view = new DataView(buffer);
  const tag = (offset, text) => {
    for (let i = 0; i < 4; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + frames * 4, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 48000, true);
  view.setUint32(28, 48000 * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  tag(36, 'data');
  view.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i += 1) view.setFloat32(44 + i * 4, samples[i], true);

  const parsed = parseWav(buffer);
  const transformed = parsed.ok
    ? impulseToResponse(parsed.samples, parsed.sampleRate, { beforeMs: 1, widthMs: 20 })
    : { ok: false, message: parsed.message };
  report('A WAV impulse is read at its own arrival',
    transformed.ok && approx(transformed.peakMs, (arrival / 48000) * 1000, 0.05) &&
      !!transformed.response.phaseDeg,
    transformed.ok ? 'peak ' + transformed.peakMs.toFixed(3) + ' ms, ' +
      transformed.response.points + ' points' : transformed.message);
}

/* 23. A 16-bit PCM WAV is read sample for sample. */
{
  const frames = 4800;
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  const tag = (offset, text) => {
    for (let i = 0; i < 4; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + frames * 2, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 48000, true);
  view.setUint32(28, 96000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, frames * 2, true);
  view.setInt16(44 + 100 * 2, 32767, true);
  const parsed = parseWav(buffer);
  report('A 16-bit PCM WAV is read sample for sample',
    parsed.ok && parsed.frames === frames && approx(parsed.samples[100], 1, 1e-4),
    parsed.ok ? parsed.frames + ' frames, the peak reads ' + parsed.samples[100].toFixed(3) : parsed.message);
}

/* 24. Each filter is the transfer function it claims to be. */
{
  const lowPass = chainResponse(
    [{ kind: 'lowPass', frequency: 1000, q: 0.7071, gainDb: 0, enabled: true }],
    new Float64Array([100, 1000, 10000]), 48000);
  const allPass = chainResponse(
    [{ kind: 'allPass2', frequency: 1000, q: 0.7071, gainDb: 0, enabled: true }],
    new Float64Array([100, 1000, 10000]), 48000);
  const peaking = chainResponse(
    [{ kind: 'peaking', frequency: 1000, q: 2, gainDb: 6, enabled: true }],
    new Float64Array([1000]), 48000);
  const bypassed = chainResponse([
    { kind: 'peaking', frequency: 1000, q: 2, gainDb: 6, enabled: true },
    { kind: 'peaking', frequency: 1000, q: 2, gainDb: 6, enabled: false },
  ], new Float64Array([1000]), 48000);
  const flat = Math.max(Math.abs(allPass.magDb[0]), Math.abs(allPass.magDb[1]), Math.abs(allPass.magDb[2]));
  report('Each filter is the complex transfer function it claims',
    approx(lowPass.magDb[0], 0, 0.1) && approx(lowPass.magDb[1], -3.0103, 0.2) &&
      lowPass.magDb[2] < -35 && flat < 1e-6 && approx(peaking.magDb[0], 6, 0.05) &&
      approx(bypassed.magDb[0], 6, 0.05),
    'low-pass ' + lowPass.magDb.map((value) => value.toFixed(1)).join('/') +
      ', all-pass flat to ' + flat.toExponential(1) + ' dB, peaking ' + peaking.magDb[0].toFixed(2) + ' dB');
}

/* 25. A prediction is compared with a measurement band by band. */
{
  const predicted = modelResponse(null, 0);
  const measured = modelResponse(null, 3);
  const stats = compareCurves(predicted, measured, { min: 200, max: 2000 });
  report('A prediction is compared with a measurement band by band',
    approx(stats.meanDb, 3, 0.02) && approx(stats.rmsDb, 3, 0.02) && approx(stats.worstDb, 3, 0.02),
    'mean ' + stats.meanDb.toFixed(2) + ' dB, rms ' + stats.rmsDb.toFixed(2) +
      ' dB over ' + stats.count + ' points');
}

/* 26. Free-field distance costs level and adds travel time. */
{
  const settings = effectiveSettings(
    { gainDb: 0, delayMs: 0, polarity: 'normal', distanceM: 2 },
    null,
    { enabled: true, referenceDistanceM: 1, speedOfSound: 343 },
  );
  report('Free-field distance costs 6.02 dB and adds 2.92 ms',
    approx(settings.freeFieldGainDb, -6.0206, 0.01) && approx(settings.freeFieldDelayMs, 2.9155, 0.01),
    settings.freeFieldGainDb.toFixed(2) + ' dB, ' + settings.freeFieldDelayMs.toFixed(2) + ' ms');
}

/* 27. A group adds to a source without overwriting it. */
{
  const settings = effectiveSettings(
    { gainDb: -3, delayMs: 1, polarity: 'normal' },
    { gainDb: 2, delayMs: 0.5, polarity: 'inverted' },
    { enabled: false },
  );
  report('A group adds to its source without overwriting it',
    approx(settings.gainDb, -1, 1e-9) && approx(settings.delayMs, 1.5, 1e-9) && settings.inverted,
    'effective ' + settings.gainDb + ' dB, ' + settings.delayMs + ' ms, inverted');
}

/* 28. A filter gives its answer at every supported sample rate. */
{
  const design = designCrossover({ family: 'Linkwitz-Riley', slope: 24, frequency: 1000, type: 'highPass' });
  const at48 = design.ok ? chainResponse(design.filters, new Float64Array([1000]), 48000) : null;
  const at44 = design.ok ? chainResponse(design.filters, new Float64Array([1000]), 44100) : null;
  const at96 = design.ok ? chainResponse(design.filters, new Float64Array([1000]), 96000) : null;
  report('A crossover reads −6 dB at 44.1, 48 and 96 kHz',
    !!design.ok && approx(at48.magDb[0], -6.02, 0.2) && approx(at44.magDb[0], -6.02, 0.2) &&
      approx(at96.magDb[0], -6.02, 0.2),
    design.ok ? [at44.magDb[0], at48.magDb[0], at96.magDb[0]]
      .map((value) => value.toFixed(2)).join(' / ') + ' dB' : design.message);
}

/* 29. A file whose frequencies are not in order is sorted before it is modelled. */
{
  const lines = [];
  for (let i = 11; i >= 0; i -= 1) {
    lines.push((100 * Math.pow(2, i / 3)).toFixed(1) + ' ' + (-6 - i * 0.2).toFixed(2) + ' ' + (i * 9));
  }
  const parsed = parseResponseText(lines.join('\n'));
  const resampled = parsed.ok ? resampleResponse(parsed.response) : null;
  report('An unsorted response is put in order first',
    parsed.ok && parsed.response.fMin < parsed.response.fMax && resampled && resampled.ok,
    parsed.ok ? 'read ' + parsed.points + ' points, ' + parsed.response.fMin.toFixed(0) + ' – ' +
      parsed.response.fMax.toFixed(0) + ' Hz' : parsed.message);
}

/* 30. Two datasets that cannot be summed are warned about, not silently combined. */
{
  const curve = {
    magDb: Array.from(gridFrequencies(GRID_POINTS), () => -3),
    phaseDeg: Array.from(gridFrequencies(GRID_POINTS), () => 0),
    coherence: Array.from(gridFrequencies(GRID_POINTS), () => 0.9),
  };
  const dataset = (id, reference, sampleRate) => normalizeDataset({
    id,
    label: id,
    curve,
    sampleRate,
    conditions: { reference },
  });
  const first = dataset('a', 'loopback', 48000);
  const second = dataset('b', 'internal', 44100);
  if (!first || !second) {
    report('Incompatible datasets are warned about', false, 'test datasets could not be built');
  } else {
    const model = { id: 'm', name: 'm', datasets: [first, second] };
    const project = {
      models: [model],
      sources: [
        { id: 's1', modelId: 'm', datasetId: 'a', name: 'A', filters: [] },
        { id: 's2', modelId: 'm', datasetId: 'b', name: 'B', filters: [] },
      ],
      groups: [],
      positions: [{ id: 'centre', label: 'Centre', weight: 1 }],
      settings: {},
    };
    const evaluation = evaluateSystem(project, { positionId: 'centre' });
    const same = evaluateSystem({
      ...project,
      models: [{ id: 'm', name: 'm', datasets: [first, dataset('c', 'loopback', 48000)] }],
      sources: [{ id: 's1', modelId: 'm', datasetId: 'a', name: 'A', filters: [] }],
    }, { positionId: 'centre' });
    report('Incompatible datasets are warned about',
      evaluation.warnings.length >= 2 && same.warnings.every((warning) => !/sample rates/.test(warning)),
      evaluation.warnings.length + ' warning(s) for a mixed pair, ' +
        same.warnings.length + ' for one dataset');
  }
}

/* 31. One delay serves every measuring position, weighted by each one. */
{
  const reference = modelResponse(null, 0);
  const first = modelResponse((frequency) => -2 * Math.PI * frequency * 0.002, 0);
  const second = modelResponse((frequency) => -2 * Math.PI * frequency * 0.002, 0);
  const result = optimizeMultiPosition({
    pairs: [
      { reference, target: first, weight: 3, label: 'Front' },
      { reference, target: second, weight: 1, label: 'Rear' },
    ],
    band: { min: 200, max: 1000 },
    delay: { min: -10, max: 10, stepMs: 0.1 },
    polarity: 'normal',
    objective: 'sum',
  });
  report('One delay serves every position at once',
    result.ok && approx(result.best.delayMs, -2, 0.2) && result.perPosition.length === 2,
    result.ok ? 'common ' + result.best.delayMs.toFixed(2) + ' ms across ' +
      result.perPosition.length + ' positions, ' + result.confidence.level : result.message);
}

/* 31b. When positions disagree, the common delay is a compromise and says so. */
{
  const reference = modelResponse(null, 0);
  const first = modelResponse((frequency) => -2 * Math.PI * frequency * 0.002, 0);
  const second = modelResponse((frequency) => -2 * Math.PI * frequency * 0.004, 0);
  const result = optimizeMultiPosition({
    pairs: [
      { reference, target: first, weight: 1, label: 'Front' },
      { reference, target: second, weight: 1, label: 'Rear' },
    ],
    band: { min: 200, max: 1000 },
    delay: { min: -10, max: 10, stepMs: 0.1 },
    polarity: 'normal',
    objective: 'sum',
  });
  const own = result.ok ? result.perPosition.map((position) => position.ownBestDelayMs) : [];
  report('A common delay is a compromise when positions disagree',
    result.ok && approx(own[0], -2, 0.2) && approx(own[1], -4, 0.2) &&
      Math.abs(result.best.delayMs - own[0]) > 0.1 &&
      Math.abs(result.best.delayMs - own[1]) > 0.1,
    result.ok ? 'common ' + result.best.delayMs.toFixed(2) + ' ms against own best ' +
      own.map((value) => value.toFixed(1)).join(' / ') + ' ms' : result.message);
}

/* 32. The sweep and the improvement over the current arrangement are reported. */
{
  const reference = modelResponse(null, 0);
  const target = modelResponse((frequency) => -2 * Math.PI * frequency * 0.002, 0);
  const result = optimizeAlignment({
    reference, target, band: { min: 200, max: 1000 },
    delay: { min: -10, max: 10, stepMs: 0.05 }, polarity: 'normal', objective: 'sum',
  });
  report('The optimizer reports a sweep and the improvement',
    result.ok && result.sweep.length >= 10 && result.improvement.summationDb > 0 &&
      result.before && result.before.gainDb < result.best.gainDb,
    result.ok ? result.sweep.length + ' sweep points, ' +
      result.improvement.summationDb.toFixed(1) + ' dB better than now' : result.message);
}

/* 33. A saved scenario evaluates exactly like the project it was saved from. */
{
  const reference = modelResponse(null, 0);
  const target = modelResponse((frequency) => -2 * Math.PI * frequency * 0.002, 0);
  const frequencies = gridFrequencies(GRID_POINTS);
  const curve = {
    magDb: Array.from(frequencies, (frequency) => -3),
    phaseDeg: Array.from(frequencies, (frequency) => -360 * frequency * 0.001),
    coherence: Array.from(frequencies, () => 0.9),
  };
  const dataset = normalizeDataset({ id: 'd', label: 'd', curve, sampleRate: 48000 });
  const model = { id: 'm', name: 'm', datasets: [dataset] };
  const sources = [
    { id: 's1', modelId: 'm', datasetId: 'd', name: 'A', gainDb: 0, delayMs: 0, polarity: 'normal', filters: [] },
    { id: 's2', modelId: 'm', datasetId: 'd', name: 'B', gainDb: 0, delayMs: 3, polarity: 'normal', filters: [] },
  ];
  const project = {
    models: [model], sources, groups: [],
    positions: [{ id: 'centre', label: 'Centre', weight: 1 }], settings: {},
  };
  const snapshot = {
    id: 'snap', name: 'snap', savedAt: new Date().toISOString(),
    data: { sources, groups: [], positions: project.positions, settings: {} },
  };
  const live = evaluateSystem(project, { positionId: 'centre' });
  const saved = evaluateSnapshot(snapshot, [model], { positionId: 'centre' });
  const liveIndex = live.sum ? nearest({ frequencies: live.sum.frequencies }, 1000) : -1;
  const savedIndex = saved && saved.sum ? nearest({ frequencies: saved.sum.frequencies }, 1000) : -1;
  report('A saved scenario evaluates like the project it came from',
    liveIndex >= 0 && savedIndex >= 0 &&
      approx(live.sum.magDb[liveIndex], saved.sum.magDb[savedIndex], 1e-9),
    liveIndex >= 0 ? 'both read ' + live.sum.magDb[liveIndex].toFixed(3) + ' dB at 1 kHz' : 'no sum');
}

/* ---------- the alignment analysis card ---------- */

const analysisBins = 2049;
const analysisDf = 48000 / 4096;

/** A capture with a known delay, level and polarity. */
function analysisCapture(label, delaySeconds, options = {}) {
  const magDb = new Float64Array(analysisBins);
  const phaseDeg = new Float64Array(analysisBins);
  const coh = new Float64Array(analysisBins).fill(options.coherence !== undefined ? options.coherence : 0.9);
  for (let k = 1; k < analysisBins; k += 1) {
    const frequency = k * analysisDf;
    magDb[k] = 0;
    phaseDeg[k] = -360 * frequency * delaySeconds;
  }
  return {
    label,
    trace: {
      magDb, phaseDeg: options.phase === false ? null : phaseDeg, coh,
      bins: analysisBins, df: analysisDf, fftSize: 4096, sampleRate: 48000,
    },
    arrivalMs: (delaySeconds * 1000),
    polarity: options.polarity || 'normal',
  };
}

/* 41. Two captures that arrive together need no arrival advice. */
{
  const result = analysePair(
    analysisCapture('Capture A', 0),
    analysisCapture('Capture B', 0),
    { band: 'crossover' });
  const summation = result.findings.find((finding) => finding.kind === 'summation');
  report('Captures that arrive together give no arrival advice',
    result.findings.every((finding) => finding.kind !== 'arrival') && !!summation &&
      /within 0.05 ms/.test(result.headline),
    result.usableBands + ' usable bands, headline “' + result.headline + '”');
}

/* 42. A known 2 ms arrival is read with its evidence and a way to verify it. */
{
  const result = analysePair(
    analysisCapture('Capture A', 0),
    analysisCapture('Capture B', 0.002),
    { band: 'crossover' });
  const arrival = result.findings.find((finding) => finding.kind === 'arrival');
  report('A known 2 ms arrival is read and a verification is offered',
    !!arrival && /2\.00 ms/.test(arrival.headline) && arrival.evidence.length >= 2 &&
      /Delay Capture A by 2\.00 ms/.test(arrival.proposal) &&
      !!arrival.expected && !!arrival.verification && /High/.test(arrival.confidence),
    arrival ? arrival.headline + ' · ' + arrival.confidence : 'no arrival finding');
}

/* 43. Opposite polarities are called out as their own finding. */
{
  const result = analysePair(
    analysisCapture('Capture A', 0, { polarity: 'normal' }),
    analysisCapture('Capture B', 0, { polarity: 'inverted' }),
    { band: 'subs' });
  const polarity = result.findings.find((finding) => finding.kind === 'polarity');
  report('Opposite polarities become a finding of their own',
    !!polarity && /opposite polarity/.test(polarity.headline) &&
      /wiring/.test(polarity.proposal) && /summation/.test(polarity.verification),
    polarity ? polarity.headline : 'no polarity finding');
}

/* 44. Low coherence refuses to advise rather than guess. */
{
  const result = analysePair(
    analysisCapture('Capture A', 0, { coherence: 0.1 }),
    analysisCapture('Capture B', 0.002, { coherence: 0.1 }),
    { band: 'crossover' });
  const refusal = result.findings.find((finding) => finding.kind === 'quality');
  report('Low coherence refuses to advise',
    !!refusal && /Not enough usable overlap/.test(refusal.headline) &&
      refusal.confidence === 'Insufficient' && result.findings.length === 1 &&
      /Capture again/.test(result.headline),
    refusal ? refusal.headline + ' — ' + result.usableBands + ' of ' + result.totalBands + ' bands' : 'no refusal');
}

/* 45. A magnitude-only capture is not given an invented phase. */
{
  const result = analysePair(
    analysisCapture('Capture A', 0, { phase: false }),
    analysisCapture('Capture B', 0.002),
    { band: 'lowEnd' });
  report('A magnitude-only capture is not given a phase',
    result.findings.length === 1 && /Not enough usable overlap/.test(result.findings[0].headline),
    result.findings.length + ' finding(s), ' + result.usableBands + ' usable bands');
}

/* ---------- CLF, LPIF, spatial average and the modes ---------- */

const clfText = [
  '<CLF1>',
  '<VERSION>   1   <DRAFT> 11',
  '<MODELNAME>  ETC Ldspk1',
  '<MANUFACTURER> ETC',
  '<DESCRIPTION> Full-range Loudspeaker',
  '<WEB-SITE>   www.etcin.com',
  '<MINBAND> 63',
  '<MAXBAND> 16000',
  '<TYPE> <Passive>',
  '<SENSITIVITY> 89.9  88.7  94.3  93.9  95.4  97.5  90',
  '<SENSITIVITY-INFO> Far-field referenced to 1m',
  '<IMPEDANCE> 3.8  7.5  11.7  10.2  9.8  11.8  17',
  '<6DB-WIDTH-HOR> 360  180  121  66  55  69  58',
  '<MEASUREMENT-DISTANCE> 9',
].join('\n');

/* 35. A CLF file is read by its published keys. */
{
  const clf = parseClf(clfText, 'ETC Ldspk1.cf1');
  const projected = clf.ok ? clfResponse(clf) : null;
  report('A CLF file is read by its published keys',
    clf.ok && clf.manufacturer.name === 'ETC Ldspk1' && clf.manufacturer.maker === 'ETC' &&
      clf.readings.length >= 7 && projected && projected.ok &&
      projected.directivity.length >= 7 &&
      !projected.magDb.some((value) => !Number.isFinite(value)),
    clf.ok ? clf.bands.length + ' bands, ' + clf.readings.length + ' readings, ' +
      projected.directivity.length + ' 6 dB widths' : clf.message);
}

/* 36. A file that is not a CLF is refused whole. */
{
  const clf = parseClf('100 0\n200 0\n400 0', 'not-a-clf.txt');
  report('A file that is not a CLF is refused', !clf.ok,
    clf.ok ? 'accepted a non-CLF file' : clf.message);
}

/* 37. LPIF is written to the published schema. */
{
  const project = {
    models: [],
    sources: [{
      id: 's1', name: 'Low driver', gainDb: -3, delayMs: 1.5, polarity: 'inverted',
      filters: [{ id: 'f1', kind: 'highPass', frequency: 120, gainDb: 0, q: 0.7071, enabled: true }],
    }],
    groups: [],
    positions: [],
    settings: {},
  };
  const built = lpifText(project, { sampleRate: 48000, title: 'Test loudspeaker' });
  const parsed = JSON.parse(built.text);
  const block = parsed.preset['processing-blocks'][0];
  report('LPIF is written to the published schema',
    built.ok && parsed.preset.title === 'Test loudspeaker' &&
      typeof parsed.preset.program === 'string' && !!parsed.preset['date-time'] &&
      block.type === 'output-b' && block['sample-rate'] === 48000 &&
      block.delay === 1.5 && block.invert === true && block.iir[0].type === 'highpass-butterworth',
    built.ok ? block.iir.length + ' IIR filter(s), sample rate ' + block['sample-rate'] : built.message);
}

/* 38. Measured positions average into one response, phase circularly. */
{
  const frequencies = gridFrequencies(GRID_POINTS);
  const trace = (level, phase) => ({
    frequencies,
    magDb: Array.from(frequencies, () => level),
    phaseDeg: phase === null ? null : Array.from(frequencies, () => phase),
    coherence: Array.from(frequencies, () => 0.9),
  });
  const power = spatialAverageResponses([
    { trace: trace(-6, 170), weight: 1 },
    { trace: trace(-6, -170), weight: 1 },
  ], { mode: 'power' });
  const onlyLevels = spatialAverageResponses([
    { trace: trace(-6, null), weight: 1 },
    { trace: trace(-6, 0), weight: 1 },
  ], { mode: 'power' });
  const index = 200;
  report('Measured positions average into one response',
    power.ok && approx(power.curve.magDb[index], -6, 0.01) &&
      Math.abs(wrapDegrees(power.curve.phaseDeg[index]) - 180) < 1 &&
      onlyLevels.ok && onlyLevels.curve.phaseDeg === null,
    power.ok ? 'level ' + power.curve.magDb[index].toFixed(2) + ' dB, phase ' +
      power.curve.phaseDeg[index].toFixed(0) + '°; a magnitude-only position keeps the average magnitude-only'
      : power.message);
}

/* 39. SER mode gives the sum before the channel DSP as well as after it. */
{
  const frequencies = gridFrequencies(GRID_POINTS);
  const magnitudeOnly = {
    id: 'd', label: 'd', sampleRate: 48000,
    curve: { magDb: Array.from(frequencies, () => -3), phaseDeg: null, coherence: null },
    conditions: { reference: '' },
  };
  const dataset = normalizeDataset(magnitudeOnly);
  const project = {
    models: [{ id: 'm', name: 'm', datasets: [dataset] }],
    sources: [{
      id: 's', modelId: 'm', datasetId: 'd', name: 'S', gainDb: 0, delayMs: 0, polarity: 'normal',
      filters: [{ id: 'f', kind: 'lowPass', frequency: 1000, gainDb: 0, q: 0.7071, enabled: true }],
    }],
    groups: [], positions: [{ id: 'centre', label: 'Centre', weight: 1 }], settings: {},
  };
  const ser = evaluateSystem(project, { mode: 'ser', positionId: 'centre' });
  const plain = evaluateSystem(project, { positionId: 'centre' });
  const index = 200;
  report('SER mode keeps the sum before and after the channel DSP',
    !!ser.sumBefore && approx(ser.sumBefore.magDb[index], -3, 0.01) &&
      approx(plain.sum.magDb[index], ser.sum.magDb[index], 1e-9) &&
      ser.sum.magDb[index] < ser.sumBefore.magDb[index],
    ser.sumBefore ? 'before ' + ser.sumBefore.magDb[index].toFixed(1) + ' dB, after ' +
      ser.sum.magDb[index].toFixed(1) + ' dB' : 'no sum before the DSP');
}

/* 40. A group's linked chain applies on top of the source's own chain. */
{
  const frequencies = gridFrequencies(GRID_POINTS);
  const dataset = normalizeDataset({
    id: 'd', label: 'd', sampleRate: 48000,
    curve: { magDb: Array.from(frequencies, () => 0), phaseDeg: Array.from(frequencies, () => 0), coherence: null },
    conditions: { reference: '' },
  });
  const filter = { id: 'g1', kind: 'peaking', frequency: 1000, gainDb: 6, q: 2, enabled: true };
  const project = {
    models: [{ id: 'm', name: 'm', datasets: [dataset] }],
    sources: [{
      id: 's', modelId: 'm', datasetId: 'd', name: 'S', gainDb: 0, delayMs: 0,
      polarity: 'normal', groupId: 'g', filters: [],
    }],
    groups: [{ id: 'g', name: 'Group', gainDb: 0, delayMs: 0, polarity: 'normal', muted: false, filters: [filter] }],
    positions: [{ id: 'centre', label: 'Centre', weight: 1 }], settings: {},
  };
  const linked = evaluateSystem(project, { positionId: 'centre' });
  const even = sumResponses([{
    frequencies,
    magDb: new Float64Array(GRID_POINTS),
    phaseDeg: new Float64Array(GRID_POINTS),
    re: new Float64Array(GRID_POINTS).fill(1),
    im: new Float64Array(GRID_POINTS),
    phaseValid: true,
  }]);
  const index = nearest({ frequencies }, 1000);
  report('A group\'s linked chain applies on top of the source',
    linked.sum && even && linked.sum.magDb[index] > even.magDb[index] + 5,
    linked.sum ? linked.sum.magDb[index].toFixed(2) + ' dB with the linked chain at 1 kHz' : 'no sum');
}

console.log('');
console.log(passed + ' passed · ' + failed + ' failed');
if (failed) process.exitCode = 1;
