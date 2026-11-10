import { FFT, hannWindow } from './fft.js';

/*
 * The waterfall: the impulse response as a stack of magnitude slices, each one
 * a window further past the impulse peak. The slices are spectra of short,
 * tapered pieces of the same complex impulse response the gate works on, so a
 * decay that rings on can be watched slice by slice.
 */

const SLICE_COUNT = 26;
const COLUMNS = 110;
const LOWEST_HZ = 20;
const HIGHEST_HZ = 20000;
const FFT_SIZE = 4096;

const COL = {
  grid: 'rgba(160,190,150,0.14)',
  gridMinor: 'rgba(160,190,150,0.07)',
  text: 'rgba(176,186,164,0.80)',
  textDim: 'rgba(160,172,150,0.52)',
  trace: '#c9ff70',
  slice: 'rgba(82,204,163,0.55)',
  cursor: 'rgba(255,140,120,0.55)',
};

const FONT_AXIS = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
const FONT_LABEL = '10px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';

/**
 * Build the slices from a finished result.
 * `res` is what Analyser.results() returns, plus `irRe` / `irIm`, the complex
 * impulse response the analyser keeps for the gate.
 */
export function buildWaterfall(res, rangeMs) {
  if (!res || !res.irRe || !res.irIm) return null;

  const n = Math.min(res.irRe.length, res.irIm.length);
  if (n < 256) return null;

  const sampleRate = res.sampleRate;
  const top = Math.min(HIGHEST_HZ, sampleRate / 2);
  if (!(top > LOWEST_HZ * 4)) return null;

  const span = Math.min(Math.max(rangeMs, 1), 50);
  const windowMs = Math.min(Math.max(span * 0.12, 1.5), 8);
  const windowSamples = Math.min(n, Math.max(32, Math.round((windowMs / 1000) * sampleRate)));
  const taper = hannWindow(windowSamples);

  if (!buildWaterfall.fft) buildWaterfall.fft = new FFT(FFT_SIZE);
  const fft = buildWaterfall.fft;
  const df = sampleRate / FFT_SIZE;
  const half = FFT_SIZE / 2;

  // The response is loudest here: every slice is measured from this point.
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
  const lastBin = half;

  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const cumulative = new Float64Array(half + 2);

  const times = new Float64Array(SLICE_COUNT);
  const db = [];
  let loudest = -Infinity;

  for (let slice = 0; slice < SLICE_COUNT; slice++) {
    const time = (span * slice) / (SLICE_COUNT - 1);
    times[slice] = time;

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

    const row = new Float64Array(COLUMNS);
    for (let c = 0; c < COLUMNS; c++) {
      const f = freqs[c];
      let k0 = Math.floor(f / ratio / df);
      let k1 = Math.ceil((f * ratio) / df);
      k0 = Math.min(Math.max(k0, 1), Math.max(1, lastBin - 1));
      k1 = Math.min(Math.max(k1, k0), lastBin);

      const power = (cumulative[k1 + 1] - cumulative[k0]) / (k1 - k0 + 1);
      const value = 10 * Math.log10(Math.max(power, 1e-30));
      row[c] = value;
      if (value > loudest) loudest = value;
    }
    db.push(row);
  }

  if (!Number.isFinite(loudest)) return null;

  for (let s = 0; s < SLICE_COUNT; s++) {
    for (let c = 0; c < COLUMNS; c++) {
      db[s][c] = Math.min(0, Math.max(-60, db[s][c] - loudest));
    }
  }

  return { times, freqs, db, rangeMs: span };
}

export class WaterfallChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pad = { left: 34, right: 54, top: 18, bottom: 62 };
    this.floorDb = -60;
    this.ceilingDb = 0;
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(180, rect.width);
    this.h = Math.max(150, rect.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw(slices, options) {
    const opts = options || {};
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);

    const w = this.w;
    const h = this.h;
    const pad = this.pad;

    ctx.fillStyle = '#0e130f';
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1;
    this.roundRect(0.5, 0.5, w - 1, h - 1, 12);
    ctx.fill();
    ctx.stroke();

    if (!slices) {
      ctx.fillStyle = COL.textDim;
      ctx.font = FONT_LABEL;
      ctx.textAlign = 'center';
      ctx.fillText('No measurement yet — start one, or use Demo measurement', w / 2, h / 2);
      ctx.textAlign = 'left';
      return;
    }

    const plot = {
      x: pad.left,
      y: pad.top,
      w: Math.max(40, w - pad.left - pad.right),
      h: Math.max(60, h - pad.top - pad.bottom),
    };

    const scale = Math.max(0.05, (opts.amplitude || 100) / 100);
    const axisHeight = plot.h * 0.66;
    const stackHeight = axisHeight * scale;
    const depthY = plot.h * 0.34;
    const depthX = plot.w * 0.2;
    const freqWidth = plot.w - depthX;
    const frontBottom = plot.y + plot.h;

    const lowest = Math.max(1, slices && slices.freqs.length ? slices.freqs[0] : LOWEST_HZ);
    const highest = Math.max(lowest * 2, slices && slices.freqs.length ? slices.freqs[slices.freqs.length - 1] : HIGHEST_HZ);
    const logLow = Math.log10(lowest);
    const logSpan = Math.max(0.0001, Math.log10(highest) - logLow);
    const timeSpan = Math.max(1, opts.rangeMs || 20);

    const xOf = (frequency, depth) => {
      const t = (Math.log10(Math.max(frequency, lowest)) - logLow) / logSpan;
      return plot.x + t * freqWidth + depth * depthX;
    };
    const yOf = (value, depth) => {
      const clamped = Math.min(this.ceilingDb, Math.max(this.floorDb, value));
      const t = (clamped - this.ceilingDb) / (this.floorDb - this.ceilingDb);
      return frontBottom - t * axisHeight - depth * depthY;
    };
    const sliceY = (value, depth) => {
      const clamped = Math.min(this.ceilingDb, Math.max(this.floorDb, value));
      const t = (clamped - this.ceilingDb) / (this.floorDb - this.ceilingDb);
      return frontBottom - t * stackHeight - depth * depthY;
    };

    // The faint box the three axes make.
    ctx.save();
    ctx.font = FONT_AXIS;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let level = 0; level >= this.floorDb; level -= 10) {
      const yFront = yOf(level, 0);
      const yBack = yOf(level, 1);

      ctx.strokeStyle = level === 0 ? COL.grid : COL.gridMinor;
      ctx.beginPath();
      ctx.moveTo(plot.x, Math.round(yFront) + 0.5);
      ctx.lineTo(plot.x + freqWidth, Math.round(yFront) + 0.5);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(plot.x, Math.round(yFront) + 0.5);
      ctx.lineTo(plot.x + depthX, Math.round(yBack) + 0.5);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(plot.x + freqWidth, Math.round(yFront) + 0.5);
      ctx.lineTo(plot.x + freqWidth + depthX, Math.round(yBack) + 0.5);
      ctx.stroke();

      ctx.fillStyle = COL.textDim;
      ctx.fillText(String(level), plot.x - 5, yFront);
    }

    for (let i = 0; i < [100, 1000, 10000].length; i++) {
      const f = [100, 1000, 10000][i];
      if (f >= highest) continue;
      const x = xOf(f, 0);
      ctx.strokeStyle = COL.gridMinor;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, frontBottom);
      ctx.lineTo(Math.round(x + depthX) + 0.5, frontBottom - depthY);
      ctx.stroke();
    }

    ctx.strokeStyle = COL.grid;
    ctx.beginPath();
    ctx.moveTo(plot.x, Math.round(frontBottom) + 0.5);
    ctx.lineTo(plot.x + freqWidth, Math.round(frontBottom) + 0.5);
    ctx.stroke();

    ctx.font = FONT_AXIS;
    ctx.fillStyle = COL.textDim;
    ctx.textAlign = 'right';
    ctx.fillText('dB', plot.x - 5, plot.y - 2);

    // The stack.
    if (slices && slices.db.length > 1) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(plot.x - 4, plot.y - 4, plot.w + 8, plot.h + 8);
      ctx.clip();

      for (let index = slices.db.length - 1; index >= 0; index--) {
        const depth = Math.min(1, Math.max(0, slices.times[index] / Math.max(0.001, slices.rangeMs)));
        const floorY = frontBottom - depth * depthY;
        const row = slices.db[index];
        const front = depth < 0.001;

        if (!front) {
          ctx.strokeStyle = 'rgba(119,200,193,' + (0.09 + 0.07 * (1 - depth)).toFixed(3) + ')';
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (let c = 0; c < row.length; c += 3) {
            const x = xOf(slices.freqs[c], depth);
            ctx.moveTo(x, sliceY(row[c], depth));
            ctx.lineTo(x, floorY);
          }
          ctx.stroke();
        }

        ctx.beginPath();
        for (let c = 0; c < row.length; c++) {
          const x = xOf(slices.freqs[c], depth);
          const y = sliceY(row[c], depth);
          if (c === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }

        if (front) {
          const topY = sliceY(0, depth);
          const gradient = ctx.createLinearGradient(0, topY, 0, floorY);
          gradient.addColorStop(0, 'rgba(201,255,112,0.28)');
          gradient.addColorStop(1, 'rgba(201,255,112,0.02)');
          ctx.save();
          ctx.lineTo(xOf(slices.freqs[row.length - 1], depth), floorY);
          ctx.lineTo(xOf(slices.freqs[0], depth), floorY);
          ctx.closePath();
          ctx.fillStyle = gradient;
          ctx.fill();
          ctx.restore();

          ctx.beginPath();
          for (let c = 0; c < row.length; c++) {
            const x = xOf(slices.freqs[c], depth);
            const y = sliceY(row[c], depth);
            if (c === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.strokeStyle = 'rgba(201,255,112,0.20)';
          ctx.lineWidth = 5;
          ctx.stroke();
          ctx.strokeStyle = COL.trace;
          ctx.lineWidth = 1.8;
          ctx.stroke();
        } else {
          ctx.strokeStyle = 'rgba(82,204,163,' + (0.28 + 0.45 * (1 - depth)).toFixed(3) + ')';
          ctx.lineWidth = 1;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.stroke();
        }
      }
      ctx.restore();
    } else {
      ctx.textAlign = 'center';
      ctx.font = FONT_LABEL;
      ctx.fillStyle = COL.text;
      ctx.fillText('No measurement yet', plot.x + freqWidth / 2, plot.y + plot.h / 2 - 10);
      ctx.font = FONT_AXIS;
      ctx.fillStyle = COL.textDim;
      ctx.fillText('Start the measurement, or use Demo measurement.', plot.x + freqWidth / 2, plot.y + plot.h / 2 + 8);
    }

    // The time axis, receding to the back plane.
    const axisX0 = plot.x + freqWidth;
    ctx.strokeStyle = COL.grid;
    ctx.beginPath();
    ctx.moveTo(axisX0, frontBottom);
    ctx.lineTo(axisX0 + depthX, frontBottom - depthY);
    ctx.stroke();

    const step = this.timeStep(timeSpan);
    for (let t = 0; t <= timeSpan + 0.001; t += step) {
      const depth = Math.min(1, t / timeSpan);
      const x = axisX0 + depth * depthX;
      const y = frontBottom - depth * depthY;

      ctx.strokeStyle = COL.grid;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 4, y);
      ctx.stroke();

      ctx.font = FONT_AXIS;
      ctx.fillStyle = COL.text;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const text = t >= timeSpan - 0.001 ? t.toFixed(0) + ' ms' : t.toFixed(0);
      ctx.fillText(text, x + 7, y);
    }

    // The gate's two edges, marked on the same axis.
    if (opts.gate && opts.gate.enabled) {
      const start = Math.min(1, Math.max(0, Math.max(0, opts.gate.startMs) / timeSpan));
      const end = Math.min(1, Math.max(0, (opts.gate.startMs + opts.gate.widthMs) / timeSpan));
      if (end > start) {
        const xa = axisX0 + start * depthX - 5;
        const ya = frontBottom - start * depthY;
        const xb = axisX0 + end * depthX - 5;
        const yb = frontBottom - end * depthY;

        ctx.strokeStyle = COL.trace;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(xa, ya);
        ctx.lineTo(xb, yb);
        ctx.stroke();

        for (const [x, y] of [[xa, ya], [xb, yb]]) {
          ctx.beginPath();
          ctx.moveTo(x - 3, y);
          ctx.lineTo(x + 3, y);
          ctx.stroke();
        }
      }
    }

    // The gate ruler below the frequency axis.
    const rulerY = frontBottom + 16;
    const rulerColour = opts.gate && opts.gate.enabled ? COL.trace : COL.textDim;
    ctx.strokeStyle = rulerColour;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(plot.x, Math.round(rulerY) + 0.5);
    ctx.lineTo(xOf(highest, 0), Math.round(rulerY) + 0.5);
    ctx.stroke();

    for (const x of [plot.x, xOf(highest, 0)]) {
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, rulerY - 5);
      ctx.lineTo(Math.round(x) + 0.5, rulerY + 5);
      ctx.stroke();
    }

    if (opts.gate) {
      const gate = opts.gate;
      const label = gate.enabled
        ? 'gate ' + gate.startMs.toFixed(1) + ' – ' + (gate.startMs + gate.widthMs).toFixed(1) + ' ms'
        : 'gate off · ' + gate.startMs.toFixed(1) + ' – ' + (gate.startMs + gate.widthMs).toFixed(1) + ' ms';
      ctx.font = FONT_AXIS;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const textWidth = ctx.measureText(label).width;
      const backingX = plot.x + freqWidth / 2 - textWidth / 2 - 7;
      ctx.fillStyle = '#0e130f';
      this.roundRect(backingX, rulerY - 8, textWidth + 14, 16, 5);
      ctx.fill();
      ctx.fillStyle = rulerColour;
      ctx.fillText(label, plot.x + freqWidth / 2, rulerY);
    }

    // The frequency axis.
    ctx.font = FONT_LABEL;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const labelY = rulerY + 17;
    const marks = [20, 100, 1000, 10000, 20000];
    for (let i = 0; i < marks.length; i++) {
      const f = marks[i];
      if (f < lowest - 0.5 || f > highest + 0.5) continue;
      const text = f >= 1000 ? (f >= 20000 ? '20k' : Math.round(f / 1000) + 'k') : String(f);
      ctx.fillStyle = COL.text;
      ctx.fillText(text, xOf(f, 0), labelY);
    }

    ctx.font = FONT_AXIS;
    ctx.fillStyle = COL.textDim;
    ctx.fillText('Frequency (Hz)', plot.x + freqWidth / 2, labelY + 17);
    ctx.restore();
  }

  timeStep(rangeMs) {
    const steps = [1, 2, 5, 10, 20, 25];
    for (let i = 0; i < steps.length; i++) {
      if (steps[i] >= rangeMs / 4) return steps[i];
    }
    return 25;
  }

  roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }
}
