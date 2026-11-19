/*
 * The modeler's chart: magnitude, phase, group delay, impulse and difference
 * on one canvas, all on a logarithmic frequency axis.
 *
 * It is painted on a single canvas from data that is already computed — the chart
 * never recomputes a response and never rebuilds the page. A zoom or a cursor
 * move only schedules a repaint, so dragging the delay or editing a filter stays
 * responsive while the curves update.
 */

const F_MIN = 20;
const F_MAX = 20000;

const COL = {
  bg: '#0a0e16',
  panel: '#10151d',
  border: 'rgba(148,180,255,0.08)',
  gridMajor: 'rgba(178,200,255,0.10)',
  gridMinor: 'rgba(178,200,255,0.045)',
  zero: 'rgba(200,216,255,0.22)',
  text: 'rgba(226,236,248,0.82)',
  textDim: 'rgba(178,194,214,0.56)',
  halo: 'rgba(8,12,20,0.92)',
  cursor: 'rgba(255,138,110,0.55)',
  selection: 'rgba(65,217,255,0.14)',
  null: 'rgba(255,111,94,0.55)',
};

export const TRACE_COLORS = [
  '#41d9ff', '#3ef0b8', '#ffb054', '#c9a3ff', '#7de87a', '#ffb36b', '#5ec8ff', '#ff8fb8',
];

const FONT_TICK = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
const FONT_LABEL = '9px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';

const FREQ_LINES = [
  20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 2000,
  3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 20000,
];
const FREQ_MAJOR = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

function formatHz(frequency) {  const f = Number(frequency);
  if (!Number.isFinite(f)) return '—';
  if (f >= 1000) {
    const k = f / 1000;
    return (Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)) + 'k';
  }
  return f.toFixed(0);
}

function wrapPhase(degrees) {
  let value = Number(degrees) % 360;
  if (value > 180) value -= 360;
  if (value < -180) value += 360;
  return value;
}

function finite(value) {
  return Number.isFinite(value);
}

export class ModelerChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mode = 'transfer';
    this.phaseMode = 'wrapped';
    this.dbSpan = 0;
    this.range = { min: F_MIN, max: F_MAX };
    this.traces = [];
    this.impulse = null;
    this.summary = '';
    this.showLegend = true;
    this.cursor = null;
    this.drag = null;
    this.markers = [];
    this.crossoverHz = null;
    this.scheduled = false;
    this.onHover = null;
    this.onRangeChange = null;
    this.pad = { left: 46, right: 16, top: 26, bottom: 22 };
    this.w = 0;
    this.h = 0;
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(180, rect.width || this.canvas.clientWidth || 320);
    this.h = Math.max(160, rect.height || this.canvas.clientHeight || 240);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setMode(mode) {
    this.mode = ['transfer', 'groupdelay', 'impulse', 'difference', 'ser', 'polar', 'directivity']
      .includes(mode) ? mode : 'transfer';
  }

  setPhaseMode(mode) {
    this.phaseMode = mode === 'unwrapped' ? 'unwrapped' : 'wrapped';
  }

  /** A fixed dB window, or 0 to let the range follow the traces. */
  setDbSpan(span) {
    const value = Number(span);
    this.dbSpan = Number.isFinite(value) && value >= 20 ? value : 0;
  }

  setRange(min, max) {
    const lo = Math.min(Math.max(Number(min) || F_MIN, F_MIN), F_MAX * 0.99);
    const hi = Math.min(F_MAX, Math.max(Number(max) || F_MAX, lo * 1.001));
    this.range = { min: lo, max: hi };
  }

  resetRange() {
    this.range = { min: F_MIN, max: F_MAX };
    this.dbSpan = 0;
  }

  setTraces(traces) {
    this.traces = (traces || []).filter((trace) => trace && trace.magDb);
  }

  setImpulse(impulse) {
    this.impulse = impulse && Array.isArray(impulse.values) ? impulse : null;
  }

  /** Phase intersection markers: frequencies where two traces meet. */
  setMarkers(markers) {
    this.markers = (markers || []).filter((marker) =>
      Number.isFinite(marker.frequency) && Number.isFinite(marker.phaseDeg));
  }

  /** The crossover region to shade, or null when it is off. */
  setCrossover(frequency) {
    const value = Number(frequency);
    this.crossoverHz = Number.isFinite(value) && value > 0 ? value : null;
  }

  /**
   * A repaint scheduled for the next animation frame. Several pointer moves
   * between two frames paint once, so dragging a delay never queues a backlog
   * of drawings behind the finger.
   */
  scheduleDraw() {
    if (this.scheduled) return;
    this.scheduled = true;
    const run = () => {
      this.scheduled = false;
      this.draw();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else run();
  }

  plotRect() {
    const p = this.pad;
    return {
      x: p.left,
      y: p.top,
      w: Math.max(20, this.w - p.left - p.right),
      h: Math.max(20, this.h - p.top - p.bottom),
    };
  }

  xOf(frequency) {
    const p = this.plotRect();
    const r = this.range;
    const t = Math.log(Math.max(frequency, r.min) / r.min) / Math.log(r.max / r.min);
    return p.x + Math.min(1, Math.max(0, t)) * p.w;
  }

  freqAtX(x) {
    const p = this.plotRect();
    const r = this.range;
    const t = Math.min(1, Math.max(0, (x - p.x) / p.w));
    return r.min * Math.exp(t * Math.log(r.max / r.min));
  }

  /** Which panes this mode has, and their share of the plot. */
  panes() {
    if (this.mode === 'transfer') {
      return [
        { id: 'magnitude', weight: 0.62, unit: 'dB' },
        { id: 'phase', weight: 0.38, unit: '°' },
      ];
    }
    if (this.mode === 'ser') {
      // SER mode: no phase plot — the system EQ above, the result below.
      return [
        { id: 'system', weight: 0.5, unit: 'dB' },
        { id: 'result', weight: 0.5, unit: 'dB' },
      ];
    }
    if (this.mode === 'groupdelay') return [{ id: 'groupdelay', weight: 1, unit: 'ms' }];
    if (this.mode === 'impulse') return [{ id: 'impulse', weight: 1, unit: 'dB' }];
    if (this.mode === 'polar') return [{ id: 'polar', weight: 1, unit: '°' }];
    if (this.mode === 'directivity') return [{ id: 'directivity', weight: 1, unit: '°' }];
    return [{ id: 'difference', weight: 1, unit: 'dB' }];
  }

  /** The traces that are visible and inside the mode's own picture. */
  visibleTraces() {
    if (this.mode === 'difference') {
      return this.traces.filter((trace) => trace.kind === 'difference' && trace.visible !== false);
    }
    if (this.mode === 'ser') {
      return this.traces.filter((trace) => (trace.kind === 'system' || trace.kind === 'sum') &&
        trace.visible !== false);
    }
    if (this.mode === 'groupdelay') {
      return this.traces.filter((trace) => trace.groupDelayMs && trace.groupDelayVisible !== false);
    }
    return this.traces.filter((trace) => trace.visible !== false &&
      (trace.kind !== 'difference') && (trace.kind !== 'system'));
  }

  /** The dB window: from the traces, or pinned by the span picker. */
  magnitudeRange() {
    const traces = this.visibleTraces();
    let lo = Infinity;
    let hi = -Infinity;
    for (const trace of traces) {
      for (let i = 0; i < trace.magDb.length; i += 1) {
        const f = trace.frequencies[i];
        if (f < this.range.min || f > this.range.max) continue;
        const value = trace.magDb[i];
        if (!finite(value)) continue;
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }
    }
    if (!finite(lo) || !finite(hi)) { lo = -60; hi = 0; }
    if (this.dbSpan > 0) {
      const top = Math.ceil(hi / 5) * 5;
      return { min: top - this.dbSpan, max: top };
    }
    const pad = Math.max(4, (hi - lo) * 0.08);
    let min = Math.floor(lo - pad);
    let max = Math.ceil(hi + pad);
    if (max - min < 24) max = min + 24;
    return { min, max };
  }

  phaseRange() {
    if (this.phaseMode === 'wrapped') return { min: -190, max: 190 };
    const traces = this.visibleTraces()
      .filter((trace) => trace.phaseDeg && trace.phaseVisible !== false && trace.phaseValid !== false);
    let lo = Infinity;
    let hi = -Infinity;
    for (const trace of traces) {
      for (let i = 0; i < trace.phaseDeg.length; i += 1) {
        const f = trace.frequencies[i];
        if (f < this.range.min || f > this.range.max) continue;
        const value = trace.phaseDeg[i];
        if (!finite(value)) continue;
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }
    }
    if (!finite(lo) || !finite(hi)) { lo = -180; hi = 180; }
    const pad = Math.max(30, (hi - lo) * 0.1);
    return { min: Math.floor(lo - pad), max: Math.ceil(hi + pad) };
  }

  groupDelayRange() {
    let lo = Infinity;
    let hi = -Infinity;
    for (const trace of this.visibleTraces()) {
      for (const value of trace.groupDelayMs) {
        if (!finite(value)) continue;
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }
    }
    if (!finite(lo) || !finite(hi)) { lo = -5; hi = 15; }
    const pad = Math.max(0.5, (hi - lo) * 0.1);
    return { min: Math.floor((lo - pad) * 2) / 2, max: Math.ceil((hi + pad) * 2) / 2 };
  }

  differenceRange() {
    let lo = Infinity;
    let hi = -Infinity;
    for (const trace of this.visibleTraces()) {
      for (const value of trace.magDb) {
        if (!finite(value)) continue;
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }
    }
    if (!finite(lo) || !finite(hi)) { lo = -12; hi = 12; }
    const pad = Math.max(2, (hi - lo) * 0.12);
    return { min: Math.floor(lo - pad), max: Math.ceil(hi + pad) };
  }

  frequencyTicks() {
    const r = this.range;
    const p = this.plotRect();
    const many = r.max / r.min >= 900;
    let ticks = (many ? FREQ_MAJOR : FREQ_LINES).filter((f) => f >= r.min && f <= r.max);
    const limit = p.w < 300 ? 4 : p.w < 460 ? 6 : 9;
    if (ticks.length > limit) {
      const picked = [];
      for (let i = 0; i < limit; i += 1) {
        picked.push(ticks[Math.round((i / (limit - 1)) * (ticks.length - 1))]);
      }
      ticks = Array.from(new Set(picked));
    }
    if (!ticks.length) ticks = [r.min, r.max];
    return ticks;
  }

  /* ---------- painting ---------- */

  draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, this.w, this.h);

    const panes = this.panes();
    const area = this.plotRect();
    let top = area.y;
    const total = panes.reduce((sum, pane) => sum + pane.weight, 0);

    const used = [];
    for (const pane of panes) {
      const height = Math.max(24, (area.h * pane.weight) / total);
      const rect = { x: area.x, y: top, w: area.w, h: height };
      ctx.fillStyle = COL.panel;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.strokeStyle = COL.border;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(rect.x) + 0.5, Math.round(rect.y) + 0.5, rect.w, rect.h);
      used.push({ ...pane, rect });
      top += height + 2;
    }

    if (this.mode !== 'polar' && this.mode !== 'directivity') {
      this.drawFrequencyGrid(used[used.length - 1].rect, area);
    }
    if (this.mode === 'transfer') this.drawCrossoverBand(used);

    for (const pane of used) {
      if (pane.id === 'magnitude') this.drawMagnitude(pane.rect);
      else if (pane.id === 'phase') this.drawPhase(pane.rect);
      else if (pane.id === 'groupdelay') this.drawGroupDelay(pane.rect);
      else if (pane.id === 'impulse') this.drawImpulsePane(pane.rect);
      else if (pane.id === 'difference') this.drawDifference(pane.rect);
      else if (pane.id === 'system') this.drawSerPane(pane.rect, 'system');
      else if (pane.id === 'result') this.drawSerPane(pane.rect, 'sum');
      else if (pane.id === 'polar') this.drawPolar(pane.rect);
      else if (pane.id === 'directivity') this.drawDirectivity(pane.rect);
    }

    if (this.mode !== 'polar' && this.mode !== 'directivity') {
      this.drawFrequencyAxis(used[used.length - 1].rect);
    }

    this.drawFrequencyAxis(used[used.length - 1].rect);
    if (this.showLegend) this.drawLegend(area);
    this.drawCursor(used);
  }

  /**
   * A quiet band around the crossover frequency, so the region being aligned is
   * obvious without changing a single curve.
   */
  drawCrossoverBand(panes) {
    if (!this.crossoverHz || !panes.length) return;
    const min = Math.max(this.range.min, this.crossoverHz / Math.pow(2, 1 / 6));
    const max = Math.min(this.range.max, this.crossoverHz * Math.pow(2, 1 / 6));
    if (!(max > min)) return;
    const x0 = this.xOf(min);
    const x1 = this.xOf(max);
    if (!(x1 > x0)) return;

    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(111,212,202,0.08)';
    for (const pane of panes) ctx.fillRect(x0, pane.rect.y, x1 - x0, pane.rect.h);
    ctx.strokeStyle = 'rgba(111,212,202,0.28)';
    ctx.setLineDash([2, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const x of [x0, x1]) {
      ctx.moveTo(Math.round(x) + 0.5, panes[0].rect.y);
      ctx.lineTo(Math.round(x) + 0.5, panes[0].rect.y + panes[0].rect.h);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawFrequencyGrid(rect, area) {    const ctx = this.ctx;
    const r = this.range;
    ctx.save();
    for (const line of FREQ_LINES) {
      if (line < r.min || line > r.max) continue;
      const x = this.xOf(line);
      const major = FREQ_MAJOR.includes(line);
      ctx.strokeStyle = major ? COL.gridMajor : COL.gridMinor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, area.y);
      ctx.lineTo(Math.round(x) + 0.5, rect.y + rect.h);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawFrequencyAxis(rect) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = COL.textDim;
    ctx.font = FONT_TICK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const line of this.frequencyTicks()) {
      ctx.fillText(formatHz(line), this.xOf(line), rect.y + rect.h + 4);
    }
    ctx.restore();
  }

  dbToY(db, rect, range) {
    const v = Math.min(range.max, Math.max(range.min, db));
    const t = (range.max - v) / Math.max(1e-6, range.max - range.min);
    return rect.y + t * rect.h;
  }

  strokeTrace(points, color, width, dash) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    ctx.strokeStyle = COL.halo;
    ctx.lineWidth = width + 2.4;
    ctx.setLineDash(dash || []);
    ctx.beginPath();
    let started = false;
    for (const point of points) {
      if (!point) { started = false; continue; }
      if (!started) { ctx.moveTo(point[0], point[1]); started = true; }
      else ctx.lineTo(point[0], point[1]);
    }
    ctx.stroke();

    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash || []);
    ctx.beginPath();
    started = false;
    for (const point of points) {
      if (!point) { started = false; continue; }
      if (!started) { ctx.moveTo(point[0], point[1]); started = true; }
      else ctx.lineTo(point[0], point[1]);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawPaneLabel(rect, text, unit) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = COL.textDim;
    ctx.font = FONT_LABEL;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(text, rect.x + 5, rect.y + 4);
    ctx.restore();
  }

  drawDbAxis(rect, range, unit) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = COL.textDim;
    ctx.font = FONT_TICK;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const step = this.axisStep(range);
    for (let value = Math.ceil(range.min / step) * step; value <= range.max; value += step) {
      const y = this.dbToY(value, rect, range);
      if (y < rect.y - 1 || y > rect.y + rect.h + 1) continue;
      ctx.fillText((value > 0 ? '+' : '') + value.toFixed(step < 1 ? 1 : 0), rect.x - 4, y);
      ctx.strokeStyle = value === 0 ? COL.zero : COL.gridMinor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(rect.x, Math.round(y) + 0.5);
      ctx.lineTo(rect.x + rect.w, Math.round(y) + 0.5);
      ctx.stroke();
    }
    ctx.restore();
  }

  axisStep(range) {
    const span = range.max - range.min;
    if (span <= 4) return 0.5;
    if (span <= 12) return 1;
    if (span <= 30) return 5;
    if (span <= 80) return 10;
    if (span <= 200) return 20;
    return 50;
  }

  drawMagnitude(rect) {
    const range = this.magnitudeRange();
    this.drawDbAxis(rect, range, 'dB');
    this.drawPaneLabel(rect, 'dB', '');
    const smoothing = this.smoothingOctaves !== undefined ? this.smoothingOctaves : 0;

    for (const trace of this.visibleTraces()) {
      const points = [];
      for (let i = 0; i < trace.magDb.length; i += 1) {
        const f = trace.frequencies[i];
        if (f < this.range.min || f > this.range.max) { points.push(null); continue; }
        const value = trace.magDb[i];
        if (!finite(value)) { points.push(null); continue; }
        points.push([this.xOf(f), this.dbToY(value, rect, range)]);
      }
      const smoothed = smoothing > 0 ? this.smoothedPoints(points, smoothing) : points;
      this.strokeTrace(smoothed, trace.color, trace.width || 1.6, trace.dash || []);
    }
  }

  /** A light visual smoothing pass, only where a curve is continuous. */
  smoothedPoints(points, octaves) {
    const radius = Math.max(1, Math.round(octaves * 24));
    const out = points.slice();
    for (let i = 0; i < points.length; i += 1) {
      if (!points[i]) continue;
      let sum = 0;
      let count = 0;
      for (let k = Math.max(0, i - radius); k <= Math.min(points.length - 1, i + radius); k += 1) {
        if (!points[k]) continue;
        sum += points[k][1];
        count += 1;
      }
      if (count) out[i] = [points[i][0], sum / count];
    }
    return out;
  }

  drawPhase(rect) {
    const range = this.phaseRange();
    this.drawDbAxis(rect, range, '°');
    this.drawPaneLabel(rect, 'phase', '');
    const traces = this.visibleTraces()
      .filter((trace) => trace.phaseDeg && trace.phaseVisible !== false && trace.phaseValid !== false);

    for (const trace of traces) {
      const points = [];
      for (let i = 0; i < trace.phaseDeg.length; i += 1) {
        const f = trace.frequencies[i];
        if (f < this.range.min || f > this.range.max) { points.push(null); continue; }
        const value = trace.phaseDeg[i];
        if (!finite(value)) { points.push(null); continue; }
        const shown = this.phaseMode === 'wrapped'
          ? ((((value + 180) % 360) + 360) % 360) - 180
          : value;
        points.push([this.xOf(f), this.dbToY(shown, rect, range)]);
      }
      this.strokeTrace(points, trace.color, trace.width || 1.3, trace.phaseDashed ? [3, 3] : []);
    }

    // Where two phase traces cross, a dot marks the frequency.
    const ctx = this.ctx;
    for (const marker of this.markers) {
      if (marker.frequency < this.range.min || marker.frequency > this.range.max) continue;
      const phase = this.phaseMode === 'wrapped' ? wrapPhase(marker.phaseDeg) : marker.phaseDeg;
      if (phase < range.min || phase > range.max) continue;
      const x = this.xOf(marker.frequency);
      const y = this.dbToY(phase, rect, range);
      ctx.save();
      ctx.fillStyle = marker.color || 'rgba(255,180,130,0.9)';
      ctx.strokeStyle = 'rgba(9,13,10,0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, 2.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    if (!traces.length) {
      const ctx = this.ctx;
      ctx.save();
      ctx.fillStyle = COL.textDim;
      ctx.font = FONT_LABEL;
      ctx.textAlign = 'center';
      ctx.fillText('no phase in the model — it stays magnitude-only', rect.x + rect.w / 2, rect.y + rect.h / 2);
      ctx.restore();
    }
  }

  drawGroupDelay(rect) {
    const range = this.groupDelayRange();
    this.drawDbAxis(rect, range, 'ms');
    this.drawPaneLabel(rect, 'group delay', 'ms');
    for (const trace of this.visibleTraces()) {
      const points = [];
      for (let i = 0; i < trace.groupDelayMs.length; i += 1) {
        const f = trace.frequencies[i];
        if (f < this.range.min || f > this.range.max) { points.push(null); continue; }
        const value = trace.groupDelayMs[i];
        if (!finite(value)) { points.push(null); continue; }
        points.push([this.xOf(f), this.dbToY(value, rect, range)]);
      }
      this.strokeTrace(points, trace.color, trace.width || 1.5, trace.dash || []);
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = COL.textDim;
    ctx.font = FONT_LABEL;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('gaps: low coherence or a cancellation null', rect.x + rect.w - 6, rect.y + rect.h - 4);
    ctx.restore();
  }

  drawImpulsePane(rect) {
    const impulse = this.impulse;
    this.drawPaneLabel(rect, 'impulse · derived', 'dB');
    if (!impulse || !Array.isArray(impulse.values) || impulse.values.length < 2) {
      const ctx = this.ctx;
      ctx.save();
      ctx.fillStyle = COL.textDim;
      ctx.font = FONT_LABEL;
      ctx.textAlign = 'center';
      ctx.fillText('no impulse yet — it is derived from the summed response', rect.x + rect.w / 2, rect.y + rect.h / 2);
      ctx.restore();
      return;
    }

    const start = Number(impulse.startMs) || -5;
    const step = Number(impulse.stepMs) || 1;
    const end = start + step * (impulse.values.length - 1);
    const range = { min: -90, max: 5 };
    const xOfMs = (ms) => rect.x + ((ms - start) / Math.max(1e-6, end - start)) * rect.w;

    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = COL.textDim;
    ctx.font = FONT_TICK;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let value = range.min; value <= range.max; value += 10) {
      const y = this.dbToY(value, rect, range);
      ctx.fillText(value + '', rect.x - 4, y);
    }

    const ticks = 6;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= ticks; i += 1) {
      const ms = start + ((end - start) * i) / ticks;
      const x = xOfMs(ms);
      ctx.fillStyle = COL.textDim;
      ctx.fillText(ms.toFixed(0) + ' ms', x, rect.y + rect.h + 4);
      ctx.strokeStyle = COL.gridMinor;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, rect.y);
      ctx.lineTo(Math.round(x) + 0.5, rect.y + rect.h);
      ctx.stroke();
    }

    // The zero line and the 1 ms rule show the time base honestly.
    ctx.strokeStyle = COL.zero;
    ctx.beginPath();
    ctx.moveTo(Math.round(xOfMs(0)) + 0.5, rect.y);
    ctx.lineTo(Math.round(xOfMs(0)) + 0.5, rect.y + rect.h);
    ctx.stroke();
    ctx.restore();

    const points = [];
    for (let i = 0; i < impulse.values.length; i += 1) {
      const ms = start + i * step;
      const value = Number(impulse.values[i]);
      if (!finite(value)) { points.push(null); continue; }
      points.push([xOfMs(ms), this.dbToY(value, rect, range)]);
    }
    this.strokeTrace(points, '#ffb15d', 1.6, []);
  }

  drawDifference(rect) {
    const range = this.differenceRange();
    this.drawDbAxis(rect, range, 'dB');
    this.drawPaneLabel(rect, 'predicted − measured', 'dB');
    const traces = this.traces.filter((trace) => trace.kind === 'difference' && trace.visible !== false);
    if (!traces.length) {
      const ctx = this.ctx;
      ctx.save();
      ctx.fillStyle = COL.textDim;
      ctx.font = FONT_LABEL;
      ctx.textAlign = 'center';
      ctx.fillText('choose a measured response to compare', rect.x + rect.w / 2, rect.y + rect.h / 2);
      ctx.restore();
      return;
    }
    for (const trace of traces) {
      const points = [];
      for (let i = 0; i < trace.magDb.length; i += 1) {
        const f = trace.frequencies[i];
        if (f < this.range.min || f > this.range.max) { points.push(null); continue; }
        const value = trace.magDb[i];
        if (!finite(value)) { points.push(null); continue; }
        points.push([this.xOf(f), this.dbToY(value, rect, range)]);
      }
      this.strokeTrace(points, trace.color, 1.6, trace.dash || []);
    }
  }

  drawLegend(area) {
    const traces = this.visibleTraces().slice(0, 8);
    if (!traces.length) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.font = FONT_LABEL;
    ctx.textBaseline = 'middle';
    let x = area.x + 8;
    const y = area.y + 8;
    for (const trace of traces) {
      const label = trace.label || trace.id;
      const width = ctx.measureText(label).width;
      if (x + width + 22 > area.x + area.w) break;
      ctx.strokeStyle = trace.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 12, y);
      ctx.stroke();
      ctx.fillStyle = COL.text;
      ctx.textAlign = 'left';
      ctx.fillText(label, x + 16, y);
      x += width + 28;
    }
    ctx.restore();
  }

  drawCursor(panes) {
    if (!this.cursor) return;
    const ctx = this.ctx;
    const area = this.plotRect();
    if (this.cursor.x < area.x || this.cursor.x > area.x + area.w) return;
    ctx.save();
    ctx.strokeStyle = COL.cursor;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(this.cursor.x) + 0.5, area.y);
    ctx.lineTo(Math.round(this.cursor.x) + 0.5, area.y + area.h);
    ctx.stroke();
    ctx.restore();
  }

  /** The reading at one frequency for the cursor, for the readout line. */
  readAt(frequency) {
    const readings = [];
    for (const trace of this.traces) {
      if (trace.visible === false) continue;
      const index = nearestIndex(trace.frequencies, frequency);
      if (index < 0) continue;
      readings.push({
        id: trace.id,
        label: trace.label || trace.id,
        color: trace.color,
        magDb: trace.magDb[index],
        phaseDeg: trace.phaseDeg ? trace.phaseDeg[index] : null,
        groupDelayMs: trace.groupDelayMs ? trace.groupDelayMs[index] : null,
        kind: trace.kind,
      });
    }
    return readings;
  }

  /* ---------- interaction ---------- */

  bindEvents() {
    if (this.bound) return;
    this.bound = true;
    const canvas = this.canvas;

    canvas.addEventListener('pointerdown', (event) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (event.shiftKey || event.button === 1) {
        this.drag = { mode: 'pan', x, y, startRange: { ...this.range } };
      } else {
        this.drag = { mode: 'zoom', x, y, to: x };
      }
      canvas.setPointerCapture(event.pointerId);
    });

    canvas.addEventListener('pointermove', (event) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      if (this.drag && this.drag.mode === 'zoom') {
        this.drag.to = x;
        const lo = Math.min(this.drag.x, x);
        const hi = Math.max(this.drag.x, x);
        if (hi - lo > 4) this.draw();
        return;
      }
      if (this.drag && this.drag.mode === 'pan') {
        const span = this.drag.startRange;
        const factor = Math.pow(2, -(x - this.drag.x) / 120);
        const min = Math.max(F_MIN, Math.min(F_MAX * 0.98, span.min * factor));
        const max = Math.min(F_MAX, Math.max(min * 1.001, span.max * factor));
        this.setRange(min, max);
        if (this.onRangeChange) this.onRangeChange(this.range);
        this.scheduleDraw();
        return;
      }

      this.cursor = { x, y };
      if (this.onHover) {
        const area = this.plotRect();
        if (x >= area.x && x <= area.x + area.w) {
          this.onHover({ frequency: this.freqAtX(x), x, y });
        } else this.onHover(null);
      }
      this.scheduleDraw();
    });

    const finish = (event) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      if (this.drag && this.drag.mode === 'zoom') {
        const lo = Math.min(this.drag.x, this.drag.to);
        const hi = Math.max(this.drag.x, this.drag.to);
        if (hi - lo > 12) {
          this.setRange(this.freqAtX(lo), this.freqAtX(hi));
          if (this.onRangeChange) this.onRangeChange(this.range);
        }
      }
      this.drag = null;
      this.cursor = { x, y: 0 };
      this.draw();
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', () => { this.drag = null; });

    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const anchor = this.freqAtX(x);
      const factor = Math.exp(event.deltaY * 0.0016);
      const min = Math.max(F_MIN, anchor - (anchor - this.range.min) * factor);
      const max = Math.min(F_MAX, anchor + (this.range.max - anchor) * factor);
      this.setRange(min, max);
      if (this.onRangeChange) this.onRangeChange(this.range);
      this.scheduleDraw();
    }, { passive: false });

    canvas.addEventListener('dblclick', () => {
      this.resetRange();
      if (this.onRangeChange) this.onRangeChange(this.range);
      this.draw();
    });

    canvas.addEventListener('pointerleave', () => {
      this.cursor = null;
      if (this.onHover) this.onHover(null);
      this.draw();
    });
  }
}

function nearestIndex(frequencies, wanted) {
  if (!frequencies || !frequencies.length) return -1;
  let lo = 0;
  let hi = frequencies.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frequencies[mid] <= wanted) lo = mid;
    else hi = mid;
  }
  return Math.abs(frequencies[lo] - wanted) <= Math.abs(frequencies[hi] - wanted) ? lo : hi;
}



/** The 6 dB width at a frequency, interpolated in log frequency. */
function widthAt(directivity, frequency) {
  if (!directivity || !directivity.length) return NaN;
  if (frequency <= directivity[0].frequency) return directivity[0].widthDeg;
  const last = directivity[directivity.length - 1];
  if (frequency >= last.frequency) return last.widthDeg;
  let index = 0;
  while (index < directivity.length - 1 && directivity[index + 1].frequency < frequency) index += 1;
  const low = directivity[index];
  const high = directivity[index + 1];
  const span = Math.log(high.frequency / low.frequency);
  const t = span > 0 ? Math.log(frequency / low.frequency) / span : 0;
  return low.widthDeg + (high.widthDeg - low.widthDeg) * t;
}
