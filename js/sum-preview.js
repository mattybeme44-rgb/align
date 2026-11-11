/*
 * What Capture A and Capture B would do together once B is delayed, gained or
 * flipped: a prediction from the stored curves only. Nothing here changes the
 * measurement, the captures, the gate or anything sent to the speaker.
 */

const POINT_COUNT = 240;
const LOWEST_HZ = 20;
const HIGHEST_HZ = 20000;
const SCAN_HIGHEST_HZ = 400;

const BAND_CENTRES = [
  25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200,
  250, 315, 400, 500, 630, 800, 1000, 1250,
  1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000,
];

function traceRate(trace) {
  if (!trace || !(trace.fftSize > 0) || !(trace.sampleRate > 0) || !(trace.bins > 1)) return 0;
  return trace.sampleRate / trace.fftSize;
}

function frequencyAxis(a, b) {
  const dfA = traceRate(a);
  const dfB = traceRate(b);
  if (!(dfA > 0) || !(dfB > 0)) return null;

  const highest = Math.min(HIGHEST_HZ, Math.min(a.sampleRate, b.sampleRate) / 2);
  if (!(highest > LOWEST_HZ * 2)) return null;

  const low = Math.log10(LOWEST_HZ);
  const high = Math.log10(highest);
  const frequencies = new Float64Array(POINT_COUNT);
  for (let i = 0; i < POINT_COUNT; i += 1) {
    frequencies[i] = Math.pow(10, low + (high - low) * (i / (POINT_COUNT - 1)));
  }
  return frequencies;
}

/** One trace resampled onto the shared axis, held as complex values. */
function spectrum(trace, frequencies) {
  const df = traceRate(trace);
  if (!(df > 0)) return null;

  const re = new Float64Array(frequencies.length);
  const im = new Float64Array(frequencies.length);
  const last = trace.bins - 1;

  for (let i = 0; i < frequencies.length; i += 1) {
    const position = frequencies[i] / df;
    const lower = Math.min(last, Math.max(0, Math.floor(position)));
    const upper = Math.min(last, lower + 1);
    const fraction = Math.min(1, Math.max(0, position - lower));

    const mag0 = Number(trace.magDb[lower]);
    const mag1 = Number(trace.magDb[upper]);
    const phase0 = Number(trace.phaseDeg[lower]);
    const phase1 = Number(trace.phaseDeg[upper]);

    const m0 = Number.isFinite(mag0) ? Math.pow(10, mag0 / 20) : 0;
    const m1 = Number.isFinite(mag1) ? Math.pow(10, mag1 / 20) : 0;
    const p0 = Number.isFinite(phase0) ? phase0 * Math.PI / 180 : 0;
    const p1 = Number.isFinite(phase1) ? phase1 * Math.PI / 180 : 0;

    re[i] = m0 * Math.cos(p0) * (1 - fraction) + m1 * Math.cos(p1) * fraction;
    im[i] = m0 * Math.sin(p0) * (1 - fraction) + m1 * Math.sin(p1) * fraction;
  }

  return { re, im };
}

function decibels(re, im) {
  return 20 * Math.log10(Math.max(Math.hypot(re, im), 1e-9));
}

/** Rotate a complex value by a delay at one frequency. */
function rotate(re, im, frequency, delaySeconds) {
  const angle = -2 * Math.PI * frequency * delaySeconds;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return { re: re * cosine - im * sine, im: re * sine + im * cosine };
}

function bandDeltas(axis, a, b, gain, delaySeconds) {
  const bands = [];
  const ratio = Math.pow(2, 1 / 6);
  const lowest = axis[0];
  const highest = axis[axis.length - 1];

  BAND_CENTRES.forEach((centre) => {
    if (centre <= lowest || centre >= highest) return;
    let sumPower = 0;
    let louderPower = 0;
    let count = 0;

    for (let i = 0; i < axis.length; i += 1) {
      const frequency = axis[i];
      if (frequency < centre / ratio || frequency > centre * ratio) continue;
      const rotated = rotate(b.re[i] * gain, b.im[i] * gain, frequency, delaySeconds);
      const sumRe = a.re[i] + rotated.re;
      const sumIm = a.im[i] + rotated.im;
      const aPower = a.re[i] * a.re[i] + a.im[i] * a.im[i];
      const bPower = rotated.re * rotated.re + rotated.im * rotated.im;
      sumPower += sumRe * sumRe + sumIm * sumIm;
      louderPower += Math.max(aPower, bPower);
      count += 1;
    }

    if (!count || sumPower <= 1e-30 || louderPower <= 1e-30) return;
    const delta = 10 * Math.log10(sumPower / louderPower);
    if (Number.isFinite(delta)) bands.push({ centreHz: centre, deltaDb: delta });
  });

  return bands;
}

function frequencyLabel(hz) {
  if (hz >= 1000) {
    const thousands = hz / 1000;
    return (Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)) + ' kHz';
  }
  return hz.toFixed(0) + ' Hz';
}

function summaryText(bands, delayMs) {
  const adds = bands.filter((band) => band.deltaDb > 0.5)
    .sort((left, right) => right.deltaDb - left.deltaDb)[0];
  const cancels = bands.filter((band) => band.deltaDb < -0.5)
    .sort((left, right) => left.deltaDb - right.deltaDb)[0];

  const timing = Math.abs(delayMs) < 0.005
    ? 'With B as it arrived'
    : 'At ' + Math.abs(delayMs).toFixed(2) + ' ms';

  const parts = [];
  parts.push(adds
    ? timing + ' the pair adds about ' + Math.round(adds.deltaDb) + ' dB around ' + frequencyLabel(adds.centreHz)
    : timing + ' the pair adds little');

  if (cancels) {
    const place = cancels.centreHz < 40 ? 'below 40 Hz' : 'around ' + frequencyLabel(cancels.centreHz);
    parts.push(place + ' they cancel about ' + Math.round(-cancels.deltaDb) + ' dB');
  }

  return parts.join('; ') + '.';
}

export function buildSumPreview(traceA, traceB, options = {}) {
  const delayMs = Number(options.delayMs) || 0;
  const levelDb = Number(options.levelDb) || 0;
  const inverted = !!options.inverted;

  const axis = frequencyAxis(traceA, traceB);
  if (!axis) return null;
  const a = spectrum(traceA, axis);
  const b = spectrum(traceB, axis);
  if (!a || !b) return null;

  const gain = Math.pow(10, levelDb / 20) * (inverted ? -1 : 1);
  const delaySeconds = delayMs / 1000;
  const points = [];

  for (let i = 0; i < axis.length; i += 1) {
    const rotated = rotate(b.re[i] * gain, b.im[i] * gain, axis[i], delaySeconds);
    points.push({
      frequency: axis[i],
      aDb: decibels(a.re[i], a.im[i]),
      bDb: decibels(rotated.re, rotated.im),
      sumDb: decibels(a.re[i] + rotated.re, a.im[i] + rotated.im),
    });
  }

  const bands = bandDeltas(axis, a, b, gain, delaySeconds);
  return {
    points,
    bands,
    lowestHz: axis[0],
    highestHz: axis[axis.length - 1],
    summary: summaryText(bands, delayMs),
  };
}

/** Scan the delay for the strongest low-frequency sum. Reads only. */
export function bestOverlap(traceA, traceB, options = {}) {
  const levelDb = Number(options.levelDb) || 0;
  const inverted = !!options.inverted;

  const axis = frequencyAxis(traceA, traceB);
  if (!axis) return null;
  const a = spectrum(traceA, axis);
  const b = spectrum(traceB, axis);
  if (!a || !b) return null;

  const indices = [];
  for (let i = 0; i < axis.length; i += 1) {
    if (axis[i] <= SCAN_HIGHEST_HZ) indices.push(i);
  }
  if (indices.length < 4) return null;

  const gain = Math.pow(10, levelDb / 20) * (inverted ? -1 : 1);

  const powerAt = (delayMs) => {
    const delaySeconds = delayMs / 1000;
    let total = 0;
    indices.forEach((index) => {
      const rotated = rotate(b.re[index] * gain, b.im[index] * gain, axis[index], delaySeconds);
      const sumRe = a.re[index] + rotated.re;
      const sumIm = a.im[index] + rotated.im;
      total += sumRe * sumRe + sumIm * sumIm;
    });
    return total;
  };

  let bestPower = -Infinity;
  let bestDelay = 0;
  const step = 0.05;
  const steps = 800;
  for (let i = 0; i <= steps; i += 1) {
    const delay = -20 + i * step;
    const power = powerAt(delay);
    if (power > bestPower) {
      bestPower = power;
      bestDelay = delay;
    }
  }

  const baseline = powerAt(0);
  if (!(baseline > 1e-30) || !(bestPower > 1e-30)) return null;
  return { delayMs: bestDelay, gainDb: 10 * Math.log10(bestPower / baseline) };
}

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

function prepareCanvas(canvas) {  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 320;
  const height = canvas.clientHeight || 260;
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

function shortFrequency(frequency) {
  return frequency >= 1000
    ? (frequency / 1000).toFixed(0) + 'k'
    : frequency.toFixed(0);
}

export function drawSumChart(canvas, data) {
  if (!canvas) return;
  const { ctx, width, height } = prepareCanvas(canvas);
  if (width < 40 || height < 40) return;

  ctx.clearRect(0, 0, width, height);

  const panel = { x: 0.5, y: 0.5, w: width - 1, h: height - 1 };
  ctx.fillStyle = 'rgba(10, 16, 11, 0.96)';
  ctx.strokeStyle = 'rgba(161, 191, 150, 0.16)';
  ctx.lineWidth = 1;
  roundedRectPath(ctx, panel.x, panel.y, panel.w, panel.h, 14);
  ctx.fill();
  ctx.stroke();

  if (!data || !data.points || data.points.length < 2) {
    ctx.fillStyle = 'rgba(156, 159, 149, 0.9)';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Hold Capture A and Capture B to predict their sum', width / 2, height / 2);
    return;
  }

  const plot = { x: 34, y: 10, w: width - 46, h: height - 32 };
  const low = data.lowestHz;
  const high = data.highestHz;

  let minimum = Infinity;
  let maximum = -Infinity;
  data.points.forEach((point) => {
    [point.aDb, point.bDb, point.sumDb].forEach((value) => {
      if (!Number.isFinite(value)) return;
      if (value < minimum) minimum = value;
      if (value > maximum) maximum = value;
    });
  });
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return;
  const pad = Math.max(6, (maximum - minimum) * 0.1);
  let dbLow = Math.floor((minimum - pad) / 6) * 6;
  let dbHigh = Math.ceil((maximum + pad) / 6) * 6;
  if (dbHigh - dbLow < 40) {
    const mid = (dbHigh + dbLow) / 2;
    dbLow = Math.floor((mid - 20) / 6) * 6;
    dbHigh = Math.ceil((mid + 20) / 6) * 6;
  }

  const xFor = (frequency) => plot.x +
    (Math.log(frequency / low) / Math.log(high / low)) * plot.w;
  const yFor = (db) => plot.y + plot.h - ((db - dbLow) / (dbHigh - dbLow)) * plot.h;

  ctx.font = '9px ui-monospace, monospace';
  ctx.textAlign = 'center';
  [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].forEach((frequency) => {
    if (frequency < low || frequency > high) return;
    const x = xFor(frequency);
    ctx.strokeStyle = 'rgba(161, 191, 150, 0.10)';
    ctx.beginPath();
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.h);
    ctx.stroke();
    ctx.fillStyle = 'rgba(156, 159, 149, 0.8)';
    ctx.fillText(shortFrequency(frequency), Math.min(plot.x + plot.w - 10, Math.max(plot.x + 10, x)),
      plot.y + plot.h + 12);
  });

  ctx.textAlign = 'right';
  for (let db = Math.ceil(dbLow / 12) * 12; db <= dbHigh; db += 12) {
    const y = yFor(db);
    ctx.strokeStyle = db === 0 ? 'rgba(161, 191, 150, 0.26)' : 'rgba(161, 191, 150, 0.08)';
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(156, 159, 149, 0.8)';
    ctx.fillText(db.toFixed(0), plot.x - 4, y + 3);
  }

  const stroke = (key, color, lineWidth, dash) => {
    ctx.beginPath();
    data.points.forEach((point, index) => {
      const x = xFor(point.frequency);
      const y = yFor(point[key]);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
    ctx.setLineDash(dash || []);
    ctx.stroke();
    ctx.setLineDash([]);
  };

  stroke('aDb', 'rgba(226, 235, 214, 0.35)', 1.2, [4, 3]);
  stroke('bDb', 'rgba(143, 199, 250, 0.38)', 1.2, [4, 3]);
  stroke('sumDb', '#c9ff70', 2);

  ctx.fillStyle = 'rgba(156, 159, 149, 0.9)';
  ctx.textAlign = 'left';
  ctx.fillText('dB', plot.x - 30, plot.y + 4);
}
