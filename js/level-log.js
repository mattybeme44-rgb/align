/*
 * The selected input's level over the last two minutes, so drift, music peaks
 * or a noise event can be seen rather than guessed at. Reads the input only.
 */

export const LEVEL_LOG_WINDOW_SECONDS = 120;

function roundedRectPath(ctx, x, y, w, h, radius) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function prepareCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 320;
  const height = canvas.clientHeight || 240;
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

export function drawLevelLog(canvas, samples, options = {}) {
  if (!canvas) return;
  const { ctx, width, height } = prepareCanvas(canvas);
  if (width < 40 || height < 40) return;

  const windowSeconds = Number(options.windowSeconds) || LEVEL_LOG_WINDOW_SECONDS;
  const reference = Number(options.reference) || Date.now();
  const unit = options.unit || 'dBFS';

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(10, 16, 11, 0.96)';
  ctx.strokeStyle = 'rgba(161, 191, 150, 0.16)';
  ctx.lineWidth = 1;
  roundedRectPath(ctx, 0.5, 0.5, width - 1, height - 1, 14);
  ctx.fill();
  ctx.stroke();

  const plot = { x: 36, y: 12, w: width - 50, h: height - 34 };

  if (!samples || !samples.length) {
    ctx.fillStyle = 'rgba(156, 159, 149, 0.9)';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Nothing logged yet', width / 2, height / 2);
    return;
  }

  const values = samples.map((sample) => sample.db);
  const lowValue = Math.min(...values);
  const highValue = Math.max(...values);
  const pad = Math.max(4, (highValue - lowValue) * 0.15);
  const dbLow = Math.floor((lowValue - pad) / 6) * 6;
  const dbHigh = Math.ceil((highValue + pad) / 6) * 6;
  const span = Math.max(6, dbHigh - dbLow);

  const yFor = (db) => plot.y + plot.h - ((db - dbLow) / span) * plot.h;
  const start = reference - windowSeconds * 1000;
  const xFor = (time) => plot.x +
    Math.min(1, Math.max(0, (time - start) / (windowSeconds * 1000))) * plot.w;

  const step = span > 60 ? 24 : span < 24 ? 6 : 12;
  ctx.font = '9px ui-monospace, monospace';
  ctx.textAlign = 'right';
  for (let db = Math.ceil(dbLow / step) * step; db <= dbHigh; db += step) {
    const y = yFor(db);
    ctx.strokeStyle = 'rgba(161, 191, 150, 0.09)';
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(156, 159, 149, 0.8)';
    ctx.fillText(db.toFixed(0), plot.x - 5, y + 3);
  }

  ctx.textAlign = 'center';
  for (let seconds = 0; seconds <= windowSeconds; seconds += 30) {
    const x = plot.x + (seconds / windowSeconds) * plot.w;
    ctx.fillStyle = 'rgba(156, 159, 149, 0.75)';
    ctx.fillText(seconds === 0 ? '−2 min' : '−' + (windowSeconds - seconds) + ' s', x, plot.y + plot.h + 13);
  }

  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  [[minimum, 'rgba(156, 159, 149, 0.5)'], [mean, 'rgba(119, 200, 193, 0.55)'],
    [maximum, 'rgba(217, 162, 108, 0.55)']].forEach(([value, color]) => {
    ctx.beginPath();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.moveTo(plot.x, yFor(value));
    ctx.lineTo(plot.x + plot.w, yFor(value));
    ctx.stroke();
    ctx.setLineDash([]);
  });

  ctx.beginPath();
  samples.forEach((sample, index) => {
    const x = xFor(sample.time);
    const y = yFor(sample.db);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#c9ff70';
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  ctx.stroke();

  ctx.strokeStyle = '#ff8a79';
  ctx.lineWidth = 1.6;
  samples.forEach((sample) => {
    if (!sample.clipped) return;
    const x = xFor(sample.time);
    ctx.beginPath();
    ctx.moveTo(x, plot.y + plot.h);
    ctx.lineTo(x, plot.y + plot.h - 8);
    ctx.stroke();
  });

  ctx.fillStyle = 'rgba(204, 208, 197, 0.9)';
  ctx.textAlign = 'left';
  ctx.fillText(unit, plot.x, plot.y - 2);
}

export function levelLogCsv(samples, unit) {
  const lines = ['time,level,unit,clipped'];
  (samples || []).forEach((sample) => {
    lines.push([
      new Date(sample.time).toISOString(),
      Number(sample.db).toFixed(1),
      unit || 'dBFS',
      sample.clipped ? '1' : '0',
    ].join(','));
  });
  return lines.join('\n') + '\n';
}
