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

/** The envelope's own noise floor, taken from the last tenth of the window. */
export function envelopeNoiseFloor(envelope) {
  if (!envelope || envelope.length <= 32) return null;

  const tail = Math.max(8, Math.floor(envelope.length / 10));
  let sum = 0;
  let count = 0;
  for (let i = envelope.length - tail; i < envelope.length; i++) {
    const value = envelope[i];
    if (!Number.isFinite(value)) continue;
    sum += Math.pow(10, value / 10);
    count += 1;
  }
  if (!count || !(sum > 0)) return null;
  return 10 * Math.log10(sum / count);
}

/** Schroeder backward integral: the energy still to come, in dB from 0. */
export function schroederDecay(envelope, noiseDb) {
  if (!envelope || !envelope.length) return null;

  const noise = Number.isFinite(noiseDb) ? Math.pow(10, noiseDb / 10) : 0;
  const power = new Float64Array(envelope.length);

  for (let i = 0; i < envelope.length; i++) {
    const value = envelope[i];
    const linear = Number.isFinite(value) ? Math.pow(10, value / 10) : 0;
    power[i] = Math.max(0, linear - noise);
  }

  let total = 0;
  const decay = new Float64Array(envelope.length);
  for (let i = envelope.length - 1; i >= 0; i--) {
    total += power[i];
    decay[i] = 10 * Math.log10(Math.max(total, 1e-20));
  }

  if (Number.isFinite(decay[0])) {
    for (let i = 0; i < decay.length; i++) decay[i] -= decay[0];
  }
  return decay;
}

/** Fit a straight line between two levels of a Schroeder curve. */
export function fitSchroeder(decay, sampleRate, startDb, endDb) {
  if (!decay || !(sampleRate > 0) || decay.length <= 16) return null;

  let first = -1;
  for (let i = 1; i < decay.length; i++) {
    const value = decay[i];
    if (!Number.isFinite(value)) continue;
    if (first < 0 && value <= startDb) first = i;
    if (first >= 0 && value <= endDb) break;
  }
  if (first < 0) return null;

  let last = first;
  for (let i = first; i < decay.length; i++) {
    if (!Number.isFinite(decay[i])) continue;
    last = i;
    if (decay[i] <= endDb) break;
  }
  if (!(last > first + 8)) return null;

  const span = decay[first] - decay[last];
  if (!(span >= 8)) return null;

  let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0, count = 0;
  for (let i = first; i <= last; i++) {
    const value = decay[i];
    if (!Number.isFinite(value)) continue;
    const x = i / sampleRate;
    sumX += x;
    sumY += value;
    sumXX += x * x;
    sumXY += x * value;
    count += 1;
  }
  if (count < 8) return null;

  const denominator = count * sumXX - sumX * sumX;
  if (!(Math.abs(denominator) > 1e-18)) return null;

  const slope = (count * sumXY - sumX * sumY) / denominator;
  if (!(slope < -0.5) || !Number.isFinite(slope)) return null;

  const intercept = (sumY - slope * sumX) / count;
  let ssRes = 0;
  let ssTot = 0;
  const meanY = sumY / count;
  for (let i = first; i <= last; i++) {
    const value = decay[i];
    if (!Number.isFinite(value)) continue;
    const x = i / sampleRate;
    const predicted = intercept + slope * x;
    ssRes += (value - predicted) ** 2;
    ssTot += (value - meanY) ** 2;
  }

  const r2 = ssTot > 1e-18 ? Math.max(0, Math.min(1, 1 - ssRes / ssTot)) : 0;
  const rt60 = 60 / -slope;
  if (!(rt60 >= 0.05) || rt60 > 30) return null;

  return { rt60, r2 };
}

/** T20, T30 and EDT from one decay window, with the fit quality and noise floor. */
export function analyseDecay(envelope, sampleRate) {
  const noiseDb = envelopeNoiseFloor(envelope);
  const decay = schroederDecay(envelope, noiseDb);

  if (!decay) {
    return { t20: null, t30: null, edt: null, confidence: 0, noiseDb, decay: null };
  }

  const t20 = fitSchroeder(decay, sampleRate, -5, -25);
  const t30 = fitSchroeder(decay, sampleRate, -5, -35);
  const edt = fitSchroeder(decay, sampleRate, 0, -10);

  return {
    t20: t20 ? t20.rt60 : null,
    t30: t30 ? t30.rt60 : null,
    edt: edt ? edt.rt60 : null,
    confidence: Math.max(t30 ? t30.r2 : 0, t20 ? t20.r2 : 0),
    noiseDb,
    decay,
  };
}

/** C50 and C80 straight from the Schroeder curve. */
function clarityFromDecay(decay, sampleRate) {
  if (!decay) return null;

  const clarity = (seconds) => {
    const index = Math.min(decay.length - 1, Math.max(1, Math.round(seconds * sampleRate)));
    const total = Math.pow(10, decay[0] / 10);
    const late = Math.pow(10, decay[index] / 10);
    const early = total - late;
    if (!(early > 0) || !(late > 1e-12)) return null;
    return 10 * Math.log10(early / late);
  };

  const c50 = clarity(0.05);
  const c80 = clarity(0.08);
  if (c50 === null || c80 === null) return null;
  return { c50, c80 };
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
  const reading = analyseDecay(envelope, sampleRate);
  const overall = reading.t30 !== null ? reading.t30 : reading.t20;
  const clarity = clarityFromDecay(reading.decay, sampleRate) || decayClarity(envelope, sampleRate);

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
    const bandReading = analyseDecay(bandEnvelope, sampleRate);
    const rt60 = bandReading.t30 !== null ? bandReading.t30 : bandReading.t20;
    if (rt60 !== null && rt60 !== undefined) bands.push({ frequency: centre, rt60 });
  }

  return {
    overall,
    bands,
    gated,
    clarity,
    t20: reading.t20,
    t30: reading.t30,
    edt: reading.edt,
    confidence: reading.confidence,
    noiseDb: reading.noiseDb,
  };
}
