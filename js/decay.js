import { FFT } from './fft.js';

/*
 * What the room does after the direct sound: the early arrivals behind the
 * impulse peak, and how long the response takes to fall 60 dB per third-octave
 * band. Both read the same complex impulse response the waterfall uses.
 */

export const DECAY_BAND_CENTRES = [
  250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000,
];

const fftCache = new Map();

function fftFor(size) {
  if (!fftCache.has(size)) fftCache.set(size, new FFT(size));
  return fftCache.get(size);
}

/** The strongest peaks behind the direct sound, inside the first 50 ms. */
export function buildReflections(res) {
  if (!res || !(res.fftSize > 1) || !(res.sampleRate > 0) || !res.irDb) return [];
  const n = Math.min(res.fftSize, res.irDb.length);
  if (n <= 8) return [];

  let peak = 0;
  let peakValue = -Infinity;
  for (let i = 0; i < n; i++) {
    if (res.irDb[i] > peakValue) {
      peakValue = res.irDb[i];
      peak = i;
    }
  }
  if (!Number.isFinite(peakValue)) return [];

  const window = Math.min(n - 1, Math.round(0.05 * res.sampleRate));
  if (window <= 4) return [];

  const values = new Float64Array(window);
  for (let k = 0; k < window; k++) values[k] = res.irDb[(peak + k) % n];

  // A gentle 3-tap pass, so a single noisy sample is not a reflection.
  const smoothed = new Float64Array(window);
  for (let i = 0; i < window; i++) {
    const a = values[Math.max(0, i - 1)];
    const b = values[i];
    const c = values[Math.min(window - 1, i + 1)];
    smoothed[i] = (a + 2 * b + c) / 4;
  }

  const spacing = Math.max(1, Math.round(0.001 * res.sampleRate));
  const minimumLevel = -30;
  const minimumProminence = 6;

  const found = [];
  let valley = 0;
  let lastIndex = -spacing;

  for (let i = 1; i < window - 1; i++) {
    const value = smoothed[i];
    if (value < valley) valley = value;

    const isPeak = value >= smoothed[i - 1] && value >= smoothed[i + 1];
    if (isPeak && value >= minimumLevel && i - lastIndex >= spacing && value - valley >= minimumProminence) {
      found.push({ index: i, level: value });
      lastIndex = i;
      valley = value;
    }
  }

  return found
    .sort((a, b) => b.level - a.level)
    .slice(0, 6)
    .map((item) => ({
      delayMs: item.index / res.sampleRate * 1000,
      levelDb: item.level,
    }));
}

/** The energy envelope of a complex signal in dB, smoothed over about 1 ms. */
function decayEnvelope(re, im, length, sampleRate) {
  const count = Math.min(length, re.length, im.length);
  if (!(count > 1) || !(sampleRate > 0)) return null;

  const window = Math.max(1, Math.round(0.001 * sampleRate));
  const envelope = new Float64Array(count);
  let running = 0;

  for (let i = 0; i < count; i++) {
    const power = re[i] * re[i] + im[i] * im[i];
    running += power;
    if (i >= window) {
      const old = i - window;
      running -= re[old] * re[old] + im[old] * im[old];
    }
    const mean = running / Math.min(i + 1, window);
    envelope[i] = 10 * Math.log10(Math.max(mean, 1e-20));
  }
  return envelope;
}

/** Least-squares RT60: fit the part of the envelope falling 5 to 25 dB. */
function fitDecayRT60(envelope, sampleRate) {
  if (!envelope || !(sampleRate > 0)) return null;

  let loudest = -Infinity;
  for (let i = 0; i < envelope.length; i++) {
    if (envelope[i] > loudest) loudest = envelope[i];
  }
  if (!Number.isFinite(loudest)) return null;

  const startLevel = loudest - 5;
  const endLevel = loudest - 25;
  let first = -1;
  let last = -1;

  for (let i = 0; i < envelope.length; i++) {
    const value = envelope[i];
    if (!Number.isFinite(value)) continue;
    if (first < 0 && i > 0 && value <= startLevel) first = i;
    if (first >= 0 && value <= endLevel) {
      last = i;
      break;
    }
  }

  if (first < 0) return null;
  const end = last >= 0 ? last : envelope.length - 1;
  if (!(end > first + 1)) return null;
  // A fit over less than 8 dB is noise dressed as a slope.
  if (envelope[first] - envelope[end] < 8) return null;

  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  let count = 0;

  for (let i = first; i <= end; i++) {
    const value = envelope[i];
    if (!Number.isFinite(value)) continue;
    const x = i / sampleRate;
    sumX += x;
    sumY += value;
    sumXX += x * x;
    sumXY += x * value;
    count += 1;
  }
  if (count < 4) return null;

  const denominator = count * sumXX - sumX * sumX;
  if (!(Math.abs(denominator) > 1e-12)) return null;

  const slope = (count * sumXY - sumX * sumY) / denominator;
  if (!(slope < -1) || !Number.isFinite(slope)) return null;

  const rt60 = 60 / -slope;
  if (!(rt60 >= 0.05) || rt60 > 30) return null;
  return rt60;
}

/** C50 and C80 from an energy envelope that starts at the impulse peak. */
export function decayClarity(envelope, sampleRate) {
  if (!envelope || envelope.length <= 8 || !(sampleRate > 0)) return null;
  // A decay shorter than 100 ms after the peak cannot say anything honest.
  if (envelope.length < 0.1 * sampleRate) return null;

  let loudest = -Infinity;
  let total = 0;
  for (const value of envelope) {
    if (!Number.isFinite(value)) continue;
    loudest = Math.max(loudest, value);
    total += Math.pow(10, value / 10);
  }
  if (!Number.isFinite(loudest) || loudest <= -80 || total <= 0) return null;

  const clarity = (seconds) => {
    const split = Math.min(envelope.length, Math.round(seconds * sampleRate));
    let early = 0;
    for (let i = 0; i < split; i++) {
      const value = envelope[i];
      if (!Number.isFinite(value)) continue;
      early += Math.pow(10, value / 10);
    }
    const late = total - early;
    if (!(early > 0) || late <= 1e-12 * total) return 99;
    return 10 * Math.log10(early / late);
  };

  return { c50: clarity(0.05), c80: clarity(0.08) };
}

/** Plain words for what the clarity ratios say about the listening position. */
export function clarityReading(c50) {
  if (c50 >= 10) return 'A speech-friendly position.';
  if (c50 >= 0) return 'Between speech and music.';
  return 'A reverberant position.';
}

/**
 * RT60 overall and per third-octave band from 250 Hz to 4 kHz, read from the
 * gate when it is on and from the whole response when it is off.
 */
export function buildRoomDecay(res, gate) {
  if (!res || !res.irRe || !res.irIm || !(res.sampleRate > 0)) return null;
  const n = Math.min(res.irRe.length, res.irIm.length);
  if (n <= 512) return null;

  let peak = 0;
  let peakEnergy = -Infinity;
  for (let i = 0; i < n; i++) {
    const energy = res.irRe[i] * res.irRe[i] + res.irIm[i] * res.irIm[i];
    if (energy > peakEnergy) {
      peakEnergy = energy;
      peak = i;
    }
  }
  if (!(peakEnergy > 0)) return null;

  const sampleRate = res.sampleRate;
  const gated = !!(gate && gate.enabled);
  const offset = gated ? Math.max(0, Math.round((gate.startMs / 1000) * sampleRate)) : 0;
  const wholeWindow = Math.min(n - 1, Math.round(1.5 * sampleRate));
  const requested = gated ? Math.round((gate.widthMs / 1000) * sampleRate) : wholeWindow;
  const length = Math.max(64, Math.min(wholeWindow, requested));
  if (!(length > 64)) return null;

  const spectrumRe = new Float64Array(n);
  const spectrumIm = new Float64Array(n);
  // Fade the far end out, so the segment's abrupt end does not ring back into
  // the decay the fit is reading.
  const fade = Math.min(Math.floor(length / 2), Math.max(8, Math.floor(length / 10)));
  for (let k = 0; k < length; k++) {
    let index = (peak + offset + k) % n;
    if (index < 0) index += n;
    let weight = 1;
    if (k >= length - fade) {
      weight = 0.5 * (1 + Math.cos(Math.PI * (k - (length - fade)) / fade));
    }
    spectrumRe[k] = res.irRe[index] * weight;
    spectrumIm[k] = res.irIm[index] * weight;
  }

  const envelope = decayEnvelope(spectrumRe, spectrumIm, length, sampleRate);
  const overall = fitDecayRT60(envelope, sampleRate);
  const clarity = decayClarity(envelope, sampleRate);

  const fft = fftFor(n);
  fft.forward(spectrumRe, spectrumIm);

  const df = sampleRate / n;
  const ratio = Math.pow(2, 1 / 6);
  const bins = res.bins || Math.floor(n / 2) + 1;
  const bands = [];

  for (const centre of DECAY_BAND_CENTRES) {
    const low = Math.max(1, Math.floor((centre / ratio) / df));
    const high = Math.min(bins - 1, Math.floor((centre * ratio) / df));
    if (!(high >= low)) continue;

    const bandRe = spectrumRe.slice();
    const bandIm = spectrumIm.slice();
    for (let k = 0; k < n; k++) {
      if (k >= low && k <= high) continue;
      bandRe[k] = 0;
      bandIm[k] = 0;
    }
    fft.inverse(bandRe, bandIm);

    const bandEnvelope = decayEnvelope(bandRe, bandIm, length, sampleRate);
    const rt60 = fitDecayRT60(bandEnvelope, sampleRate);
    if (rt60 !== null) bands.push({ frequency: centre, rt60 });
  }

  return { overall, bands, gated, clarity };
}
