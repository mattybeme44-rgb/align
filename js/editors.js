/*
 * The two editor charts: the parametric EQ designer's predicted response, and
 * the hand-drawn target curve. Both keep the app's dark panel look and are
 * driven by a pointer, so a node can be dragged straight on the plot.
 */

import { customTargetDb, frequencyText, sortedTargetPoints } from './targets.js';
import { bankResponseDb, eqFilterKind, filterResponseDb } from './parametric-eq.js';

const F_MIN = 20;
const F_MAX = 20000;

const COL = {
  border: 'rgba(160,190,150,0.12)',
  grid: 'rgba(160,190,150,0.09)',
  gridZero: 'rgba(160,190,150,0.26)',
  text: 'rgba(176,186,164,0.82)',
  textDim: 'rgba(160,172,150,0.55)',
  ghost: 'rgba(226,235,214,0.55)',
  trace: '#c9ff70',
  accent: '#c9ff70',
  phase: '#77c8c1',
  target: 'rgba(214,222,206,0.85)',
  node: '#c9ff70',
  savedColors: ['#b4a7f7', '#fbb679', '#72c7f2', '#eea4b3', '#a8df9b', '#f7d47b', '#86d5ca', '#d8a691'],
};

const FONT_AXIS = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
const FONT_UNIT = '8px ui-monospace, SFMono-Regular, Menlo, monospace';

const FREQ_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

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

function rule(ctx, x1, y1, x2, y2, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
  ctx.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5);
  ctx.stroke();
}

function shortFrequency(frequency) {
  return frequency >= 1000
    ? String(Math.round(frequency / 1000)) + 'k'
    : String(Math.round(frequency));
}

export class EqDesignerChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pad = { left: 32, right: 14, top: 12, bottom: 20 };
    this.dbMin = -18;
    this.dbMax = 18;
    this.selected = null;
    this.w = 0;
    this.h = 0;
    this.resize();
  }

  resize() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(140, rect.width || this.canvas.parentElement.clientWidth || 320);
    this.h = Math.max(120, rect.height || 260);
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

  xOf(frequency) {
    const plot = this.plotRect();
    const t = Math.log(Math.max(frequency, F_MIN) / F_MIN) / Math.log(F_MAX / F_MIN);
    return plot.x + Math.min(1, Math.max(0, t)) * plot.w;
  }

  freqAtX(x) {
    const plot = this.plotRect();
    const t = Math.min(1, Math.max(0, (x - plot.x) / plot.w));
    return F_MIN * Math.exp(t * Math.log(F_MAX / F_MIN));
  }

  yOf(db) {
    const plot = this.plotRect();
    const clamped = Math.min(this.dbMax, Math.max(this.dbMin, db));
    return plot.y + ((this.dbMax - clamped) / Math.max(1e-6, this.dbMax - this.dbMin)) * plot.h;
  }

  dbAtY(y) {
    const plot = this.plotRect();
    const t = Math.min(1, Math.max(0, (y - plot.y) / Math.max(1, plot.h)));
    return this.dbMax - t * (this.dbMax - this.dbMin);
  }

  nearestFilter(filters, x, y) {
    let best = null;
    let bestDistance = Infinity;
    for (const filter of filters || []) {
      const kind = eqFilterKind(filter.kind);
      const nodeX = this.xOf(filter.frequency);
      const nodeY = this.yOf(kind.allowsGain ? filter.gainDb : 0);
      const distance = Math.hypot(nodeX - x, nodeY - y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = filter;
      }
    }
    return bestDistance <= 34 ? best : null;
  }

  /** One averaged dB value per pixel column, so the ghost reads as a line. */
  measurementColumns(filters, res) {
    const plot = this.plotRect();
    const count = Math.max(2, Math.ceil(plot.w));
    const values = new Float32Array(count);
    if (!res || !(res.bins > 2) || !(res.df > 0)) return null;

    for (let i = 0; i < count; i++) {
      const f1 = this.freqAtX(plot.x + i);
      const f2 = this.freqAtX(plot.x + i + 1);
      const k0 = Math.max(1, Math.floor(f1 / res.df));
      const k1 = Math.min(res.bins - 1, Math.max(k0, Math.ceil(f2 / res.df)));
      let sum = 0;
      let n = 0;
      for (let k = k0; k <= k1; k++) {
        const v = res.magDb[k];
        if (!Number.isFinite(v)) continue;
        sum += Math.pow(10, v / 10);
        n += 1;
      }
      values[i] = n > 0 ? 10 * Math.log10(sum / n) : this.dbMin;
    }
    return values;
  }

  draw(options) {
    const opts = options || {};
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    if (this.w < 60 || this.h < 60) return;

    paintPanel(ctx, this.w, this.h);

    const plot = this.plotRect();
    const sampleRate = Number(opts.sampleRate) > 0 ? Number(opts.sampleRate) : 48000;
    const filters = opts.filters || [];
    const selected = opts.selected || null;
    const columns = Math.max(2, Math.ceil(plot.w));

    this.drawGrid(plot);

    // Each filter on its own, faint.
    filters.forEach((filter, index) => {
      if (filter.enabled === false) return;
      const color = COL.savedColors[index % COL.savedColors.length];
      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < columns; i++) {
        const frequency = this.freqAtX(plot.x + i);
        const value = filterResponseDb(filter, frequency, sampleRate);
        const x = plot.x + i + 0.5;
        const y = this.yOf(value);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.globalAlpha = filter.id === selected ? 0.85 : 0.34;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.restore();
    });

    const live = this.measurementColumns(filters, opts.res);
    if (live) {
      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < live.length; i++) {
        const x = plot.x + i + 0.5;
        const y = this.yOf(live[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = COL.ghost;
      ctx.lineWidth = 1.2;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < columns; i++) {
        const frequency = this.freqAtX(plot.x + i);
        const value = live[Math.min(live.length - 1, i)] +
          bankResponseDb(filters, frequency, sampleRate);
        const x = plot.x + i + 0.5;
        const y = this.yOf(value);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = 'rgba(201,255,112,0.16)';
      ctx.lineWidth = 4.5;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.strokeStyle = COL.trace;
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < columns; i++) {
        const frequency = this.freqAtX(plot.x + i);
        const value = bankResponseDb(filters, frequency, sampleRate);
        const x = plot.x + i + 0.5;
        const y = this.yOf(value);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = COL.trace;
      ctx.lineWidth = 1.8;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();
    }

    this.drawNodes(plot, filters, selected);
  }

  drawGrid(plot) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = FONT_AXIS;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (const frequency of FREQ_TICKS) {
      const x = this.xOf(frequency);
      rule(ctx, x, plot.y, x, plot.y + plot.h, COL.grid);
      ctx.fillStyle = COL.textDim;
      ctx.fillText(shortFrequency(frequency), Math.min(plot.x + plot.w - 9, Math.max(plot.x + 9, x)), plot.y + plot.h + 5);
    }

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let db = this.dbMin; db <= this.dbMax; db += 6) {
      const y = this.yOf(db);
      rule(ctx, plot.x, y, plot.x + plot.w, y, db === 0 ? COL.gridZero : COL.grid);
      ctx.fillStyle = db === 0 ? COL.text : COL.textDim;
      ctx.fillText(String(db), plot.x - 6, y);
    }

    ctx.font = FONT_UNIT;
    ctx.fillStyle = COL.textDim;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('dB', plot.x + plot.w - 4, plot.y + 3);
    ctx.restore();
  }

  drawNodes(plot, filters, selected) {
    const ctx = this.ctx;
    filters.forEach((filter, index) => {
      const kind = eqFilterKind(filter.kind);
      const color = filter.enabled === false ? COL.textDim : COL.savedColors[index % COL.savedColors.length];
      const x = this.xOf(filter.frequency);
      const y = this.yOf(kind.allowsGain ? filter.gainDb : 0);
      const radius = filter.id === selected ? 7 : 5;

      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = filter.id === selected ? color : '#0b0f0c';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.restore();
    });
  }
}

export class TargetEditorChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pad = { left: 32, right: 14, top: 12, bottom: 20 };
    this.dbMin = -12;
    this.dbMax = 12;
    this.selectedIndex = -1;
    this.w = 0;
    this.h = 0;
    this.resize();
  }

  resize() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(140, rect.width || this.canvas.parentElement.clientWidth || 320);
    this.h = Math.max(120, rect.height || 260);
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

  xOf(frequency) {
    const plot = this.plotRect();
    const t = Math.log(Math.max(frequency, F_MIN) / F_MIN) / Math.log(F_MAX / F_MIN);
    return plot.x + Math.min(1, Math.max(0, t)) * plot.w;
  }

  freqAtX(x) {
    const plot = this.plotRect();
    const t = Math.min(1, Math.max(0, (x - plot.x) / plot.w));
    return F_MIN * Math.exp(t * Math.log(F_MAX / F_MIN));
  }

  yOf(db) {
    const plot = this.plotRect();
    const clamped = Math.min(this.dbMax, Math.max(this.dbMin, db));
    return plot.y + ((this.dbMax - clamped) / Math.max(1e-6, this.dbMax - this.dbMin)) * plot.h;
  }

  dbAtY(y) {
    const plot = this.plotRect();
    const t = Math.min(1, Math.max(0, (y - plot.y) / Math.max(1, plot.h)));
    return this.dbMax - t * (this.dbMax - this.dbMin);
  }

  nearestPoint(target, x, y) {
    let best = -1;
    let bestDistance = Infinity;
    const points = sortedTargetPoints(target);
    points.forEach((point, index) => {
      const distance = Math.hypot(this.xOf(point.frequency) - x, this.yOf(point.db) - y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return bestDistance <= 32 ? best : -1;
  }

  draw(options) {
    const opts = options || {};
    const ctx = this.ctx;
    const plot = this.plotRect();
    ctx.clearRect(0, 0, this.w, this.h);
    if (this.w < 60 || this.h < 60) return;

    paintPanel(ctx, this.w, this.h);
    this.drawGrid(plot);

    // The live measurement, faded, so the curve can be placed against it.
    const res = opts.res;
    if (res && res.bins > 2 && res.df > 0) {
      const columns = Math.max(2, Math.ceil(plot.w));
      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < columns; i++) {
        const f1 = this.freqAtX(plot.x + i);
        const f2 = this.freqAtX(plot.x + i + 1);
        const k0 = Math.max(1, Math.floor(f1 / res.df));
        const k1 = Math.min(res.bins - 1, Math.max(k0, Math.ceil(f2 / res.df)));
        let sum = 0;
        let n = 0;
        for (let k = k0; k <= k1; k++) {
          const v = res.magDb[k];
          if (!Number.isFinite(v)) continue;
          sum += Math.pow(10, v / 10);
          n += 1;
        }
        const value = n > 0 ? 10 * Math.log10(sum / n) : this.dbMin;
        const x = plot.x + i + 0.5;
        const y = this.yOf(value);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = 'rgba(226,235,214,0.28)';
      ctx.lineWidth = 1.1;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();
    }

    const target = opts.target;
    const points = sortedTargetPoints(target);
    if (points.length) {
      const columns = Math.max(2, Math.ceil(plot.w));
      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < columns; i++) {
        const frequency = this.freqAtX(plot.x + i);
        const y = this.yOf(customTargetDb(target, frequency));
        const x = plot.x + i + 0.5;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = 'rgba(201,255,112,0.16)';
      ctx.lineWidth = 4.5;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.strokeStyle = COL.target;
      ctx.lineWidth = 1.9;
      ctx.stroke();
      ctx.restore();
    }

    const selected = Number(opts.selected);
    points.forEach((point, index) => {
      const x = this.xOf(point.frequency);
      const y = this.yOf(point.db);
      const radius = index === selected ? 7 : 5;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = index === selected ? COL.node : '#0b0f0c';
      ctx.fill();
      ctx.strokeStyle = COL.node;
      ctx.lineWidth = 1.6;
      ctx.stroke();

      if (index === selected) {
        ctx.font = FONT_UNIT;
        ctx.fillStyle = COL.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText((point.db >= 0 ? '+' : '') + point.db.toFixed(1) + ' dB',
          Math.min(plot.x + plot.w - 26, Math.max(plot.x + 26, x)), y - 9);
      }
      ctx.restore();
    });
  }

  drawGrid(plot) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = FONT_AXIS;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (const frequency of FREQ_TICKS) {
      const x = this.xOf(frequency);
      rule(ctx, x, plot.y, x, plot.y + plot.h, COL.grid);
      ctx.fillStyle = COL.textDim;
      ctx.fillText(shortFrequency(frequency), Math.min(plot.x + plot.w - 9, Math.max(plot.x + 9, x)), plot.y + plot.h + 5);
    }

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let db = this.dbMin; db <= this.dbMax; db += 6) {
      const y = this.yOf(db);
      rule(ctx, plot.x, y, plot.x + plot.w, y, db === 0 ? COL.gridZero : COL.grid);
      ctx.fillStyle = db === 0 ? COL.text : COL.textDim;
      ctx.fillText((db > 0 ? '+' : '') + db, plot.x - 6, y);
    }

    ctx.font = FONT_UNIT;
    ctx.fillStyle = COL.textDim;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('dB', plot.x + plot.w - 4, plot.y + 3);
    ctx.restore();
  }
}

/** A frequency written the app's way, for editor readouts. */
export function editorFrequencyText(frequency) {
  return frequencyText(frequency);
}
