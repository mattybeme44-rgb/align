import { FFT, hannWindow } from './fft.js';

/*
 * The impulse decay as a heat map: one row per window past the impulse peak,
 * frequency across on a log scale, and the energy of each slice as colour from
 * dark through teal to lime. Built only while its screen is open.
 */

const ROWS = 64;
const COLUMNS = 100;
const FFT_SIZE = 2048;
const LOWEST_HZ = 20;
const HIGHEST_HZ = 20000;

const COL = {
  text: 'rgba(176,186,164,0.82)',
  textDim: 'rgba(160,172,150,0.52)',
  grid: 'rgba(160,190,150,0.16)',
  gridMinor: 'rgba(160,190,150,0.07)',
  accent: '#c9ff70',
};

const FONT_AXIS = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
const FONT_LABEL = '10px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';

/** Build the time-frequency energy grid from a finished result. */
export function buildSpectrogram(res, rangeMs) {
  if (!res || !res.irRe || !res.irIm || !(res.sampleRate > 2000)) return null;
  const n = Math.min(res.irRe.length, res.irIm.length);
  if (n < 256) return null;

  const sampleRate = res.sampleRate;
  const top = Math.min(HIGHEST_HZ, sampleRate / 2);
  if (!(top > LOWEST_HZ * 4)) return null;

  const span = Math.min(Math.max(rangeMs, 2), 50);
  const windowMs = Math.min(Math.max(span / 24, 0.8), 6);
  const windowSamples = Math.min(n, Math.max(32, Math.round((windowMs / 1000) * sampleRate)));
  const taper = hannWindow(windowSamples);

  if (!buildSpectrogram.fft) buildSpectrogram.fft = new FFT(FFT_SIZE);
  const fft = buildSpectrogram.fft;
  const df = sampleRate / FFT_SIZE;
  const half = FFT_SIZE / 2;

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

  const freqs = new Float64Array(COLUMNS);
  const logLow = Math.log10(LOWEST_HZ);
  const logHigh = Math.log10(top);
  for (let c = 0; c < COLUMNS; c++) {
    const t = c / (COLUMNS - 1);
    freqs[c] = Math.pow(10, logLow + (logHigh - logLow) * t);
  }

  const ratio = Math.pow(2, 1 / 12);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const cumulative = new Float64Array(half + 2);

  const times = new Float64Array(ROWS);
  const db = [];
  let loudest = -Infinity;

  for (let row = 0; row < ROWS; row++) {
    const time = (span * row) / (ROWS - 1);
    times[row] = time;
    const start = peak + Math.round((time / 1000) * sampleRate);

    re.fill(0);
    im.fill(0);
    for (let k = 0; k < windowSamples; k++) {
      let index = (start + k) % n;
      if (index < 0) index += n;
      re[k] = res.irRe[index] * taper[k];
      im[k] = res.irIm[index] * taper[k];
    }
    fft.forward(re, im);

    cumulative[0] = 0;
    for (let k = 0; k <= half; k++) {
      cumulative[k + 1] = cumulative[k] + re[k] * re[k] + im[k] * im[k];
    }

    const values = new Float64Array(COLUMNS);
    for (let c = 0; c < COLUMNS; c++) {
      const f = freqs[c];
      let k0 = Math.floor(f / ratio / df);
      let k1 = Math.ceil((f * ratio) / df);
      k0 = Math.min(Math.max(k0, 1), Math.max(1, half - 1));
      k1 = Math.min(Math.max(k1, k0), half);

      const power = (cumulative[k1 + 1] - cumulative[k0]) / (k1 - k0 + 1);
      const value = 10 * Math.log10(Math.max(power, 1e-30));
      values[c] = value;
      if (value > loudest) loudest = value;
    }
    db.push(values);
  }

  if (!Number.isFinite(loudest)) return null;
  for (let row = 0; row < ROWS; row++) {
    for (let c = 0; c < COLUMNS; c++) {
      db[row][c] = Math.min(0, Math.max(-60, db[row][c] - loudest));
    }
  }

  return { times, freqs, db, rangeMs: span };
}

const STOPS = [
  { position: 0.0, r: 0.035, g: 0.05, b: 0.04 },
  { position: 0.35, r: 0.055, g: 0.22, b: 0.16 },
  { position: 0.65, r: 0.1, g: 0.45, b: 0.38 },
  { position: 0.85, r: 0.25, g: 0.78, b: 0.55 },
  { position: 1.0, r: 0.79, g: 1.0, b: 0.44 },
];

function heatColour(t) {
  const value = Math.max(0, Math.min(1, t));
  for (let i = 1; i < STOPS.length; i++) {
    const lower = STOPS[i - 1];
    const upper = STOPS[i];
    if (value > upper.position) continue;
    const span = Math.max(upper.position - lower.position, 1e-9);
    const fraction = (value - lower.position) / span;
    return [
      Math.round((lower.r + (upper.r - lower.r) * fraction) * 255),
      Math.round((lower.g + (upper.g - lower.g) * fraction) * 255),
      Math.round((lower.b + (upper.b - lower.b) * fraction) * 255),
    ];
  }
  const last = STOPS[STOPS.length - 1];
  return [Math.round(last.r * 255), Math.round(last.g * 255), Math.round(last.b * 255)];
}

function formatFrequency(frequency) {
  if (frequency >= 1000) {
    const k = frequency / 1000;
    return (Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)) + 'k';
  }
  return frequency.toFixed(0);
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function timeStep(rangeMs) {
  for (const candidate of [1, 2, 5, 10, 20, 25]) {
    if (candidate >= rangeMs / 5) return candidate;
  }
  return 25;
}

export class SpectrogramChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pad = { left: 40, right: 16, top: 24, bottom: 46 };
    this.w = 0;
    this.h = 0;
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(160, rect.width);
    this.h = Math.max(150, rect.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw(data, options) {
    const opts = options || {};
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);

    const p = this.pad;
    const plot = {
      x: p.left,
      y: p.top,
      w: Math.max(40, this.w - p.left - p.right),
      h: Math.max(60, this.h - p.top - p.bottom),
    };
    const span = Math.max(2, opts.rangeMs || (data ? data.rangeMs : 50));

    ctx.save();
    roundRect(ctx, 0.5, 0.5, this.w - 1, this.h - 1, 12);
    ctx.fillStyle = '#0e130f';
    ctx.fill();
    ctx.strokeStyle = 'rgba(160,190,150,0.14)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    if (!data) {
      ctx.fillStyle = COL.textDim;
      ctx.font = FONT_LABEL;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No measurement yet', plot.x + plot.w / 2, plot.y + plot.h / 2 - 10);
      ctx.font = '11px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.fillText('Start the measurement, or use Demo measurement.', plot.x + plot.w / 2, plot.y + plot.h / 2 + 10);
      ctx.textAlign = 'left';
      return;
    }

    const rows = data.db.length;
    const columns = data.db[0].length;
    const cellW = plot.w / columns;
    const cellH = plot.h / rows;

    for (let r = 0; r < rows; r++) {
      const y = plot.y + (r / rows) * plot.h;
      for (let c = 0; c < columns; c++) {
        const t = (data.db[r][c] + 60) / 60;
        const [red, green, blue] = heatColour(t);
        ctx.fillStyle = 'rgb(' + red + ',' + green + ',' + blue + ')';
        ctx.fillRect(plot.x + c * cellW, y, cellW + 0.5, cellH + 0.5);
      }
    }

    // Time grid and labels down the side.
    const step = timeStep(span);
    ctx.save();
    ctx.font = FONT_AXIS;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let tick = 0; tick <= span + 0.001; tick += step) {
      const y = plot.y + (tick / span) * plot.h;
      ctx.strokeStyle = COL.grid;
      ctx.beginPath();
      ctx.moveTo(plot.x, Math.round(y) + 0.5);
      ctx.lineTo(plot.x + plot.w, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = COL.textDim;
      ctx.fillText(tick.toFixed(0), plot.x - 7, y);
    }
    ctx.fillStyle = COL.textDim;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('ms', plot.x - 7, plot.y - 5);

    // Frequency grid.
    for (const frequency of [100, 1000, 10000]) {
      const x = plot.x + (Math.log10(frequency / LOWEST_HZ) / Math.log10(HIGHEST_HZ / LOWEST_HZ)) * plot.w;
      if (x < plot.x || x > plot.x + plot.w) continue;
      ctx.strokeStyle = COL.grid;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, plot.y);
      ctx.lineTo(Math.round(x) + 0.5, plot.y + plot.h);
      ctx.stroke();
    }

    // The gate across the map.
    const gateEnabled = !!(opts.gate && opts.gate.enabled);
    const gateStart = Math.max(0, Math.min(span, opts.gate ? opts.gate.startMs : 0));
    const gateEnd = Math.max(0, Math.min(span, gateStart + (opts.gate ? opts.gate.widthMs : 0)));
    const startY = plot.y + (gateStart / span) * plot.h;
    const endY = plot.y + (gateEnd / span) * plot.h;

    if (Math.abs(endY - startY) > 1) {
      ctx.fillStyle = gateEnabled ? 'rgba(201,255,112,0.07)' : 'rgba(201,255,112,0.02)';
      ctx.fillRect(plot.x, Math.min(startY, endY), plot.w, Math.abs(endY - startY));
    }

    ctx.strokeStyle = gateEnabled ? 'rgba(201,255,112,0.85)' : 'rgba(201,255,112,0.30)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(plot.x, Math.round(endY) + 0.5);
    ctx.lineTo(plot.x + plot.w, Math.round(endY) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = FONT_AXIS;
    ctx.fillStyle = gateEnabled ? COL.accent : COL.textDim;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const gateLabel = gateEnabled
      ? 'gate ' + gateStart.toFixed(1) + ' – ' + gateEnd.toFixed(1) + ' ms'
      : 'gate off · ' + (opts.gate ? opts.gate.startMs.toFixed(1) : '0.0') + ' – ' +
        (opts.gate ? (opts.gate.startMs + opts.gate.widthMs).toFixed(1) : '0.0') + ' ms';
    ctx.fillText(gateLabel, plot.x + plot.w / 2, Math.max(plot.y + 10, Math.min(plot.y + plot.h - 6, endY - 5)));
    ctx.restore();

    // Frequency labels along the bottom.
    ctx.save();
    ctx.font = FONT_LABEL;
    ctx.fillStyle = COL.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const frequency of [20, 100, 1000, 10000, 20000]) {
      const x = plot.x + (Math.log10(frequency / LOWEST_HZ) / Math.log10(HIGHEST_HZ / LOWEST_HZ)) * plot.w;
      if (x < plot.x - 0.5 || x > plot.x + plot.w + 0.5) continue;
      ctx.fillText(formatFrequency(frequency), Math.min(plot.x + plot.w - 10, Math.max(plot.x + 10, x)), plot.y + plot.h + 10);
    }
    ctx.fillStyle = COL.textDim;
    ctx.fillText('Frequency (Hz)', plot.x + plot.w / 2, plot.y + plot.h + 28);
    ctx.restore();
  }
}
