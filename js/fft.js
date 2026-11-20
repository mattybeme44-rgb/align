/**
 * Minimal iterative radix-2 FFT on typed arrays.
 * Sizes must be powers of two. Forward is e^(-j2πkn/N).
 */
export class FFT {
  constructor(size) {
    if (!Number.isInteger(size) || size < 2 || (size & (size - 1)) !== 0) {
      throw new Error('FFT size must be a power of two');
    }
    this.size = size;
    this.levels = Math.round(Math.log2(size));
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < this.levels; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = r;
    }
    const half = size >> 1;
    this.cosTable = new Float64Array(half);
    this.sinTable = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      this.cosTable[i] = Math.cos((2 * Math.PI * i) / size);
      this.sinTable[i] = Math.sin((2 * Math.PI * i) / size);
    }
    // Packing buffers for realInverse(). Created on first use, so the other
    // users of this class (spectrograms, waterfalls, decay) never pay for them.
    this.packRe = new Float64Array(half);
    this.packIm = new Float64Array(half);
    this.halfFft = null;
  }

  forward(re, im) {
    const n = this.size;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    const cosT = this.cosTable;
    const sinT = this.sinTable;
    for (let span = 2; span <= n; span <<= 1) {
      const half = span >> 1;
      const step = n / span;
      for (let base = 0; base < n; base += span) {
        for (let k = 0, idx = 0; k < half; k++, idx += step) {
          const a = base + k;
          const b = a + half;
          const c = cosT[idx];
          const s = sinT[idx];
          const tr = re[b] * c + im[b] * s;
          const ti = im[b] * c - re[b] * s;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }

  /**
   * Inverse transform of a Hermitian half-spectrum, writing a real signal.
   *
   * `halfRe`/`halfIm` hold bins 0..N/2 of a spectrum whose negative
   * frequencies are its conjugates — exactly what any real signal produces,
   * and exactly what the callers in analyser.js build. Doing that as an
   * N-point complex transform wastes half the work, because the result is
   * known to be real. This packs the even and odd output samples into one
   * complex array, transforms it at N/2, and unpacks: half the butterflies for
   * the same answer.
   *
   * Every N/2-point intermediate here is an ordinary complex transform, so the
   * arithmetic is the same floating-point work in the same order — only the
   * wasted imaginary half is gone. Agreement with inverse() is at rounding
   * level, not approximation level.
   */
  realInverse(halfRe, halfIm, out) {
    const n = this.size;
    const m = n >> 1;
    if (m < 2) throw new Error('realInverse needs an FFT size of at least 4');
    if (!this.halfFft) this.halfFft = new FFT(m);

    // Scratch for the packed signal: N/2 complex samples, one per output pair.
    // These must be this instance's own buffers — the half-size transform's
    // packing buffers are N/4 long and indexing them here overruns them.
    const zr = this.packRe;
    const zi = this.packIm;
    const cosT = this.cosTable;
    const sinT = this.sinTable;

    for (let k = 0; k < m; k++) {
      // X[k + N/2] mirrors X[N/2 - k]; at k = 0 it is the Nyquist bin, which is
      // real on its own.
      const cr = k === 0 ? halfRe[m] : halfRe[m - k];
      const ci = k === 0 ? 0 : -halfIm[m - k];
      const xr = halfRe[k];
      const xi = halfIm[k];

      const er = 0.5 * (xr + cr);
      const ei = 0.5 * (xi + ci);
      const dr = 0.5 * (xr - cr);
      const di = 0.5 * (xi - ci);

      // Odd-sample spectrum, rotated back into place:
      // O[k] = e^(+j2πk/N) · (X[k] − X[k+N/2]) / 2
      const c = cosT[k];
      const s = sinT[k];
      const orr = dr * c - di * s;
      const oi = dr * s + di * c;

      // The packed signal is even + j·odd samples, so Z = E + j·O.
      zr[k] = er - oi;
      zi[k] = ei + orr;
    }

    this.halfFft.inverse(zr, zi);

    for (let k = 0; k < m; k++) {
      out[2 * k] = zr[k];
      out[2 * k + 1] = zi[k];
    }
    return out;
  }

  /** Inverse transform, in place, scaled by 1/N. */
  inverse(re, im) {
    const n = this.size;
    for (let i = 0; i < n; i++) im[i] = -im[i];
    this.forward(re, im);
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= inv;
      im[i] *= -inv;
    }
  }
}

/** Periodic Hann window. */
export function hannWindow(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  }
  return w;
}

export function nextPowerOfTwo(n) {
  let p = 2;
  while (p < n) p <<= 1;
  return p;
}
