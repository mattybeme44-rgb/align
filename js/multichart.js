/*
 * The multi-microphone chart: three measured transfer functions and the
 * spatial average, on one logarithmic frequency axis.
 *
 * Drawing is decoupled from the FFT: the analysers update a few times a second
 * and every trace is eased toward its latest value on the animation frame, so
 * the display moves smoothly without ever asking the DSP to run faster.
 */

export const MULTI_COLORS = {
  A: '#9df058',
  B: '#5ec8ff',
  C: '#ffb054',
  average: '#c9a3ff',
};

const F_MIN = 20;
const F_MAX = 20000;

const COL = {
  panel: '#0a0d14',
  border: 'rgba(148,180,255,0.16)',
  grid: 'rgba(178,200,255,0.10)',
  gridMajor: 'rgba(140,200,255,0.16)',
  text: 'rgba(226,236,248,0.72)',
  dim: 'rgba(178,194,214,0.42)',
  cursor: 'rgba(226,236,248,0.45)',
};

const FONT_AXIS = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
const FONT_LEGEND = '10px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';

const FREQ_LINES = [20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 600, 700, 800, 900,
  1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 20000];

function formatHz(frequency) {
  if (frequency >= 1000) {
    const k = frequency / 1000;
    return (Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)) + 'k';
  }
  return frequency.toFixed(0);
}

function rule(ctx, x1, y1, x2, y2, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width || 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
  ctx.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5);
  ctx.stroke();
}

export class MultiChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.w = 0;
    this.h = 0;
    this.pad = { left: 42, right: 44, top: 30, bottom: 22 };
    this.range = { min: F_MIN, max: F_MAX };
    this.dbMin = -60;
    this.dbMax = 10;
    /** Eased copies of the traces, so the lines move instead of jumping. */
    this.eased = {};
    this.selection = null;
    this.resize();
  }

  resize() {
    if (!this.canvas || !this.ctx) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(160, rect.width);
    this.h = Math.max(140, rect.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setRange(min, max) {
    const lo = Math.min(Math.max(min, F_MIN), F_MAX * 0.99);
    const hi = Math.min(F_MAX, Math.max(max, lo * 1.001));
    this.range = { min: lo, max: hi };
  }

  plotRect() {
    const p = this.pad;
    return {
      x: p.left,
      y: p.top,
      w: Math.max(10, this.w - p.left - p.right),
      h: Math.max(10, this.h - p.top - p.bottom),
    };
  }

  xOf(frequency) {
    const plot = this.plotRect();
    const r = this.range;
    const t = Math.log(Math.max(frequency, r.min) / r.min) / Math.log(r.max / r.min);
    return plot.x + Math.min(1, Math.max(0, t)) * plot.w;
  }

  freqAtX(x) {
    const plot = this.plotRect();
    const r = this.range;
    const t = Math.min(1, Math.max(0, (x - plot.x) / plot.w));
    return r.min * Math.exp(t * Math.log(r.max / r.min));
  }

  layout(showPhase, showCoherence) {
    const plot = this.plotRect();
    const gap = 8;
    const phaseH = showPhase ? Math.max(40, Math.round(plot.h * 0.28)) : 0;
    const cohH = showCoherence ? Math.max(18, Math.round(plot.h * 0.14)) : 0;
    const gaps = (showPhase ? gap : 0) + (showCoherence ? gap : 0);
    const magH = Math.max(40, plot.h - phaseH - cohH - gaps);

    const mag = { x: plot.x, y: plot.y, w: plot.w, h: magH };
    let y = plot.y + magH;
    let phase = null;
    if (showPhase) {
      y += gap;
      phase = { x: plot.x, y, w: plot.w, h: phaseH };
      y += phaseH;
    }
    let coh = null;
    if (showCoherence) {
      y += gap;
      coh = { x: plot.x, y, w: plot.w, h: cohH };
    }
    return { mag, phase, coh, bottom: y + (coh ? coh.h : 0) };
  }

  dbToY(db, pane) {
    const value = Math.min(this.dbMax, Math.max(this.dbMin, db));
    const t = (this.dbMax - value) / Math.max(1e-6, this.dbMax - this.dbMin);
    return pane.y + t * pane.h;
  }

  phaseToY(deg, pane, span) {
    const value = Math.min(span, Math.max(-span, deg));
    return pane.y + (1 - (value + span) / (2 * span)) * pane.h;
  }

  cohToY(value, pane) {
    return pane.y + (1 - Math.min(1, Math.max(0, value))) * pane.h;
  }

  /** One dB value per pixel column, averaged in power. */
  columns(trace, pane, count) {
    const values = new Float32Array(count);
    if (!trace || !(trace.bins > 2) || !(trace.df > 0)) return values;
    for (let i = 0; i < count; i++) {
      const f1 = this.freqAtX(pane.x + i);
      const f2 = this.freqAtX(pane.x + i + 1);
      const k0 = Math.max(1, Math.floor(f1 / trace.df));
      const k1 = Math.min(trace.bins - 1, Math.max(k0, Math.ceil(f2 / trace.df)));
      let sum = 0;
      let n = 0;
      for (let k = k0; k <= k1; k++) {
        const v = trace.magDb[k];
        if (!Number.isFinite(v)) continue;
        sum += Math.pow(10, v / 10);
        n += 1;
      }
      values[i] = n ? 10 * Math.log10(sum / n) : NaN;
    }
    return values;
  }

  smooth(values) {
    const out = new Float32Array(values.length);
    for (let i = 0; i < values.length; i++) {
      const a = values[Math.max(0, i - 1)];
      const b = values[i];
      const c = values[Math.min(values.length - 1, i + 1)];
      if (!Number.isFinite(b)) { out[i] = NaN; continue; }
      const left = Number.isFinite(a) ? a : b;
      const right = Number.isFinite(c) ? c : b;
      out[i] = (left + 2 * b + right) / 4;
    }
    return out;
  }

  ease(key, target, factor) {
    const previous = this.eased[key];
    if (!previous || previous.length !== target.length) {
      this.eased[key] = Float32Array.from(target);
      return this.eased[key];
    }
    for (let i = 0; i < target.length; i++) {
      const value = target[i];
      if (!Number.isFinite(value)) { previous[i] = NaN; continue; }
      const current = previous[i];
      previous[i] = Number.isFinite(current) ? current + (value - current) * factor : value;
    }
    return previous;
  }

  updateRange(series, average) {
    let min = Infinity;
    let max = -Infinity;
    const consider = (trace) => {
      if (!trace || !(trace.bins > 2)) return;
      for (let k = 1; k < trace.bins; k++) {
        const v = trace.magDb[k];
        if (!Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    };
    for (const item of series) if (item.visible) consider(item);
    if (average) consider(average);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;

    let top = Math.ceil((max + 4) / 10) * 10;
    let bottom = Math.floor((min - 6) / 10) * 10;
    if (top - bottom < 40) {
      const mid = (top + bottom) / 2;
      top = Math.ceil((mid + 20) / 10) * 10;
      bottom = Math.floor((mid - 20) / 10) * 10;
    }
    this.dbMax += (top - this.dbMax) * 0.2;
    this.dbMin += (bottom - this.dbMin) * 0.2;
  }

  draw(state) {
    const ctx = this.ctx;
    if (!ctx) return;
    const options = state || {};
    const series = (options.series || []).filter((item) => item && item.visible && item.trace);
    const average = options.showAverage === false ? null : options.average;
    const showPhase = options.showPhase !== false;
    const showCoh = options.showCoherence !== false;
    const phaseSpan = options.phaseSpan || 180;
    this.phaseMode = options.phaseMode || 'wrapped';

    ctx.clearRect(0, 0, this.w, this.h);
    if (this.w < 80 || this.h < 80) return;

    ctx.fillStyle = COL.panel;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.strokeStyle = COL.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, this.w - 1, this.h - 1);

    this.updateRange(series, average);
    const layout = this.layout(showPhase, showCoh);
    const bottom = layout.bottom;

    this.drawGrid(layout, bottom);
    this.drawAxes(layout, phaseSpan, options.phaseMode);
    this.drawLegend(series, average, options.showAverage !== false);

    const columns = Math.max(2, Math.ceil(layout.mag.w));

    // Individual microphones first, the average over them.
    for (const item of series) {
      const raw = this.smooth(this.columns(item.trace, layout.mag, columns));
      const values = this.ease('mag-' + item.letter, raw, 0.35);
      this.strokeMagnitude(values, layout.mag, item.color, 1.4);
    }
    if (average) {
      const raw = this.smooth(this.columns(average, layout.mag, columns));
      const values = this.ease('mag-avg', raw, 0.35);
      this.strokeMagnitude(values, layout.mag, MULTI_COLORS.average, 2.4);
    }

    if (layout.phase && showPhase) {
      for (const item of series) {
        if (item.phaseVisible === false) continue;
        this.strokePhase(item, layout.phase, phaseSpan, options.coherenceThreshold);
      }
      if (average && options.averagePhase) {
        this.strokePhase({ trace: average, color: MULTI_COLORS.average, letter: 'avg' },
          layout.phase, phaseSpan, options.coherenceThreshold);
      }
    }

    if (layout.coh && showCoh) {
      for (const item of series) {
        this.strokeCoherence(item.trace, layout.coh, item.color);
      }
    }

    if (Number.isFinite(options.cursorFreq)) {
      const x = this.xOf(options.cursorFreq);
      rule(ctx, x, layout.mag.y, x, bottom, COL.cursor, 1);
    }
    if (this.selection) this.drawSelection(layout, bottom);
  }

  strokeMagnitude(values, pane, color, width) {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    let open = false;
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (!Number.isFinite(value)) { open = false; continue; }
      const x = pane.x + i;
      const y = this.dbToY(value, pane);
      if (open) ctx.lineTo(x, y);
      else { ctx.moveTo(x, y); open = true; }
    }
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(8,11,9,0.9)';
    ctx.lineWidth = width + 2;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.restore();
  }

  strokePhase(item, pane, span, threshold) {
    const trace = item.trace;
    if (!trace || !(trace.bins > 2)) return;
    const ctx = this.ctx;
    const count = Math.max(2, Math.ceil(pane.w));
    const strong = [];
    const faint = [];
    let previous = null;
    const unwrapped = this.phaseMode === 'unwrapped';

    for (let i = 0; i < count; i++) {
      const frequency = this.freqAtX(pane.x + i);
      const position = frequency / trace.df;
      if (!(position >= 0) || position > trace.bins - 1) {
        strong.push(null);
        faint.push(null);
        previous = null;
        continue;
      }
      const lower = Math.floor(position);
      const upper = Math.min(trace.bins - 1, lower + 1);
      const t = position - lower;
      const phase = trace.phaseDeg[lower] * (1 - t) + trace.phaseDeg[upper] * t;
      const coh = Math.min(trace.coh[lower] ?? 0, trace.coh[upper] ?? 0);
      if (!Number.isFinite(phase)) {
        strong.push(null);
        faint.push(null);
        previous = null;
        continue;
      }
      // A display offset turns only this microphone's drawn phase; the measured
      // arrival stays in the delay readout where it belongs.
      const offset = Number(item.phaseOffsetMs) || 0;
      const turned = phase - 360 * frequency * offset / 1000;
      const value = unwrapped ? turned : wrapDegrees(turned);
      if (previous !== null && Math.abs(value - previous) > (unwrapped ? 90 : 180)) {
        strong.push(null);
        faint.push(null);
      }
      const point = { x: pane.x + i, y: this.phaseToY(value, pane, span) };
      (coh >= (threshold || 0.35) ? strong : faint).push(point);
      previous = value;
    }

    const drawList = (list, alpha, width) => {
      if (!list.length) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = item.color;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      let open = false;
      for (const point of list) {
        if (!point) { open = false; continue; }
        if (open) ctx.lineTo(point.x, point.y);
        else { ctx.moveTo(point.x, point.y); open = true; }
      }
      ctx.stroke();
      ctx.restore();
    };

    drawList(faint, 0.22, 1);
    drawList(strong, 1, item.letter === 'avg' ? 1.8 : 1.2);
  }

  strokeCoherence(trace, pane, color) {
    if (!trace || !(trace.bins > 2)) return;
    const ctx = this.ctx;
    const count = Math.max(2, Math.ceil(pane.w));
    ctx.save();
    ctx.beginPath();
    let open = false;
    for (let i = 0; i < count; i++) {
      const frequency = this.freqAtX(pane.x + i);
      const k = Math.round(frequency / trace.df);
      if (!(k >= 0 && k < trace.bins)) { open = false; continue; }
      const value = trace.coh[k];
      if (!Number.isFinite(value)) { open = false; continue; }
      const x = pane.x + i;
      const y = this.cohToY(value, pane);
      if (open) ctx.lineTo(x, y);
      else { ctx.moveTo(x, y); open = true; }
    }
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
  }

  drawGrid(layout, bottom) {
    const ctx = this.ctx;
    const mag = layout.mag;
    for (const frequency of FREQ_LINES) {
      if (frequency < this.range.min || frequency > this.range.max) continue;
      const x = this.xOf(frequency);
      rule(ctx, x, mag.y, x, bottom, COL.grid, 1);
    }
    const range = this.dbMax - this.dbMin;
    const step = range > 70 ? 20 : 10;
    const start = Math.ceil(this.dbMin / step) * step;
    ctx.font = FONT_AXIS;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let db = start; db <= this.dbMax; db += step) {
      const y = this.dbToY(db, mag);
      rule(ctx, mag.x, y, mag.x + mag.w, y, db === 0 ? COL.gridMajor : COL.grid, 1);
      ctx.fillStyle = db === 0 ? COL.text : COL.dim;
      ctx.fillText(String(db), mag.x - 6, y);
    }
  }

  drawAxes(layout, phaseSpan, phaseMode) {
    const ctx = this.ctx;
    const mag = layout.mag;
    ctx.font = FONT_AXIS;
    ctx.fillStyle = COL.dim;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const ticks = this.range.max / this.range.min > 900
      ? [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
      : FREQ_LINES;
    for (const frequency of ticks) {
      if (frequency < this.range.min || frequency > this.range.max) continue;
      const x = Math.min(mag.x + mag.w - 8, Math.max(mag.x + 8, this.xOf(frequency)));
      ctx.fillText(formatHz(frequency), x, layout.bottom + 6);
    }
    ctx.textAlign = 'right';
    ctx.fillStyle = COL.dim;
    ctx.fillText('dB', mag.x + mag.w - 2, mag.y + 3);

    if (layout.phase) {
      ctx.textAlign = 'left';
      for (const deg of [phaseSpan, 0, -phaseSpan]) {
        const y = this.phaseToY(deg, layout.phase, phaseSpan);
        rule(ctx, layout.phase.x, y, layout.phase.x + layout.phase.w, y,
          deg === 0 ? COL.gridMajor : COL.grid, 1);
        ctx.fillStyle = COL.dim;
        ctx.textAlign = 'left';
        ctx.fillText(deg > 0 ? '+' + deg : String(deg), layout.phase.x + layout.phase.w + 5, y);
      }
      ctx.fillText(phaseMode === 'unwrapped' ? '° unwrapped' : '°',
        layout.phase.x + layout.phase.w - 2, layout.phase.y + 2);
    }

    if (layout.coh) {
      for (const value of [1, 0.5, 0]) {
        const y = this.cohToY(value, layout.coh);
        rule(ctx, layout.coh.x, y, layout.coh.x + layout.coh.w, y, COL.grid, 1);
        ctx.fillStyle = COL.dim;
        ctx.textAlign = 'left';
        ctx.fillText(value === 1 ? '1' : value === 0 ? '0' : '0.5',
          layout.coh.x + layout.coh.w + 5, y);
      }
      ctx.fillText('coh', layout.coh.x + layout.coh.w - 2, layout.coh.y + 1);
    }
  }

  drawLegend(series, average, showAverage) {
    const ctx = this.ctx;
    const plot = this.plotRect();
    let x = plot.x;
    let y = 10;
    ctx.font = FONT_LEGEND;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const items = series.map((item) => ({ label: 'Mic ' + item.letter, color: item.color }));
    if (average && showAverage) items.push({ label: 'Spatial average', color: MULTI_COLORS.average });

    for (const item of items) {
      const width = 18 + ctx.measureText(item.label).width;
      if (x > plot.x && x + width > plot.maxX + 2) {
        x = plot.x;
        y += 13;
      }
      ctx.strokeStyle = item.color;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 12, y);
      ctx.stroke();
      ctx.fillStyle = COL.text;
      ctx.fillText(item.label, x + 17, y);
      x += width + 12;
    }
  }

  drawSelection(layout, bottom) {
    const ctx = this.ctx;
    const x0 = Math.min(this.selection.x0, this.selection.x1);
    const x1 = Math.max(this.selection.x0, this.selection.x1);
    if (x1 - x0 < 2) return;
    ctx.fillStyle = 'rgba(201,255,112,0.10)';
    ctx.fillRect(x0, layout.mag.y, x1 - x0, bottom - layout.mag.y);
    ctx.strokeStyle = 'rgba(201,255,112,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x0) + 0.5, Math.round(layout.mag.y) + 0.5,
      x1 - x0, bottom - layout.mag.y);
  }
}

function wrapDegrees(deg) {
  let value = deg % 360;
  if (value > 180) value -= 360;
  if (value < -180) value += 360;
  return value;
}
