/*
 * Phase 2 checks: calibration sign, silent inputs, spatial-average bias, the
 * coherence maths against a known SNR, and the decay window's edges.
 *
 *   node tests/phase2.mjs
 *
 * Synthetic signals with known answers throughout. None of this is a live
 * measurement.
 */

import { Analyser } from '../js/analyser.js';
import { MultiAnalyser } from '../js/multianalyser.js';
import { applyCalibration } from '../js/calibration.js';
import { calibrationCurve, applyCorrection } from '../js/micmatch.js';
import { spatialAverage } from '../js/spatial.js';
import { buildRoomDecay } from '../js/decay.js';

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

/* 1. A manufacturer calibration must be removed, not doubled, in both paths. */
{
  const bins = 128;
  const df = 100;
  const magDb = new Float32Array(bins).fill(0);
  // The microphone reads 3 dB high across the band; the file says so.
  const cal = { name: 'test', points: [{ frequency: 1000, db: 3 }, { frequency: 9000, db: 3 }] };
  const single = applyCalibration({ df, magDb, bins }, cal);
  const multi = applyCorrection(magDb, calibrationCurve(cal, bins, df));
  const k = 20; // 2 kHz
  const agree = Math.abs(single.magDb[k] - multi[k]) < 1e-6;
  const corrected = Math.abs(single.magDb[k] + 3) < 1e-4;
  report('Calibration is removed, and both paths agree', agree && corrected,
    'single-microphone ' + single.magDb[k].toFixed(2) + ' dB, multi-microphone ' +
    multi[k].toFixed(2) + ' dB at 2 kHz (expected −3.00 dB from both)');
}

/* 2. A microphone that goes silent must say so, and its curve must fall. */
{
  const size = 8192;
  const rate = 48000;
  const ref = whiteNoise(40000, 31);
  // Mic B hears the reference at half level, 60 samples late: a clean -6 dB.
  const mic = new Float32Array(40000);
  for (let i = 60; i < 40000; i++) mic[i] = 0.5 * ref[i - 60];

  const multi = new MultiAnalyser(size, rate, 3);
  const r = new Float32Array(size);
  const micWindow = new Float32Array(size);

  for (let frame = 0; frame < 20; frame++) {
    const start = frame * 1024;
    r.set(ref.subarray(start, start + size));
    micWindow.set(mic.subarray(start, start + size));
    // Mic A is coherent, mic B drops out at frame 20, mic C tracks A.
    multi.accumulate([micWindow, micWindow, micWindow], r);
  }
  const before = multi.results({ compensate: false, smoothing: 0, normalize: false })[1];
  const k = Math.round(3000 / before.df);
  const magnitudeBefore = before.magDb[k];
  const coherenceBefore = before.coh[k];

  // Input 2 stops: the workspace passes null for it from here on.
  for (let frame = 20; frame < 60; frame++) {
    const start = frame * 1024;
    r.set(ref.subarray(start, start + size));
    micWindow.set(mic.subarray(start, start + size));
    multi.accumulate([micWindow, null, micWindow], r);
  }
  const after = multi.results({ compensate: false, smoothing: 0, normalize: false })[1];

  const dropped = magnitudeBefore - after.magDb[k];
  report('A silent microphone reports no signal and its curve falls away',
    after.silent === true && after.coh[k] < 0.2 && dropped > 20,
    'silent ' + after.silent + ', magnitude ' + magnitudeBefore.toFixed(1) + ' → ' +
    after.magDb[k].toFixed(1) + ' dB, coherence ' + (coherenceBefore * 100).toFixed(0) + '% → ' +
    (after.coh[k] * 100).toFixed(0) + '%');

  const live = multi.results({ compensate: false, smoothing: 0, normalize: false })[0];
  report('The microphones still connected keep measuring', live.silent === false && live.coh[k] > 0.9,
    'mic A coherence ' + (live.coh[k] * 100).toFixed(0) + '% while mic B was silent');
}

/* 3. A microphone with no data must not pull the average down. */
{
  const bins = 64;
  const df = 500;
  const good = () => {
    const magDb = new Float32Array(bins);
    const coh = new Float32Array(bins).fill(0.9);
    for (let k = 1; k < bins; k++) magDb[k] = 0;
    return { bins, df, magDb, coh };
  };
  const dead = good();
  for (let k = 1; k < bins; k++) dead.magDb[k] = NaN;

  const average = spatialAverage([good(), dead], [true, true], 'power', null);
  const k = 10;
  report('A microphone with no data does not bias the average',
    Number.isFinite(average.magDb[k]) && Math.abs(average.magDb[k]) < 1e-4,
    'average ' + average.magDb[k].toFixed(2) + ' dB with one microphone reporting no data (expected 0.00 dB)');

  const width = spatialAverage([good(), dead], [false, false], 'power', null);
  report('An average with nothing enabled reports no data, not −140 dB',
    Number.isNaN(width.magDb[k]),
    'value ' + String(width.magDb[k]) + ' with every microphone disabled');
}

/* 4. Coherence of a signal with independent noise follows SNR/(1+SNR). */
{
  const size = 8192;
  const rate = 48000;
  const frames = 260;
  const length = frames * 1024 + size;
  const signal = whiteNoise(length, 41);
  const noise = whiteNoise(length, 42);
  // Signal power 1, noise power 0.25: SNR 4, so coherence should read 0.8.
  const measured = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    measured[i] = signal[i] + noise[i] * 0.5;
  }
  const analyser = new Analyser(size, rate);
  analyser.updateRate = 0.02;
  const r = new Float32Array(size);
  const m = new Float32Array(size);
  for (let frame = 0; frame < frames; frame++) {
    const start = frame * 1024;
    r.set(signal.subarray(start, start + size));
    m.set(measured.subarray(start, start + size));
    analyser.accumulate(m, r);
  }
  const res = analyser.results({ compensate: false, smoothing: 0, normalize: false });
  const k0 = Math.round(1000 / res.df);
  const k1 = Math.round(8000 / res.df);
  let sum = 0;
  let count = 0;
  for (let k = k0; k <= k1; k++) {
    sum += res.coh[k];
    count += 1;
  }
  const mean = sum / count;
  report('Coherence of a signal with noise at SNR 4 reads 0.80', Math.abs(mean - 0.8) < 0.05,
    'mean coherence ' + mean.toFixed(3) + ' over 1–8 kHz (expected 0.800)');
}

/* 5. Decay: a window past the end of the impulse response is refused. */
function decayingResponse(options) {
  const n = options.fftSize;
  const rate = options.sampleRate;
  const irRe = new Float64Array(n);
  const irIm = new Float64Array(n);
  const random = mulberry32(options.seed);
  if (options.decay) {
    const peak = options.peak || Math.round(0.02 * rate);
    for (let i = peak; i < n; i++) {
      const t = (i - peak) / rate;
      const envelope = Math.exp(-t * 6.9 / options.rt60);
      irRe[i] = envelope * (random() * 2 - 1);
      irIm[i] = envelope * (random() * 2 - 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      irRe[i] = (random() * 2 - 1) * 1e-4;
      irIm[i] = (random() * 2 - 1) * 1e-4;
    }
  }
  return {
    fftSize: n, sampleRate: rate, bins: n / 2 + 1, irRe, irIm,
    magDb: new Float32Array(n / 2 + 1), phaseDeg: new Float32Array(n / 2 + 1),
    coh: new Float32Array(n / 2 + 1),
  };
}

{
  // A 0.4 s decay needs a window long enough to hold it: 65536 at 48 kHz is
  // 1.37 s, where 8192 is only 170 ms.
  const long = decayingResponse({ fftSize: 65536, sampleRate: 48000, decay: true, rt60: 0.4, seed: 5 });
  const short = decayingResponse({ fftSize: 8192, sampleRate: 48000, decay: true, rt60: 0.4, seed: 5 });

  const beyond = buildRoomDecay(short, { enabled: true, startMs: 170, widthMs: 60 });
  report('A decay window past the end of the impulse response is refused', beyond === null,
    beyond === null ? 'refused' : 'returned a reading of ' + (beyond.overall || 'null') + ' s');

  const tooShort = buildRoomDecay(short, { enabled: true, startMs: 0, widthMs: 150 });
  report('A window too short to hold the decay reports nothing', tooShort === null || tooShort.overall === null,
    tooShort && tooShort.overall !== null
      ? 'reported ' + tooShort.overall.toFixed(2) + ' s from a 170 ms window'
      : 'no reading, as it should be');

  const inside = buildRoomDecay(long, { enabled: true, startMs: 0, widthMs: 600 });
  const ok = inside && inside.overall !== null;
  const error = ok ? Math.abs(inside.overall - 0.4) : Infinity;
  report('A decay window inside the response reads the true RT60', ok && error < 0.1,
    ok ? 'RT60 ' + inside.overall.toFixed(3) + ' s against a true 0.400 s, confidence ' +
      inside.confidence.toFixed(2) : 'no reading from a window that holds the decay');
}

/* 6. Noise with no decay must not produce an RT60. */
{
  const res = decayingResponse({ fftSize: 8192, sampleRate: 48000, decay: false, seed: 9 });
  const reading = buildRoomDecay(res, { enabled: true, startMs: 0, widthMs: 150 });
  const value = reading ? reading.overall : null;
  report('Noise with no decay does not produce an RT60', reading === null || value === null,
    value === null ? 'no reading' : 'reported ' + Number(value).toFixed(2) + ' s');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
