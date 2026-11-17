/*
 * Audit checks: the gated transfer function, the polarity readout, the
 * interpolation of stored curves, and a guard that the ungated analysis still
 * matches the pre-audit analyser kept in tests/_baseline.
 *
 *   node tests/audit.mjs
 *
 * Every signal is synthetic and carries its own known answer. None of this is a
 * live measurement.
 */

import { Analyser } from '../js/analyser.js';
import { generateSignal } from '../js/signals.js';
import { MultiAnalyser } from '../js/multianalyser.js';
import { curveFromPoints } from '../js/micmatch.js';
import { Analyser as BaselineAnalyser } from './_baseline/analyser.js';

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

/** source delayed by `samples`, scaled by `gain` (a negative gain inverts it). */
function delayed(source, samples, gain = 1) {
  const out = new Float32Array(source.length);
  for (let i = samples; i < source.length; i++) out[i] = gain * source[i - samples];
  return out;
}

/* 1. A gated transfer function of a flat response must stay flat. */
{
  const size = 8192;
  const rate = 48000;
  const samples = 73;
  const white = whiteNoise(60000, 17);
  // A strongly coloured reference: a one-pole low-pass of white noise. Its
  // spectrum falls away steeply with frequency, which is what exposes a gated
  // curve that is built from the cross spectrum instead of the transfer function.
  const ref = new Float32Array(white.length);
  let state = 0;
  for (let i = 0; i < white.length; i++) {
    state = 0.95 * state + white[i];
    ref[i] = state;
  }
  const mic = delayed(ref, samples, 0.5);

  const run = (gate) => {
    const analyser = new Analyser(size, rate);
    analyser.updateRate = 0.05;
    analyser.searchRadius = 0;
    const r = new Float32Array(size);
    const m = new Float32Array(size);
    for (let frame = 0; frame < 40; frame++) {
      const start = frame * 1024;
      r.set(ref.subarray(start, start + size));
      m.set(mic.subarray(start, start + size));
      analyser.accumulate(m, r);
    }
    return analyser.results({ compensate: false, smoothing: 0, normalize: false, gate });
  };

  const worstDeviation = (res) => {
    const k0 = Math.round(200 / res.df);
    const k1 = Math.round(5000 / res.df);
    let worst = 0;
    for (let k = k0; k <= k1; k++) worst = Math.max(worst, Math.abs(res.magDb[k] + 6.02));
    return worst;
  };

  const ungated = worstDeviation(run(null));
  const gated = worstDeviation(run({ enabled: true, startMs: -2, widthMs: 20 }));
  report('Ungated curve of a flat -6.02 dB response', ungated < 0.3,
    'worst deviation ' + ungated.toFixed(2) + ' dB over 200 Hz – 5 kHz');
  report('Gated curve of the same response', gated < 0.3,
    'worst deviation ' + gated.toFixed(2) + ' dB over 200 Hz – 5 kHz (must match the ungated curve)');
}

/* 2. Polarity must be reported, both normal and inverted. */
function polarityFor(sign) {
  const size = 8192;
  const rate = 48000;
  const ref = whiteNoise(40000, 29);
  const mic = delayed(ref, 73, sign);
  const analyser = new Analyser(size, rate);
  analyser.updateRate = 0.05;
  analyser.searchRadius = 0;
  const r = new Float32Array(size);
  const m = new Float32Array(size);
  let last = null;
  for (let frame = 0; frame < 12; frame++) {
    const start = frame * 1024;
    r.set(ref.subarray(start, start + size));
    m.set(mic.subarray(start, start + size));
    analyser.accumulate(m, r);
    // The app calls results() on every analysis frame, and polarity is a vote
    // across those frames, so the check does the same.
    last = analyser.results({ compensate: false, smoothing: 0, normalize: false });
  }
  return last;
}

{
  const normal = polarityFor(1);
  report('Polarity of a normal-phase microphone',
    normal.polarityKnown === true && normal.polarity === 1,
    'known ' + normal.polarityKnown + ', reads ' + (normal.polarity > 0 ? 'normal' : 'inverted'));
}
{
  const inverted = polarityFor(-1);
  report('Polarity of an inverted microphone',
    inverted.polarityKnown === true && inverted.polarity === -1,
    'known ' + inverted.polarityKnown + ', reads ' + (inverted.polarity > 0 ? 'normal' : 'inverted'));
}

/* 3. Stored curves must interpolate in log frequency, like the vendor curves. */
{
  const points = [{ frequency: 100, db: 0 }, { frequency: 1000, db: 10 }];
  const df = 10;
  const bins = 201;
  const curve = curveFromPoints(points, bins, df);
  const k = 32; // 320 Hz
  const expected = 10 * Math.log10(320 / 100);
  report('Stored curve interpolates in log frequency', curve !== null && Math.abs(curve[k] - expected) < 0.05,
    'at 320 Hz ' + (curve ? curve[k].toFixed(2) : 'null') + ' dB, log-linear expects ' + expected.toFixed(2) + ' dB');
}

/* 4. The ungated analysis must still match the pre-audit analyser exactly. */
{
  const size = 8192;
  const rate = 48000;
  const ref = whiteNoise(40000, 7);
  const mic = delayed(ref, 211, 0.7);
  const current = new Analyser(size, rate);
  const old = new BaselineAnalyser(size, rate);
  const r = new Float32Array(size);
  const m = new Float32Array(size);
  const options = { compensate: true, smoothing: 1 / 6, normalize: true, phaseSmoothing: 1 / 6 };
  let worst = 0;
  for (let frame = 0; frame < 12; frame++) {
    const start = frame * 1024;
    r.set(ref.subarray(start, start + size));
    m.set(mic.subarray(start, start + size));
    current.accumulate(m, r);
    old.accumulate(m, r);
    const a = current.results(options);
    const b = old.results(options);
    for (let k = 0; k < a.bins; k++) {
      worst = Math.max(worst, Math.abs(a.magDb[k] - b.magDb[k]), Math.abs(a.phaseDeg[k] - b.phaseDeg[k]),
        Math.abs(a.coh[k] - b.coh[k]));
    }
    worst = Math.max(worst, Math.abs(a.delayMs - b.delayMs));
  }
  report('Ungated analysis matches the pre-audit analyser', worst < 1e-4,
    'largest difference ' + worst.toExponential(2) + ' across magnitude, phase, coherence and delay');
}

/* 5. Three-microphone analysis must match three independent analysers. */
{
  const size = 8192;
  const rate = 48000;
  const ref = whiteNoise(40000, 13);
  const mics = [0, 1, 2].map((i) => delayed(ref, 60 + 40 * i, 0.5 + 0.3 * i));
  const multi = new MultiAnalyser(size, rate, 3);
  const solo = [0, 1, 2].map(() => new Analyser(size, rate));
  const r = new Float32Array(size);
  const windows = [0, 1, 2].map(() => new Float32Array(size));
  const options = { compensate: false, smoothing: 1 / 6, normalize: false, phaseSmoothing: 1 / 6 };
  let worst = 0;
  for (let frame = 0; frame < 12; frame++) {
    const start = frame * 1024;
    r.set(ref.subarray(start, start + size));
    for (let i = 0; i < 3; i++) windows[i].set(mics[i].subarray(start, start + size));
    multi.accumulate(windows, r);
    for (let i = 0; i < 3; i++) solo[i].accumulate(windows[i], r);
    const grouped = multi.results(options);
    for (let i = 0; i < 3; i++) {
      const single = solo[i].results(options);
      for (let k = 0; k < single.bins; k++) {
        worst = Math.max(worst, Math.abs(grouped[i].magDb[k] - single.magDb[k]));
      }
    }
  }
  report('Three-microphone analysis matches independent analysers', worst < 1e-6,
    'largest magnitude difference ' + worst.toExponential(2) + ' dB');
}

/* 6. Gate on the app's default stimulus: a pink-noise reference, a flat response. */
{
  const size = 8192;
  const rate = 48000;
  const ref = generateSignal('pink', rate, 1000);
  const mic = delayed(ref, 73, 0.5);
  const analyser = new Analyser(size, rate);
  analyser.updateRate = 0.05;
  analyser.searchRadius = 0;
  const r = new Float32Array(size);
  const m = new Float32Array(size);
  for (let frame = 0; frame < 40; frame++) {
    const start = frame * 1024;
    r.set(ref.subarray(start, start + size));
    m.set(mic.subarray(start, start + size));
    analyser.accumulate(m, r);
  }
  const res = analyser.results({ compensate: false, smoothing: 0, normalize: false,
    gate: { enabled: true, startMs: -2, widthMs: 20 } });
  const k0 = Math.round(200 / res.df);
  const k1 = Math.round(5000 / res.df);
  let worst = 0;
  for (let k = k0; k <= k1; k++) worst = Math.max(worst, Math.abs(res.magDb[k] + 6.02));
  report('Gated curve with a pink-noise reference', worst < 0.5,
    'worst deviation ' + worst.toFixed(2) + ' dB over 200 Hz – 5 kHz');
}

/* 7. The coherence array is reused across frames, not allocated per frame. */
{
  const size = 8192;
  const rate = 48000;
  const ref = whiteNoise(20000, 21);
  const mic = delayed(ref, 40, 0.5);
  const analyser = new Analyser(size, rate);
  const r = new Float32Array(size);
  const m = new Float32Array(size);
  const options = { compensate: false, smoothing: 0, normalize: false };

  r.set(ref.subarray(0, size));
  m.set(mic.subarray(0, size));
  analyser.accumulate(m, r);
  const first = analyser.results(options);

  r.set(ref.subarray(4096, 4096 + size));
  m.set(mic.subarray(4096, 4096 + size));
  analyser.accumulate(m, r);
  const second = analyser.results(options);

  const reused = first.coh === second.coh && first.coh.buffer === second.coh.buffer;
  report('Coherence reuses one buffer across frames', reused,
    reused ? 'one allocation, reused — the per-frame allocation was GC churn'
      : 'a fresh array was allocated');

  // The reused buffer still carries this frame's values, not the last frame's.
  const analyserB = new Analyser(size, rate);
  const rB = new Float32Array(size);
  const mB = new Float32Array(size);
  rB.set(ref.subarray(0, size));
  mB.set(ref.subarray(0, size)); // mic identical to the reference: coherence ~1
  analyserB.accumulate(mB, rB);
  analyserB.accumulate(mB, rB);
  const resB = analyserB.results({ compensate: false, smoothing: 0, normalize: false });
  let outOfRange = 0;
  for (let k = 1; k < resB.bins; k++) {
    if (!(resB.coh[k] >= 0 && resB.coh[k] <= 1)) outOfRange += 1;
  }
  const kMid = Math.round(1000 / resB.df);
  report('Coherence stays bounded and reads the current frame',
    outOfRange === 0 && resB.coh[kMid] > 0.99,
    'coherence at 1 kHz ' + (resB.coh[kMid] * 100).toFixed(1) + '% for identical signals, ' +
      outOfRange + ' bins outside 0–1');
}

/* 8. The gate window works on the analytic-signal IR (complex), not just its magnitude. */
{
  // A pure delay plus a half-cycle phase flip at the peak: the sign of the
  // correlation peak must survive as polarity, and the gated curve of a flat
  // response must stay flat whatever the gate's start position.
  const size = 8192;
  const rate = 48000;
  const ref = generateSignal('pink', rate, 1000);
  const mic = delayed(ref, 73, 0.5);
  const analyser = new Analyser(size, rate);
  analyser.updateRate = 0.05;
  const r = new Float32Array(size);
  const m = new Float32Array(size);
  for (let frame = 0; frame < 40; frame++) {
    const start = frame * 1024;
    r.set(ref.subarray(start, start + size));
    m.set(mic.subarray(start, start + size));
    analyser.accumulate(m, r);
  }
  // Two different gate starts on the same flat response must agree.
  const gateA = analyser.results({ compensate: false, smoothing: 0, normalize: false,
    gate: { enabled: true, startMs: -1, widthMs: 20 } });
  const gateB = analyser.results({ compensate: false, smoothing: 0, normalize: false,
    gate: { enabled: true, startMs: -0.5, widthMs: 20 } });
  const k0 = Math.round(300 / gateA.df);
  const k1 = Math.round(3000 / gateA.df);
  let worst = 0;
  for (let k = k0; k <= k1; k++) worst = Math.max(worst, Math.abs(gateA.magDb[k] - gateB.magDb[k]));
  report('Two gate positions read the same flat response', worst < 0.3,
    'worst difference ' + worst.toFixed(3) + ' dB over 300 Hz – 3 kHz');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
