/*
 * Headless DSP checks, run with Node:
 *
 *   node tests/dsp.mjs
 *
 * Every signal is synthetic and carries its own expected answer, so a failure
 * points at the maths. Nothing here is a live measurement, and none of it is
 * evidence that a particular interface or microphone works.
 */

import { FFT } from '../js/fft.js';
import { Analyser } from '../js/analyser.js';
import { spatialAverage } from '../js/spatial.js';
import { relativeMatch } from '../js/micmatch.js';

let passed = 0;
let failed = 0;

function report(name, pass, detail) {
  if (pass) passed += 1;
  else failed += 1;
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + ' — ' + detail);
}

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

/** Feed overlapping windows of two long signals, so each frame is a new frame. */
function measureStream(ref, mic, fftSize, sampleRate, frames) {
  const analyser = new Analyser(fftSize, sampleRate);
  // Below 1 so consecutive frames are averaged: with updateRate 1 each frame
  // replaces the cross spectrum, and a single frame is always 100 % coherent.
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

function meanCoherence(result) {
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

/* 1. FFT round trip */
{
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
  report('Fourier transform round trip', worst < 1e-6,
    'largest sample error ' + worst.toExponential(2));
}

/* 2. Known delay at 48 kHz */
{
  const size = 8192;
  const rate = 48000;
  const samples = 73;
  const ref = whiteNoise(40000, 23);
  const mic = delayed(ref, samples);
  const result = measureStream(ref, mic, size, rate, 12);
  const expected = (samples / rate) * 1000;
  report('Known delay at 48 kHz', Math.abs(result.delayMs - expected) < 0.05,
    'measured ' + result.delayMs.toFixed(3) + ' ms, expected ' + expected.toFixed(3) + ' ms');
}

/* 3. Known delay at 44.1 kHz */
{
  const size = 8192;
  const rate = 44100;
  const samples = 97;
  const ref = whiteNoise(40000, 41);
  const mic = delayed(ref, samples);
  const result = measureStream(ref, mic, size, rate, 12);
  const expected = (samples / rate) * 1000;
  report('Known delay at 44.1 kHz', Math.abs(result.delayMs - expected) < 0.05,
    'measured ' + result.delayMs.toFixed(3) + ' ms, expected ' + expected.toFixed(3) + ' ms');
}

/* 4. Magnitude of a known -6.02 dB gain */
{
  const size = 16384;
  const rate = 48000;
  const tone = 1000;
  const length = size + 12 * 1024;
  const ref = new Float32Array(length);
  const mic = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const value = Math.sin((2 * Math.PI * tone * i) / rate);
    ref[i] = value;
    mic[i] = value * 0.5;
  }
  const result = measureStream(ref, mic, size, rate, 12);
  const k = Math.round(tone / result.df);
  report('Magnitude of a -6.02 dB gain', Math.abs(result.magDb[k] + 6.02) < 0.15,
    'measured ' + result.magDb[k].toFixed(2) + ' dB at 1 kHz');
}

/* 5. Coherence of identical signals */
{
  const size = 8192;
  const ref = whiteNoise(40000, 7);
  const result = measureStream(ref, ref, size, 48000, 12);
  const coherence = meanCoherence(result);
  report('Coherence of identical signals', coherence > 0.99,
    'mean coherence ' + (coherence * 100).toFixed(1) + '%');
}

/* 6. Coherence of unrelated noise */
{
  const size = 8192;
  const ref = whiteNoise(500000, 3);
  const mic = whiteNoise(500000, 99);
  const result = measureStream(ref, mic, size, 48000, 400);
  const coherence = meanCoherence(result);
  report('Coherence of unrelated noise', coherence < 0.2,
    'mean coherence ' + (coherence * 100).toFixed(1) + '%');
}

/* 7. Spatial averaging */
function fakeResult(bins, df, magnitude, coherence) {
  const magDb = new Float32Array(bins);
  const coh = new Float32Array(bins);
  const phaseDeg = new Float32Array(bins);
  for (let k = 1; k < bins; k++) {
    magDb[k] = magnitude(k * df);
    coh[k] = coherence;
  }
  return { bins, df, magDb, coh, phaseDeg };
}

{
  const bins = 2048;
  const df = 48000 / 4096;
  const results = [
    fakeResult(bins, df, () => -6, 1),
    fakeResult(bins, df, () => 0, 1),
    fakeResult(bins, df, () => 6, 1),
  ];
  const power = spatialAverage(results, [true, true, true], 'power', null);
  const db = spatialAverage(results, [true, true, true], 'db', null);
  const expectedPower = 10 * Math.log10((Math.pow(10, -0.6) + 1 + Math.pow(10, 0.6)) / 3);
  const k = 500;
  const pass = Math.abs(power.magDb[k] - expectedPower) < 0.05 && Math.abs(db.magDb[k]) < 0.01;
  report('Spatial average, power and dB modes', pass,
    'power ' + power.magDb[k].toFixed(2) + ' dB (expected ' + expectedPower.toFixed(2) +
    '), dB average ' + db.magDb[k].toFixed(2) + ' dB');
}

testCoherenceWeighting();

function testCoherenceWeighting() {
  const bins = 1024;
  const df = 48000 / 2048;
  const results = [
    fakeResult(1024, df, () => -6, 1),
    fakeResult(1024, df, () => 0, 0),
    fakeResult(1024, df, () => 6, 0),
  ];
  const weighted = spatialAverage(results, [true, true, true], 'coherence', null);
  const k = 300;
  report('Spatial average, coherence weighting', Math.abs(weighted.magDb[k] + 6) < 0.05,
    'weighted curve ' + weighted.magDb[k].toFixed(2) + ' dB with only mic A coherent');
}

/* 8. Relative microphone matching */
{
  const bins = 4096;
  const df = 48000 / 8192;
  const reference = fakeResult(bins, df, () => 0, 0.9);
  const target = fakeResult(bins, df, (frequency) => (frequency > 1000 ? 3 : 0), 0.9);
  const match = relativeMatch(reference, target, {
    coherence: 0.6, smoothing: 1 / 6, maxDb: 6, fMin: 40, fMax: 16000,
  });
  const k = Math.round(2000 / df);
  const pass = match.accepted && Math.abs(match.correction[k] + 3) < 0.5;
  report('Relative matching corrects a known +3 dB tilt', pass,
    match.accepted
      ? 'correction ' + match.correction[k].toFixed(2) + ' dB at 2 kHz, residual ±' +
        match.residual.toFixed(2) + ' dB'
      : 'refused: ' + match.reason);
}

/* 9. Correction limit */
{
  const bins = 4096;
  const df = 48000 / 8192;
  const reference = fakeResult(bins, df, () => 0, 0.9);
  const target = fakeResult(bins, df, () => 12, 0.9);
  const match = relativeMatch(reference, target, {
    coherence: 0.6, smoothing: 1 / 6, maxDb: 6, fMin: 40, fMax: 16000,
  });
  const k = Math.round(2000 / df);
  const pass = match.accepted && Math.abs(match.correction[k] + 6) < 0.3;
  report('Matching clamps to its correction limit', pass,
    match.accepted ? 'correction ' + match.correction[k].toFixed(2) + ' dB' : 'refused: ' + match.reason);
}

/* 10. Incoherent capture refused */
{
  const bins = 4096;
  const df = 48000 / 8192;
  const reference = fakeResult(bins, df, () => 0, 0.2);
  const target = fakeResult(bins, df, () => 3, 0.2);
  const match = relativeMatch(reference, target, { coherence: 0.6 });
  report('Matching refuses an incoherent capture', !match.accepted,
    match.accepted ? 'accepted, which it should not have been' : 'refused: ' + match.reason);
}

/* 11. Channel independence arithmetic used by the engine */
{
  const count = 4096;
  const a = whiteNoise(count, 5);
  const b = whiteNoise(count, 6);
  const same = Float32Array.from(a);

  const correlation = (x, y) => {
    let dot = 0;
    let xp = 0;
    let yp = 0;
    for (let i = 0; i < x.length; i++) {
      dot += x[i] * y[i];
      xp += x[i] * x[i];
      yp += y[i] * y[i];
    }
    return dot / Math.sqrt(xp * yp);
  };

  const duplicate = correlation(a, same);
  const independent = correlation(a, b);
  report('Channel separation measure', duplicate > 0.999 && Math.abs(independent) < 0.1,
    'identical ' + duplicate.toFixed(4) + ', independent ' + independent.toFixed(4));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
