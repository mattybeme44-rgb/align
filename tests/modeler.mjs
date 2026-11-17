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
import {
  effectiveSettings,
  groupDelay,
  optimizeAlignment,
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

console.log('');
console.log(passed + ' passed · ' + failed + ' failed');
if (failed) process.exitCode = 1;
