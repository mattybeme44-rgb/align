import { FFT } from './fft.js';

const SIZE = 2048;
const COLUMNS = 80;
const HISTORY = 60;
const fft = new FFT(SIZE);
const taper = Float64Array.from({ length: SIZE }, (_, i) => 0.5 * (1 - Math.cos(2 * Math.PI * i / SIZE)));
const re = new Float64Array(SIZE);
const im = new Float64Array(SIZE);

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
