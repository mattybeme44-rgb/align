import { FFT } from './fft.js';

/*
 * Total harmonic distortion by stepped tone: play one sine at a time through
 * the measurement output and read the harmonics it excites at two, three and
 * four times the tone.
 */

const FFT_SIZE = 16384;
const fft = new FFT(FFT_SIZE);
const taper = Float64Array.from(
  { length: FFT_SIZE },
  (_, i) => 0.5 * (1 - Math.cos(2 * Math.PI * i / FFT_SIZE)),
);

/** Third-octave steps from 100 Hz to 8 kHz. */
export const DISTORTION_STEPS = [
  100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
  1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000,
];

function unusable(f0) {
  return { frequency: f0, thdPercent: null, valid: false, fundamentalDb: null, strongest: null, strongestDb: null };
}

export function measureDistortion(samples, rate, f0) {
  if (!samples || samples.length < FFT_SIZE || !(rate > 0) || !(f0 > 0)) return unusable(f0);

  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const offset = samples.length - FFT_SIZE;
  let windowSum = 0;
  for (let i = 0; i < FFT_SIZE; i++) {
    re[i] = samples[offset + i] * taper[i];
    windowSum += taper[i];
  }
  if (!(windowSum > 0)) return unusable(f0);
  fft.forward(re, im);

  const df = rate / FFT_SIZE;
  const half = FFT_SIZE / 2;

  function bandPower(freq) {
    const centre = Math.round(freq / df);
    if (centre < 1 || centre + 3 >= half) return null;
    let sum = 0;
    for (let k = centre - 3; k <= centre + 3; k++) {
      sum += re[k] * re[k] + im[k] * im[k];
    }
    return sum;
  }

  const fundamental = bandPower(f0);
  if (!fundamental) return unusable(f0);

  // A sine of peak amplitude A at the tone reads rms(A/√2) here, so a
  // full-scale sine lands at -3 dBFS.
  const rmsOf = (power) => Math.sqrt(2 * power) / windowSum;
  const fundamentalDb = 20 * Math.log10(Math.max(rmsOf(fundamental), 1e-9));

  let harmonicPower = 0;
  let strongest = null;
  let strongestPower = 0;
  let strongestDb = null;
  for (const harmonic of [2, 3, 4]) {
    const power = bandPower(harmonic * f0);
    if (power === null) continue;
    harmonicPower += power;
    if (power > strongestPower) {
      strongestPower = power;
      strongest = harmonic;
      strongestDb = 20 * Math.log10(Math.max(rmsOf(power), 1e-9));
    }
  }

  const thd = 100 * Math.sqrt(harmonicPower / fundamental);
  const valid = fundamentalDb > -55;

  return {
    frequency: f0,
    thdPercent: valid ? thd : null,
    valid,
    fundamentalDb,
    strongest,
    strongestDb,
  };
}
