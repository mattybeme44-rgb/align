/*
 * The three pictures the custom speaker builder draws.
 *
 * Every line here comes from the numbers the builder's engine computed: the
 * generated magnitude curve, the angular attenuation of the chosen taper, and
 * the cabinet's own dimensions. Nothing is sketched for decoration, and nothing
 * is presented as a measurement:
 *   - the response chart is the theoretical curve, drawn on the modeler's own
 *     20 Hz – 20 kHz log axis;
 *   - the polar chart is the approximation the widths and taper define, not a
 *     polar measurement;
 *   - the cabinet view is geometry: outline, acoustic centre, coverage angle and
 *     aim. Its size says nothing about how the cabinet behaves acoustically.
 */

export const CURVE_COLOURS = ['#41d9ff', '#f7a94e', '#58e07a', '#f26bd8', '#ff6f5e', '#45e8c2'];

const AXIS = 'rgba(255,255,255,0.10)';
const AXIS_TEXT = '#7a828a';
const TEXT = '#b6bec5';

export function curveColour(index) {
  return CURVE_COLOURS[Math.abs(Number(index) || 0) % CURVE_COLOURS.length];
}

function prepare(canvas, height) {
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  const cssHeight = Math.max(80, Number(height) || 130);
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  // A hidden card reports no client width; falling back to the backing-store
  // width would multiply the canvas on every hidden render, so it is divided
  // back by the pixel ratio first.
  const measured = canvas.clientWidth || (canvas.width ? canvas.width / dpr : 0) || 280;
  const cssWidth = Math.max(180, Math.round(measured));
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.fillStyle = '#0b0f12';
  ctx.fillRect(0, 0, cssWidth, cssHeight);
  ctx.font = '9px -apple-system, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  return { ctx, width: cssWidth, height: cssHeight };
}

function axisText(ctx, text, x, y, align) {
  ctx.fillStyle = AXIS_TEXT;
  ctx.textAlign = align || 'left';
  ctx.fillText(text, x, y);
}

/* ---------- the theoretical response ---------- */

/**
 * `payload`: { curves: [{ label, magDb, colour, dashed }], title, height }.
 * The frequency axis is the modeler's own grid, so the curve lines up with what
 * the workspace will draw once the dataset is used.
 */
export function drawResponseChart(canvas, payload) {
  const drawn = prepare(canvas, payload && payload.height);
  if (!drawn) return;
  const { ctx, width, height } = drawn;
  const curves = ((payload && payload.curves) || []).filter((curve) => curve && curve.magDb);
  const pad = { left: 30, right: 8, top: 12, bottom: 16 };
  const plotWidth = Math.max(10, width - pad.left - pad.right);
  const plotHeight = Math.max(10, height - pad.top - pad.bottom);

  let min = Infinity;
  let max = -Infinity;
  for (const curve of curves) {
    for (let i = 0; i < curve.magDb.length; i += 1) {
      const value = Number(curve.magDb[i]);
      if (!Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    axisText(ctx, 'Nothing to draw yet', pad.left, height / 2);
    return;
  }
  min = Math.floor((min - 4) / 10) * 10;
  max = Math.ceil((max + 4) / 10) * 10;
  if (max - min < 30) max = min + 30;

  const fMin = 20;
  const fMax = 20000;
  const xAt = (frequency) => pad.left + (Math.log(frequency / fMin) / Math.log(fMax / fMin)) * plotWidth;
  const yAt = (db) => pad.top + ((max - db) / (max - min)) * plotHeight;

  ctx.strokeStyle = AXIS;
  ctx.lineWidth = 1;
  const decades = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  for (const frequency of decades) {
    const x = xAt(frequency);
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + plotHeight);
    ctx.stroke();
  }
  ctx.textAlign = 'center';
  for (const [frequency, label] of [[100, '100'], [1000, '1k'], [10000, '10k']]) {
    axisText(ctx, label, xAt(frequency), height - 7, 'center');
  }
  // The tick step follows the range, so a narrow window is not buried in
  // numbers and a wide one still has a grid to read against.
  const span = max - min;
  const step = span <= 40 ? 5 : span <= 80 ? 10 : 20;
  for (let db = Math.ceil(min / step) * step; db <= max; db += step) {
    const y = yAt(db);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotWidth, y);
    ctx.stroke();
    axisText(ctx, String(Math.round(db)), pad.left - 4, y, 'right');
  }

  for (const curve of curves) {
    ctx.strokeStyle = curve.colour || curveColour(0);
    ctx.lineWidth = curve.dashed ? 1 : 1.4;
    ctx.setLineDash(curve.dashed ? [4, 3] : []);
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < curve.magDb.length; i += 1) {
      const value = Number(curve.magDb[i]);
      if (!Number.isFinite(value)) {
        started = false;
        continue;
      }
      const frequency = fMin * Math.pow(fMax / fMin, i / Math.max(1, curve.magDb.length - 1));
      const x = xAt(frequency);
      const y = yAt(value);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // A compact legend at the bottom right, where the curve normally is not. The
  // label is right-aligned and the swatch placed before it, so a long name
  // cannot run off the canvas.
  let legendY = height - pad.bottom - 12 - Math.min(3, Math.max(0, curves.length - 1)) * 11;
  const right = width - pad.right;
  ctx.textAlign = 'right';
  for (const curve of curves.slice(0, 4)) {
    const label = String(curve.label || '').slice(0, 22);
    ctx.fillStyle = TEXT;
    ctx.fillText(label, right, legendY);
    const labelWidth = ctx.measureText(label).width;
    ctx.fillStyle = curve.colour || curveColour(0);
    ctx.fillRect(Math.max(pad.left, right - labelWidth - 13), legendY - 1, 10, 2);
    legendY += 11;
  }
  axisText(ctx, 'dB SPL at 1 m', pad.left, pad.top + 5);
}

/* ---------- the directivity approximation ---------- */

function polarPoint(cx, cy, radius, angleDeg, scale) {
  const angle = (angleDeg * Math.PI) / 180;
  return { x: cx + radius * Math.sin(angle), y: cy - radius * Math.cos(angle) };
}

/** The dB a cut costs at an angle, from the engine's own profile arithmetic. */
function cutDb(angle, halfWidth, profile, referenceDb) {
  const width = Number(halfWidth) * 2;
  if (!(width > 0)) return 0;
  const ratio = (2 * Math.abs(angle)) / width;
  const reference = Math.abs(Number(referenceDb) > 0 ? Number(referenceDb) : 6);
  let shape;
  if (profile === 'cosine') shape = 1 - Math.cos((Math.PI * Math.min(ratio, 2)) / 2);
  else if (profile === 'steep') shape = ratio * ratio * ratio * ratio;
  else shape = ratio * ratio;
  return Math.max(-40, -reference * shape);
}

/**
 * `payload`: { hDeg, vDeg, profile, referenceDb, height }.
 * The horizontal cut is drawn left–right and the vertical cut up–down, on a
 * 0 dB to −30 dB radial scale. It is the approximation the entered coverage and
 * taper define, labelled as such on the card.
 */
export function drawPolarChart(canvas, payload) {
  const drawn = prepare(canvas, payload && payload.height);
  if (!drawn) return;
  const { ctx, width, height } = drawn;
  const cx = width / 2;
  const cy = height / 2 + 2;
  const radius = Math.max(20, Math.min(width, height) / 2 - 20);
  const floorDb = 30;
  const radial = (db) => radius * (1 - Math.max(0, -Number(db)) / floorDb);

  ctx.strokeStyle = AXIS;
  ctx.lineWidth = 1;
  for (const db of [0, -6, -12, -18, -24, -30]) {
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, radial(db)), 0, Math.PI * 2);
    ctx.stroke();
  }
  for (let angle = 0; angle < 180; angle += 30) {
    const a = polarPoint(cx, cy, radius, angle, 1);
    const b = polarPoint(cx, cy, radius, angle + 180, 1);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    axisText(ctx, String(angle) + '°', a.x, a.y - 6, 'center');
  }
  // The ring scale is stated once, out of the way, rather than as a label on a
  // ring where it would collide with the degree numbers.
  axisText(ctx, '0 to −30 dB · 6 dB rings', 6, height - 7);

  const hWidth = Number(payload && payload.hDeg);
  const vWidth = Number(payload && payload.vDeg);
  if (!(hWidth > 0) || !(vWidth > 0)) {
    axisText(ctx, 'omni — no directivity claimed', cx, cy + radius + 8, 'center');
    return;
  }
  const profile = payload && payload.profile;
  const reference = payload && payload.referenceDb;

  /**
   * One cut through the pattern: the horizontal cut runs left–right and the
   * vertical cut top–bottom on the same cardioid-style plot. Both are drawn from
   * the engine's own attenuation, so the picture and the prediction agree.
   */
  const drawCut = (halfWidth, kind, colour) => {
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let step = -90; step <= 90; step += 1) {
      const db = cutDb(step, halfWidth, profile, reference);
      const r = Math.max(1, radial(db));
      const angle = (step * Math.PI) / 180;
      const x = kind === 'h' ? cx + r * Math.sin(angle) : cx;
      const y = kind === 'h' ? cy : cy + r * Math.sin(angle);
      if (step === -90) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  drawCut(hWidth / 2, 'h', CURVE_COLOURS[0]);
  drawCut(vWidth / 2, 'v', CURVE_COLOURS[1]);

  ctx.textAlign = 'left';
  ctx.fillStyle = CURVE_COLOURS[0];
  ctx.fillRect(6, 8, 10, 2);
  ctx.fillStyle = TEXT;
  ctx.fillText('H ' + Math.round(hWidth) + '°', 20, 9);
  ctx.fillStyle = CURVE_COLOURS[1];
  ctx.fillRect(6, 20, 10, 2);
  ctx.fillStyle = TEXT;
  ctx.fillText('V ' + Math.round(vWidth) + '°', 20, 21);
  axisText(ctx, 'approximation', width - 6, height - 7, 'right');
}

/* ---------- the cabinet ---------- */

/** The isometric projection used by the cabinet view. */
function projector(widthM, heightM, depthM) {
  const cos30 = Math.cos(Math.PI / 6);
  const sin30 = 0.5;
  const project = (x, y, z) => ({
    x: (x - z) * cos30,
    y: (x + z) * sin30 - (y - heightM / 2),
  });
  const corners = [];
  const index = {};
  for (const xi of [0, 1]) {
    for (const yi of [0, 1]) {
      for (const zi of [0, 1]) {
        const x = (xi - 0.5) * widthM;
        const y = yi * heightM;
        const z = zi * depthM;
        index[xi + '' + yi + '' + zi] = corners.length;
        corners.push({ x, y, z, point: project(x, y, z) });
      }
    }
  }
  return { project, corners, index };
}

function cabinetEdges(index) {
  const edges = [];
  for (const xi of [0, 1]) {
    for (const yi of [0, 1]) {
      for (const zi of [0, 1]) {
        if (xi === 0) edges.push([index['0' + yi + zi], index['1' + yi + zi]]);
        if (yi === 0) edges.push([index[xi + '0' + zi], index[xi + '1' + zi]]);
        // The string is built explicitly: `xi + yi + '0'` would add the two
        // numbers first and look up "00" instead of "000".
        if (zi === 0) edges.push([index[String(xi) + String(yi) + '0'], index[String(xi) + String(yi) + '1']]);
      }
    }
  }
  return edges;
}

/**
 * `payload`: { widthM, heightM, depthM, colour, hDeg, vDeg, acousticCenter,
 * aimH, aimV, height }. The cabinet is drawn from its entered dimensions; the
 * coverage cone is the same angle the builder predicts with.
 */
export function drawCabinetChart(canvas, payload) {
  const drawn = prepare(canvas, payload && payload.height);
  if (!drawn) return;
  const { ctx, width, height } = drawn;
  const widthM = Math.max(0.05, Number(payload && payload.widthM) || 0.5);
  const heightM = Math.max(0.05, Number(payload && payload.heightM) || 0.7);
  const depthM = Math.max(0.05, Number(payload && payload.depthM) || 0.4);
  const colour = (payload && payload.colour) || '#3a4652';
  const aimH = Number(payload && payload.aimH) || 0;
  const aimV = Number(payload && payload.aimV) || 0;
  const hDeg = Number(payload && payload.hDeg) || 0;
  const vDeg = Number(payload && payload.vDeg) || 0;
  const centreOffset = (payload && payload.acousticCenter) || null;

  const box = projector(widthM, heightM, depthM);
  const edges = cabinetEdges(box.index);

  // A cone length long enough to read, in cabinet units, then everything is
  // projected and fitted to the canvas.
  const reach = Math.max(heightM, depthM, 1) * 1.4;
  const acoustic = {
    x: centreOffset ? Number(centreOffset.xM) || 0 : 0,
    y: heightM / 2 + (centreOffset ? Number(centreOffset.yM) || 0 : 0),
    z: depthM - (centreOffset ? Number(centreOffset.zM) || 0 : 0),
  };
  const direction = (thetaH, thetaV) => {
    const h = (thetaH * Math.PI) / 180;
    const v = (thetaV * Math.PI) / 180;
    return {
      x: Math.sin(h) * Math.cos(v),
      y: Math.sin(v),
      z: Math.cos(h) * Math.cos(v),
    };
  };
  const ray = (thetaH, thetaV) => {
    const dir = direction(thetaH, thetaV);
    return box.project(acoustic.x + dir.x * reach, acoustic.y + dir.y * reach, acoustic.z + dir.z * reach);
  };
  const centre = box.project(acoustic.x, acoustic.y, acoustic.z);
  const rays = {
    left: ray(aimH - hDeg / 2, aimV),
    right: ray(aimH + hDeg / 2, aimV),
    up: ray(aimH, aimV + vDeg / 2),
    down: ray(aimH, aimV - vDeg / 2),
    axis: ray(aimH, aimV),
  };

  const points = box.corners.map((corner) => corner.point)
    .concat([centre, rays.left, rays.right, rays.up, rays.down, rays.axis]);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const scale = Math.min((width - 34) / spanX, (height - 30) / spanY);
  const offsetX = (width - spanX * scale) / 2 - minX * scale;
  const offsetY = (height - spanY * scale) / 2 - minY * scale;
  const toScreen = (point) => ({ x: point.x * scale + offsetX, y: point.y * scale + offsetY });

  const screen = box.corners.map((corner) => toScreen(corner.point));

  // The front face (the baffle) is at z = depth; fill it first.
  const front = [
    box.index['001'], box.index['101'], box.index['111'], box.index['011'],
  ].map((i) => screen[i]);
  ctx.beginPath();
  ctx.moveTo(front[0].x, front[0].y);
  for (const point of front.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.closePath();
  ctx.fillStyle = colour;
  ctx.globalAlpha = 0.35;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  for (const [a, b] of edges) {
    ctx.beginPath();
    ctx.moveTo(screen[a].x, screen[a].y);
    ctx.lineTo(screen[b].x, screen[b].y);
    ctx.stroke();
  }

  const centreScreen = toScreen(centre);
  const drawRay = (endpoint, colourValue, dashed) => {
    const target = toScreen(endpoint);
    ctx.strokeStyle = colourValue;
    ctx.lineWidth = 1;
    ctx.setLineDash(dashed ? [3, 3] : []);
    ctx.beginPath();
    ctx.moveTo(centreScreen.x, centreScreen.y);
    ctx.lineTo(target.x, target.y);
    ctx.stroke();
    ctx.setLineDash([]);
  };

  if (hDeg > 0) {
    ctx.fillStyle = 'rgba(65,217,255,0.14)';
    ctx.beginPath();
    ctx.moveTo(centreScreen.x, centreScreen.y);
    const left = toScreen(rays.left);
    const right = toScreen(rays.right);
    ctx.lineTo(left.x, left.y);
    ctx.lineTo(right.x, right.y);
    ctx.closePath();
    ctx.fill();
    drawRay(rays.left, CURVE_COLOURS[0], false);
    drawRay(rays.right, CURVE_COLOURS[0], false);
  }
  if (vDeg > 0) {
    drawRay(rays.up, CURVE_COLOURS[1], true);
    drawRay(rays.down, CURVE_COLOURS[1], true);
  }
  drawRay(rays.axis, 'rgba(255,255,255,0.45)', true);

  ctx.fillStyle = '#eceef0';
  ctx.beginPath();
  ctx.arc(centreScreen.x, centreScreen.y, 2.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#eceef0';
  ctx.beginPath();
  ctx.moveTo(centreScreen.x - 6, centreScreen.y);
  ctx.lineTo(centreScreen.x + 6, centreScreen.y);
  ctx.moveTo(centreScreen.x, centreScreen.y - 6);
  ctx.lineTo(centreScreen.x, centreScreen.y + 6);
  ctx.stroke();

  axisText(ctx, 'front', width - 6, height - 8, 'right');
  axisText(ctx, (centreOffset ? 'acoustic centre' : 'centre · offset unknown'), 6, height - 8);
  axisText(ctx, 'aim ' + Math.round(aimH) + '° H / ' + Math.round(aimV) + '° V', 6, 10);
}
