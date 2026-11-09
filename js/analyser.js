import { FFT, hannWindow } from './fft.js';

/**
 * Fractional-octave power smoothing over a linearly spaced spectrum.
 * `octaves` is the bandwidth in octaves (1/6 -> 0.1667).
 */
export function smoothPower(power, df, octaves) {
  const bins = power.length;
  const cum = new Float64Array(bins + 1);
  for (let k = 0; k < bins; k++) cum[k + 1] = cum[k] + power[k];

  const out = new Float64Array(bins);
  const ratio = Math.pow(2, octaves / 2);

  for (let k = 0; k < bins; k++) {
    const f = Math.max(k * df, df);
    let k0 = Math.floor(f / ratio / df);
    let k1 = Math.ceil((f * ratio) / df);
    if (k0 < 1) k0 = 1;
    if (k1 > bins - 1) k1 = bins - 1;
    if (k1 < k0) {
      out[k] = power[k];
      continue;
    }
    out[k] = (cum[k1 + 1] - cum[k0]) / (k1 - k0 + 1);
  }
  return out;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Compare 1/3-octave bands against their local median and suggest corrections.
 * Returns [{ freq, gain }] sorted by absolute gain, biggest first.
 */
export function suggestEq(magDb, coh, sampleRate, fftSize) {
  const df = sampleRate / fftSize;
  const bins = magDb.length;
  const half = Math.pow(2, 1 / 6);

  const bands = [];
  for (let f = 40; f <= 16000; f *= Math.pow(2, 1 / 3)) {
    const k0 = Math.max(1, Math.floor(f / half / df));
    const k1 = Math.min(bins - 1, Math.ceil((f * half) / df));
    if (k1 <= k0) {
      bands.push(null);
      continue;
    }
    let power = 0;
    let coherence = 0;
    for (let k = k0; k <= k1; k++) {
      power += Math.pow(10, Math.max(-140, magDb[k]) / 10);
      coherence += coh[k];
    }
    const count = k1 - k0 + 1;
    bands.push({
      freq: f,
      db: 10 * Math.log10(Math.max(power / count, 1e-14)),
      coherence: coherence / count,
    });
  }

  const suggestions = [];
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i];
    if (!band || band.coherence < 0.5) continue;
    const neighbours = [];
    for (let j = Math.max(0, i - 2); j <= Math.min(bands.length - 1, i + 2); j++) {
      if (bands[j]) neighbours.push(bands[j].db);
    }
    if (neighbours.length < 3) continue;
    const deviation = band.db - median(neighbours);
    if (Math.abs(deviation) < 3) continue;
    const gain = Math.max(-9, Math.min(6, -deviation));
    suggestions.push({ freq: band.freq, gain });
  }

  suggestions.sort((a, b) => Math.abs(b.gain) - Math.abs(a.gain));
  return suggestions.slice(0, 6);
}

/**
 * Exponential-averaged transfer function analyser.
 * Feed it matched windows of the measurement and the reference signal.
 */
export class Analyser {
  constructor(fftSize, sampleRate) {
    this.sampleRate = sampleRate;
    this.fftSize = 0;
    this.setFftSize(fftSize);
    // 0 = search the whole window. A short window that tracks an offset it
    // already knows should set this to a fraction of the window instead.
    this.searchRadius = 0;
  }

  setFftSize(size) {
    this.fftSize = size;
    this.bins = size / 2 + 1;
    this.df = this.sampleRate / size;
    this.fft = new FFT(size);
    this.window = hannWindow(size);
    this.xr = new Float64Array(size);
    this.xi = new Float64Array(size);
    this.yr = new Float64Array(size);
    this.yi = new Float64Array(size);
    this.sxx = new Float64Array(this.bins);
    this.syy = new Float64Array(this.bins);
    this.sxyRe = new Float64Array(this.bins);
    this.sxyIm = new Float64Array(this.bins);
    this.fullRe = new Float64Array(size);
    this.fullIm = new Float64Array(size);
    this.ir = new Float64Array(size);
    this.updateRate = 0.1;
    this.frames = 0;
    this.peakIndex = 0;
    this.peakRe = 1;
    this.delayAvg = null;
    this.delayRaw = 0;
    this.delayMedian = 0;
    this.delayHistory = [];
    this.delayJitter = 0;
    this.polarity = 1;
    this.polarityVotes = 0;
  }

  reset() {
    this.sxx.fill(0);
    this.syy.fill(0);
    this.sxyRe.fill(0);
    this.sxyIm.fill(0);
    this.ir.fill(0);
    this.frames = 0;
    this.peakIndex = 0;
    this.peakRe = 1;
    this.delayAvg = null;
    this.delayRaw = 0;
    this.delayMedian = 0;
    this.delayHistory = [];
    this.delayJitter = 0;
    this.polarity = 1;
    this.polarityVotes = 0;
  }

  /** Accumulate one window pair. mic = measured, ref = reference. */
  accumulate(mic, ref) {
    const n = this.fftSize;
    const w = this.window;
    const xr = this.xr;
    const xi = this.xi;
    const yr = this.yr;
    const yi = this.yi;

    for (let i = 0; i < n; i++) {
      const gain = w[i];
      xr[i] = ref[i] * gain;
      xi[i] = 0;
      yr[i] = mic[i] * gain;
      yi[i] = 0;
    }

    this.fft.forward(xr, xi);
    this.fft.forward(yr, yi);

    const a = this.frames === 0 ? 1 : this.updateRate;
    const b = 1 - a;

    for (let k = 0; k < this.bins; k++) {
      const xrk = xr[k];
      const xik = xi[k];
      const yrk = yr[k];
      const yik = yi[k];

      const pxx = xrk * xrk + xik * xik;
      const pyy = yrk * yrk + yik * yik;
      const cre = yrk * xrk + yik * xik;
      const cim = yik * xrk - yrk * xik;

      this.sxx[k] = this.sxx[k] * b + pxx * a;
      this.syy[k] = this.syy[k] * b + pyy * a;
      this.sxyRe[k] = this.sxyRe[k] * b + cre * a;
      this.sxyIm[k] = this.sxyIm[k] * b + cim * a;
    }

    this.frames += 1;
  }

  /**
   * Inverse-transform the cross spectrum into a cross-correlation.
   * `shift` (samples) rotates the phase to remove a known delay.
   * `detect` reads the peak, giving the remaining delay and the sign of the
   * correlation there (which is the polarity the caller turns into a reading).
   */
  computeIR(shift, detect) {
    const n = this.fftSize;
    const half = n / 2;
    const re = this.fullRe;
    const im = this.fullIm;

    re.fill(0);
    im.fill(0);
    re[0] = this.sxyRe[0];
    im[0] = 0;

    for (let k = 1; k < half; k++) {
      let rr = this.sxyRe[k];
      let ii = this.sxyIm[k];
      if (shift !== 0) {
        const theta = (2 * Math.PI * k * shift) / n;
        const c = Math.cos(theta);
        const s = Math.sin(theta);
        const nr = rr * c - ii * s;
        const ni = rr * s + ii * c;
        rr = nr;
        ii = ni;
      }
      re[k] = rr;
      im[k] = ii;
      re[n - k] = rr;
      im[n - k] = -ii;
    }
    re[half] = this.sxyRe[half];
    im[half] = 0;

    this.fft.inverse(re, im);

    const ir = this.ir;
    // The peak is only looked for in a neighbourhood of zero unless the caller
    // asks for the whole window. A high-latency input puts the true delay near
    // half a window, where the circular correlation is ambiguous: the peak
    // then lands on either side of the boundary from one frame to the next and
    // the reading hops by a whole window (341 ms at 16384 / 48 kHz). Tracking
    // near zero makes that impossible; the coarse offset that puts the delay
    // near zero in the first place is measured separately, over a long window.
    const radius = this.searchRadius > 0 ? Math.min(this.searchRadius, half) : half;
    let peak = 0;
    let peakValue = -Infinity;
    for (let i = 0; i < n; i++) {
      const magnitude = Math.hypot(re[i], im[i]);
      ir[i] = magnitude;
      const distance = i <= half ? i : i - n;
      if (distance < -radius || distance > radius) continue;
      if (magnitude > peakValue) {
        peakValue = magnitude;
        peak = i;
      }
    }

    if (detect) {
      const y0 = ir[(peak - 1 + n) % n];
      const y1 = ir[peak];
      const y2 = ir[(peak + 1) % n];
      const denom = y0 - 2 * y1 + y2;
      let frac = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
      if (!Number.isFinite(frac) || Math.abs(frac) > 1) frac = 0;

      let signed = peak + frac;
      if (signed > n / 2) signed -= n;
      this.peakIndex = signed;
      this.peakRe = re[peak];
    }

    return peak;
  }

  /**
   * Follow the delay frame by frame.
   *
   * The cross-correlation is circular, so a delay that drifts past half a
   * window comes back on the other side, a whole window away — 341 ms at
   * 16384 / 48 kHz. The fine search is normally restricted to a fraction of the
   * window, which already rules that out; the fold here is the safety net for
   * callers that search the whole window. The median of the last few frames
   * sets the reading, so one bad frame can no longer throw the number across the
   * screen. `delayJitter` is how far those frames spread, which is what tells
   * the UI the delay is moving rather than just noisy.
   */
  trackDelay(delay) {
    const n = this.fftSize;
    let candidate = delay;

    if (this.delayAvg !== null && Number.isFinite(this.delayAvg)) {
      while (candidate - this.delayAvg > n / 2) candidate -= n;
      while (candidate - this.delayAvg < -n / 2) candidate += n;
    }

    this.delayRaw = delay;

    const history = this.delayHistory;
    history.push(candidate);
    if (history.length > 9) history.shift();

    const sorted = history.slice().sort((a, b) => a - b);
    const median = sorted[(sorted.length - 1) >> 1];
    this.delayMedian = median;
    this.delayJitter = sorted[sorted.length - 1] - sorted[0];

    if (this.delayAvg === null || !Number.isFinite(this.delayAvg)) {
      this.delayAvg = median;
    } else {
      this.delayAvg += (median - this.delayAvg) * 0.35;
    }

    return candidate;
  }

  /**
   * Polarity only changes when several frames agree. With noise, or across a
   * link whose latency wanders, a single frame flips sign on its own, and the
   * readout used to flicker normal / inverted because of it.
   */
  votePolarity(sign) {
    if (sign === this.polarity) {
      this.polarityVotes = 0;
      return;
    }
    this.polarityVotes += 1;
    if (this.polarityVotes >= 3) {
      this.polarity = sign;
      this.polarityVotes = 0;
    }
  }

  /** Mean coherence over the band the readout shows, 200 Hz – 10 kHz. */
  meanCoherence() {
    const k0 = Math.max(1, Math.round(200 / this.df));
    const k1 = Math.min(this.bins - 1, Math.round(10000 / this.df));
    let sum = 0;
    let count = 0;
    for (let k = k0; k <= k1; k++) {
      const denom = this.sxx[k] * this.syy[k];
      const cxy = this.sxyRe[k] * this.sxyRe[k] + this.sxyIm[k] * this.sxyIm[k];
      sum += denom > 0 ? Math.min(1, cxy / denom) : 0;
      count += 1;
    }
    return count > 0 ? sum / count : 0;
  }

  /**
   * Build the display-ready result set.
   * opts: { compensate, smoothing (octave fraction, 0 = off), normalize }
   */
  results(opts) {
    const options = opts || {};
    const compensate = options.compensate !== false;
    const smoothing = options.smoothing || 0;
    const normalize = options.normalize !== false;
    const n = this.fftSize;
    const bins = this.bins;

    this.computeIR(0, true);
    this.trackDelay(this.peakIndex);

    // The sign at the peak is only read when the two signals are actually
    // related. Across a link whose latency wanders — Bluetooth, typically —
    // coherence collapses and the sign is just noise, so the readout says
    // nothing instead of flickering between normal and inverted.
    const coherence = this.meanCoherence();
    const polarityKnown = this.frames >= 3 && coherence > 0.45;
    if (polarityKnown) this.votePolarity(this.peakRe >= 0 ? 1 : -1);

    if (compensate) this.computeIR(this.delayAvg, false);

    const shift = compensate ? this.delayAvg : 0;
    const power = new Float64Array(bins);
    const rawPhase = new Float64Array(bins);
    const coh = new Float32Array(bins);

    for (let k = 0; k < bins; k++) {
      const sxx = this.sxx[k];
      let hr = 0;
      let hi = 0;
      if (sxx > 0) {
        hr = this.sxyRe[k] / sxx;
        hi = this.sxyIm[k] / sxx;
      }

      if (shift !== 0) {
        const theta = (2 * Math.PI * k * shift) / n;
        const c = Math.cos(theta);
        const s = Math.sin(theta);
        const nr = hr * c - hi * s;
        const ni = hr * s + hi * c;
        hr = nr;
        hi = ni;
      }

      power[k] = hr * hr + hi * hi;
      rawPhase[k] = Math.atan2(hi, hr);

      const cxy = this.sxyRe[k] * this.sxyRe[k] + this.sxyIm[k] * this.sxyIm[k];
      const denom = sxx * this.syy[k];
      coh[k] = denom > 0 ? Math.min(1, cxy / denom) : 0;
    }

    const smoothed = smoothing > 0 ? smoothPower(power, this.df, smoothing) : power;

    const db = new Float64Array(bins);
    for (let k = 0; k < bins; k++) {
      db[k] = 10 * Math.log10(Math.max(smoothed[k], 1e-24));
    }

    if (normalize) {
      const k0 = Math.max(1, Math.round(300 / this.df));
      const k1 = Math.min(bins - 1, Math.round(3000 / this.df));
      let sum = 0;
      let count = 0;
      for (let k = k0; k <= k1; k++) {
        sum += Math.pow(10, db[k] / 10);
        count += 1;
      }
      if (count > 0 && sum > 0) {
        const reference = 10 * Math.log10(sum / count);
        for (let k = 0; k < bins; k++) db[k] -= reference;
      }
    }

    const magDb = new Float32Array(bins);
    for (let k = 0; k < bins; k++) {
      magDb[k] = Math.max(-140, Math.min(40, db[k]));
    }

    // Unwrap the phase across frequency, then convert to degrees.
    const unwrapped = new Float64Array(bins);
    const phaseDeg = new Float32Array(bins);
    unwrapped[0] = rawPhase[0];
    for (let k = 1; k < bins; k++) {
      let delta = rawPhase[k] - rawPhase[k - 1];
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      unwrapped[k] = unwrapped[k - 1] + delta;
    }
    for (let k = 0; k < bins; k++) {
      phaseDeg[k] = (unwrapped[k] * 180) / Math.PI;
    }

    // Impulse response in dB relative to its own peak.
    const irDb = new Float32Array(n);
    let irPeak = 0;
    for (let i = 0; i < n; i++) {
      if (this.ir[i] > irPeak) irPeak = this.ir[i];
    }
    for (let i = 0; i < n; i++) {
      const v = irPeak > 0 ? this.ir[i] / irPeak : 0;
      irDb[i] = v > 0 ? Math.max(-120, 20 * Math.log10(v)) : -120;
    }

    return {
      sampleRate: this.sampleRate,
      fftSize: n,
      df: this.df,
      bins: bins,
      magDb: magDb,
      phaseDeg: phaseDeg,
      coh: coh,
      irDb: irDb,
      delaySamples: this.delayAvg,
      delayMs: (this.delayAvg / this.sampleRate) * 1000,
      delayMedianSamples: this.delayMedian,
      delayRawSamples: this.delayRaw,
      delayJitterSamples: this.delayJitter,
      polarity: this.polarity,
      polarityKnown: polarityKnown,
      frames: this.frames,
    };
  }
}
