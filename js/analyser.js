import { FFT, hannWindow } from './fft.js';

/**
 * Fractional-octave power smoothing over a linearly spaced spectrum.
 * `octaves` is the bandwidth in octaves (1/6 -> 0.1667).
 */
/**
 * Fractional-octave power smoothing over a linearly spaced spectrum.
 * `octaves` is the bandwidth in octaves (1/6 -> 0.1667). `out` and `cum` are
 * optional scratch buffers of bins and bins + 1 entries, so a live measurement
 * reuses them instead of allocating on every frame.
 */
export function smoothPower(power, df, octaves, out, cum) {
  const bins = power.length;
  const sums = cum && cum.length === bins + 1 ? cum : new Float64Array(bins + 1);
  sums[0] = 0;
  for (let k = 0; k < bins; k++) sums[k + 1] = sums[k] + power[k];

  const values = out && out.length === bins ? out : new Float64Array(bins);
  const ratio = Math.pow(2, octaves / 2);

  for (let k = 0; k < bins; k++) {
    const f = Math.max(k * df, df);
    let k0 = Math.floor(f / ratio / df);
    let k1 = Math.ceil((f * ratio) / df);
    if (k0 < 1) k0 = 1;
    if (k1 > bins - 1) k1 = bins - 1;
    if (k1 < k0) {
      values[k] = power[k];
      continue;
    }
    values[k] = (sums[k1 + 1] - sums[k0]) / (k1 - k0 + 1);
  }
  return values;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** The smallest turn that expresses an angle difference, in radians. */
function turnsOnly(delta) {
  let value = delta;
  while (value > Math.PI) value -= 2 * Math.PI;
  while (value < -Math.PI) value += 2 * Math.PI;
  return value;
}

/**
 * Vector-average a complex spectrum over fractional-octave bands.
 *
 * Phase is the argument of a complex quantity, so smoothing it by averaging
 * wrapped angles folds across ±180° and lands the curve in the wrong place.
 * Averaging the real and imaginary parts is the arithmetic that survives a wrap,
 * and it is what a fractional-octave analyser shows. A band whose vector sum
 * collapses keeps its own bin rather than snapping to a meaningless angle.
 */
export function smoothComplex(re, im, df, octaves, outRe, outIm, cumReIn, cumImIn) {
  const bins = re.length;
  if (!(bins > 2) || !(df > 0) || !(octaves > 0)) return { re, im };

  // Optional scratch buffers, so a live measurement reuses them instead of
  // allocating two bins + 1 arrays on every frame.
  const cumRe = cumReIn && cumReIn.length === bins + 1 ? cumReIn : new Float64Array(bins + 1);
  const cumIm = cumImIn && cumImIn.length === bins + 1 ? cumImIn : new Float64Array(bins + 1);
  for (let k = 0; k < bins; k++) {
    cumRe[k + 1] = cumRe[k] + re[k];
    cumIm[k + 1] = cumIm[k] + im[k];
  }

  const resultRe = outRe && outRe.length === bins ? outRe : new Float64Array(bins);
  const resultIm = outIm && outIm.length === bins ? outIm : new Float64Array(bins);
  resultRe.set(re);
  resultIm.set(im);

  const ratio = Math.pow(2, octaves / 2);
  for (let k = 0; k < bins; k++) {
    const f = Math.max(k * df, df);
    let k0 = Math.floor(f / ratio / df);
    let k1 = Math.ceil((f * ratio) / df);
    if (k0 < 1) k0 = 1;
    if (k1 > bins - 1) k1 = bins - 1;
    if (k1 < k0) continue;

    const count = k1 - k0 + 1;
    const sumRe = cumRe[k1 + 1] - cumRe[k0];
    const sumIm = cumIm[k1 + 1] - cumIm[k0];
    if (Math.hypot(sumRe, sumIm) < 1e-30) continue;
    resultRe[k] = sumRe / count;
    resultIm[k] = sumIm / count;
  }

  return { re: resultRe, im: resultIm };
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
    // Real impulse response written by the half-size inverse, before it is
    // copied into the buffers a caller sees.
    this.realIr = new Float64Array(size);
    this.ir = new Float64Array(size);
    // The complex impulse response, kept so a time gate can window it and
    // transform it back for a gated magnitude curve.
    this.irRe = new Float64Array(size);
    this.irIm = new Float64Array(size);
    // The impulse response of the transfer function itself (IFFT of H), which
    // the gate windows. Kept apart from irRe/irIm, which carry the reference's
    // spectrum with them.
    this.hIrRe = new Float64Array(size);
    this.hIrIm = new Float64Array(size);
    // Working buffers for one result set. A live measurement builds a result
    // every frame, and a fresh couple of hundred kilobytes of Float64 each
    // time is what used to keep the browser's collector running while the
    // audio was playing; these are reused instead. Nothing here is handed to a
    // caller, so they are safe to overwrite.
    this.scratchPower = new Float64Array(this.bins);
    this.scratchRawPhase = new Float64Array(this.bins);
    this.scratchDb = new Float64Array(this.bins);
    this.scratchUnwrapped = new Float64Array(this.bins);
    this.scratchSmoothed = new Float64Array(this.bins);
    this.scratchGatedPower = new Float64Array(this.bins);
    this.scratchCumulative = new Float64Array(this.bins + 1);
    // The coherence array handed out in the result. It is reused every frame —
    // allocating it fresh was the GC churn that used to run alongside the
    // audio. Callers may hold the result object only until the next frame: the
    // traces a capture freezes are copied out (captureTrace), and the impulse
    // chart's Hold works because irDb stays a fresh allocation per frame.
    this.scratchCoh = new Float32Array(this.bins);
    this.gateRe = new Float64Array(size);
    this.gateIm = new Float64Array(size);
    // The cross spectrum after the delay rotation computeIR() applied, so the
    // transfer function does not have to repeat that per-bin trigonometry.
    this.rotRe = new Float64Array(this.bins);
    this.rotIm = new Float64Array(this.bins);
    // The complex transfer function, and the buffers its phase smoothing writes into.
    this.scratchHRe = new Float64Array(this.bins);
    this.scratchHIm = new Float64Array(this.bins);
    this.scratchHReOut = new Float64Array(this.bins);
    this.scratchHImOut = new Float64Array(this.bins);
    // Cumulative sums for the phase-aware smoothing, reused every frame.
    this.scratchCumRe = new Float64Array(this.bins + 1);
    this.scratchCumIm = new Float64Array(this.bins + 1);
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
    this.polarityDecided = false;
    /** RMS of the most recent measurement window, so a dead input can be told
     * apart from one that is merely quiet. */
    this.lastEnergy = 0;
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
    this.polarityDecided = false;
    this.lastEnergy = 0;
  }

  /** Accumulate one window pair. mic = measured, ref = reference. */
  accumulate(mic, ref) {
    const n = this.fftSize;
    const w = this.window;
    const xr = this.xr;
    const xi = this.xi;
    const yr = this.yr;
    const yi = this.yi;

    let energy = 0;
    for (let i = 0; i < n; i++) {
      const sample = mic[i];
      energy += sample * sample;
    }
    this.lastEnergy = Math.sqrt(energy / n);

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

    // Only bins 0..N/2 are filled. The negative frequencies are these bins'
    // conjugates, and the transform below reconstructs them itself.
    re[0] = this.sxyRe[0];
    im[0] = 0;
    this.rotRe[0] = this.sxyRe[0];
    this.rotIm[0] = 0;

    // The rotation angle advances by a constant step from bin to bin, so one
    // sine and one cosine seed the sweep and a complex multiply carries it:
    // two trig calls per frame instead of two per bin (16384 of them at
    // 16384/48 kHz). The running product is renormalised periodically so
    // rounding cannot drift its magnitude, and the angle error across a whole
    // sweep stays far below a millionth of a degree.
    const stepAngle = shift !== 0 ? (2 * Math.PI * shift) / n : 0;
    const stepRe = shift !== 0 ? Math.cos(stepAngle) : 1;
    const stepIm = shift !== 0 ? Math.sin(stepAngle) : 0;
    let rotCos = stepRe;
    let rotSin = stepIm;

    for (let k = 1; k < half; k++) {
      let rr = this.sxyRe[k];
      let ii = this.sxyIm[k];
      if (shift !== 0) {
        const c = rotCos;
        const s = rotSin;
        const nr = rr * c - ii * s;
        const ni = rr * s + ii * c;
        rr = nr;
        ii = ni;

        const advanceRe = rotCos * stepRe - rotSin * stepIm;
        const advanceIm = rotCos * stepIm + rotSin * stepRe;
        rotCos = advanceRe;
        rotSin = advanceIm;
        if ((k & 255) === 0) {
          const norm = Math.sqrt(rotCos * rotCos + rotSin * rotSin);
          if (norm > 0) {
            rotCos /= norm;
            rotSin /= norm;
          }
        }
      }
      re[k] = rr;
      im[k] = ii;
      // Kept so results() can read the transfer function straight from the
      // spectrum this rotation already produced.
      this.rotRe[k] = rr;
      this.rotIm[k] = ii;
    }
    re[half] = this.sxyRe[half];
    im[half] = 0;
    this.rotRe[half] = this.sxyRe[half];
    this.rotIm[half] = 0;

    // A Hermitian spectrum has a real inverse, so this transforms at half size
    // rather than running a full complex transform and discarding an imaginary
    // half that is known to be zero.
    const real = this.realIr;
    this.fft.realInverse(re, im, real);

    this.irRe.set(real);
    // The imaginary half of a real inverse is zero, and it was already only
    // rounding residue. The gate, the spectrogram and the decay curve all read
    // irRe² + irIm², so they see the same energy to within 1e-32.
    this.irIm.fill(0);

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
      // abs, not hypot: the inverse is real, so there is no imaginary part to
      // combine, and hypot is a guarded, far slower call.
      const magnitude = Math.abs(real[i]);
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
      this.peakRe = real[peak];
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
      this.polarityDecided = true;
      return;
    }
    this.polarityVotes += 1;
    if (this.polarityVotes >= 3) {
      this.polarity = sign;
      this.polarityVotes = 0;
      this.polarityDecided = true;
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
   * Inverse-transform the transfer function H = Sxy / Sxx into its own impulse
   * response, so a gate can window the loudspeaker's response and not the
   * cross-correlation. Sxy is the reference's spectrum times H, so gating Sxy
   * tilts the curve by the reference's slope: 3 dB per octave for the pink
   * noise the app plays by default. H is Hermitian for a real signal, so the
   * negative frequencies are its conjugates.
   */
  buildTransferIR(hRe, hIm) {
    const n = this.fftSize;
    const half = n >> 1;
    // The half-spectrum goes through the spectrum buffers computeIR() has
    // finished with; hIrRe is the real result the gate windows.
    const re = this.fullRe;
    const im = this.fullIm;
    re[0] = hRe[0];
    im[0] = 0;
    for (let k = 1; k < half; k++) {
      re[k] = hRe[k];
      im[k] = hIm[k];
    }
    re[half] = hRe[half];
    im[half] = 0;
    const real = this.realIr;
    this.fft.realInverse(re, im, real);
    this.hIrRe.set(real);
    this.hIrIm.fill(0);
  }

  /**
   * The power spectrum of the impulse response windowed in time, measured from
   * the impulse peak, with softly tapered edges so the gate itself does not add
   * ripples to the curve.
   * `gate`: { startMs, widthMs }
   */
  gatedPower(gate) {
    const n = this.fftSize;
    const bins = this.bins;
    if (n < 8 || bins < 2) return null;

    let peak = 0;
    for (let i = 1; i < n; i++) {
      if (this.ir[i] > this.ir[peak]) peak = i;
    }

    const start = peak + Math.round((gate.startMs / 1000) * this.sampleRate);
    const width = Math.min(n, Math.max(16, Math.round((gate.widthMs / 1000) * this.sampleRate)));
    const taper = Math.min(Math.max(8, Math.floor(width / 10)), Math.floor(width / 2));
    // The onset ramp must finish at the impulse peak, not wherever the ramp
    // happens to be when the peak arrives. A gate opening 0.5 ms before the
    // peak used to weigh the direct sound down to a fraction of its amplitude,
    // which put a gain on the gated curve that moved with the gate's start
    // position — a level error the measurement did not contain. The ramp now
    // squeezes into the lead-in the gate actually has, and the peak always
    // enters at full weight. The decay-side taper keeps its full length: it
    // softens the truncation edge, which is what it is there for.
    const lead = Math.max(0, -Math.round((gate.startMs / 1000) * this.sampleRate));
    const onset = Math.min(taper, lead);

    const re = this.gateRe;
    const im = this.gateIm;
    re.fill(0);
    im.fill(0);

    for (let offset = 0; offset < width; offset++) {
      let index = (start + offset) % n;
      if (index < 0) index += n;

      let weight = 1;
      if (offset < onset) {
        weight = 0.5 * (1 - Math.cos((Math.PI * offset) / onset));
      } else if (offset >= width - taper) {
        weight = 0.5 * (1 - Math.cos((Math.PI * (width - offset - 1)) / taper));
      }

      re[index] = this.hIrRe[index] * weight;
      im[index] = this.hIrIm[index] * weight;
    }

    this.fft.forward(re, im);

    const power = this.scratchGatedPower;
    for (let k = 0; k < bins; k++) {
      power[k] = re[k] * re[k] + im[k] * im[k];
    }
    return power;
  }

  /**
   * Build the display-ready result set.
   * opts: { compensate, smoothing (octave fraction, 0 = off), normalize,
   *         gate: { enabled, startMs, widthMs } }
   */
  results(opts) {
    const options = opts || {};
    const compensate = options.compensate !== false;
    const smoothing = options.smoothing || 0;
    const phaseSmoothing = options.phaseSmoothing || this.phaseSmoothing || 0;
    const normalize = options.normalize !== false;
    const gate = options.gate || null;
    const gated = !!(gate && gate.enabled);
    const n = this.fftSize;
    const bins = this.bins;

    this.computeIR(0, true);
    this.trackDelay(this.peakIndex);

    // The sign at the peak is only read when the two signals are actually
    // related. Across a link whose latency wanders — Bluetooth, typically —
    // coherence collapses and the sign is just noise, so the readout says
    // nothing instead of flickering between normal and inverted.
    // The vote has to run before the decided flag is read: the flag is only set
    // by a vote, so testing it first meant the readout could never leave unknown.
    const coherence = this.meanCoherence();
    const measurable = this.frames >= 3 && coherence > 0.45;
    if (measurable) this.votePolarity(this.peakRe >= 0 ? 1 : -1);
    const polarityKnown = measurable && this.polarityDecided;

    if (compensate) this.computeIR(this.delayAvg, false);

    const shift = compensate ? this.delayAvg : 0;
    // computeIR() above has already rotated the cross spectrum by exactly this
    // shift, so the transfer function is read from that rotation instead of
    // repeating the same per-bin trigonometry a second time.
    const rotated = compensate && shift !== 0;
    const power = this.scratchPower;
    const rawPhase = this.scratchRawPhase;
    const coh = this.scratchCoh;

    let hRe = this.scratchHRe;
    let hIm = this.scratchHIm;

    for (let k = 0; k < bins; k++) {
      const sxx = this.sxx[k];
      let hr = 0;
      let hi = 0;
      if (sxx > 0) {
        if (rotated) {
          hr = this.rotRe[k] / sxx;
          hi = this.rotIm[k] / sxx;
        } else {
          hr = this.sxyRe[k] / sxx;
          hi = this.sxyIm[k] / sxx;
        }
      }

      power[k] = hr * hr + hi * hi;
      hRe[k] = hr;
      hIm[k] = hi;

      const cxy = this.sxyRe[k] * this.sxyRe[k] + this.sxyIm[k] * this.sxyIm[k];
      const denom = sxx * this.syy[k];
      coh[k] = denom > 0 ? Math.min(1, cxy / denom) : 0;
    }

    // Taken before any smoothing, so the gate sees the measured transfer function.
    if (gated) this.buildTransferIR(hRe, hIm);

    // Phase-aware smoothing: the transfer function is complex, so the average is
    // a vector sum of the real and imaginary parts, not an average of wrapped
    // angles, which would fold across ±180° and move the curve somewhere the
    // measurement never was.
    if (phaseSmoothing > 0) {
      const averaged = smoothComplex(hRe, hIm, this.df, phaseSmoothing,
        this.scratchHReOut, this.scratchHImOut, this.scratchCumRe, this.scratchCumIm);
      hRe = averaged.re;
      hIm = averaged.im;
    }

    for (let k = 0; k < bins; k++) rawPhase[k] = Math.atan2(hIm[k], hRe[k]);

    let spectrumPower = power;
    if (gated) {
      const windowed = this.gatedPower(gate);
      if (windowed) spectrumPower = windowed;
    }

    const smoothed = smoothing > 0
      ? smoothPower(spectrumPower, this.df, smoothing, this.scratchSmoothed, this.scratchCumulative)
      : spectrumPower;

    const db = this.scratchDb;
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

    // Unwrap outward from 1 kHz rather than up from DC. The lowest bins of a
    // real room carry almost nothing, so one turn of noise down there used to
    // shift every bin above it by 360° from one frame to the next, and the
    // curve wandered while nothing had actually moved. Starting at the
    // reference and walking out keeps that noise where it belongs.
    const unwrapped = this.scratchUnwrapped;
    const phaseDeg = new Float32Array(bins);
    if (bins > 0) {
      const centre = Math.min(Math.max(1, Math.round(1000 / this.df)), bins - 1);
      unwrapped[centre] = rawPhase[centre];
      for (let k = centre + 1; k < bins; k++) {
        unwrapped[k] = unwrapped[k - 1] + turnsOnly(rawPhase[k] - rawPhase[k - 1]);
      }
      for (let k = centre - 1; k >= 0; k--) {
        unwrapped[k] = unwrapped[k + 1] - turnsOnly(rawPhase[k + 1] - rawPhase[k]);
      }
      for (let k = 0; k < bins; k++) phaseDeg[k] = (unwrapped[k] * 180) / Math.PI;
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
      // True when the last window carried no usable signal: the curve on screen
      // is the average running down towards nothing, not a live measurement.
      silent: !(this.lastEnergy > 1e-6),
      gated: gated,
      // The complex impulse response, for the waterfall's slices.
      irRe: this.irRe,
      irIm: this.irIm,
    };
  }
}
