const F_MIN = 20;
const F_MAX = 20000;
const LOG_SPAN = Math.log(F_MAX / F_MIN);

const COL = {
  bg: '#0b0f14',
  grid: 'rgba(90,120,150,0.22)',
  text: 'rgba(140,165,190,0.85)',
  trace: '#f0b429',
  phase: '#4cc9f0',
  coh: '#9d7bff',
  ghost: 'rgba(120,190,255,0.45)',
  cursor: 'rgba(255,120,120,0.8)',
};

function formatHz(f) {
  if (f >= 1000) {
    const k = f / 1000;
    return (Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)) + 'k';
  }
  return f.toFixed(0);
}

const MONO = '9px ui-monospace, SFMono-Regular, Menlo, monospace';

export class TransferChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pad = { left: 44, right: 42, top: 12, bottom: 20 };
    this.dbMin = -60;
    this.dbMax = 10;
    this.w = 0;
    this.h = 0;
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(120, rect.width);
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

  xOf(freq) {
    const p = this.plotRect();
    const t = Math.log(freq / F_MIN) / LOG_SPAN;
    return p.x + Math.min(1, Math.max(0, t)) * p.w;
  }

  freqAtX(x) {
    const p = this.plotRect();
    const t = Math.min(1, Math.max(0, (x - p.x) / p.w));
    return F_MIN * Math.exp(t * LOG_SPAN);
  }

  dbToY(db, magBottom) {
    const p = this.plotRect();
    const v = Math.min(this.dbMax, Math.max(this.dbMin, db));
    const t = (this.dbMax - v) / (this.dbMax - this.dbMin);
    return p.y + t * (magBottom - p.y);
  }

  updateRange(res) {
    const df = res.sampleRate / res.fftSize;
    const k0 = Math.max(1, Math.floor(30 / df));
    const k1 = Math.min(res.bins - 1, Math.ceil(18000 / df));
    let min = Infinity;
    let max = -Infinity;
    for (let k = k0; k <= k1; k++) {
      const v = res.magDb[k];
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;

    let targetMin = Math.floor((min - 4) / 10) * 10;
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
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, this.w, this.h);
    if (this.w < 40 || this.h < 40) return;

    const p = this.plotRect();
    const showPhase = options.showPhase !== false;
    const showCoh = Boolean(res) && options.showCoh !== false;
    const cohBand = showCoh ? Math.max(24, p.h * 0.2) : 0;
    const magBottom = p.y + p.h - cohBand;

    if (res) this.updateRange(res);

    this.drawGrid(p, magBottom, showPhase, showCoh);

    if (res) {
      if (options.snapshot) this.drawMagnitude(p, options.snapshot, COL.ghost, 1, magBottom);
      if (showCoh) this.drawCoherence(p, res, cohBand);
      this.drawMagnitude(p, res, COL.trace, 1.7, magBottom);
      if (showPhase) this.drawPhase(p, res);
      if (options.cursorFreq) this.drawCursor(p, options.cursorFreq);
    }
  }

  drawGrid(p, magBottom, showPhase, showCoh) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1;
    ctx.font = MONO;
    ctx.fillStyle = COL.text;

    const minor = [
      20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 2000, 3000, 4000,
      5000, 6000, 7000, 8000, 9000, 10000, 20000,
    ];
    const major = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

    for (let i = 0; i < minor.length; i++) {
      const f = minor[i];
      const x = Math.round(this.xOf(f)) + 0.5;
      ctx.globalAlpha = major.indexOf(f) >= 0 ? 1 : 0.4;
      ctx.beginPath();
      ctx.moveTo(x, p.y);
      ctx.lineTo(x, magBottom);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    const labels = p.w < 380 ? [50, 200, 1000, 5000, 20000] : major;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i < labels.length; i++) {
      const f = labels[i];
      const x = Math.min(p.x + p.w - 10, Math.max(p.x + 10, this.xOf(f)));
      ctx.fillText(formatHz(f), x, magBottom + 5);
    }

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const step = this.dbMax - this.dbMin > 90 ? 20 : 10;
    for (let db = Math.ceil(this.dbMin / step) * step; db <= this.dbMax; db += step) {
      const y = Math.round(this.dbToY(db, magBottom)) + 0.5;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.moveTo(p.x, y);
      ctx.lineTo(p.x + p.w, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(db + '', p.x - 5, y);
    }

    if (showPhase) {
      ctx.fillStyle = COL.phase;
      ctx.textAlign = 'left';
      ctx.fillText('+180', p.x + p.w + 5, p.y + 6);
      ctx.fillText('0', p.x + p.w + 5, p.y + p.h / 2);
      ctx.fillText('-180', p.x + p.w + 5, p.y + p.h - 6);
      ctx.fillStyle = COL.text;
    }

    if (showCoh) {
      const top = p.y + p.h - Math.max(24, p.h * 0.2);
      ctx.textAlign = 'left';
      ctx.fillText('1', p.x + p.w + 5, top + 4);
      ctx.fillText('0', p.x + p.w + 5, p.y + p.h - 4);
    }

    ctx.restore();
  }

  drawMagnitude(p, trace, color, width, magBottom) {
    const ctx = this.ctx;
    const df = trace.sampleRate / trace.fftSize;
    const bins = trace.bins;
    if (!bins) return;

    ctx.save();
    ctx.beginPath();
    let started = false;
    for (let x = Math.floor(p.x); x <= p.x + p.w; x++) {
      const f1 = this.freqAtX(x);
      const f2 = this.freqAtX(x + 1);
      const k0 = Math.max(1, Math.floor(f1 / df));
      const k1 = Math.min(bins - 1, Math.max(k0, Math.ceil(f2 / df)));
      let v = -Infinity;
      for (let k = k0; k <= k1; k++) {
        const value = trace.magDb[k];
        if (value > v) v = value;
      }
      if (!Number.isFinite(v)) v = this.dbMin;
      const y = this.dbToY(v, magBottom);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
  }

  drawPhase(p, trace) {
    const ctx = this.ctx;
    const df = trace.sampleRate / trace.fftSize;
    const bins = trace.bins;
    if (!bins) return;

    ctx.save();
    ctx.beginPath();
    let started = false;
    for (let x = Math.floor(p.x); x <= p.x + p.w; x++) {
      const f = this.freqAtX(x);
      const k = Math.min(bins - 1, Math.max(0, Math.round(f / df)));
      let deg = trace.phaseDeg[k];
      if (!Number.isFinite(deg)) continue;
      deg = Math.max(-180, Math.min(180, deg));
      const y = p.y + (1 - (deg + 180) / 360) * p.h;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = COL.phase;
    ctx.lineWidth = 1.1;
    ctx.globalAlpha = 0.85;
    ctx.stroke();
    ctx.restore();
  }

  drawCoherence(p, res, cohBand) {
    const ctx = this.ctx;
    const df = res.sampleRate / res.fftSize;
    const bottom = p.y + p.h;
    const top = bottom - cohBand;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(p.x, bottom);
    let started = false;
    for (let x = Math.floor(p.x); x <= p.x + p.w; x++) {
      const f1 = this.freqAtX(x);
      const f2 = this.freqAtX(x + 1);
      const k0 = Math.max(1, Math.floor(f1 / df));
      const k1 = Math.min(res.bins - 1, Math.max(k0, Math.ceil(f2 / df)));
      let sum = 0;
      let count = 0;
      for (let k = k0; k <= k1; k++) {
        sum += res.coh[k];
        count += 1;
      }
      const value = count > 0 ? sum / count : 0;
      const y = bottom - value * (cohBand - 4);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.lineTo(p.x + p.w, bottom);
    ctx.closePath();
    ctx.fillStyle = 'rgba(157,123,255,0.16)';
    ctx.fill();
    ctx.strokeStyle = COL.coh;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  drawCursor(p, freq) {
    const ctx = this.ctx;
    const x = this.xOf(freq);
    ctx.save();
    ctx.strokeStyle = COL.cursor;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, p.y);
    ctx.lineTo(x, p.y + p.h);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
}


export class ImpulseChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pad = { left: 38, right: 10, top: 10, bottom: 18 };
    this.w = 0;
    this.h = 0;
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(120, rect.width);
    this.h = Math.max(60, rect.height);
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

  draw(res) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, this.w, this.h);
    if (this.w < 40 || this.h < 30) return;

    const p = this.plotRect();
    let peakMs = 0;
    let peak = 0;
    let n = 0;
    let sr = 48000;

    if (res) {
      n = res.fftSize;
      sr = res.sampleRate;
      for (let i = 0; i < n; i++) {
        if (res.irDb[i] > res.irDb[peak]) peak = i;
      }
      const signed = peak > n / 2 ? peak - n : peak;
      peakMs = (signed / sr) * 1000;
    }

    const xMin = peakMs - 5;
    const xMax = peakMs + 55;
    const xOf = (ms) => p.x + ((ms - xMin) / (xMax - xMin)) * p.w;
    const yOf = (db) => p.y + (Math.min(0, Math.max(-80, db)) / -80) * p.h;

    ctx.save();
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1;
    ctx.font = MONO;
    ctx.fillStyle = COL.text;

    for (let db = 0; db >= -80; db -= 20) {
      const y = Math.round(yOf(db)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(p.x, y);
      ctx.lineTo(p.x + p.w, y);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(db + '', p.x - 4, y);
    }

    const span = xMax - xMin;
    const stepMs = span > 90 ? 20 : 10;
    const startTick = Math.ceil(xMin / stepMs) * stepMs;
    for (let ms = startTick; ms <= xMax; ms += stepMs) {
      const x = Math.round(xOf(ms)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, p.y);
      ctx.lineTo(x, p.y + p.h);
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(ms.toFixed(0), x, p.y + p.h + 4);
    }

    if (res) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(p.x, p.y, p.w, p.h);
      ctx.clip();
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const time = ((i > n / 2 ? i - n : i) / sr) * 1000;
        const x = xOf(time);
        const y = yOf(res.irDb[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = COL.trace;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();

      const xp = xOf(peakMs);
      if (xp >= p.x && xp <= p.x + p.w) {
        ctx.strokeStyle = 'rgba(240,180,41,0.45)';
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(xp, p.y);
        ctx.lineTo(xp, p.y + p.h);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = COL.text;
    ctx.fillText('ms', p.x + p.w - 12, p.y + p.h + 4);

    ctx.restore();
  }
}
