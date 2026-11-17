import { FFT } from './fft.js';
import { Analyser } from './analyser.js';
import { spatialAverage } from './spatial.js';
import { relativeMatch } from './micmatch.js';

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
