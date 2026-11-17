/*
 * Precision and size benchmarks.
 *
 *   node tests/precision.mjs
 *
 * Three questions, each answered by measurement on this machine:
 *
 *  1. Does Float32 cost accuracy in the transform? The same FFT run on
 *     Float32Array and Float64Array buffers, against a direct DFT reference.
 *  2. What does each FFT size cost per analysis frame, for one and for three
 *     microphones, including the reference channel's transform?
 *  3. How much memory does one analyser hold at each size?
 *
 * Node on a laptop is not an iPhone. These are relative figures and a shape to
 * watch, not a phone's performance.
 */

import { FFT } from '../js/fft.js';
import { MultiAnalyser } from '../js/multianalyser.js';

/* ---------- 1. Float32 against Float64 ---------- */

/** A direct DFT of one bin, in double precision, as the reference answer. */
function dftBin(signal, k) {
  const n = signal.length;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const angle = (-2 * Math.PI * k * i) / n;
    re += signal[i] * Math.cos(angle);
    im += signal[i] * Math.sin(angle);
  }
  return { re, im };
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

function precisionComparison(size) {
  const fft = new FFT(size);
  const random = mulberry32(17);
  const source = new Float64Array(size);
  let peak = 0;
  for (let i = 0; i < size; i++) {
    source[i] = random() * 2 - 1;
    peak = Math.max(peak, Math.abs(source[i]));
  }

  const rows = [];
  for (const kind of ['Float32Array', 'Float64Array']) {
    const re = kind === 'Float32Array' ? new Float32Array(size) : new Float64Array(size);
    const im = kind === 'Float32Array' ? new Float32Array(size) : new Float64Array(size);
    for (let i = 0; i < size; i++) re[i] = source[i];

    // Round-trip error.
    fft.forward(re, im);
    fft.inverse(re, im);
    let roundTrip = 0;
    for (let i = 0; i < size; i++) roundTrip = Math.max(roundTrip, Math.abs(re[i] - source[i]));

    // A single bin against the direct DFT.
    const testBin = 37;
    const reference = dftBin(source, testBin);
    for (let i = 0; i < size; i++) {
      re[i] = source[i];
      im[i] = 0;
    }
    fft.forward(re, im);
    const magnitude = Math.hypot(re[testBin], im[testBin]);
    const expected = Math.hypot(reference.re, reference.im);
    const binError = Math.abs(magnitude - expected) / Math.max(expected, 1e-12);

    // Timing.
    const start = performance.now();
    const runs = 40;
    for (let r = 0; r < runs; r++) {
      for (let i = 0; i < size; i++) { re[i] = source[i]; im[i] = 0; }
      fft.forward(re, im);
    }
    const ms = (performance.now() - start) / runs;

    rows.push({ kind, roundTrip, binError, ms });
  }
  return rows;
}

console.log('Float32 against Float64, ' + 8192 + '-point FFT');
console.log('  buffer precision   round-trip error   bin magnitude error   forward time');
for (const row of precisionComparison(8192)) {
  console.log('  ' + row.kind.padEnd(18) +
    row.roundTrip.toExponential(2).padEnd(19) +
    (row.binError * 100).toExponential(2).padEnd(22) + '%   ' +
    row.ms.toFixed(3) + ' ms');
}

/* ---------- 2 and 3. Each FFT size, one and three microphones ---------- */

function typedBytes(object) {
  let total = 0;
  for (const key of Object.keys(object)) {
    const value = object[key];
    if (value && typeof value === 'object' && typeof value.byteLength === 'number'
      && value.BYTES_PER_ELEMENT) {
      total += value.byteLength;
    }
  }
  return total;
}

const SIZES = [4096, 8192, 16384, 32768, 65536];
const rate = 48000;
const options = { compensate: false, smoothing: 1 / 6, normalize: false, phaseSmoothing: 1 / 6 };

console.log('\nAnalysis cost per frame, ' + (rate / 1000) + ' kHz');
console.log('  FFT size  window   mics  accumulate   results   total    budget at 3/s   analyser memory');

for (const size of SIZES) {
  const frames = 24;
  const hop = 1024;
  const length = hop * frames + size + 1024;
  const random = mulberry32(3);
  const ref = new Float32Array(length);
  for (let i = 0; i < length; i++) ref[i] = random() * 2 - 1;
  const mics = [0, 1, 2].map((index) => {
    const out = new Float32Array(length);
    const shift = 40 + 31 * index;
    for (let n = shift; n < length; n++) out[n] = 0.6 * ref[n - shift];
    return out;
  });

  for (const count of [1, 3]) {
    const multi = new MultiAnalyser(size, rate, count);
    multi.setUpdateRate(0.1);
    const r = new Float32Array(size);
    const windows = [0, 1, 2].map(() => new Float32Array(size));
    const accumulate = [];
    const results = [];

    for (let frame = 0; frame < frames + 2; frame++) {
      const start = Math.min(frame * hop, length - size - 1);
      r.set(ref.subarray(start, start + size));
      for (let i = 0; i < count; i++) windows[i].set(mics[i].subarray(start, start + size));

      const t0 = performance.now();
      multi.accumulate(windows, r);
      const t1 = performance.now();
      multi.results(options);
      const t2 = performance.now();
      if (frame >= 2) {
        accumulate.push(t1 - t0);
        results.push(t2 - t1);
      }
    }

    const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const acc = median(accumulate);
    const res = median(results);
    const total = acc + res;
    const windowMs = (size / rate) * 1000;
    const memory = multi.analysers.reduce((sum, analyser) => sum + typedBytes(analyser), 0);
    console.log('  ' + String(size).padEnd(10) +
      (windowMs.toFixed(1) + ' ms').padEnd(9) +
      String(count).padEnd(6) +
      (acc.toFixed(2) + ' ms').padEnd(13) +
      (res.toFixed(2) + ' ms').padEnd(10) +
      (total.toFixed(2) + ' ms').padEnd(9) +
      (total * 3).toFixed(1).padEnd(16) + ' ' +
      (memory / 1048576).toFixed(2) + ' MB');
  }
}

console.log('\nThe window column is how much audio one analysis frame covers.');
console.log('The budget column is the per-second cost at the workspace\'s 3 updates/s,');
console.log('against 1000 ms in every second.');
