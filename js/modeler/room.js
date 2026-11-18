/*
 * Room geometry for the Room Designer.
 *
 * One geometry, three views: the plan, the section and the 3D drawing all read
 * the same outline, the same floor heights and the same ceiling function, so
 * they cannot disagree with each other.
 *
 * Everything is stored in metres, whatever unit the screen is set to. The
 * imperial display is a conversion at the edge, never a second set of numbers
 * in the project.
 *
 * Coordinates, used by every other module:
 *   x — across the room, 0 at the left wall as the audience sees it, +x right
 *   y — along the room, 0 at the stage wall, +y towards the rear
 *   z — height above the floor at that point
 *
 * Nothing in this file predicts sound. It says where the surfaces are.
 */

export const FEET_PER_METRE = 3.280839895013123;
export const SQUARE_FEET_PER_SQUARE_METRE = FEET_PER_METRE * FEET_PER_METRE;

export const UNITS = [
  { id: 'metric', label: 'Metres', suffix: 'm' },
  { id: 'imperial', label: 'Feet', suffix: 'ft' },
];

export const SHAPES = [
  { id: 'rect', label: 'Rectangular' },
  { id: 'l', label: 'L-shaped' },
  { id: 'custom', label: 'Custom polygon' },
];

export const CEILING_TYPES = [
  { id: 'flat', label: 'Flat' },
  { id: 'sloped', label: 'Sloped (front to rear)' },
  { id: 'aframe', label: 'A-frame' },
];

/** What a placed cabinet is doing in the system. */
export const SOURCE_ROLES = [
  { id: 'sub', label: 'Subwoofer' },
  { id: 'main', label: 'Main left / right' },
  { id: 'centre', label: 'Centre' },
  { id: 'frontfill', label: 'Front fill' },
  { id: 'sidefill', label: 'Side fill' },
  { id: 'mids', label: 'Mid-room delay' },
  { id: 'rear', label: 'Rear delay' },
  { id: 'custom', label: 'Custom' },
];

export function roleLabel(id) {
  const found = SOURCE_ROLES.find((entry) => entry.id === id);
  return found ? found.label : 'Custom';
}

function num(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, low, high, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(high, Math.max(low, number));
}

function text(value, limit) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, limit);
}

function makeId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(16).slice(2, 6);
}

/* ---------- units ---------- */

export function unitSuffix(units) {
  return units === 'imperial' ? 'ft' : 'm';
}

export function metresToDisplay(metres, units) {
  const value = num(metres, 0);
  return units === 'imperial' ? value * FEET_PER_METRE : value;
}

export function displayToMetres(value, units) {
  const number = num(value, 0);
  return units === 'imperial' ? number / FEET_PER_METRE : number;
}

/** A length as the screen shows it, with its unit. */
export function formatLength(metres, units, digits) {
  const value = metresToDisplay(metres, units);
  const places = Number.isFinite(digits) ? digits : (Math.abs(value) >= 10 ? 1 : 2);
  return value.toFixed(places) + ' ' + unitSuffix(units);
}

export function formatArea(squareMetres, units) {
  const value = units === 'imperial'
    ? num(squareMetres, 0) * SQUARE_FEET_PER_SQUARE_METRE
    : num(squareMetres, 0);
  return (value >= 100 ? value.toFixed(0) : value.toFixed(1)) + ' ' +
    (units === 'imperial' ? 'ft²' : 'm²');
}

export function formatVolume(cubicMetres, units) {
  const value = units === 'imperial'
    ? num(cubicMetres, 0) * FEET_PER_METRE * FEET_PER_METRE * FEET_PER_METRE
    : num(cubicMetres, 0);
  return (value >= 1000 ? value.toFixed(0) : value.toFixed(1)) + ' ' +
    (units === 'imperial' ? 'ft³' : 'm³');
}

/* ---------- the shape ---------- */

function point(raw) {
  if (!raw) return null;
  const x = Number(raw.x !== undefined ? raw.x : raw[0]);
  const y = Number(raw.y !== undefined ? raw.y : raw[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
}

function normalizePoints(list, limit = 48) {
  const points = [];
  for (const entry of Array.isArray(list) ? list.slice(0, limit) : []) {
    const built = point(entry);
    if (!built) continue;
    const previous = points[points.length - 1];
    if (previous && Math.abs(previous.x - built.x) < 0.001 &&
      Math.abs(previous.y - built.y) < 0.001) continue;
    points.push(built);
  }
  if (points.length >= 3) {
    const first = points[0];
    const last = points[points.length - 1];
    if (Math.abs(first.x - last.x) < 0.001 && Math.abs(first.y - last.y) < 0.001) points.pop();
  }
  return points;
}

/**
 * The plan outline for a shape. A rectangular or L-shaped room is defined by
 * its dimensions, so editing a dimension regenerates the polygon; a custom room
 * keeps the polygon that was drawn or typed.
 */
export function generateOutline(room) {
  const width = clamp(room.size.widthM, 1, 400, 12);
  const length = clamp(room.size.lengthM, 1, 600, 30);
  if (room.shape === 'l') {
    const notchWidth = clamp(room.size.notchWidthM, 0, width * 0.95, width * 0.4);
    const notchLength = clamp(room.size.notchLengthM, 0, length * 0.95, length * 0.35);
    return [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: length - notchLength },
      { x: width - notchWidth, y: length - notchLength },
      { x: width - notchWidth, y: length },
      { x: 0, y: length },
    ];
  }
  if (room.shape === 'custom') {
    const drawn = normalizePoints(room.outline);
    return drawn.length >= 3 ? drawn : [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: length },
      { x: 0, y: length },
    ];
  }
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: length },
    { x: 0, y: length },
  ];
}

/* ---------- areas, stages, obstacles ---------- */

function normalizeRect(raw, defaults) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const base = defaults || {};
  let x0 = num(source.x0, num(base.x0, 0));
  let x1 = num(source.x1, num(base.x1, 1));
  let y0 = num(source.y0, num(base.y0, 0));
  let y1 = num(source.y1, num(base.y1, 1));
  if (x1 < x0) { const swap = x0; x0 = x1; x1 = swap; }
  if (y1 < y0) { const swap = y0; y0 = y1; y1 = swap; }
  return {
    x0: clamp(x0, -200, 400, 0),
    x1: clamp(x1, -200, 400, 1),
    y0: clamp(y0, -200, 600, 0),
    y1: clamp(y1, -200, 600, 1),
  };
}

function normalizeStage(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    id: text(source.id, 60) || makeId('st-'),
    name: text(source.name, 40) || 'Stage',
    ...normalizeRect(source),
    heightM: clamp(source.heightM, 0, 12, 0.6),
  };
}

function normalizePlatform(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    id: text(source.id, 60) || makeId('pl-'),
    name: text(source.name, 40) || 'Platform',
    ...normalizeRect(source),
    heightM: clamp(source.heightM, 0, 20, 1),
  };
}

function normalizeAudience(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    id: text(source.id, 60) || makeId('au-'),
    name: text(source.name, 40) || 'Audience',
    ...normalizeRect(source),
    earHeightM: clamp(source.earHeightM, 0.3, 3, 1.2),
    raked: source.raked === true,
    risePerMetre: clamp(source.risePerMetre, 0, 0.5, 0),
  };
}

function normalizeObstacle(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    id: text(source.id, 60) || makeId('ob-'),
    name: text(source.name, 40) || 'Obstacle',
    kind: ['column', 'wall', 'truss', 'structure'].includes(source.kind) ? source.kind : 'column',
    ...normalizeRect(source),
    heightM: clamp(source.heightM, 0, 40, 3),
    baseM: clamp(source.baseM, 0, 20, 0),
  };
}

function normalizeMic(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    id: text(source.id, 60) || makeId('mic-'),
    name: text(source.name, 40) || 'Mic',
    x: clamp(source.x, -50, 400, 0),
    y: clamp(source.y, -50, 600, 0),
    z: clamp(source.z, 0, 60, 1.2),
    captureId: text(source.captureId, 80),
    captureName: text(source.captureName, 80),
    note: text(source.note, 200),
  };
}

/* ---------- the room ---------- */

export function emptySettings() {
  return {
    bandMode: 'third',
    frequencyHz: 1000,
    metric: 'level',
    resolution: 56,
    showHeatmap: true,
    earHeightM: 1.2,
    speedOfSound: 343,
    levelMode: 'relative',
    levelOffsetDb: 0,
    normalizeTo: 'reference',
    uniformityDb: 3,
    snapM: 0.1,
    leftGroupId: '',
    rightGroupId: '',
    refMicId: '',
    view: 'plan',
  };
}

export function emptyRoom(name) {
  return {
    id: makeId('room-'),
    name: text(name, 80) || 'New room',
    units: 'metric',
    shape: 'rect',
    size: { widthM: 12, lengthM: 24, notchWidthM: 5, notchLengthM: 8 },
    wallHeightM: 6,
    riseM: 3,
    ridgeX: 6,
    ceiling: 'flat',
    outline: [
      { x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 24 }, { x: 0, y: 24 },
    ],
    stages: [],
    platforms: [],
    audience: [
      { id: 'au-main', name: 'Audience', x0: 0.5, y0: 3, x1: 11.5, y1: 22, earHeightM: 1.2, raked: false, risePerMetre: 0 },
    ],
    obstacles: [],
    mics: [],
    settings: emptySettings(),
    subArray: {
      preset: 'broadside',
      count: 8,
      spacingM: 1.2,
      frequencyHz: 80,
      gainDb: 0,
      polarity: 'normal',
      groupId: '',
    },
    notes: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeRoom(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const base = emptyRoom(source.name);
  const room = {
    ...base,
    id: text(source.id, 60) || base.id,
    name: text(source.name, 80) || base.name,
    units: source.units === 'imperial' ? 'imperial' : 'metric',
    shape: SHAPES.some((entry) => entry.id === source.shape) ? source.shape : 'rect',
    ceiling: CEILING_TYPES.some((entry) => entry.id === source.ceiling) ? source.ceiling : 'flat',
    size: {
      widthM: clamp(source.size && source.size.widthM, 1, 400, 12),
      lengthM: clamp(source.size && source.size.lengthM, 1, 600, 24),
      notchWidthM: clamp(source.size && source.size.notchWidthM, 0, 400, 5),
      notchLengthM: clamp(source.size && source.size.notchLengthM, 0, 600, 8),
    },
    wallHeightM: clamp(source.wallHeightM, 1, 60, 6),
    riseM: clamp(source.riseM, 0, 60, 3),
    ridgeX: clamp(source.ridgeX, 0, 400, 6),
    // A custom plan keeps the polygon it was drawn with; the other shapes are
    // regenerated from their dimensions below.
    outline: Array.isArray(source.outline) && source.outline.length >= 3
      ? source.outline
      : base.outline,
    stages: (Array.isArray(source.stages) ? source.stages : []).map(normalizeStage).slice(0, 12),
    platforms: (Array.isArray(source.platforms) ? source.platforms : []).map(normalizePlatform).slice(0, 12),
    audience: (Array.isArray(source.audience) ? source.audience : []).map(normalizeAudience).slice(0, 12),
    obstacles: (Array.isArray(source.obstacles) ? source.obstacles : []).map(normalizeObstacle).slice(0, 24),
    mics: (Array.isArray(source.mics) ? source.mics : []).map(normalizeMic).slice(0, 24),
    settings: { ...emptySettings(), ...(source.settings && typeof source.settings === 'object' ? source.settings : {}) },
    subArray: {
      ...base.subArray,
      ...(source.subArray && typeof source.subArray === 'object' ? source.subArray : {}),
    },
    notes: text(source.notes, 400),
    createdAt: text(source.createdAt, 40) || base.createdAt,
    updatedAt: text(source.updatedAt, 40) || base.updatedAt,
  };
  room.settings.resolution = clamp(room.settings.resolution, 16, 128, 56);
  room.settings.frequencyHz = clamp(room.settings.frequencyHz, 20, 20000, 1000);
  room.settings.earHeightM = clamp(room.settings.earHeightM, 0.3, 3, 1.2);
  room.settings.speedOfSound = clamp(room.settings.speedOfSound, 200, 500, 343);
  room.settings.levelOffsetDb = clamp(room.settings.levelOffsetDb, -60, 60, 0);
  room.settings.uniformityDb = clamp(room.settings.uniformityDb, 0.5, 12, 3);
  room.settings.snapM = clamp(room.settings.snapM, 0, 5, 0.1);
  room.settings.levelMode = room.settings.levelMode === 'absolute' ? 'absolute' : 'relative';
  room.settings.normalizeTo = room.settings.normalizeTo === 'max' ? 'max' : 'reference';
  room.outline = generateOutline(room);
  return room;
}

/* ---------- geometry ---------- */

export function outlineBounds(points) {
  const list = Array.isArray(points) && points.length ? points : [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const entry of list) {
    if (entry.x < minX) minX = entry.x;
    if (entry.x > maxX) maxX = entry.x;
    if (entry.y < minY) minY = entry.y;
    if (entry.y > maxY) maxY = entry.y;
  }
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

/** Shoelace area of a planar polygon, always positive. */
export function polygonArea(points) {
  const list = Array.isArray(points) ? points : [];
  if (list.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    const b = list[(i + 1) % list.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** Ray casting: is the point inside the polygon? */
export function pointInPolygon(points, x, y) {
  const list = Array.isArray(points) ? points : [];
  if (list.length < 3) return false;
  let inside = false;
  for (let i = 0, j = list.length - 1; i < list.length; j = i, i += 1) {
    const xi = list[i].x;
    const yi = list[i].y;
    const xj = list[j].x;
    const yj = list[j].y;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function pointInRect(rect, x, y) {
  if (!rect) return false;
  return x >= Math.min(rect.x0, rect.x1) && x <= Math.max(rect.x0, rect.x1) &&
    y >= Math.min(rect.y0, rect.y1) && y <= Math.max(rect.y0, rect.y1);
}

export function insideRoom(room, x, y) {
  return pointInPolygon(room.outline, x, y);
}

/** The ceiling height above the floor at a point. */
export function ceilingHeightAt(room, x, y) {
  const wall = num(room.wallHeightM, 6);
  const rise = num(room.riseM, 0);
  if (room.ceiling === 'sloped') {
    const bounds = outlineBounds(room.outline);
    const span = Math.max(1e-6, bounds.maxY - bounds.minY);
    const t = Math.min(1, Math.max(0, (y - bounds.minY) / span));
    return wall + rise * t;
  }
  if (room.ceiling === 'aframe') {
    const bounds = outlineBounds(room.outline);
    const ridge = num(room.ridgeX, (bounds.minX + bounds.maxX) / 2);
    const reach = Math.max(1e-6, Math.max(ridge - bounds.minX, bounds.maxX - ridge));
    const t = Math.max(0, 1 - Math.abs(x - ridge) / reach);
    return wall + rise * t;
  }
  return wall;
}

/** How far the floor is raised at a point: a stage or a speaker platform. */
export function floorHeightAt(room, x, y) {
  let height = 0;
  for (const stage of room.stages || []) {
    if (pointInRect(stage, x, y)) height = Math.max(height, num(stage.heightM, 0));
  }
  for (const platform of room.platforms || []) {
    if (pointInRect(platform, x, y)) height = Math.max(height, num(platform.heightM, 0));
  }
  return height;
}

/** The listening height above the floor at a point: raked seating included. */
export function earHeightAt(room, x, y) {
  let ear = num(room.settings && room.settings.earHeightM, 1.2);
  for (const area of room.audience || []) {
    if (!pointInRect(area, x, y)) continue;
    ear = Math.max(0.3, num(area.earHeightM, ear));
    if (area.raked && Number(area.risePerMetre) > 0) {
      const from = Math.min(area.y0, area.y1);
      ear += Math.max(0, y - from) * Number(area.risePerMetre);
    }
  }
  return ear;
}

/** A receiver's full height: floor, stage and ear height, kept under the ceiling. */
export function listenerZ(room, x, y) {
  const ceiling = ceilingHeightAt(room, x, y);
  const z = floorHeightAt(room, x, y) + earHeightAt(room, x, y);
  return Math.max(0.1, Math.min(ceiling - 0.1 > 0 ? ceiling - 0.1 : z, z));
}

export function roomMetrics(room) {
  const bounds = outlineBounds(room.outline);
  const area = polygonArea(room.outline);
  // The volume is a geometric estimate: the plan area times the mean of the
  // ceiling sampled on a coarse grid. It is never presented as a measured room
  // volume and no reverberation time is derived from it.
  const steps = 24;
  let ceilingSum = 0;
  let count = 0;
  let minCeiling = Infinity;
  let maxCeiling = -Infinity;
  for (let i = 0; i <= steps; i += 1) {
    for (let j = 0; j <= steps; j += 1) {
      const x = bounds.minX + (bounds.width * i) / steps;
      const y = bounds.minY + (bounds.height * j) / steps;
      if (!pointInPolygon(room.outline, x, y)) continue;
      const h = ceilingHeightAt(room, x, y);
      ceilingSum += h;
      count += 1;
      if (h < minCeiling) minCeiling = h;
      if (h > maxCeiling) maxCeiling = h;
    }
  }
  const meanCeiling = count ? ceilingSum / count : room.wallHeightM;
  return {
    area,
    bounds,
    meanCeilingM: meanCeiling,
    minCeilingM: Number.isFinite(minCeiling) ? minCeiling : room.wallHeightM,
    maxCeilingM: Number.isFinite(maxCeiling) ? maxCeiling : room.wallHeightM,
    volumeM3: area * meanCeiling,
    audienceArea: (room.audience || []).reduce((total, entry) =>
      total + polygonArea([
        { x: entry.x0, y: entry.y0 },
        { x: entry.x1, y: entry.y0 },
        { x: entry.x1, y: entry.y1 },
        { x: entry.x0, y: entry.y1 },
      ]), 0),
  };
}

/** The rectangle the heat map is computed over: the audience if there is one. */
export function heatBounds(room) {
  const areas = (room.audience || []).filter((entry) => entry.x1 > entry.x0 && entry.y1 > entry.y0);
  if (!areas.length) {
    const bounds = outlineBounds(room.outline);
    return { minX: bounds.minX, maxX: bounds.maxX, minY: bounds.minY, maxY: bounds.maxY };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const area of areas) {
    minX = Math.min(minX, area.x0, area.x1);
    maxX = Math.max(maxX, area.x0, area.x1);
    minY = Math.min(minY, area.y0, area.y1);
    maxY = Math.max(maxY, area.y0, area.y1);
  }
  return { minX, maxX, minY, maxY };
}

/** Is this point inside an audience area (or the room when there is none)? */
export function insideAudience(room, x, y) {
  const areas = room.audience || [];
  if (!areas.length) return pointInPolygon(room.outline, x, y);
  return areas.some((area) => pointInRect(area, x, y));
}

/* ---------- templates ---------- */

function rectRoom(name, widthM, lengthM, wallM) {
  const room = emptyRoom(name);
  room.size.widthM = widthM;
  room.size.lengthM = lengthM;
  room.wallHeightM = wallM;
  room.audience = [{
    id: makeId('au-'), name: 'Audience',
    x0: Math.max(0.5, widthM * 0.06), y0: Math.min(lengthM * 0.2, lengthM - 2),
    x1: widthM - Math.max(0.5, widthM * 0.06), y1: lengthM - Math.max(0.5, lengthM * 0.06),
    earHeightM: 1.2, raked: false, risePerMetre: 0,
  }];
  room.settings.earHeightM = 1.2;
  room.outline = generateOutline(room);
  return room;
}

/**
 * The Pioneer warehouse example: 41 ft wide, 110 ft long, an A-frame roof with
 * its peak at about 40 ft and the front side walls at about 17 ft.
 *
 * Those dimensions are converted to metres once, here, so every calculation is
 * in one system. The drawing is a starting layout only: no manufacturer
 * acoustic data is attached to it, and the loudspeaker positions are a template
 * the operator moves.
 */
export const WAREHOUSE_DIMENSIONS = {
  widthFt: 41,
  lengthFt: 110,
  peakFt: 40,
  eaveFt: 17,
};

export function warehouseRoom(units) {
  const width = WAREHOUSE_DIMENSIONS.widthFt / FEET_PER_METRE;
  const length = WAREHOUSE_DIMENSIONS.lengthFt / FEET_PER_METRE;
  const eave = WAREHOUSE_DIMENSIONS.eaveFt / FEET_PER_METRE;
  const peak = WAREHOUSE_DIMENSIONS.peakFt / FEET_PER_METRE;
  const room = emptyRoom('Pioneer warehouse example');
  room.units = units === 'imperial' ? 'imperial' : 'metric';
  room.shapes = 'rect';
  room.shape = 'rect';
  room.size.widthM = width;
  room.size.lengthM = length;
  room.wallHeightM = eave;
  room.ceiling = 'aframe';
  room.riseM = peak - eave;
  room.ridgeX = width / 2;
  room.stages = [{
    id: makeId('st-'), name: 'Stage', heightM: 1.2,
    x0: width * 0.1, x1: width * 0.9, y0: 0.6, y1: 5.5,
  }];
  room.audience = [{
    id: makeId('au-'), name: 'Audience floor',
    x0: width * 0.04, y0: 6.5, x1: width * 0.96, y1: length - 2,
    earHeightM: 1.2, raked: false, risePerMetre: 0,
  }];
  room.mics = [
    { id: makeId('mic-'), name: 'Front centre', x: width / 2, y: length * 0.25, z: 1.2 + 1.2, captureId: '', captureName: '', note: '' },
    { id: makeId('mic-'), name: 'Middle', x: width / 2, y: length * 0.5, z: 1.2, captureId: '', captureName: '', note: '' },
    { id: makeId('mic-'), name: 'Rear', x: width / 2, y: length * 0.85, z: 1.2, captureId: '', captureName: '', note: '' },
  ];
  room.settings.refMicId = room.mics[1].id;
  room.settings.frequencyHz = 100;
  room.outline = generateOutline(room);
  return room;
}

/**
 * The cabinets the warehouse example places. The numbering is the one the
 * operator uses: 1 and 2 far right, 3 and 4 centre right, 5 and 6 centre left,
 * 7 and 8 far left. "Right" is the audience's right looking at the stage, which
 * is +x here.
 *
 * No directivity, sensitivity or measured response is invented: each entry is a
 * position and a name only, and the acoustic data arrives later by import or
 * measurement.
 */
export function warehouseSources(room) {
  const width = room.size.widthM;
  const length = room.size.lengthM;
  const stageY = 3.2;
  const entries = [];

  const pairCentres = [
    { centre: width * 0.92, pair: 'far right', numbers: [1, 2] },
    { centre: width * 0.7, pair: 'centre right', numbers: [3, 4] },
    { centre: width * 0.3, pair: 'centre left', numbers: [5, 6] },
    { centre: width * 0.08, pair: 'far left', numbers: [7, 8] },
  ];
  const subGap = 1.35;
  for (const group of pairCentres) {
    group.numbers.forEach((number, index) => {
      const direction = index === 0 ? -1 : 1;
      entries.push({
        number,
        name: 'Sub ' + number,
        role: 'sub',
        manufacturer: 'Pioneer',
        model: 'XY-218HS-B',
        type: 'Subwoofer',
        x: Math.min(width - 0.4, Math.max(0.4, group.centre + direction * subGap / 2)),
        y: stageY,
        z: 0.35,
        aimH: 0,
        aimV: 0,
        note: 'Template position · ' + group.pair + ' pair',
      });
    });
  }

  const mains = [
    { name: 'Main left outer', x: width * 0.1 },
    { name: 'Main left inner', x: width * 0.32 },
    { name: 'Main right inner', x: width * 0.68 },
    { name: 'Main right outer', x: width * 0.9 },
  ];
  mains.forEach((main) => {
    entries.push({
      name: main.name,
      role: 'main',
      manufacturer: 'Pioneer',
      model: 'XY-3B',
      type: 'Top / main',
      x: main.x,
      y: 1.4,
      z: 5.2,
      aimH: Math.atan2(width / 2 - main.x, length * 0.35 - 1.4) * (180 / Math.PI),
      aimV: -8,
      note: 'Template position · flown main',
    });
  });

  [['Mid delay left', width * 0.28], ['Mid delay right', width * 0.72]].forEach(([name, x]) => {
    entries.push({
      name, role: 'mids', manufacturer: 'Pioneer', model: 'XY-3B', type: 'Top / main',
      x, y: length * 0.45, z: 6.5, aimH: 0, aimV: -6,
      note: 'Template position · mid-room delay',
    });
  });

  [['Rear delay left', width * 0.28], ['Rear delay right', width * 0.72]].forEach(([name, x]) => {
    entries.push({
      name, role: 'rear', manufacturer: 'Pioneer', model: 'XY-3B', type: 'Top / main',
      x, y: length * 0.78, z: 6.5, aimH: 0, aimV: -6,
      note: 'Template position · rear delay',
    });
  });

  return entries;
}

export const ROOM_TEMPLATES = [
  { id: 'empty', label: 'Empty rectangular room' },
  { id: 'club', label: 'Small club (18 × 24 m)' },
  { id: 'theatre', label: 'Theatre with a raked audience' },
  { id: 'lshape', label: 'L-shaped room' },
  { id: 'warehouse', label: 'Pioneer warehouse example (41 × 110 ft)' },
];

export function roomTemplate(id) {
  if (id === 'club') {
    const room = rectRoom('Small club', 18, 24, 5.5);
    room.ceiling = 'flat';
    room.stages = [{
      id: makeId('st-'), name: 'Stage', heightM: 0.8,
      x0: 2, x1: 16, y0: 0.5, y1: 4.5,
    }];
    return normalizeRoom(room);
  }
  if (id === 'theatre') {
    const room = rectRoom('Theatre', 20, 30, 8);
    room.ceiling = 'sloped';
    room.riseM = 4;
    room.stages = [{
      id: makeId('st-'), name: 'Stage', heightM: 1.1,
      x0: 2, x1: 18, y0: 0.8, y1: 6,
    }];
    room.audience = [{
      id: makeId('au-'), name: 'Raked seating',
      x0: 1.5, y0: 7, x1: 18.5, y1: 28,
      earHeightM: 1.15, raked: true, risePerMetre: 0.08,
    }];
    return normalizeRoom(room);
  }
  if (id === 'lshape') {
    const room = rectRoom('L-shaped room', 24, 28, 6);
    room.shape = 'l';
    room.size.notchWidthM = 10;
    room.size.notchLengthM = 12;
    room.outline = generateOutline(room);
    room.audience = [{
      id: makeId('au-'), name: 'Audience',
      x0: 1.5, y0: 4, x1: 12, y1: 26,
      earHeightM: 1.2, raked: false, risePerMetre: 0,
    }];
    return normalizeRoom(room);
  }
  if (id === 'warehouse') return warehouseRoom('metric');
  return normalizeRoom(emptyRoom('New room'));
}

/** Snap a coordinate to a grid, leaving it alone when the grid is off. */
export function snapValue(value, step) {
  const size = Number(step);
  if (!(size > 0)) return Number(value) || 0;
  return Math.round(Number(value) / size) * size;
}

export function snapPoint(x, y, step) {
  return { x: snapValue(x, step), y: snapValue(y, step) };
}
