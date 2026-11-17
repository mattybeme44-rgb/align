/*
 * Long-run stability: many analysis frames, with inputs appearing and
 * disappearing mid-run, watching for heap growth, NaN and state that changes
 * without being asked to.
 *
 *   node --expose-gc tests/stability.mjs
 *
 * This is one process in Node. It says nothing about a browser, a phone or an
 * audio interface.
 */

import { MultiAnalyser } from '../js/multianalyser.js';
import { spatialAverage } from '../js/spatial.js';

const size = 16384;
const rate = 48000;
const totalFrames = Number(process.argv[2]) || 1200;
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

const random = mulberry32(5);
const length = hop * totalFrames + size + 2048;
const ref = new Float32Array(length);
for (let i = 0; i < length; i++) ref[i] = random() * 2 - 1;
const mics = [0, 1, 2].map((index) => {
  const out = new Float32Array(length);
  const shift = 50 + 37 * index;
  for (let n = shift; n < length; n++) out[n] = (0.5 + 0.2 * index) * ref[n - shift];
  return out;
});

const multi = new MultiAnalyser(size, rate, 3);
const r = new Float32Array(size);
let currentSize = size;
const windows = [0, 1, 2].map(() => new Float32Array(size));
const options = { compensate: false, smoothing: 1 / 6, normalize: false, phaseSmoothing: 1 / 6 };

function heapMb() {
  if (typeof global.gc === 'function') global.gc();
  return process.memoryUsage().heapUsed / 1048576;
}

const baseline = heapMb();
const baselineTyped = multi.analysers.reduce((sum, analyser) => {
  let bytes = 0;
  for (const key of Object.keys(analyser)) {
    const value = analyser[key];
    if (value && typeof value.byteLength === 'number' && value.BYTES_PER_ELEMENT) bytes += value.byteLength;
  }
  return sum + bytes;
}, 0);

let nanFrames = 0;
let checkedFrames = 0;
let snapshots = 0;
let savedSnapshots = [];
let fftChanges = 0;
const started = performance.now();

for (let frame = 0; frame < totalFrames; frame++) {
  // Changing the FFT size means the windows and the reference buffer have to be
  // rebuilt to match, exactly as the workspace does when the size changes.
  if (frame % 419 === 0) {
    const next = frame % 838 === 0 ? 8192 : 16384;
    if (next !== currentSize) {
      multi.setFftSize(next);
      currentSize = next;
      for (let i = 0; i < 3; i++) windows[i] = new Float32Array(next);
      fftChanges += 1;
    }
  }

  const start = Math.min(frame * hop, length - currentSize - 2);
  r.set(ref.subarray(start, start + currentSize));

  // Inputs come and go the way a bad connection does: B drops out for a while,
  // then C, and both come back.
  const bPresent = frame % 211 >= 40;
  const cPresent = frame % 307 >= 90;
  for (let i = 0; i < 3; i++) {
    const present = i === 0 ? true : i === 1 ? bPresent : cPresent;
    if (present) windows[i].set(mics[i].subarray(start, start + currentSize));
  }
  const pass = [
    windows[0],
    bPresent ? windows[1] : null,
    cPresent ? windows[2] : null,
  ];

  multi.accumulate(pass, r);
  const results = multi.results(options);
  const combined = spatialAverage(results, [true, true, true], 'power', null);

  if (frame % 7 === 0) {
    checkedFrames += 1;
    let bad = false;
    for (const result of results) {
      for (let k = 1; k < result.bins; k += 97) {
        if (!Number.isFinite(result.magDb[k]) && !result.silent) bad = true;
        if (!Number.isFinite(result.coh[k])) bad = true;
      }
      if (!Number.isFinite(result.delayMs)) bad = true;
    }
    for (let k = 1; k < combined.magDb.length; k += 97) {
      if (!Number.isFinite(combined.magDb[k])) bad = true;
    }
    if (bad) nanFrames += 1;
  }

  // Snapshots, calibration toggles and FFT-size changes, as the UI does them.
  if (frame % 173 === 0) {
    snapshots += 1;
    savedSnapshots.push({
      magDb: Float32Array.from(results[0].magDb),
      phaseDeg: Float32Array.from(results[0].phaseDeg),
      coh: Float32Array.from(results[0].coh),
    });
    // Keep only the newest four, the way the workspace does.
    savedSnapshots = savedSnapshots.slice(-4);
    spatialAverage(results, [true, false, true], 'coherence',
      [null, null, Float32Array.from({ length: results[0].bins }, () => 0.5)]);
  }
  if (frame % 241 === 0) multi.reset();
}

// The reference buffer is sized for `size`, but a 16384-point window is always
// what the analyser finally holds, so put it back before the memory check.
if (currentSize !== size) {
  multi.setFftSize(size);
  currentSize = size;
}

const elapsed = performance.now() - started;
const after = heapMb();
const afterTyped = multi.analysers.reduce((sum, analyser) => {
  let bytes = 0;
  for (const key of Object.keys(analyser)) {
    const value = analyser[key];
    if (value && typeof value.byteLength === 'number' && value.BYTES_PER_ELEMENT) bytes += value.byteLength;
  }
  return sum + bytes;
}, 0);

let failures = 0;
function report(name, pass, detail) {
  if (!pass) failures += 1;
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + ' — ' + detail);
}

console.log(totalFrames + ' frames of three-microphone analysis, ' +
  ((totalFrames * hop) / rate).toFixed(1) + ' s of audio, in ' + (elapsed / 1000).toFixed(1) + ' s\n');

report('No NaN in magnitude, coherence or delay', nanFrames === 0,
  nanFrames + ' of ' + checkedFrames + ' checked frames carried an invalid value');
report('Heap does not grow beyond the buffers', after - baseline < 24,
  'heap ' + baseline.toFixed(1) + ' → ' + after.toFixed(1) + ' MB (Δ ' +
  (after - baseline).toFixed(1) + ' MB)');
report('Typed-array memory is stable across FFT-size changes', Math.abs(afterTyped - baselineTyped) < 1,
  (baselineTyped / 1048576).toFixed(2) + ' → ' + (afterTyped / 1048576).toFixed(2) + ' MB over ' +
  fftChanges + ' size changes');
report('Snapshots stay bounded', savedSnapshots.length <= 4,
  snapshots + ' snapshots taken, ' + savedSnapshots.length + ' held');

console.log('\n' + (failures === 0 ? 'no failures' : failures + ' failed'));
if (failures > 0) process.exitCode = 1;
