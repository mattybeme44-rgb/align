/*
 * Timing of one three-microphone analysis frame, on this machine, in Node.
 *
 *   node tests/bench.mjs
 *
 * Times the accumulate and results steps separately, using the same options the
 * workspace uses. Node's numbers are a guide to relative cost; the phone and the
 * laptop each have their own budget, and they are not measured here.
 */

import { MultiAnalyser } from '../js/multianalyser.js';

const size = 16384;
const rate = 48000;
const frames = 60;
const warmup = 5;
const hop = 1024;

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

const total = hop * (frames + warmup) + size + 1024;
const random = mulberry32(5);
const ref = new Float32Array(total);
for (let i = 0; i < total; i++) ref[i] = random() * 2 - 1;
const mics = [0, 1, 2].map((i) => {
  const out = new Float32Array(total);
  const gain = 0.5 + 0.2 * i;
  const shift = 50 + 37 * i;
  for (let n = shift; n < total; n++) out[n] = gain * ref[n - shift];
  return out;
});

const multi = new MultiAnalyser(size, rate, 3);
const r = new Float32Array(size);
const windows = [0, 1, 2].map(() => new Float32Array(size));
const options = { compensate: false, smoothing: 1 / 6, normalize: false, phaseSmoothing: 1 / 6 };

const accumulateMs = [];
const resultsMs = [];

for (let frame = 0; frame < frames + warmup; frame++) {
  const start = frame * hop;
  r.set(ref.subarray(start, start + size));
  for (let i = 0; i < 3; i++) windows[i].set(mics[i].subarray(start, start + size));

  const t0 = performance.now();
  multi.accumulate(windows, r);
  const t1 = performance.now();
  multi.results(options);
  const t2 = performance.now();

  if (frame >= warmup) {
    accumulateMs.push(t1 - t0);
    resultsMs.push(t2 - t1);
  }
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const acc = median(accumulateMs);
const res = median(resultsMs);
console.log('Three microphones, ' + size + '-point FFT, ' + frames + ' frames (median)');
console.log('  accumulate (spectra and cross spectra): ' + acc.toFixed(2) + ' ms per frame');
console.log('  results (IFFTs, phase, smoothing):      ' + res.toFixed(2) + ' ms per frame');
console.log('  total:                                  ' + (acc + res).toFixed(2) + ' ms per frame');
