const F_MIN = 20;
const F_MAX = 20000;
const LOG_SPAN = Math.log(F_MAX / F_MIN);

const COL = {
  bg: '#0b0f0c',
  border: 'rgba(160,190,150,0.10)',
  gridMajor: 'rgba(160,190,150,0.14)',
  gridMinor: 'rgba(160,190,150,0.06)',
  gridZero: 'rgba(160,190,150,0.28)',
  text: 'rgba(176,186,164,0.80)',
  textDim: 'rgba(160,172,150,0.52)',
  trace: '#c9ff70',
  phase: '#77c8c1',
  coh: '#d9a26c',
  ghost: 'rgba(226,235,214,0.55)',
  ghostB: 'rgba(143,199,250,0.65)',
  peak: 'rgba(201,255,112,0.32)',
  average: '#eeaac4',
  overlay: '#b4a7f7',
  savedColors: ['#b4a7f7', '#fbb679', '#72c7f2', '#eea4b3', '#a8df9b', '#f7d47b', '#86d5ca', '#d8a691'],
  target: 'rgba(214,222,206,0.45)',
  cursor: 'rgba(255,140,120,0.55)',
};

const FONT_AXIS = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
const FONT_UNIT = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
const FONT_LEGEND = '9px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';

const FREQ_LINES = [
  20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 2000, 3000, 4000,
  5000, 6000, 7000, 8000, 9000, 10000, 20000,
];
const FREQ_MAJOR = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const FREQ_LABELS_NARROW = [20, 200, 2000, 20000];

/** The magnitude targets, as the app's Analysis card offers them. */
export const TARGET_CURVES = [
  { id: 'flat', label: 'Flat' },
  { id: 'tilt', label: '−1 dB/oct above 1 kHz' },
  { id: 'room', label: 'Room curve (+6 dB low end)' },
];

/** The target in dB, 0 dB being the app's normalised reference level. */
export function targetDb(id, frequency) {
  const f = Math.max(frequency, 1);
  if (id === 'tilt') {
    if (f <= 1000) return 0;
    return -Math.log2(f / 1000);
  }
  if (id === 'room') {
    if (f >= 200) return 0;
    const t = Math.log2(200 / f) / Math.log2(200 / 30);
    return 6 * Math.min(1, Math.max(0, t));
  }
  return 0;
}

/** Wrap an angle into ±180°, the range the phase pane shows. */
export function wrapDegrees(deg) {
  let v = deg % 360;
  if (v > 180) v -= 360;
  if (v < -180) v += 360;
  return v;
}

function formatHz(f) {
  if (f >= 1000) {
    const k = f / 1000;
    return (Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)) + 'k';
  }
  return f.toFixed(0);
}

function roundRect(ctx, x, y, w, h, r) {
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

/** The dark, rounded panel every plot is drawn on. */
function paintPanel(ctx, w, h) {
  const shade = ctx.createLinearGradient(0, 0, 0, h);
  shade.addColorStop(0, '#0e130f');
  shade.addColorStop(1, '#090d0a');

  roundRect(ctx, 0.5, 0.5, w - 1, h - 1, 12);
  ctx.fillStyle = shade;
  ctx.fill();
  ctx.strokeStyle = COL.border;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** A hairline, snapped to the pixel grid so it stays crisp. */
function rule(ctx, x1, y1, x2, y2, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width || 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
  ctx.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5);
  ctx.stroke();
}

/** One gentle 3-tap pass, so a curve reads as a line rather than as noise. */
function smoothColumns(values) {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const a = values[Math.max(0, i - 1)];
    const b = values[i];
    const c = values[Math.min(values.length - 1, i + 1)];
    out[i] = (a + 2 * b + c) / 4;
  }
  return out;
}

export class TransferChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pad = { left: 46, right: 46, top: 40, bottom: 26 };
    this.dbMin = -60;
    this.dbMax = 10;
    this.w = 0;
    this.h = 0;
    // The frequency span on show: 20 Hz – 20 kHz until a drag zooms in.
    this.range = { min: F_MIN, max: F_MAX };
    /** A drag in progress: the two pixel columns being selected. */
    this.selection = null;
    // The drawn phase, eased between frames so the trace settles.
    this.phaseValues = null;
    this.phaseStamp = -1;
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(140, rect.width);
    this.h = Math.max(120, rect.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Show only this frequency span, keeping the logarithmic axis. */
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

  xOf(freq) {
    const p = this.plotRect();
    const r = this.range;
    const t = Math.log(Math.max(freq, r.min) / r.min) / Math.log(r.max / r.min);
    return p.x + Math.min(1, Math.max(0, t)) * p.w;
  }

  freqAtX(x) {
    const p = this.plotRect();
    const r = this.range;
    const t = Math.min(1, Math.max(0, (x - p.x) / p.w));
    return r.min * Math.exp(t * Math.log(r.max / r.min));
  }

  /** Frequencies to label: a readable handful however far the axis is zoomed. */
  frequencyTicks() {
    const r = this.range;
    const p = this.plotRect();
    const many = r.max / r.min >= 900;
    let ticks = (many ? FREQ_MAJOR : FREQ_LINES).filter((f) => f >= r.min && f <= r.max);
    const limit = p.w < 380 ? 5 : 10;
    if (ticks.length > limit) {
      const picked = [];
      for (let i = 0; i < limit; i++) {
        picked.push(ticks[Math.round((i / (limit - 1)) * (ticks.length - 1))]);
      }
      ticks = Array.from(new Set(picked));
    }
    if (ticks.length === 0) ticks = [r.min, r.max];
    return ticks;
  }


  dbToY(db, pane) {
    const v = Math.min(this.dbMax, Math.max(this.dbMin, db));
    const t = (this.dbMax - v) / Math.max(1e-6, this.dbMax - this.dbMin);
    return pane.y + t * pane.h;
  }

  phaseToY(deg, pane) {
    const v = Math.min(180, Math.max(-180, deg));
    return pane.y + (1 - (v + 180) / 360) * pane.h;
  }

  cohToY(value, pane) {
    const v = Math.min(1, Math.max(0, value));
    return pane.y + (1 - v) * pane.h;
  }

  /** Magnitude, phase and coherence stacked to fit the height available. */
  layout(options) {
    const p = this.plotRect();
    const showPhase = options.showPhase !== false;
    const showCoh = options.showCoh !== false;
    const gap = 12;

    const cohH = showCoh ? Math.max(18, Math.round(p.h * 0.15)) : 0;
    const phaseH = showPhase ? Math.max(32, Math.round(p.h * 0.26)) : 0;
    const gaps = (showPhase ? gap : 0) + (showCoh ? gap : 0);
    const magH = Math.max(24, p.h - phaseH - cohH - gaps);

    const panes = { mag: { x: p.x, y: p.y, w: p.w, h: magH }, phase: null, coh: null };
    let y = p.y + magH;
    if (showPhase) {
      y += gap;
      panes.phase = { x: p.x, y, w: p.w, h: phaseH };
      y += phaseH;
    }
    if (showCoh) {
      y += gap;
      panes.coh = { x: p.x, y, w: p.w, h: cohH };
    }
    return panes;
  }

  panesBottom(panes) {
    const last = panes.coh || panes.phase || panes.mag;
    return last.y + last.h;
  }

  /** The vertical range, widened to take in every trace and the target. */
  updateRange(res, options) {
    const opts = options || {};
    const span = this.range;
    let min = Infinity;
    let max = -Infinity;

    const include = (trace) => {
      if (!trace || !trace.bins || !trace.sampleRate || !trace.fftSize) return;
      const df = trace.sampleRate / trace.fftSize;
      const k0 = Math.max(1, Math.floor(Math.max(30, span.min) / df));
      const k1 = Math.min(trace.bins - 1, Math.ceil(Math.min(18000, span.max) / df));
      for (let k = k0; k <= k1; k++) {
        const v = trace.magDb[k];
        if (!Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    };

    include(res);
    include(opts.peakHold);
    include(opts.average);
    include(opts.secondSnapshot);
    include(opts.snapshot);

    for (const item of opts.savedCurves || []) {
      const curve = item.curve || [];
      for (let index = 0; index < curve.length; index++) {
        const frequency = F_MIN * Math.exp((index / Math.max(1, curve.length - 1)) * LOG_SPAN);
        if (frequency < span.min || frequency > span.max) continue;
        const v = curve[index];
        if (!Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }

    if (opts.target) {
      for (let f = span.min; f <= span.max; f *= 1.25) {
        const v = targetDb(opts.target, f);
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }

    if (!Number.isFinite(min) || !Number.isFinite(max)) return;

    let targetMin = Math.floor((min - 6) / 10) * 10;
    let targetMax = Math.ceil((max + 4) / 10) * 10;
    if (targetMax - targetMin < 50) {
      const mid = (targetMax + targetMin) / 2;
      targetMin = Math.floor((mid - 25) / 10) * 10;
      targetMax = Math.ceil((mid + 25) / 10) * 10;
    }

    const ease = 0.18;
    this.dbMin += (targetMin - this.dbMin) * ease;
    this.dbMax += (targetMax - this.dbMax) * ease;
  }

  draw(res, opts) {
    const options = opts || {};
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    if (this.w < 60 || this.h < 60) return;

    this.pad.top = Math.max(40, 48 + (options.savedCurves || []).length * 12);
    paintPanel(ctx, this.w, this.h);
    this.updateRange(res, options);
    if (res) this.updatePhase(res);

    const panes = this.layout(options);
    const bottom = this.panesBottom(panes);

    this.drawFrames(panes, bottom);
    this.drawFrequencyAxis(panes, bottom);
    this.drawDbAxis(panes.mag);
    if (panes.phase) this.drawPhaseAxis(panes.phase);
    if (panes.coh) this.drawCohAxis(panes.coh);
    this.drawLegend(panes, options);

    if (options.target) this.drawTarget(panes.mag, options.target);
    (options.savedCurves || []).forEach((item, index) => {
      this.drawSavedCurve(panes.mag, item.curve, COL.savedColors[index % COL.savedColors.length]);
    });
    if (options.peakHold) this.drawPeakHold(panes.mag, options.peakHold);
    if (options.average) this.drawAverage(panes.mag, options.average);

    if (res) {
      if (options.secondSnapshot) this.drawGhost(panes.mag, options.secondSnapshot, COL.ghostB);
      if (options.snapshot) this.drawGhost(panes.mag, options.snapshot, COL.ghost);
      this.drawMagnitude(panes.mag, res, false);
      if (panes.coh) this.drawCoherence(panes.coh, res);
      if (panes.phase) {
        const anchor = this.phaseAnchor(res);
        if (options.showCaptureAPhase && options.snapshot) {
          this.drawPhase(panes.phase, options.snapshot, { anchor, held: true, color: COL.ghost });
        }
        if (options.showCaptureBPhase && options.secondSnapshot) {
          this.drawPhase(panes.phase, options.secondSnapshot, { anchor, held: true, color: COL.ghostB });
        }
        this.drawPhase(panes.phase, res);
      }
    }
    if (panes.phase) {
      const anchor = res ? this.phaseAnchor(res) : 0;
      (options.savedCurves || []).forEach((item, index) => {
        this.drawSavedPhase(panes.phase, item, anchor, COL.savedColors[index % COL.savedColors.length]);
      });
    }

    if (options.cursorFreq) this.drawCursor(panes, bottom, options.cursorFreq, res);
    if (this.selection) this.drawSelection(panes, bottom);
  }

  /** The band a drag is selecting before it becomes the new frequency span. */
  drawSelection(panes, bottom) {
    const x0 = Math.min(this.selection.x0, this.selection.x1);
    const x1 = Math.max(this.selection.x0, this.selection.x1);
    if (!(x1 - x0 >= 1)) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(201,255,112,0.12)';
    ctx.fillRect(x0, panes.mag.y, x1 - x0, bottom - panes.mag.y);
    ctx.strokeStyle = 'rgba(201,255,112,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x0) + 0.5, Math.round(panes.mag.y) + 0.5, x1 - x0, bottom - panes.mag.y);
    ctx.restore();
  }

  drawFrames(panes, bottom) {
    const ctx = this.ctx;
    const p = panes.mag;
    const top = p.y;

    rule(ctx, p.x, top, p.x, bottom, COL.gridMajor);
    rule(ctx, p.x + p.w, top, p.x + p.w, bottom, COL.gridMajor);
    rule(ctx, p.x, top, p.x + p.w, top, COL.gridMajor);
    rule(ctx, p.x, bottom, p.x + p.w, bottom, COL.gridMajor);

    if (panes.phase) rule(ctx, p.x, panes.phase.y - 6, p.x + p.w, panes.phase.y - 6, COL.gridMinor);
    if (panes.coh) rule(ctx, p.x, panes.coh.y - 6, p.x + p.w, panes.coh.y - 6, COL.gridMajor);
  }

  drawFrequencyAxis(panes, bottom) {
    const ctx = this.ctx;
    const p = panes.mag;

    for (let i = 0; i < FREQ_LINES.length; i++) {
      const f = FREQ_LINES[i];
      if (f < this.range.min || f > this.range.max) continue;
      const x = this.xOf(f);
      const major = FREQ_MAJOR.indexOf(f) >= 0;
      rule(ctx, x, p.y, x, bottom, major ? COL.gridMajor : COL.gridMinor);
    }

    const labels = this.frequencyTicks();
    ctx.save();
    ctx.font = FONT_AXIS;
    ctx.fillStyle = COL.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i < labels.length; i++) {
      const f = labels[i];
      const x = Math.min(p.x + p.w - 12, Math.max(p.x + 12, this.xOf(f)));
      ctx.fillText(formatHz(f), x, bottom + 12);
    }
    ctx.font = FONT_UNIT;
    ctx.fillStyle = COL.textDim;
    ctx.textAlign = 'left';
    ctx.fillText('Hz', p.x + p.w + 7, bottom + 13);
    ctx.restore();
  }

  drawDbAxis(pane) {
    const ctx = this.ctx;
    const range = this.dbMax - this.dbMin;
    const step = range > 70 ? 20 : 10;
    const start = Math.ceil(this.dbMin / step) * step;

    ctx.save();
    ctx.font = FONT_AXIS;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let db = start; db <= this.dbMax; db += step) {
      const y = this.dbToY(db, pane);
      rule(ctx, pane.x, y, pane.x + pane.w, y, db === 0 ? COL.gridZero : COL.gridMajor);
      ctx.fillStyle = db === 0 ? COL.text : COL.textDim;
      ctx.fillText(db + '', pane.x - 8, y);
    }

    ctx.font = FONT_UNIT;
    ctx.fillStyle = COL.textDim;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('dB', pane.x + pane.w - 3, pane.y + 4);
    ctx.restore();
  }

  drawPhaseAxis(pane) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = FONT_AXIS;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    for (let deg = 180; deg >= -180; deg -= 90) {
      const y = this.phaseToY(deg, pane);
      rule(ctx, pane.x, y, pane.x + pane.w, y, deg === 0 ? COL.gridZero : COL.gridMinor);
      ctx.fillStyle = COL.textDim;
      ctx.fillText(deg > 0 ? '+' + deg : String(deg), pane.x + pane.w + 7, y);
    }

    ctx.font = FONT_UNIT;
    ctx.fillStyle = COL.textDim;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('°', pane.x + pane.w - 3, pane.y + 4);
    ctx.restore();
  }

  drawCohAxis(pane) {
    const ctx = this.ctx;
    const ticks = [1, 0.5, 0];

    ctx.save();
    ctx.font = FONT_AXIS;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < ticks.length; i++) {
      const v = ticks[i];
      const y = this.cohToY(v, pane);
      rule(ctx, pane.x, y, pane.x + pane.w, y, v === 0 ? COL.gridZero : COL.gridMinor);
      ctx.fillStyle = COL.textDim;
      ctx.fillText(v === 1 ? '1' : v === 0 ? '0' : '0.5', pane.x + pane.w + 7, y);
    }

    ctx.font = FONT_UNIT;
    ctx.fillStyle = COL.textDim;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('coh', pane.x + pane.w - 3, pane.y + 3);
    ctx.restore();
  }

  drawLegend(panes, options) {
    const ctx = this.ctx;
    const p = this.plotRect();
    const short = p.w < 430;
    const items = [[short ? 'Mag' : 'Magnitude', COL.trace]];
    if (panes.phase) items.push(['Phase', COL.phase]);
    if (panes.coh) items.push([short ? 'Coh' : 'Coherence', COL.coh]);
    if (options.target) items.push(['Target', COL.target]);
    (options.savedCurves || []).forEach((item, index) => items.push([
      (item.name || 'Saved').slice(0, short ? 12 : 24), COL.savedColors[index % COL.savedColors.length],
    ]));
    if (panes.phase && options.showCaptureAPhase && options.snapshot) items.push(['Phase A', COL.ghost]);
    if (panes.phase && options.showCaptureBPhase && options.secondSnapshot) items.push(['Phase B', COL.ghostB]);
    if (options.peakHold) items.push(['Peak', COL.peak]);
    if (options.average) items.push(['Avg ' + (options.averageCount || 0), COL.average]);
    if (options.snapshot) items.push([short ? 'A' : 'Capture A', COL.ghost]);
    if (options.secondSnapshot) items.push([short ? 'B' : 'Capture B', COL.ghostB]);

    let x = p.x;
    let y = 16;

    ctx.save();
    ctx.font = FONT_LEGEND;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineCap = 'round';

    for (let i = 0; i < items.length; i++) {
      const label = items[i][0];
      const color = items[i][1];
      const width = 16 + ctx.measureText(label).width;

      if (x > p.x + 1 && x + width > p.x + p.w + 2) {
        x = p.x;
        y += 14;
      }

      ctx.strokeStyle = color;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 11, y);
      ctx.stroke();
      ctx.fillStyle = COL.text;
      ctx.fillText(label, x + 16, y);
      x += width + (short ? 11 : 16);
    }
    ctx.restore();
  }

  /** One averaged dB value per pixel column: smooth, with no bin-level fuzz. */
  magnitudeColumns(pane, trace) {
    const df = trace.sampleRate / trace.fftSize;
    const bins = trace.bins;
    const count = Math.max(2, Math.ceil(pane.w));
    const values = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const f1 = this.freqAtX(pane.x + i);
      const f2 = this.freqAtX(pane.x + i + 1);
      const k0 = Math.max(1, Math.floor(f1 / df));
      const k1 = Math.min(bins - 1, Math.max(k0, Math.ceil(f2 / df)));

      let sum = 0;
      let n = 0;
      for (let k = k0; k <= k1; k++) {
        const v = trace.magDb[k];
        if (!Number.isFinite(v)) continue;
        sum += Math.pow(10, v / 10);
        n += 1;
      }
      values[i] = n > 0 ? 10 * Math.log10(sum / n) : this.dbMin;
    }
    return smoothColumns(values);
  }

  drawMagnitude(pane, trace, ghost) {
    const ctx = this.ctx;
    const values = this.magnitudeColumns(pane, trace);
    const x0 = pane.x + 0.5;
    const yOf = (db) => this.dbToY(db, pane);
    const bottom = pane.y + pane.h;

    if (!ghost) {
      const gradient = ctx.createLinearGradient(0, pane.y, 0, bottom);
      gradient.addColorStop(0, 'rgba(201,255,112,0.20)');
      gradient.addColorStop(1, 'rgba(201,255,112,0.00)');

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x0, yOf(values[0]));
      for (let i = 1; i < values.length; i++) ctx.lineTo(x0 + i, yOf(values[i]));
      ctx.lineTo(x0 + values.length - 1, bottom);
      ctx.lineTo(x0, bottom);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x0, yOf(values[0]));
    for (let i = 1; i < values.length; i++) ctx.lineTo(x0 + i, yOf(values[i]));
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (ghost) {
      ctx.strokeStyle = COL.ghost;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      // A wide, faint pass underneath makes the crisp trace glow a little.
      ctx.strokeStyle = 'rgba(201,255,112,0.14)';
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.strokeStyle = COL.trace;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  }

  /** A captured curve, dashed like the iOS capture ghosts. */
  drawGhost(pane, trace, color) {
    const values = this.magnitudeColumns(pane, trace);
    if (values.length < 2) return;
    const ctx = this.ctx;
    const x0 = pane.x + 0.5;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x0, this.dbToY(values[0], pane));
    for (let i = 1; i < values.length; i++) ctx.lineTo(x0 + i, this.dbToY(values[i], pane));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  drawPeakHold(pane, trace) {
    const values = this.magnitudeColumns(pane, trace);
    if (values.length < 2) return;
    const ctx = this.ctx;
    const x0 = pane.x + 0.5;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x0, this.dbToY(values[0], pane));
    for (let i = 1; i < values.length; i++) ctx.lineTo(x0 + i, this.dbToY(values[i], pane));
    ctx.strokeStyle = COL.peak;
    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();
  }

  drawAverage(pane, trace) {
    const values = this.magnitudeColumns(pane, trace);
    if (values.length < 2) return;
    const ctx = this.ctx;
    const x0 = pane.x + 0.5;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x0, this.dbToY(values[0], pane));
    for (let i = 1; i < values.length; i++) ctx.lineTo(x0 + i, this.dbToY(values[i], pane));
    ctx.strokeStyle = COL.average;
    ctx.lineWidth = 1.4;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash([5, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  /** A saved measurement's curve, log-spaced from 20 Hz to 20 kHz. */
  drawSavedCurve(pane, curve, color = COL.overlay) {
    if (!curve || curve.length < 2) return;
    const ctx = this.ctx;
    const count = Math.max(2, Math.ceil(pane.w));
    ctx.save();
    ctx.beginPath();
    let started = false;

    for (let i = 0; i < count; i++) {
      const frequency = this.freqAtX(pane.x + i);
      const position = (Math.log(frequency / F_MIN) / LOG_SPAN) * (curve.length - 1);
      const lower = Math.min(curve.length - 1, Math.max(0, Math.floor(position)));
      const upper = Math.min(curve.length - 1, lower + 1);
      const fraction = position - lower;
      const db = curve[lower] * (1 - fraction) + curve[upper] * fraction;
      if (!Number.isFinite(db)) {
        started = false;
        continue;
      }
      const x = pane.x + i + 0.5;
      const y = this.dbToY(db, pane);
      if (started) ctx.lineTo(x, y);
      else {
        ctx.moveTo(x, y);
        started = true;
      }
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  drawSavedPhase(pane, item, anchor, color) {
    if (!Array.isArray(item.phase) || !Array.isArray(item.phaseCoherence) || item.phase.length < 2) return;
    const ctx = this.ctx;
    const count = Math.ceil(pane.w);
    ctx.save();
    ctx.beginPath();
    let started = false;
    let previous = null;
    for (let i = 0; i < count; i++) {
      const freq = this.freqAtX(pane.x + i);
      const position = Math.log(freq / F_MIN) / LOG_SPAN * (item.phase.length - 1);
      const low = Math.min(item.phase.length - 1, Math.max(0, Math.floor(position)));
      const high = Math.min(item.phase.length - 1, low + 1);
      const t = position - low;
      const coh = item.phaseCoherence[low] * (1 - t) + item.phaseCoherence[high] * t;
      if (!(coh >= 0.35)) { started = false; previous = null; continue; }
      const raw = item.phase[low] * (1 - t) + item.phase[high] * t;
      const angle = wrapDegrees(raw - anchor - 360 * freq * (item.previewDelayMs || 0) / 1000);
      if (!Number.isFinite(angle)) { started = false; previous = null; continue; }
      if (previous !== null && Math.abs(angle - previous) > 180) started = false;
      if (started) ctx.lineTo(pane.x + i, this.phaseToY(angle, pane));
      else { ctx.moveTo(pane.x + i, this.phaseToY(angle, pane)); started = true; }
      previous = angle;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.restore();
  }

  /** The target, faint and dashed, behind every trace. */
  drawTarget(pane, id) {
    const ctx = this.ctx;
    const count = Math.max(2, Math.ceil(pane.w));

    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const f = this.freqAtX(pane.x + i);
      const y = this.dbToY(targetDb(id, f), pane);
      if (i === 0) ctx.moveTo(pane.x + i + 0.5, y);
      else ctx.lineTo(pane.x + i + 0.5, y);
    }
    ctx.strokeStyle = COL.target;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  /**
   * The phase read against 1 kHz — the middle of the band the measurement is
   * normalised to — so a noisy lowest bin cannot carry the whole curve off by a
   * whole turn from one frame to the next.
   */
  phaseAnchor(res) {
    const df = res.sampleRate / res.fftSize;
    if (!(res.bins > 2) || !(df > 0)) return 0;
    const bin = Math.min(Math.max(1, Math.round(1000 / df)), res.bins - 1);
    let sum = 0;
    let n = 0;
    for (let i = Math.max(0, bin - 4); i <= Math.min(res.bins - 1, bin + 4); i++) {
      if (Number.isFinite(res.phaseDeg[i])) { sum += res.phaseDeg[i]; n++; }
    }
    return n ? sum / n : 0;
  }

  relativePhase(res, sharedAnchor) {
    const df = res.sampleRate / res.fftSize;
    const out = new Float32Array(res.bins);
    const anchor = sharedAnchor === undefined ? this.phaseAnchor(res) : sharedAnchor;
    for (let k = 0; k < res.bins; k++) {
      out[k] = res.phaseDeg[k] - anchor - 360 * k * df * (res.previewDelayMs || 0) / 1000;
    }
    return out;
  }

  /** Refresh the drawn phase once per analysis frame, easing toward the new one. */
  updatePhase(res) {
    if (!res) {
      this.phaseValues = null;
      this.phaseStamp = -1;
      return;
    }
    if (this.phaseStamp === res.frames) return;

    const relative = this.relativePhase(res);
    if (!this.phaseValues || this.phaseValues.length !== relative.length) {
      this.phaseValues = relative;
    } else {
      for (let k = 0; k < relative.length; k++) {
        const target = relative[k];
        const current = this.phaseValues[k];
        if (!Number.isFinite(target) || !Number.isFinite(current)) continue;
        // A very slow follow: the curve takes ten seconds or more to settle,
        // so it reads as a shape rather than as movement.
        this.phaseValues[k] = current + (target - current) * 0.01;
      }
    }
    this.phaseStamp = res.frames;
  }

  drawPhase(pane, res, opts = {}) {
    const ctx = this.ctx;
    const df = res.sampleRate / res.fftSize;
    if (!(df > 0) || res.bins < 3) return;

    const bins = res.bins;
    const values = opts.held
      ? this.relativePhase(res, opts.anchor)
      : this.phaseValues && this.phaseValues.length === bins ? this.phaseValues : this.relativePhase(res);
    const count = Math.max(2, Math.ceil(pane.w));
    const continuous = new Float64Array(count);
    const readable = new Uint8Array(count);

    for (let i = 0; i < count; i++) {
      const f1 = this.freqAtX(pane.x + i);
      const f2 = this.freqAtX(pane.x + i + 1);
      const k0 = Math.max(1, Math.floor(f1 / df));
      const k1 = Math.min(bins - 1, Math.max(k0, Math.ceil(f2 / df)));

      let sum = 0;
      let coherence = 0;
      let n = 0;
      for (let k = k0; k <= k1; k++) {
        const v = values[k];
        if (!Number.isFinite(v)) continue;
        sum += v;
        coherence += res.coh[k];
        n += 1;
      }
      if (n === 0) continue;

      continuous[i] = sum / n;
      // Below this the phase is noise dressed as a curve.
      readable[i] = coherence / n >= 0.35 ? 1 : 0;
    }

    // Three gentle passes, so column-to-column noise does not read as a saw.
    const smoothed = smoothColumns(smoothColumns(smoothColumns(continuous)));

    ctx.save();
    ctx.beginPath();
    let started = false;
    let previous = null;

    for (let i = 0; i < count; i++) {
      if (!readable[i]) {
        started = false;
        previous = null;
        continue;
      }

      const value = wrapDegrees(smoothed[i]);
      if (previous !== null && Math.abs(value - previous) > 180) started = false;

      const x = pane.x + i + 0.5;
      const y = this.phaseToY(value, pane);
      if (started) ctx.lineTo(x, y);
      else {
        ctx.moveTo(x, y);
        started = true;
      }
      previous = value;
    }

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (!opts.held) {
      ctx.strokeStyle = 'rgba(119,200,193,0.18)';
      ctx.lineWidth = 4;
      ctx.stroke();
    }
    ctx.strokeStyle = opts.color || COL.phase;
    ctx.lineWidth = opts.held ? 1.2 : 1.6;
    if (opts.held) ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.restore();
  }

  drawCoherence(pane, res) {
    const ctx = this.ctx;
    const df = res.sampleRate / res.fftSize;
    const bins = res.bins;
    const count = Math.max(2, Math.ceil(pane.w));
    const values = new Float32Array(count);
    const bottom = pane.y + pane.h;

    for (let i = 0; i < count; i++) {
      const f1 = this.freqAtX(pane.x + i);
      const f2 = this.freqAtX(pane.x + i + 1);
      const k0 = Math.max(1, Math.floor(f1 / df));
      const k1 = Math.min(bins - 1, Math.max(k0, Math.ceil(f2 / df)));

      let sum = 0;
      let n = 0;
      for (let k = k0; k <= k1; k++) {
        const v = res.coh[k];
        if (!Number.isFinite(v)) continue;
        sum += v;
        n += 1;
      }
      values[i] = n > 0 ? sum / n : 0;
    }

    const smoothed = smoothColumns(values);
    const x0 = pane.x + 0.5;
    const yOf = (v) => this.cohToY(v, pane);

    const gradient = ctx.createLinearGradient(0, pane.y, 0, bottom);
    gradient.addColorStop(0, 'rgba(217,162,108,0.32)');
    gradient.addColorStop(1, 'rgba(217,162,108,0.05)');

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x0, bottom);
    for (let i = 0; i < smoothed.length; i++) ctx.lineTo(x0 + i, yOf(smoothed[i]));
    ctx.lineTo(x0 + smoothed.length - 1, bottom);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < smoothed.length; i++) {
      const x = x0 + i;
      const y = yOf(smoothed[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = COL.coh;
    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
  }

  drawCursor(panes, bottom, freq, res) {
    const ctx = this.ctx;
    const x = this.xOf(freq);

    ctx.save();
    ctx.strokeStyle = COL.cursor;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, panes.mag.y);
    ctx.lineTo(Math.round(x) + 0.5, bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    if (res) {
      // Match the value the curve was drawn from: average the bins inside one
      // pixel column rather than reading a single bin.
      const df = res.sampleRate / res.fftSize;
      const f1 = this.freqAtX(x);
      const f2 = this.freqAtX(x + 1);
      const k0 = Math.max(1, Math.floor(f1 / df));
      const k1 = Math.min(res.bins - 1, Math.max(k0, Math.ceil(f2 / df)));
      let sum = 0;
      let n = 0;
      for (let k = k0; k <= k1; k++) {
        const v = res.magDb[k];
        if (!Number.isFinite(v)) continue;
        sum += Math.pow(10, v / 10);
        n += 1;
      }
      if (n > 0) {
        const y = this.dbToY(10 * Math.log10(sum / n), panes.mag);
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fillStyle = COL.trace;
        ctx.fill();
        ctx.strokeStyle = COL.bg;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

export class ImpulseChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pad = { left: 42, right: 24, top: 22, bottom: 26 };
    this.w = 0;
    this.h = 0;
    this.layout = null;
    // Milliseconds relative to the impulse peak; null is -5…55 ms.
    this.zoom = null;
    /** A drag in progress: the two pixel columns being selected. */
    this.selection = null;
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(140, rect.width);
    this.h = Math.max(80, rect.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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

  /** Milliseconds to an x on the plot, from the layout of the last draw. */
  xForMs(ms) {
    const l = this.layout;
    if (!l) return 0;
    return l.p.x + ((ms - l.xMin) / (l.xMax - l.xMin)) * l.p.w;
  }

  /** The time under an x, relative to the impulse peak. */
  msAtX(x) {
    const l = this.layout;
    if (!l) return 0;
    return l.xMin + ((x - l.p.x) / Math.max(1, l.p.w)) * (l.xMax - l.xMin);
  }

  /** Which part of the gate a tap landed on: 'start', 'end' or 'move'. */
  gateModeAt(x, gate) {
    if (!this.layout || !gate) return 'move';
    const startX = this.xForMs(gate.startMs);
    const endX = this.xForMs(gate.startMs + gate.widthMs);
    if (Math.abs(x - startX) <= 16) return 'start';
    if (Math.abs(x - endX) <= 16) return 'end';
    return 'move';
  }

  /** How many milliseconds one pixel of a drag is worth. */
  msPerPixel() {
    const l = this.layout;
    if (!l) return 0;
    return (l.xMax - l.xMin) / l.p.w;
  }

  gateLabel(gate) {
    return 'gate ' + gate.startMs.toFixed(1) + '–' + (gate.startMs + gate.widthMs).toFixed(1) + ' ms';
  }

  draw(res, opts) {
    const options = opts || {};
    const gate = options.gate || null;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    if (this.w < 60 || this.h < 50) return;

    paintPanel(ctx, this.w, this.h);

    const p = this.plotRect();
    let peakMs = 0;
    let n = 0;
    let sr = 48000;
    let peak = 0;

    if (res) {
      n = res.fftSize;
      sr = res.sampleRate;
      for (let i = 0; i < n; i++) {
        if (res.irDb[i] > res.irDb[peak]) peak = i;
      }
      const signed = peak > n / 2 ? peak - n : peak;
      peakMs = (signed / sr) * 1000;
    }

    const xMin = this.zoom ? this.zoom.min : -5;
    const xMax = this.zoom ? this.zoom.max : 55;
    const span = Math.max(0.1, xMax - xMin);
    const xOf = (ms) => p.x + ((ms - xMin) / span) * p.w;
    const yOf = (db) => p.y + (Math.min(0, Math.max(-80, db)) / -80) * p.h;
    const bottom = p.y + p.h;

    this.layout = { p, xMin, xMax, peakMs };

    ctx.save();
    ctx.font = FONT_AXIS;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let db = 0; db >= -80; db -= 20) {
      const y = yOf(db);
      rule(ctx, p.x, y, p.x + p.w, y, db === 0 ? COL.gridMajor : COL.gridMinor);
      ctx.fillStyle = COL.textDim;
      ctx.fillText(db + '', p.x - 8, y);
    }

    const stepMs = span > 80 ? 20 : span > 30 ? 10 : span > 12 ? 5 : span > 5 ? 2 : 0.5;
    const startTick = Math.ceil(xMin / stepMs) * stepMs;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let ms = startTick; ms <= xMax; ms += stepMs) {
      const x = xOf(ms);
      rule(ctx, x, p.y, x, bottom, COL.gridMinor);
      ctx.fillStyle = COL.text;
      ctx.fillText(stepMs < 1 ? ms.toFixed(1) : ms.toFixed(0), x, bottom + 5);
    }

    ctx.font = FONT_UNIT;
    ctx.fillStyle = COL.textDim;
    ctx.textAlign = 'right';
    ctx.fillText('dB', p.x + p.w - 3, p.y + 4);
    ctx.textAlign = 'left';
    ctx.fillText('ms', p.x + p.w + 7, bottom + 6);
    ctx.restore();

    if (gate && gate.enabled) {
      const gateStartX = xOf(gate.startMs);
      const gateEndX = xOf(gate.startMs + gate.widthMs);
      const startX = Math.min(p.x + p.w, Math.max(p.x, gateStartX));
      const endX = Math.min(p.x + p.w, Math.max(p.x, gateEndX));

      if (gateEndX > p.x && gateStartX < p.x + p.w) {
        ctx.save();
        ctx.fillStyle = 'rgba(201,255,112,0.10)';
        ctx.fillRect(Math.min(startX, endX), p.y, Math.max(1, Math.abs(endX - startX)), p.h);
        ctx.strokeStyle = 'rgba(201,255,112,0.85)';
        ctx.lineWidth = 1.5;

        for (const x of [startX, endX]) {
          ctx.beginPath();
          ctx.moveTo(Math.round(x) + 0.5, p.y);
          ctx.lineTo(Math.round(x) + 0.5, bottom);
          ctx.stroke();

          ctx.fillStyle = COL.trace;
          roundRect(ctx, x - 2.5, p.y, 5, 12, 2);
          ctx.fill();
          roundRect(ctx, x - 2.5, bottom - 12, 5, 12, 2);
          ctx.fill();
        }

        // A grip on the bottom edge moves the whole gate; the plot stays free
        // above it for drawing a zoom selection.
        const midX = (startX + endX) / 2;
        ctx.fillStyle = 'rgba(201,255,112,0.28)';
        roundRect(ctx, midX - 15, bottom - 5, 30, 5, 2.5);
        ctx.fill();

        const label = this.gateLabel(gate);
        ctx.font = FONT_UNIT;
        ctx.fillStyle = COL.trace;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const labelX = Math.min(p.x + p.w - 44, Math.max(p.x + 44, midX));
        ctx.fillText(label, labelX, p.y + 8);
        ctx.restore();
      }
    }

    if (!res) return;

    // One value per pixel: the peak of the response inside that column.
    const count = Math.max(2, Math.ceil(p.w));
    const columns = new Float32Array(count).fill(-Infinity);
    for (let i = 0; i < n; i++) {
      const time = ((i > n / 2 ? i - n : i) / sr) * 1000 - peakMs;
      if (time < xMin || time > xMax) continue;
      const x = xOf(time);
      const c = Math.min(count - 1, Math.max(0, Math.floor(x - p.x)));
      const v = res.irDb[i];
      if (v > columns[c]) columns[c] = v;
    }

    let first = -1;
    let last = -1;
    for (let i = 0; i < count; i++) {
      if (!Number.isFinite(columns[i])) continue;
      if (first < 0) first = i;
      last = i;
    }
    if (first < 0) return;

    const x0 = p.x + first + 0.5;
    const xEnd = p.x + last + 0.5;

    const gradient = ctx.createLinearGradient(0, p.y, 0, bottom);
    gradient.addColorStop(0, 'rgba(201,255,112,0.20)');
    gradient.addColorStop(1, 'rgba(201,255,112,0.00)');

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x0, yOf(columns[first]));
    for (let i = first + 1; i <= last; i++) ctx.lineTo(p.x + i + 0.5, yOf(columns[i]));
    ctx.lineTo(xEnd, bottom);
    ctx.lineTo(x0, bottom);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(x0, yOf(columns[first]));
    for (let i = first + 1; i <= last; i++) ctx.lineTo(p.x + i + 0.5, yOf(columns[i]));
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(201,255,112,0.16)';
    ctx.lineWidth = 4.5;
    ctx.stroke();
    ctx.strokeStyle = COL.trace;
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.restore();

    const xp = xOf(0);
    if (xp >= p.x - 2 && xp <= p.x + p.w + 2) {
      ctx.save();
      ctx.strokeStyle = 'rgba(201,255,112,0.35)';
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(Math.round(xp) + 0.5, p.y);
      ctx.lineTo(Math.round(xp) + 0.5, bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(xp, yOf(0), 3, 0, Math.PI * 2);
      ctx.fillStyle = COL.trace;
      ctx.fill();
      ctx.strokeStyle = COL.bg;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }

    if (this.selection) {
      const sx0 = Math.min(this.selection.x0, this.selection.x1);
      const sx1 = Math.max(this.selection.x0, this.selection.x1);
      if (sx1 - sx0 >= 1) {
        ctx.save();
        ctx.fillStyle = 'rgba(201,255,112,0.12)';
        ctx.fillRect(sx0, p.y, sx1 - sx0, p.h);
        ctx.strokeStyle = 'rgba(201,255,112,0.6)';
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(sx0) + 0.5, Math.round(p.y) + 0.5, sx1 - sx0, p.h);
        ctx.restore();
      }
    }
  }
}
