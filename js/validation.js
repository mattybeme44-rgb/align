import { FFT } from './fft.js';
import { Analyser } from './analyser.js';
import { spatialAverage } from './spatial.js';
import { relativeMatch } from './micmatch.js';
import {
  GRID_POINTS,
  compareCurves,
  fractionalOctaveSmooth,
  gridFrequencies,
  parseResponseText,
  resampleResponse,
  wrapDegrees,
} from './modeler/curve.js';
import { chainResponse, designCrossover } from './modeler/filters.js';
import {
  effectiveSettings,
  groupDelay,
  optimizeAlignment,
  sumResponses,
  synthesizeImpulse,
} from './modeler/model.js';

/*
 * Synthetic checks for the measurement maths.
 *
 * Every signal here is generated in the page with a known answer attached, so a
 * failure points at the DSP rather than at a room, a microphone or a browser.
 * None of this is a live measurement and none of it is presented as one.
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function whiteNoise(length, seed) {
  const random = mulberry32(seed);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = random() * 2 - 1;
  return out;
}

function delayed(source, samples) {
  const out = new Float32Array(source.length);
  for (let i = samples; i < source.length; i++) out[i] = source[i - samples];
  return out;
}

/**
 * Feed overlapping windows of two long signals. The update rate is below 1 so
 * consecutive frames are averaged: with no averaging a single frame is always
 * reported as fully coherent.
 */
function measureStream(ref, mic, fftSize, sampleRate, frames) {
  const analyser = new Analyser(fftSize, sampleRate);
  analyser.updateRate = 0.05;
  analyser.searchRadius = 0;
  const refWindow = new Float32Array(fftSize);
  const micWindow = new Float32Array(fftSize);
  const hop = 1024;
  for (let frame = 0; frame < frames; frame++) {
    const start = frame * hop;
    refWindow.set(ref.subarray(start, start + fftSize));
    micWindow.set(mic.subarray(start, start + fftSize));
    analyser.accumulate(micWindow, refWindow);
  }
  return analyser.results({ compensate: false, smoothing: 0, normalize: false });
}

function meanCoherenceOf(result) {
  const k0 = Math.max(1, Math.round(200 / result.df));
  const k1 = Math.min(result.bins - 1, Math.round(10000 / result.df));
  let sum = 0;
  let count = 0;
  for (let k = k0; k <= k1; k++) {
    sum += result.coh[k];
    count += 1;
  }
  return count ? sum / count : 0;
}

function fakeResult(bins, df, magnitude, coherence) {
  const magDb = new Float32Array(bins);
  const coh = new Float32Array(bins);
  const phaseDeg = new Float32Array(bins);
  for (let k = 1; k < bins; k++) {
    magDb[k] = magnitude(k * df);
    coh[k] = coherence;
    phaseDeg[k] = 0;
  }
  return { bins, df, magDb, coh, phaseDeg, sampleRate: 48000, fftSize: (bins - 1) * 2 };
}

const tests = [];

function test(name, detail, fn) {
  tests.push({ name, detail, fn });
}

test('Fourier transform round trip',
  'A noise burst transformed and back again must return the original samples.',
  () => {
    const size = 2048;
    const fft = new FFT(size);
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    const original = whiteNoise(size, 11);
    for (let i = 0; i < size; i++) re[i] = original[i];
    fft.forward(re, im);
    fft.inverse(re, im);
    let worst = 0;
    for (let i = 0; i < size; i++) worst = Math.max(worst, Math.abs(re[i] - original[i]));
    return {
      pass: worst < 1e-6,
      detail: 'largest sample error ' + worst.toExponential(2),
    };
  });

test('Known delay at 48 kHz',
  'Noise delayed by 73 samples must read 1.521 ms.',
  () => {
    const size = 8192;
    const rate = 48000;
    const samples = 73;
    const ref = whiteNoise(40000, 23);
    const mic = delayed(ref, samples);
    const result = measureStream(ref, mic, size, rate, 12);
    const expected = (samples / rate) * 1000;
    return {
      pass: Math.abs(result.delayMs - expected) < 0.05,
      detail: 'measured ' + result.delayMs.toFixed(3) + ' ms against ' + expected.toFixed(3) + ' ms',
    };
  });

test('Known delay at 44.1 kHz',
  'The same delay check at the other standard interface rate.',
  () => {
    const size = 8192;
    const rate = 44100;
    const samples = 97;
    const ref = whiteNoise(40000, 41);
    const mic = delayed(ref, samples);
    const result = measureStream(ref, mic, size, rate, 12);
    const expected = (samples / rate) * 1000;
    return {
      pass: Math.abs(result.delayMs - expected) < 0.05,
      detail: 'measured ' + result.delayMs.toFixed(3) + ' ms against ' + expected.toFixed(3) + ' ms',
    };
  });

test('Magnitude accuracy',
  'A 1 kHz tone at half the reference amplitude must read -6.02 dB.',
  () => {
    const size = 16384;
    const rate = 48000;
    const tone = 1000;
    const ref = new Float32Array(size);
    const mic = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      const value = Math.sin((2 * Math.PI * tone * i) / rate);
      ref[i] = value;
      mic[i] = value * 0.5;
    }
    const result = measureStream(ref, mic, size, rate, 12);
    const k = Math.round(tone / result.df);
    const measured = result.magDb[k];
    return {
      pass: Math.abs(measured - (-6.02)) < 0.15,
      detail: 'measured ' + measured.toFixed(2) + ' dB at 1 kHz',
    };
  });

test('Coherence of two identical signals',
  'The same signal on both inputs is full coherence.',
  () => {
    const size = 8192;
    const ref = whiteNoise(40000, 7);
    const result = measureStream(ref, ref, size, 48000, 12);
    const coherence = meanCoherenceOf(result);
    return {
      pass: coherence > 0.99,
      detail: 'mean coherence ' + (coherence * 100).toFixed(1) + '%',
    };
  });

test('Coherence of unrelated noise',
  'Two unrelated noise signals must not look coherent.',
  () => {
    const size = 8192;
    const ref = whiteNoise(500000, 3);
    const mic = whiteNoise(500000, 99);
    const result = measureStream(ref, mic, size, 48000, 400);
    const coherence = meanCoherenceOf(result);
    return {
      pass: coherence < 0.2,
      detail: 'mean coherence ' + (coherence * 100).toFixed(1) + '%',
    };
  });

test('Spatial average — power and dB modes',
  'Three known levels must average in power, and in dB when that mode is chosen.',
  () => {
    const bins = 2048;
    const df = 48000 / 4096;
    const results = [
      fakeResult(bins, df, () => -6, 1),
      fakeResult(bins, df, () => 0, 1),
      fakeResult(bins, df, () => 6, 1),
    ];
    const enabled = [true, true, true];
    const power = spatialAverage(results, enabled, 'power', null);
    const db = spatialAverage(results, enabled, 'db', null);
    const expectedPower = 10 * Math.log10((Math.pow(10, -0.6) + 1 + Math.pow(10, 0.6)) / 3);
    const k = 200;
    return {
      pass: Math.abs(power.magDb[k] - expectedPower) < 0.05 && Math.abs(db.magDb[k] - 0) < 0.01,
      detail: 'power ' + power.magDb[k].toFixed(2) + ' dB (expected ' + expectedPower.toFixed(2) +
        '), dB average ' + db.magDb[k].toFixed(2) + ' dB',
    };
  });

test('Spatial average — coherence weighting',
  'A microphone with no coherence must not pull the average.',
  () => {
    const bins = 2048;
    const df = 48000 / 4096;
    const results = [
      fakeResult(bins, df, () => -6, 1),
      fakeResult(bins, df, () => 0, 0),
      fakeResult(bins, df, () => 6, 0),
    ];
    const weighted = spatialAverage(results, [true, true, true], 'coherence', null);
    const k = 200;
    return {
      pass: Math.abs(weighted.magDb[k] - (-6)) < 0.05 && results.length === 3,
      detail: 'weighted curve ' + weighted.magDb[k].toFixed(2) + ' dB with only mic A coherent',
    };
  });

test('Relative microphone matching',
  'A microphone 3 dB high above 1 kHz must be corrected down by about 3 dB.',
  () => {
    const bins = 4096;
    const df = 48000 / 8192;
    const reference = fakeResult(bins, df, () => 0, 0.9);
    const target = fakeResult(bins, df, (frequency) => (frequency > 1000 ? 3 : 0), 0.9);
    const match = relativeMatch(reference, target, {
      coherence: 0.6,
      smoothing: 1 / 6,
      maxDb: 6,
      fMin: 40,
      fMax: 16000,
    });
    if (!match.accepted) {
      return { pass: false, detail: 'refused: ' + match.reason };
    }
    const k = Math.round(2000 / df);
    return {
      pass: Math.abs(match.correction[k] - (-3)) < 0.5,
      detail: 'correction ' + match.correction[k].toFixed(2) + ' dB at 2 kHz, residual ±' +
        match.residual.toFixed(2) + ' dB',
    };
  });

test('Matching respects its correction limit',
  'A 12 dB difference with a 6 dB limit must be clamped, not applied whole.',
  () => {
    const bins = 4096;
    const df = 48000 / 8192;
    const reference = fakeResult(bins, df, () => 0, 0.9);
    const target = fakeResult(bins, df, () => 12, 0.9);
    const match = relativeMatch(reference, target, {
      coherence: 0.6,
      smoothing: 1 / 6,
      maxDb: 6,
      fMin: 40,
      fMax: 16000,
    });
    if (!match.accepted) {
      return { pass: false, detail: 'refused: ' + match.reason };
    }
    const k = Math.round(2000 / df);
    return {
      pass: Math.abs(match.correction[k] - (-6)) < 0.3,
      detail: 'correction ' + match.correction[k].toFixed(2) + ' dB, clamped at the limit',
    };
  });

test('Matching refuses an incoherent capture',
  'A difference built from noise is not a correction.',
  () => {
    const bins = 4096;
    const df = 48000 / 8192;
    const reference = fakeResult(bins, df, () => 0, 0.2);
    const target = fakeResult(bins, df, () => 3, 0.2);
    const match = relativeMatch(reference, target, { coherence: 0.6 });
    return {
      pass: !match.accepted,
      detail: match.accepted ? 'accepted, which it should not have been' : 'refused: ' + match.reason,
    };
  });

/* ---------- the system data modeler ---------- */

/**
 * One complex response on the model grid, built with a known answer: a level
 * and a phase written as a function of frequency.
 */
function modelResponse(phaseFn, magDbValue = 0) {
  const frequencies = gridFrequencies(GRID_POINTS);
  const count = frequencies.length;
  const magDb = new Float64Array(count).fill(magDbValue);
  const phaseDeg = new Float64Array(count);
  const re = new Float64Array(count);
  const im = new Float64Array(count);
  const linear = Math.pow(10, magDbValue / 20);
  for (let i = 0; i < count; i++) {
    const phase = phaseFn ? phaseFn(frequencies[i]) : 0;
    phaseDeg[i] = (phase * 180) / Math.PI;
    re[i] = linear * Math.cos(phase);
    im[i] = linear * Math.sin(phase);
  }
  return { frequencies, magDb, phaseDeg, re, im, phaseValid: true, id: 'test', name: 'test' };
}

function nearest(response, frequency) {
  let best = 0;
  for (let i = 0; i < response.frequencies.length; i++) {
    if (Math.abs(response.frequencies[i] - frequency) <
      Math.abs(response.frequencies[best] - frequency)) best = i;
  }
  return best;
}

test('Two coherent sources sum to +6.02 dB',
  'Adding the same curve to itself as complex pressure must be +6.02 dB, not +3 dB.',
  () => {
    const sum = sumResponses([modelResponse(null, 0), modelResponse(null, 0)]);
    const index = nearest(sum, 1000);
    return {
      pass: Math.abs(sum.magDb[index] - 6.0206) < 0.01,
      detail: 'sum at 1 kHz ' + sum.magDb[index].toFixed(3) + ' dB',
    };
  });

test('Equal opposite-phase sources cancel',
  'An inverted copy at the same level must sum to silence, which dB magnitudes cannot show.',
  () => {
    const sum = sumResponses([modelResponse(null, 0), modelResponse(() => Math.PI, 0)]);
    const index = nearest(sum, 1000);
    return {
      pass: sum.magDb[index] < -120,
      detail: 'sum at 1 kHz ' + sum.magDb[index].toFixed(1) + ' dB',
    };
  });

test('Polarity is a 180° change, not a delay',
  'A polarity inversion must leave the level of one source alone and turn its phase by 180°.',
  () => {
    const normal = modelResponse(null, 0);
    const inverted = modelResponse(() => Math.PI, 0);
    const index = nearest(normal, 1000);
    const turn = Math.abs(wrapDegrees(inverted.phaseDeg[index] - normal.phaseDeg[index]));
    return {
      pass: Math.abs(turn - 180) < 1e-6 &&
        Math.abs(normal.magDb[index] - inverted.magDb[index]) < 1e-9,
      detail: 'phase turned ' + turn.toFixed(1) + '° at the same level',
    };
  });

test('A delay reads back as group delay',
  'A phase curve of −360° per frequency-second must read as that delay in milliseconds.',
  () => {
    const tau = 0.002;
    const response = modelResponse((frequency) => -2 * Math.PI * frequency * tau, 0);
    const delays = groupDelay(response.frequencies, response.phaseDeg, response.magDb, {});
    const index = nearest(response, 1000);
    return {
      pass: Math.abs(delays[index] - 2) < 0.01,
      detail: 'group delay at 1 kHz ' + delays[index].toFixed(3) + ' ms',
    };
  });

test('Group delay is left blank where the coherence is low',
  'Timing is only read where the data can support it; a doubtful point must not be drawn.',
  () => {
    const response = modelResponse((frequency) => -2 * Math.PI * frequency * 0.002, 0);
    const coherence = new Float64Array(response.frequencies.length).fill(0.9);
    for (let i = 0; i < coherence.length; i++) if (response.frequencies[i] > 2000) coherence[i] = 0.1;
    const delays = groupDelay(response.frequencies, response.phaseDeg, response.magDb,
      { coherence, coherenceThreshold: 0.5 });
    const low = nearest(response, 5000);
    const good = nearest(response, 500);
    return {
      pass: Number.isNaN(delays[low]) && Number.isFinite(delays[good]),
      detail: 'low-coherence point ' + (Number.isNaN(delays[low]) ? 'blank' : 'drawn') +
        ', usable point ' + delays[good].toFixed(2) + ' ms',
    };
  });

test('A Linkwitz-Riley 4th-order crossover sits 6 dB down at its frequency',
  'Two cascaded Butterworth sections must read −6.02 dB at the crossover and fall 24 dB per octave below it.',
  () => {
    const design = designCrossover({ family: 'Linkwitz-Riley', slope: 24, frequency: 1000, type: 'highPass' });
    if (!design.ok) return { pass: false, detail: design.message };
    const at = chainResponse(design.filters, new Float64Array([1000]), 48000);
    const below = chainResponse(design.filters, new Float64Array([500]), 48000);
    return {
      pass: Math.abs(at.magDb[0] + 6.0206) < 0.15 && below.magDb[0] < -20,
      detail: 'at crossover ' + at.magDb[0].toFixed(2) + ' dB, an octave below ' +
        below.magDb[0].toFixed(1) + ' dB, ' + design.filters.length + ' sections',
    };
  });

test('A 2nd-order Butterworth crossover sits 3 dB down',
  'A single Butterworth high-pass section must read −3.01 dB at its frequency and roll off below it.',
  () => {
    const design = designCrossover({ family: 'Butterworth', slope: 12, frequency: 1000, type: 'highPass' });
    if (!design.ok) return { pass: false, detail: design.message };
    const at = chainResponse(design.filters, new Float64Array([1000]), 48000);
    const below = chainResponse(design.filters, new Float64Array([500]), 48000);
    return {
      pass: Math.abs(at.magDb[0] + 3.0103) < 0.1 && below.magDb[0] < -10,
      detail: 'at crossover ' + at.magDb[0].toFixed(2) + ' dB, an octave below ' +
        below.magDb[0].toFixed(1) + ' dB',
    };
  });

test('The optimizer finds a known delay',
  'A target arriving 2 ms late must be aligned by moving it back 2 ms.',
  () => {
    const reference = modelResponse(null, 0);
    const target = modelResponse((frequency) => -2 * Math.PI * frequency * 0.002, 0);
    const result = optimizeAlignment({
      reference,
      target,
      band: { min: 200, max: 1000 },
      delay: { min: -10, max: 10, stepMs: 0.05 },
      polarity: 'normal',
      objective: 'sum',
    });
    if (!result.ok) return { pass: false, detail: result.message };
    return {
      pass: Math.abs(result.best.delayMs + 2) < 0.1,
      detail: 'recommended ' + result.best.delayMs.toFixed(2) + ' ms against −2.00 ms',
    };
  });

test('Smoothing leaves a flat curve flat',
  'Fractional-octave smoothing may not tilt a curve that has no shape to smooth.',
  () => {
    const values = new Float64Array(GRID_POINTS).fill(-12);
    const smoothed = fractionalOctaveSmooth(values, 1 / 3, GRID_POINTS);
    let worst = 0;
    for (const value of smoothed) worst = Math.max(worst, Math.abs(value + 12));
    return { pass: worst < 1e-9, detail: 'largest change ' + worst.toExponential(2) + ' dB' };
  });

test('Phase is unwrapped before it is interpolated',
  'A phase curve that wraps must stay continuous, and a delay’s phase is linear in frequency.',
  () => {
    const resampled = resampleResponse({ frequencies: [100, 1000], magDb: [0, 0], phaseDeg: [170, -170] });
    if (!resampled.ok) return { pass: false, detail: resampled.message };
    let index = 0;
    for (let i = 0; i < resampled.grid.length; i++) {
      if (Math.abs(resampled.grid[i] - 550) < Math.abs(resampled.grid[index] - 550)) index = i;
    }
    const value = resampled.phaseDeg[index];
    return {
      pass: Math.abs(value - 180) < 1,
      detail: 'phase near 550 Hz ' + value.toFixed(1) + '°',
    };
  });

test('A response file is read by its columns',
  'A known file must land on the grid with the level and phase it carried, over its own range.',
  () => {
    const lines = ['# frequency magnitude phase'];
    for (let i = 0; i < 12; i++) {
      const frequency = 100 * Math.pow(2, i / 3);
      lines.push(frequency.toFixed(1) + ',' + (-6 + i * 0.5).toFixed(2) + ',' + (i * 10) + '');
    }
    const parsed = parseResponseText(lines.join('\n'));
    if (!parsed.ok) return { pass: false, detail: parsed.message };
    return {
      pass: parsed.points === 12 && !!parsed.response.phaseDeg &&
        Math.abs(parsed.response.fMin - 100) < 0.01,
      detail: parsed.points + ' points from ' + parsed.response.fMin.toFixed(1) + ' Hz, phase ' +
        (parsed.response.phaseDeg ? 'kept' : 'dropped'),
    };
  });

test('A magnitude-only file stays magnitude-only',
  'No phase may be invented for a file that does not carry it.',
  () => {
    const lines = [];
    for (let i = 0; i < 20; i++) lines.push((100 * Math.pow(2, i / 4)).toFixed(1) + ' ' + (-3).toFixed(1));
    const parsed = parseResponseText(lines.join('\n'));
    if (!parsed.ok) return { pass: false, detail: parsed.message };
    return {
      pass: parsed.response.phaseDeg === null,
      detail: parsed.response.phaseDeg ? 'phase was invented' : 'stayed magnitude-only',
    };
  });

test('A file too short to be a response is refused',
  'A truncated file must be refused whole rather than half-imported.',
  () => {
    const parsed = parseResponseText('100 0\n200 0\n400 0');
    return { pass: !parsed.ok, detail: parsed.ok ? 'accepted a 3-row file' : parsed.message };
  });

test('Phase wrapping stays inside ±180°',
  'A wrapped phase reading must never leave the −180° to +180° range.',
  () => {
    const wrapped = [370, -190, 180, -180].map(wrapDegrees);
    return {
      pass: Math.abs(wrapped[0] - 10) < 1e-9 && Math.abs(wrapped[1] - 170) < 1e-9 &&
        wrapped[2] === 180 && wrapped[3] === -180,
      detail: wrapped.join('°, ') + '°',
    };
  });

test('The impulse response comes from the modelled sum',
  'A flat, delay-free sum must transform to an impulse at the window\'s origin.',
  () => {
    const sum = sumResponses([modelResponse(null, 0)]);
    const transformed = synthesizeImpulse(sum, { sampleRate: 48000, bins: 4096, beforeMs: 5, stepMs: 1 });
    if (!transformed.ok) return { pass: false, detail: transformed.message };
    const values = transformed.envelope.values;
    const peakIndex = values.indexOf(Math.max(...values));
    const peakMs = transformed.envelope.startMs + peakIndex * transformed.envelope.stepMs;
    return {
      pass: Math.abs(values[peakIndex]) < 0.5 && peakIndex === 5,
      detail: 'peak at ' + peakMs.toFixed(1) + ' ms, ' + values[peakIndex].toFixed(2) + ' dB',
    };
  });

test('A prediction is compared with a measurement band by band',
  'A measured curve 3 dB above the prediction must read as a 3 dB error, averaged and at its worst.',
  () => {
    const predicted = modelResponse(null, 0);
    const measured = modelResponse(null, 3);
    const stats = compareCurves(predicted, measured, { min: 200, max: 2000 });
    return {
      pass: Math.abs(stats.meanDb - 3) < 0.02 && Math.abs(stats.rmsDb - 3) < 0.02 &&
        Math.abs(stats.worstDb - 3) < 0.02,
      detail: 'mean ' + stats.meanDb.toFixed(2) + ' dB, rms ' + stats.rmsDb.toFixed(2) +
        ' dB over ' + stats.count + ' points',
    };
  });

test('Free-field distance changes the arrival and the level',
  'Two metres against one must cost 6.02 dB and add 2.92 ms of travel at 343 m/s.',
  () => {
    const settings = effectiveSettings(
      { gainDb: 0, delayMs: 0, polarity: 'normal', distanceM: 2 },
      null,
      { enabled: true, referenceDistanceM: 1, speedOfSound: 343 },
    );
    return {
      pass: Math.abs(settings.freeFieldGainDb + 6.0206) < 0.01 &&
        Math.abs(settings.freeFieldDelayMs - 2.9155) < 0.01,
      detail: settings.freeFieldGainDb.toFixed(2) + ' dB, ' +
        settings.freeFieldDelayMs.toFixed(2) + ' ms',
    };
  });

test('A band-pass passes its band and stops outside it',
  'A high-pass at 100 Hz plus a low-pass at 1 kHz must be −3 dB at each edge and fall outside.',
  () => {
    const design = designCrossover({
      family: 'Butterworth', slope: 12, frequency: 100, lowFrequency: 1000, type: 'bandPass',
    });
    if (!design.ok) return { pass: false, detail: design.message };
    const at = chainResponse(design.filters, new Float64Array([20, 100, 1000, 5000]), 48000);
    return {
      pass: Math.abs(at.magDb[1] + 3.01) < 0.3 && Math.abs(at.magDb[2] + 3.01) < 0.3 &&
        at.magDb[0] < -10 && at.magDb[3] < -10,
      detail: at.magDb.map((value) => value.toFixed(1)).join(' / ') + ' dB',
    };
  });

/* ---------- the page ---------- */

function render() {
  const holder = document.getElementById('validationResults');
  if (!holder) return;
  holder.textContent = '';

  let passed = 0;
  let failed = 0;

  for (const entry of tests) {
    let outcome;
    try {
      outcome = entry.fn();
    } catch (err) {
      outcome = { pass: false, detail: 'threw: ' + (err && err.message ? err.message : err) };
    }
    if (outcome.pass) passed += 1;
    else failed += 1;

    const row = document.createElement('div');
    row.className = 'validation-row ' + (outcome.pass ? 'pass' : 'fail');
    const badge = document.createElement('span');
    badge.className = 'validation-badge';
    badge.textContent = outcome.pass ? 'PASS' : 'FAIL';
    const body = document.createElement('div');
    const name = document.createElement('b');
    name.textContent = entry.name;
    const description = document.createElement('p');
    description.textContent = entry.detail;
    const result = document.createElement('p');
    result.className = 'validation-detail';
    result.textContent = outcome.detail;
    body.append(name, description, result);
    row.append(badge, body);
    holder.appendChild(row);
  }

  const summary = document.createElement('p');
  summary.className = 'validation-summary';
  summary.textContent = passed + ' passed · ' + failed + ' failed';
  holder.prepend(summary);
}

render();
