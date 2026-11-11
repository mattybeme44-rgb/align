import { targetDb } from './targets.js';

/* The third-octave views: the band table, the A/B balance and group delay. */

export const BAND_CENTRES = [
  25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200,
  250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000,
  2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000,
];

export const BALANCE_CENTRES = [250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000];

function formatBandFrequency(frequency) {
  if (frequency >= 1000) {
    const thousands = frequency / 1000;
    const text = Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(2);
    return text + ' kHz';
  }
  return (Number.isInteger(frequency) ? frequency.toFixed(0) : frequency.toFixed(1)) + ' Hz';
}

/** Power-average one third-octave band of a trace, or null if the bins are missing. */
export function bandLevel(trace, centre) {
  if (!trace || !(trace.fftSize > 0) || !(trace.sampleRate > 0) || !(trace.bins > 2)) return null;
  const df = trace.sampleRate / trace.fftSize;
  const ratio = Math.pow(2, 1 / 6);
  const k0 = Math.max(1, Math.floor(centre / ratio / df));
  const k1 = Math.min(trace.bins - 1, Math.ceil(centre * ratio / df));
  if (!(k1 >= k0)) return null;

  let power = 0;
  for (let k = k0; k <= k1; k += 1) {
    const db = trace.magDb[k];
    if (!Number.isFinite(db)) continue;
    power += Math.pow(10, db / 10);
  }
  return 10 * Math.log10(Math.max(power / (k1 - k0 + 1), 1e-14));
}

export function bandReadings(res, target, customs) {
  if (!res || !(res.bins > 2) || !(res.df > 0)) return [];
  const ratio = Math.pow(2, 1 / 6);

  return BAND_CENTRES.map((frequency) => {
    const k0 = Math.max(1, Math.floor(frequency / ratio / res.df));
    const k1 = Math.min(res.bins - 1, Math.ceil(frequency * ratio / res.df));
    if (!(k1 >= k0)) {
      return { frequency, levelDb: -140, targetDelta: null, coherence: 0 };
    }

    let power = 0;
    let coherence = 0;
    for (let k = k0; k <= k1; k += 1) {
      power += Math.pow(10, res.magDb[k] / 10);
      coherence += res.coh[k];
    }
    const count = k1 - k0 + 1;
    const levelDb = 10 * Math.log10(Math.max(power / count, 1e-14));
    const meanCoherence = coherence / count;
    const targetDelta = target ? levelDb - targetDb(target, frequency, customs) : null;
    return { frequency, levelDb, targetDelta, coherence: meanCoherence };
  });
}

export function bandSummary(readings) {
  if (!readings.length) return { overall: null, coherence: null };
  let power = 0;
  let coherence = 0;
  readings.forEach((item) => {
    power += Math.pow(10, item.levelDb / 10);
    coherence += item.coherence;
  });
  return {
    overall: 10 * Math.log10(Math.max(power / readings.length, 1e-14)),
    coherence: coherence / readings.length,
  };
}

/** Capture A minus Capture B by third octave, 250 Hz to 4 kHz. */
export function speakerBalance(traceA, traceB) {
  if (!traceA || !traceB) return null;
  const bands = [];
  BALANCE_CENTRES.forEach((frequency) => {
    const levelA = bandLevel(traceA, frequency);
    const levelB = bandLevel(traceB, frequency);
    if (levelA === null || levelB === null) return;
    bands.push({ frequency, difference: levelA - levelB });
  });
  if (!bands.length) return null;

  const meanDifference = bands.reduce((sum, band) => sum + band.difference, 0) / bands.length;
  return {
    bands,
    meanDifference,
    louder: meanDifference >= 0 ? 'A' : 'B',
    isBalanced: Math.abs(meanDifference) <= 2,
  };
}

export function formatBalanceFrequency(frequency) {
  return formatBandFrequency(frequency);
}

/*
 * Group delay: differentiate the already-unwrapped phase within each continuous
 * high-coherence run, never across a gap, and leave low-coherence bins empty.
 */
export function groupDelayValues(res) {
  if (!res || !(res.df > 0) || !(res.bins > 3) || !res.phaseDeg || !res.coh) return null;

  const df = res.df;
  const values = new Array(res.bins).fill(null);
  const first = Math.max(1, Math.ceil(20 / df));
  const last = Math.min(res.bins - 1, Math.floor(20000 / df));
  if (!(first < last)) return { df, values };

  let start = first;
  while (start <= last) {
    if (!Number.isFinite(res.coh[start]) || res.coh[start] < 0.35 || !Number.isFinite(res.phaseDeg[start])) {
      start += 1;
      continue;
    }
    let end = start;
    while (
      end < last &&
      Number.isFinite(res.coh[end + 1]) && res.coh[end + 1] >= 0.35 &&
      Number.isFinite(res.phaseDeg[end + 1])
    ) {
      end += 1;
    }

    if (end - start >= 2) {
      const smoothed = new Array(end - start + 1).fill(0);
      for (let k = start; k <= end; k += 1) {
        const lo = Math.max(start, k - 2);
        const hi = Math.min(end, k + 2);
        let sum = 0;
        for (let n = lo; n <= hi; n += 1) sum += res.phaseDeg[n];
        smoothed[k - start] = sum / (hi - lo + 1);
      }

      for (let k = start + 1; k < end; k += 1) {
        const radius = Math.min(32, Math.max(2, Math.round(k * 0.02)));
        const lo = Math.max(start, k - radius);
        const hi = Math.min(end, k + radius);
        const slope = (smoothed[hi - start] - smoothed[lo - start]) / ((hi - lo) * df);
        const milliseconds = -slope * 1000 / 360;
        if (Number.isFinite(milliseconds)) values[k] = milliseconds;
      }
    }
    start = end + 1;
  }

  return { df, values };
}

export class GroupDelayChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pad = { left: 46, right: 14, top: 20, bottom: 28 };
    this.data = null;
    this.cursorFreq = null;
    this.w = 0;
    this.h = 0;
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(160, rect.width);
    this.h = Math.max(180, rect.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setResult(res) {
    this.data = groupDelayValues(res);
    this.cursorFreq = null;
  }

  plotRect() {
    const p = this.pad;
    return {
      x: p.left,
      y: p.top,
      w: Math.max(20, this.w - p.left - p.right),
      h: Math.max(40, this.h - p.top - p.bottom),
    };
  }

  xOf(freq, plot) {
    const t = Math.log(Math.max(freq, 20) / 20) / Math.log(1000);
    return plot.x + Math.min(1, Math.max(0, t)) * plot.w;
  }

  freqAtX(x) {
    const plot = this.plotRect();
    const t = Math.min(1, Math.max(0, (x - plot.x) / plot.w));
    return 20 * Math.exp(t * Math.log(1000));
  }

  valueAt(freq) {
    if (!this.data || !(this.data.df > 0)) return null;
    const index = Math.round(freq / this.data.df);
    if (!(index >= 0) || !(index < this.data.values.length)) return null;
    return this.data.values[index];
  }

  draw() {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    ctx.clearRect(0, 0, w, h);

    const panel = 12;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(panel, 0);
    ctx.lineTo(w - panel, 0);
    ctx.quadraticCurveTo(w, 0, w, panel);
    ctx.lineTo(w, h - panel);
    ctx.quadraticCurveTo(w, h, w - panel, h);
    ctx.lineTo(panel, h);
    ctx.quadraticCurveTo(0, h, 0, h - panel);
    ctx.lineTo(0, panel);
    ctx.quadraticCurveTo(0, 0, panel, 0);
    ctx.closePath();
    ctx.fillStyle = '#0e130f';
    ctx.fill();
    ctx.strokeStyle = 'rgba(160,190,150,0.14)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    const plot = this.plotRect();
    const readings = this.data ? this.data.values.filter((value) => value !== null).slice().sort((a, b) => a - b) : [];
    const low = readings.length ? readings[Math.floor(readings.length / 20)] : -2;
    const high = readings.length ? readings[Math.min(readings.length - 1, Math.floor(readings.length * 19 / 20))] : 8;
    const span = Math.max(1, high - low);
    const yMin = low - span * 0.12;
    const yMax = high + span * 0.12;
    const yOf = (ms) => plot.y + plot.h - Math.min(1, Math.max(0, (ms - yMin) / (yMax - yMin))) * plot.h;

    const axis = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.save();
    ctx.font = axis;
    ctx.fillStyle = 'rgba(160,172,150,0.62)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i += 1) {
      const ms = yMin + (yMax - yMin) * i / 4;
      const y = yOf(ms);
      ctx.strokeStyle = 'rgba(160,190,150,0.14)';
      ctx.beginPath();
      ctx.moveTo(plot.x, Math.round(y) + 0.5);
      ctx.lineTo(plot.x + plot.w, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillText(ms.toFixed(1), plot.x - 7, y);
    }
    ctx.fillText('ms', plot.x - 7, plot.y - 10);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const ticks = plot.w < 320 ? [20, 200, 2000, 20000] : [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    for (const frequency of ticks) {
      const x = this.xOf(frequency, plot);
      ctx.strokeStyle = 'rgba(160,190,150,0.10)';
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, plot.y);
      ctx.lineTo(Math.round(x) + 0.5, plot.y + plot.h);
      ctx.stroke();
      const label = frequency >= 1000 ? (frequency / 1000) + 'k' : String(frequency);
      ctx.fillStyle = 'rgba(176,186,164,0.82)';
      ctx.fillText(label, Math.min(plot.x + plot.w - 10, Math.max(plot.x + 10, x)), plot.y + plot.h + 12);
    }

    if (this.data) {
      const count = Math.max(1, Math.round(plot.w));
      ctx.beginPath();
      let started = false;
      let previousBin = null;
      for (let pixel = 0; pixel <= count; pixel += 1) {
        const x = plot.x + pixel;
        const freq = this.freqAtX(x);
        const k = Math.round(freq / this.data.df);
        const value = this.data.values[k];
        if (value === null || value === undefined) {
          started = false;
          previousBin = null;
          continue;
        }
        if (previousBin !== null && k > previousBin + 1) {
          let gap = false;
          for (let n = previousBin + 1; n < k; n += 1) {
            if (this.data.values[n] === null) { gap = true; break; }
          }
          if (gap) started = false;
        }
        if (started) ctx.lineTo(x, yOf(value));
        else { ctx.moveTo(x, yOf(value)); started = true; }
        previousBin = k;
      }
      ctx.strokeStyle = '#77c8c1';
      ctx.lineWidth = 1.8;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();

      if (this.cursorFreq) {
        const x = this.xOf(this.cursorFreq, plot);
        ctx.strokeStyle = 'rgba(201,255,112,0.65)';
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, plot.y);
        ctx.lineTo(Math.round(x) + 0.5, plot.y + plot.h);
        ctx.stroke();
        ctx.setLineDash([]);
        const value = this.valueAt(this.cursorFreq);
        if (value !== null) {
          ctx.beginPath();
          ctx.arc(x, yOf(value), 3, 0, Math.PI * 2);
          ctx.fillStyle = '#c9ff70';
          ctx.fill();
        }
      }
    } else {
      ctx.fillStyle = 'rgba(160,172,150,0.62)';
      ctx.font = '12px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Start a measurement to see group delay', plot.x + plot.w / 2, plot.y + plot.h / 2);
    }

    ctx.restore();
  }
}
