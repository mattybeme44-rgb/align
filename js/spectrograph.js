import { FFT } from './fft.js';

const SIZE = 2048;
const COLUMNS = 80;
const HISTORY = 60;
const BAND_SIZE = 16384;
const bandCache = new Map();
const fft = new FFT(SIZE);
const taper = Float64Array.from({ length: SIZE }, (_, i) => 0.5 * (1 - Math.cos(2 * Math.PI * i / SIZE)));
const re = new Float64Array(SIZE);
const im = new Float64Array(SIZE);

/** One FFT, window and output buffer per size, reused between frames. */
function bandResources(size) {
  let entry = bandCache.get(size);
  if (!entry) {
    entry = {
      fft: new FFT(size),
      taper: Float64Array.from({ length: size }, (_, i) => 0.5 * (1 - Math.cos(2 * Math.PI * i / size))),
      re: new Float64Array(size),
      im: new Float64Array(size),
      values: new Float32Array(size / 2),
    };
    bandCache.set(size, entry);
  }
  return entry;
}

/** Short-window selected-input spectrum in dBFS, not the impulse-decay spectrogram. */
export function microphoneSpectrum(samples, rate) {
  if (!samples || samples.length < SIZE || !(rate > 0)) return null;
  const offset = samples.length - SIZE;
  for (let i = 0; i < SIZE; i++) {
    re[i] = samples[offset + i] * taper[i];
    im[i] = 0;
  }
  fft.forward(re, im);
  const upper = Math.min(20000, rate / 2);
  const output = new Float32Array(COLUMNS);
  for (let c = 0; c < COLUMNS; c++) {
    const f = 20 * Math.exp((c / (COLUMNS - 1)) * Math.log(upper / 20));
    const center = Math.max(1, Math.min(SIZE / 2, Math.round(f * SIZE / rate)));
    const start = Math.max(1, center - 1);
    const end = Math.min(SIZE / 2, center + 1);
    let power = 0;
    for (let k = start; k <= end; k++) power += re[k] * re[k] + im[k] * im[k];
    const db = 20 * Math.log10(Math.max(1e-9, Math.sqrt(power) / (SIZE * 0.25)));
    output[c] = Math.max(-90, Math.min(0, db));
  }
  return output;
}

/**
 * The selected input as one level per FFT bin, for the band analyser: a longer
 * window than the spectrograph's so the sixth-, twelfth- and sixteenth-octave
 * widths have more than the 80 coarse columns to average.
 *
 * Returns { values, binHz } with values[k] the dBFS level of the bin at
 * k * binHz, or null when there is not enough audio yet.
 */
export function microphoneBandSpectrum(samples, rate) {
  if (!samples || !(rate > 0)) return null;

  let size = BAND_SIZE;
  while (size > 2048 && samples.length < size) size /= 2;
  if (samples.length < size) return null;

  const { fft: bandFft, taper: window, re: bandRe, im: bandIm, values } = bandResources(size);
  const offset = samples.length - size;
  for (let i = 0; i < size; i++) {
    bandRe[i] = samples[offset + i] * window[i];
    bandIm[i] = 0;
  }
  bandFft.forward(bandRe, bandIm);

  const half = size / 2;
  const scale = 1 / (size * 0.25);
  values[0] = -120;
  for (let k = 1; k < half; k++) {
    const amplitude = Math.sqrt(bandRe[k] * bandRe[k] + bandIm[k] * bandIm[k]) * scale;
    values[k] = Math.max(-120, Math.min(0, 20 * Math.log10(Math.max(1e-9, amplitude))));
  }

  return { values, binHz: rate / size };
}

export class LiveSpectrograph {
  constructor(canvas) {
    this.canvas = canvas;
    this.rows = [];
    this.message = 'Start the measurement';
  }

  clear() {
    this.rows = [];
    this.draw();
  }

  /** The line shown while no spectrum rows have arrived yet. */
  setMessage(text) {
    if (this.message === text) return;
    this.message = text;
    this.draw();
  }

  add(row) {
    if (!row) return;
    this.rows.push(row);
    if (this.rows.length > HISTORY) this.rows.shift();
    this.draw();
  }

  draw() {
    const canvas = this.canvas;
    if (canvas.hidden || !canvas.getBoundingClientRect().width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const width = rect.width - 45;
    const height = rect.height - 28;
    ctx.fillStyle = '#101510';
    ctx.fillRect(32, 4, width, height);
    const colors = ['#0e1710', '#193c30', '#287765', '#55bb84', '#c9ff70'];
    for (let y = 0; y < this.rows.length; y++) {
      const row = this.rows[this.rows.length - y - 1];
      for (let x = 0; x < COLUMNS; x++) {
        const t = Math.max(0, Math.min(0.999, (row[x] + 90) / 90));
        ctx.fillStyle = colors[Math.floor(t * colors.length)];
        ctx.fillRect(32 + x * width / COLUMNS, 4 + y * height / HISTORY,
          width / COLUMNS + 0.5, height / HISTORY + 0.5);
      }
    }
    if (this.rows.length === 0) {
      ctx.fillStyle = 'rgba(176,186,164,0.72)';
      ctx.font = '12px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.message, 32 + width / 2, 4 + height / 2);
      ctx.textAlign = 'left';
    }
    ctx.fillStyle = '#a8b6a3';
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText('now', 2, 13);
    ctx.fillText('past', 2, height);
    for (const [label, t] of [['20', 0], ['100', 0.23], ['1k', 0.57], ['10k', 0.90]]) {
      ctx.fillText(label, 32 + width * t, rect.height - 6);
    }
  }
}
