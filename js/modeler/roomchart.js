/*
 * The Room Designer's canvases.
 *
 * Three views of one geometry — plan, section and 3D — and a response chart for
 * the selected microphone. The plan view carries the predicted coverage map.
 *
 * Everything drawn here comes from the same room object and the same prediction
 * result the panels show; there is no decorative geometry and no invented
 * curve. A view that cannot show something says so in its own corner rather
 * than drawing a plausible-looking stand-in.
 */

import { CURVE_FMIN, CURVE_FMAX, formatFrequency } from './curve.js';
import {
  ceilingHeightAt,
  floorHeightAt,
  outlineBounds,
  unitSuffix,
} from './room.js';

const DPR = () => Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);

/** The colour ramp used for every heat map, with the value it stands for. */
export const HEAT_STOPS = [
  { at: 0, colour: [8, 18, 52] },
  { at: 0.18, colour: [18, 76, 140] },
  { at: 0.36, colour: [20, 168, 172] },
  { at: 0.54, colour: [64, 208, 110] },
  { at: 0.72, colour: [206, 226, 58] },
  { at: 0.87, colour: [255, 170, 48] },
  { at: 1, colour: [255, 82, 64] },
];

export function heatColour(t) {
  const value = Math.min(1, Math.max(0, Number(t) || 0));
  let low = HEAT_STOPS[0];
  let high = HEAT_STOPS[HEAT_STOPS.length - 1];
  for (let i = 0; i < HEAT_STOPS.length - 1; i += 1) {
    if (value >= HEAT_STOPS[i].at && value <= HEAT_STOPS[i + 1].at) {
      low = HEAT_STOPS[i];
      high = HEAT_STOPS[i + 1];
      break;
    }
  }
  const span = Math.max(1e-6, high.at - low.at);
  const t2 = (value - low.at) / span;
  const r = Math.round(low.colour[0] + (high.colour[0] - low.colour[0]) * t2);
  const g = Math.round(low.colour[1] + (high.colour[1] - low.colour[1]) * t2);
  const b = Math.round(low.colour[2] + (high.colour[2] - low.colour[2]) * t2);
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

const ROLE_COLOURS = {
  sub: '#ff9a3c',
  main: '#5ec8ff',
  centre: '#9ad7ff',
  frontfill: '#7fe0c0',
  sidefill: '#b6a2ff',
  mids: '#ffd166',
  rear: '#ff8fa3',
  custom: '#c9d4e2',
};

export function roleColour(role) {
  return ROLE_COLOURS[role] || ROLE_COLOURS.custom;
}

function fmt(value, digits = 1) {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

export class RoomChart {
  constructor(canvas, handlers = {}) {
    this.canvas = canvas;
    this.handlers = handlers;
    this.state = null;
    this.transform = null;
    this.projected = [];
    this.drag = null;
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.pointer = null;
    this.heatCanvas = null;
    this.heatKey = '';
    this.bind();
  }

  bind() {
    const canvas = this.canvas;
    if (!canvas) return;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (event) => this.onDown(event));
    canvas.addEventListener('pointermove', (event) => this.onMove(event));
    canvas.addEventListener('pointerup', (event) => this.onUp(event));
    canvas.addEventListener('pointercancel', (event) => this.onUp(event));
    canvas.addEventListener('pointerleave', () => {
      this.pointer = null;
      if (this.handlers.onHover) this.handlers.onHover(null);
      this.draw();
    });
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      this.zoom = Math.min(8, Math.max(0.4, this.zoom * (event.deltaY > 0 ? 0.9 : 1.1)));
      this.draw();
    }, { passive: false });
    canvas.addEventListener('dblclick', () => {
      this.zoom = 1;
      this.pan = { x: 0, y: 0 };
      this.draw();
    });
  }

  setState(state) {
    this.state = state;
    this.draw();
  }

  resize() {
    const canvas = this.canvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(120, Math.round(rect.width || canvas.clientWidth || 600));
    const height = Math.max(120, Math.round(rect.height || canvas.clientHeight || 420));
    const ratio = DPR();
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    this.width = width;
    this.height = height;
    this.draw();
  }

  /* ---------- coordinate transforms ---------- */

  planTransform() {
    const room = this.state && this.state.room;
    const bounds = outlineBounds(room ? room.outline : [{ x: 0, y: 0 }, { x: 10, y: 10 }]);
    const pad = 34;
    const margin = 6;
    const spanX = Math.max(1, bounds.width);
    const spanY = Math.max(1, bounds.height);
    const scale = Math.min(
      (this.width - 2 * margin - 2 * pad) / spanX,
      (this.height - 2 * margin - 2 * pad) / spanY,
    ) * this.zoom;
    const centreX = (bounds.minX + bounds.maxX) / 2;
    const centreY = (bounds.minY + bounds.maxY) / 2;
    const ox = this.width / 2 - centreX * scale + this.pan.x;
    const oy = this.height / 2 - centreY * scale + this.pan.y;
    return {
      scale,
      toScreen: (x, y) => ({ x: ox + x * scale, y: oy + y * scale }),
      toWorld: (px, py) => ({ x: (px - ox) / scale, y: (py - oy) / scale }),
      bounds,
    };
  }

  sectionTransform() {
    const room = this.state && this.state.room;
    const bounds = outlineBounds(room ? room.outline : [{ x: 0, y: 0 }, { x: 10, y: 10 }]);
    const maxHeight = Math.max(
      ceilingHeightAt(room, (bounds.minX + bounds.maxX) / 2, bounds.minY),
      ceilingHeightAt(room, (bounds.minX + bounds.maxX) / 2, bounds.maxY),
      room ? room.wallHeightM + room.riseM : 6,
      3,
    );
    const pad = 46;
    const spanY = Math.max(1, bounds.height);
    const scale = Math.min((this.width - 2 * pad) / spanY,
      (this.height - 2 * pad) / (maxHeight * 1.15)) * this.zoom;
    const ox = pad + this.pan.x;
    const oy = this.height - pad + this.pan.y;
    return {
      scale,
      toScreen: (y, z) => ({ x: ox + (y - bounds.minY) * scale, y: oy - z * scale }),
      toWorld: (px, py) => ({ y: (px - ox) / scale + bounds.minY, z: (oy - py) / scale }),
      bounds,
      maxHeight,
    };
  }

  projection3d() {
    const room = this.state && this.state.room;
    const bounds = outlineBounds(room ? room.outline : [{ x: 0, y: 0 }, { x: 10, y: 10 }]);
    const maxHeight = room ? Math.max(room.wallHeightM + room.riseM, room.wallHeightM) : 8;
    const centreX = (bounds.minX + bounds.maxX) / 2;
    const centreY = (bounds.minY + bounds.maxY) / 2;
    const yaw = (this.state && this.state.yaw !== undefined ? this.state.yaw : -32) * (Math.PI / 180);
    const pitch = (this.state && this.state.pitch !== undefined ? this.state.pitch : 26) * (Math.PI / 180);
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);
    const raw = [];
    const project = (x, y, z) => {
      const dx = x - centreX;
      const dy = y - centreY;
      const rx = dx * cosY - dy * sinY;
      const depth = dx * sinY + dy * cosY;
      const sy = depth * sinP - (z - maxHeight / 2) * cosP;
      return { x: rx, y: sy, depth };
    };
    for (const corner of room ? room.outline : []) {
      raw.push(project(corner.x, corner.y, 0));
      raw.push(project(corner.x, corner.y, ceilingHeightAt(room, corner.x, corner.y)));
    }
    let minX = -1;
    let maxX = 1;
    let minY = -1;
    let maxY = 1;
    for (const entry of raw) {
      minX = Math.min(minX, entry.x);
      maxX = Math.max(maxX, entry.x);
      minY = Math.min(minY, entry.y);
      maxY = Math.max(maxY, entry.y);
    }
    const pad = 40;
    const scale = Math.min((this.width - 2 * pad) / Math.max(1, maxX - minX),
      (this.height - 2 * pad) / Math.max(1, maxY - minY)) * this.zoom;
    const ox = this.width / 2 - ((minX + maxX) / 2) * scale + this.pan.x;
    const oy = this.height / 2 - ((minY + maxY) / 2) * scale + this.pan.y;
    return {
      scale,
      toScreen: (x, y, z) => {
        const point = project(x, y, z);
        return { x: ox + point.x * scale, y: oy + point.y * scale, depth: point.depth };
      },
      bounds,
      maxHeight,
    };
  }

  /* ---------- drawing ---------- */

  draw() {
    const canvas = this.canvas;
    const state = this.state;
    if (!canvas || !state) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (!this.width) this.resize();
    const ratio = DPR();
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = '#0a0f16';
    ctx.fillRect(0, 0, this.width, this.height);

    if (state.view === 'section') {
      this.transform = this.sectionTransform();
      this.drawSection(ctx);
    } else if (state.view === '3d') {
      this.transform = this.projection3d();
      this.draw3d(ctx);
    } else {
      this.transform = this.planTransform();
      this.drawPlan(ctx);
    }
    this.drawFooter(ctx);
  }

  drawPlan(ctx) {
    const state = this.state;
    const room = state.room;
    const transform = this.transform;
    const bounds = transform.bounds;
    const units = room.units;

    this.drawPlanGrid(ctx, transform, units, room);

    // The heat map, under every other layer but above the grid.
    if (state.showHeatmap && state.heatmap && state.heatmap.ok) {
      this.drawHeat(ctx, transform);
    }

    const path = new Path2D();
    room.outline.forEach((point, index) => {
      const screen = transform.toScreen(point.x, point.y);
      if (index === 0) path.moveTo(screen.x, screen.y);
      else path.lineTo(screen.x, screen.y);
    });
    path.closePath();

    ctx.save();
    ctx.clip(path);
    // The floor is drawn inside the room so an odd-shaped plan reads correctly.
    ctx.fillStyle = 'rgba(18, 28, 42, 0.55)';
    ctx.fill(new Path2D(path));
    for (const area of room.audience || []) {
      const top = transform.toScreen(area.x0, area.y0);
      const bottom = transform.toScreen(area.x1, area.y1);
      ctx.fillStyle = 'rgba(94, 200, 255, 0.07)';
      ctx.fillRect(top.x, top.y, bottom.x - top.x, bottom.y - top.y);
      ctx.strokeStyle = 'rgba(94, 200, 255, 0.35)';
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(top.x, top.y, bottom.x - top.x, bottom.y - top.y);
      ctx.setLineDash([]);
      this.label(ctx, area.name, top.x + 6, top.y + 14, 'rgba(148, 196, 226, 0.8)');
    }
    for (const stage of room.stages || []) {
      const a = transform.toScreen(stage.x0, stage.y0);
      const b = transform.toScreen(stage.x1, stage.y1);
      ctx.fillStyle = 'rgba(255, 209, 102, 0.12)';
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.strokeStyle = 'rgba(255, 209, 102, 0.5)';
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      this.label(ctx, stage.name, a.x + 6, a.y + 14, 'rgba(255, 209, 102, 0.85)');
    }
    for (const platform of room.platforms || []) {
      const a = transform.toScreen(platform.x0, platform.y0);
      const b = transform.toScreen(platform.x1, platform.y1);
      ctx.strokeStyle = 'rgba(255, 209, 102, 0.35)';
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.setLineDash([]);
    }
    for (const obstacle of room.obstacles || []) {
      const a = transform.toScreen(obstacle.x0, obstacle.y0);
      const b = transform.toScreen(obstacle.x1, obstacle.y1);
      ctx.fillStyle = 'rgba(120, 132, 150, 0.25)';
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.strokeStyle = 'rgba(150, 162, 180, 0.6)';
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      this.label(ctx, obstacle.name, a.x + 4, a.y + 12, 'rgba(180, 190, 205, 0.8)');
    }
    ctx.restore();

    // The outline last, so it stays visible over the heat map.
    ctx.strokeStyle = '#7f93aa';
    ctx.lineWidth = 1.6;
    ctx.stroke(path);
    if (room.ceiling !== 'flat') {
      const midX = (bounds.minX + bounds.maxX) / 2;
      const a = transform.toScreen(midX, bounds.minY);
      const b = transform.toScreen(midX, bounds.maxY);
      ctx.strokeStyle = 'rgba(127, 147, 170, 0.35)';
      ctx.setLineDash([10, 6]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      this.label(ctx, room.ceiling === 'aframe' ? 'ridge' : 'ceiling slope',
        a.x + 6, (a.y + b.y) / 2, 'rgba(127, 147, 170, 0.65)');
    }

    if (state.showCoverage) this.drawCoverage(ctx, transform);
    this.drawSpeakersPlan(ctx, transform);
    this.drawMicsPlan(ctx, transform);

    if (room.shape === 'custom' && state.tool === 'vertex') {
      for (const [index, point] of room.outline.entries()) {
        const screen = transform.toScreen(point.x, point.y);
        ctx.fillStyle = '#ffd166';
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#0a0f16';
        ctx.lineWidth = 1;
        ctx.stroke();
        if (index >= 0) {
          this.label(ctx, String(index + 1), screen.x + 7, screen.y - 6, 'rgba(255, 209, 102, 0.9)');
        }
      }
    }

    if (state.ruler) this.drawRuler(ctx, transform, units);

    if (state.hover) {
      const screen = transform.toScreen(state.hover.x, state.hover.y);
      ctx.strokeStyle = 'rgba(94, 200, 255, 0.5)';
      ctx.beginPath();
      ctx.moveTo(screen.x - 6, screen.y);
      ctx.lineTo(screen.x + 6, screen.y);
      ctx.moveTo(screen.x, screen.y - 6);
      ctx.lineTo(screen.x, screen.y + 6);
      ctx.stroke();
    }

    if (!room.outline.length) {
      this.label(ctx, 'Draw or type a room outline to begin', 18, 24, '#c9d4e2');
    }

    this.cornerNote(ctx, state.heatmap && state.heatmap.ok
      ? 'Predicted map · direct sound only'
      : 'No predicted map yet');
  }

  drawPlanGrid(ctx, transform, units, room) {
    const bounds = transform.bounds;
    const step = units === 'imperial' ? 5 / 3.280839895 : 1;
    ctx.strokeStyle = 'rgba(120, 140, 165, 0.08)';
    ctx.lineWidth = 1;
    const startX = Math.floor(bounds.minX / step) * step;
    const startY = Math.floor(bounds.minY / step) * step;
    for (let x = startX; x <= bounds.maxX + step; x += step) {
      const a = transform.toScreen(x, bounds.minY);
      const b = transform.toScreen(x, bounds.maxY);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (let y = startY; y <= bounds.maxY + step; y += step) {
      const a = transform.toScreen(bounds.minX, y);
      const b = transform.toScreen(bounds.maxX, y);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    // One scale bar, labelled in the display unit.
    const barMetres = units === 'imperial' ? 3.048 : 2;
    const a = transform.toScreen(bounds.minX, bounds.maxY);
    const length = barMetres * transform.scale;
    ctx.strokeStyle = 'rgba(180, 200, 220, 0.6)';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y + 16);
    ctx.lineTo(a.x + length, a.y + 16);
    ctx.moveTo(a.x, a.y + 12);
    ctx.lineTo(a.x, a.y + 20);
    ctx.moveTo(a.x + length, a.y + 12);
    ctx.lineTo(a.x + length, a.y + 20);
    ctx.stroke();
    const text = (units === 'imperial' ? 10 : 2) + ' ' + unitSuffix(units);
    this.label(ctx, text, a.x + length + 6, a.y + 19, 'rgba(180, 200, 220, 0.8)');
  }

  drawHeat(ctx, transform) {
    const map = this.state.heatmap;
    const room = this.state.room;
    const key = [map.cols, map.rows, map.metric, map.frequencyHz, map.mode,
      map.statistics.minDb, map.statistics.maxDb, map.offsetDb].join('|');
    if (this.heatKey !== key || !this.heatCanvas) {
      const off = document.createElement('canvas');
      off.width = map.cols;
      off.height = map.rows;
      const offCtx = off.getContext('2d');
      const image = offCtx.createImageData(map.cols, map.rows);
      const low = Number.isFinite(map.statistics.minDb) ? map.statistics.minDb : 0;
      const high = Number.isFinite(map.statistics.maxDb) ? map.statistics.maxDb : 1;
      const span = Math.max(1e-6, high - low);
      for (let index = 0; index < map.values.length; index += 1) {
        const value = map.values[index];
        const pixel = index * 4;
        if (!Number.isFinite(value)) {
          image.data[pixel + 3] = 0;
          continue;
        }
        const t = (map.valuesDb[index] - low) / span;
        const colour = heatColour(t).match(/\d+/g).map(Number);
        image.data[pixel] = colour[0];
        image.data[pixel + 1] = colour[1];
        image.data[pixel + 2] = colour[2];
        image.data[pixel + 3] = 224;
      }
      offCtx.putImageData(image, 0, 0);
      this.heatCanvas = off;
      this.heatKey = key;
    }

    const bounds = map.bounds;
    const topLeft = transform.toScreen(bounds.minX, bounds.minY);
    const bottomRight = transform.toScreen(bounds.maxX, bounds.maxY);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.92;
    const clip = new Path2D();
    room.outline.forEach((point, index) => {
      const screen = transform.toScreen(point.x, point.y);
      if (index === 0) clip.moveTo(screen.x, screen.y);
      else clip.lineTo(screen.x, screen.y);
    });
    clip.closePath();
    ctx.clip(clip);
    ctx.drawImage(this.heatCanvas, topLeft.x, topLeft.y,
      bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
    ctx.restore();
  }

  drawCoverage(ctx, plan) {
    const state = this.state;
    const frequency = state.coverageFrequency || 1000;
    for (const speaker of state.speakers) {
      const width = speaker.beamwidthAt ? speaker.beamwidthAt(frequency) : NaN;
      if (!Number.isFinite(width) || !(width > 0)) continue;
      const origin = plan.toScreen(speaker.position.x, speaker.position.y);
      const aim = ((speaker.placement.aimH || 0) * Math.PI) / 180;
      const half = (width / 2) * (Math.PI / 180);
      const radius = Math.min(this.width, this.height) * 0.42;
      ctx.beginPath();
      ctx.moveTo(origin.x, origin.y);
      ctx.arc(origin.x, origin.y, radius, -Math.PI / 2 + aim - half, -Math.PI / 2 + aim + half);
      ctx.closePath();
      ctx.fillStyle = speaker.selected
        ? 'rgba(94, 200, 255, 0.16)'
        : 'rgba(94, 200, 255, 0.06)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(94, 200, 255, 0.35)';
      ctx.stroke();
    }
  }

  drawSpeakersPlan(ctx, plan) {
    const state = this.state;
    for (const speaker of state.speakers) {
      const screen = plan.toScreen(speaker.position.x, speaker.position.y);
      const colour = roleColour(speaker.role);
      const aim = ((speaker.placement.aimH || 0) * Math.PI) / 180;
      const size = speaker.selected ? 9 : 7;
      ctx.save();
      ctx.translate(screen.x, screen.y);
      ctx.rotate(aim);
      ctx.beginPath();
      ctx.moveTo(0, -size);
      ctx.lineTo(size * 0.8, size * 0.7);
      ctx.lineTo(-size * 0.8, size * 0.7);
      ctx.closePath();
      ctx.fillStyle = speaker.selected ? '#ffffff' : colour;
      ctx.fill();
      ctx.strokeStyle = speaker.selected ? colour : 'rgba(6, 12, 20, 0.9)';
      ctx.lineWidth = speaker.selected ? 2 : 1;
      ctx.stroke();
      ctx.restore();
      const labelText = speaker.shortName || speaker.name;
      this.label(ctx, labelText, screen.x + 10, screen.y - 8,
        speaker.selected ? '#ffffff' : 'rgba(214, 226, 240, 0.85)');
    }
  }

  drawMicsPlan(ctx, plan) {
    const state = this.state;
    for (const mic of state.room.mics || []) {
      const screen = plan.toScreen(mic.x, mic.y);
      const selected = mic.id === state.selectedMicId;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, selected ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = selected ? '#ff4d6d' : 'rgba(255, 77, 109, 0.75)';
      ctx.fill();
      ctx.strokeStyle = selected ? '#ffffff' : 'rgba(10, 15, 22, 0.9)';
      ctx.lineWidth = selected ? 2 : 1;
      ctx.stroke();
      this.label(ctx, mic.name, screen.x + 9, screen.y + 16,
        selected ? '#ffffff' : 'rgba(255, 168, 186, 0.85)');
    }
  }

  drawRuler(ctx, plan, units) {
    const ruler = this.state.ruler;
    const a = plan.toScreen(ruler.a.x, ruler.a.y);
    const b = plan.toScreen(ruler.b.x, ruler.b.y);
    ctx.strokeStyle = '#ffd166';
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    const distance = Math.hypot(ruler.b.x - ruler.a.x, ruler.b.y - ruler.a.y);
    const value = units === 'imperial' ? distance * 3.280839895 : distance;
    this.label(ctx, value.toFixed(2) + ' ' + unitSuffix(units) +
      ' · ' + ((distance / (this.state.speedOfSound || 343)) * 1000).toFixed(2) + ' ms',
    (a.x + b.x) / 2 + 8, (a.y + b.y) / 2 - 8, '#ffd166');
  }

  drawSection(ctx) {
    const state = this.state;
    const room = state.room;
    const transform = this.transform;
    const bounds = transform.bounds;
    const units = room.units;
    const sectionX = Number.isFinite(state.sectionX) ? state.sectionX : (bounds.minX + bounds.maxX) / 2;

    // Ground and ceiling profile through the chosen plane.
    ctx.strokeStyle = '#7f93aa';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    const steps = 90;
    for (let i = 0; i <= steps; i += 1) {
      const y = bounds.minY + (bounds.height * i) / steps;
      const screen = transform.toScreen(y, ceilingHeightAt(room, sectionX, y));
      if (i === 0) ctx.moveTo(screen.x, screen.y);
      else ctx.lineTo(screen.x, screen.y);
    }
    ctx.stroke();

    const floorA = transform.toScreen(bounds.minY, 0);
    const floorB = transform.toScreen(bounds.maxY, 0);
    ctx.strokeStyle = '#7f93aa';
    ctx.beginPath();
    ctx.moveTo(floorA.x, floorA.y);
    ctx.lineTo(floorB.x, floorB.y);
    ctx.stroke();

    // Stages and platforms as raised blocks.
    for (const stage of room.stages || []) {
      if (sectionX < Math.min(stage.x0, stage.x1) || sectionX > Math.max(stage.x0, stage.x1)) continue;
      const a = transform.toScreen(Math.min(stage.y0, stage.y1), 0);
      const b = transform.toScreen(Math.max(stage.y0, stage.y1), stage.heightM);
      ctx.fillStyle = 'rgba(255, 209, 102, 0.18)';
      ctx.fillRect(a.x, b.y, b.x - a.x, a.y - b.y);
      ctx.strokeStyle = 'rgba(255, 209, 102, 0.6)';
      ctx.strokeRect(a.x, b.y, b.x - a.x, a.y - b.y);
      this.label(ctx, stage.name + ' · ' + stage.heightM.toFixed(2) + ' m', a.x + 5, b.y + 13,
        'rgba(255, 209, 102, 0.9)');
    }
    for (const platform of room.platforms || []) {
      if (sectionX < Math.min(platform.x0, platform.x1) || sectionX > Math.max(platform.x0, platform.x1)) continue;
      const a = transform.toScreen(Math.min(platform.y0, platform.y1), 0);
      const b = transform.toScreen(Math.max(platform.y0, platform.y1), platform.heightM);
      ctx.strokeStyle = 'rgba(255, 209, 102, 0.45)';
      ctx.strokeRect(a.x, b.y, b.x - a.x, a.y - b.y);
    }

    // The audience band, at its listening height.
    for (const area of room.audience || []) {
      const a = transform.toScreen(Math.min(area.y0, area.y1), area.earHeightM);
      const b = transform.toScreen(Math.max(area.y0, area.y1), area.earHeightM);
      ctx.strokeStyle = 'rgba(94, 200, 255, 0.5)';
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const axis = transform.toScreen(bounds.minY, 0);
    for (let h = 0; h <= transform.maxHeight; h += (units === 'imperial' ? 5 / 3.280839895 : 1)) {
      const screen = transform.toScreen(bounds.minY, h);
      ctx.strokeStyle = 'rgba(120, 140, 165, 0.12)';
      ctx.beginPath();
      ctx.moveTo(axis.x, screen.y);
      ctx.lineTo(this.width - 12, screen.y);
      ctx.stroke();
      if (h % (units === 'imperial' ? 3.048 : 2) < 1e-6) {
        this.label(ctx, (units === 'imperial' ? (h * 3.280839895).toFixed(0) : h.toFixed(0)) +
          ' ' + unitSuffix(units), 8, screen.y - 2, 'rgba(148, 170, 194, 0.7)');
      }
    }

    for (const speaker of state.speakers) {
      if (Math.abs(speaker.position.x - sectionX) > Math.max(1.2, bounds.width * 0.12)) continue;
      const screen = transform.toScreen(speaker.position.y, speaker.position.z);
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, speaker.selected ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = speaker.selected ? '#ffffff' : roleColour(speaker.role);
      ctx.fill();
      ctx.strokeStyle = 'rgba(6, 12, 20, 0.9)';
      ctx.stroke();
      this.label(ctx, speaker.name, screen.x + 8, screen.y - 7,
        speaker.selected ? '#ffffff' : 'rgba(214, 226, 240, 0.8)');
      // The aim, as a short line from the cabinet.
      const aimH = ((speaker.placement.aimH || 0) * Math.PI) / 180;
      const aimV = ((speaker.placement.aimV || 0) * Math.PI) / 180;
      const reach = 2.2;
      const tip = transform.toScreen(
        speaker.position.y + Math.cos(aimV) * Math.cos(aimH) * reach,
        speaker.position.z - Math.sin(aimV) * reach,
      );
      ctx.strokeStyle = 'rgba(94, 200, 255, 0.5)';
      ctx.beginPath();
      ctx.moveTo(screen.x, screen.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.stroke();
    }

    for (const mic of state.room.mics || []) {
      const screen = transform.toScreen(mic.y, mic.z);
      ctx.fillStyle = mic.id === state.selectedMicId ? '#ff4d6d' : 'rgba(255, 77, 109, 0.7)';
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, mic.id === state.selectedMicId ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fill();
    }

    this.cornerNote(ctx, 'Section at x = ' + sectionX.toFixed(2) + ' m · no map in this view');
  }

  draw3d(ctx) {
    const state = this.state;
    const room = state.room;
    const project = this.transform;
    const bounds = project.bounds;

    // The floor.
    const floor = new Path2D();
    room.outline.forEach((point, index) => {
      const screen = project.toScreen(point.x, point.y, 0);
      if (index === 0) floor.moveTo(screen.x, screen.y);
      else floor.lineTo(screen.x, screen.y);
    });
    floor.closePath();
    ctx.fillStyle = 'rgba(20, 32, 48, 0.85)';
    ctx.fill(floor);
    ctx.strokeStyle = '#7f93aa';
    ctx.lineWidth = 1.3;
    ctx.stroke(floor);

    // The ceiling, drawn as its own polygon at the height this room reaches
    // above each corner.
    const ceiling = new Path2D();
    room.outline.forEach((point, index) => {
      const screen = project.toScreen(point.x, point.y, ceilingHeightAt(room, point.x, point.y));
      if (index === 0) ceiling.moveTo(screen.x, screen.y);
      else ceiling.lineTo(screen.x, screen.y);
    });
    ceiling.closePath();
    ctx.strokeStyle = 'rgba(127, 147, 170, 0.55)';
    ctx.stroke(ceiling);

    for (const point of room.outline) {
      const bottom = project.toScreen(point.x, point.y, 0);
      const top = project.toScreen(point.x, point.y, ceilingHeightAt(room, point.x, point.y));
      ctx.strokeStyle = 'rgba(127, 147, 170, 0.45)';
      ctx.beginPath();
      ctx.moveTo(bottom.x, bottom.y);
      ctx.lineTo(top.x, top.y);
      ctx.stroke();
    }

    for (const area of room.audience || []) {
      const corners = [
        project.toScreen(area.x0, area.y0, 0.01),
        project.toScreen(area.x1, area.y0, 0.01),
        project.toScreen(area.x1, area.y1, 0.01),
        project.toScreen(area.x0, area.y1, 0.01),
      ];
      ctx.beginPath();
      corners.forEach((corner, index) => {
        if (index === 0) ctx.moveTo(corner.x, corner.y);
        else ctx.lineTo(corner.x, corner.y);
      });
      ctx.closePath();
      ctx.fillStyle = 'rgba(94, 200, 255, 0.09)';
      ctx.fill();
    }

    for (const stage of room.stages || []) {
      const base = project.toScreen(stage.x0, stage.y0, 0);
      const top = project.toScreen(stage.x1, stage.y1, stage.heightM);
      ctx.fillStyle = 'rgba(255, 209, 102, 0.22)';
      ctx.fillRect(Math.min(base.x, top.x), Math.min(base.y, top.y),
        Math.abs(top.x - base.x), Math.abs(top.y - base.y));
    }

    const speakers = state.speakers.slice().sort((a, b) => {
      const da = project.toScreen(a.position.x, a.position.y, a.position.z).depth;
      const db = project.toScreen(b.position.x, b.position.y, b.position.z).depth;
      return da - db;
    });
    for (const speaker of speakers) {
      const screen = project.toScreen(speaker.position.x, speaker.position.y, speaker.position.z);
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, speaker.selected ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = speaker.selected ? '#ffffff' : roleColour(speaker.role);
      ctx.fill();
      ctx.strokeStyle = 'rgba(6, 12, 20, 0.9)';
      ctx.stroke();
      if (speaker.selected) {
        this.label(ctx, speaker.name, screen.x + 8, screen.y - 7, '#ffffff');
      }
    }

    for (const mic of room.mics || []) {
      const screen = project.toScreen(mic.x, mic.y, mic.z);
      ctx.fillStyle = mic.id === state.selectedMicId ? '#ff4d6d' : 'rgba(255, 77, 109, 0.6)';
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }

    this.cornerNote(ctx, '3D is a complementary wireframe · the predicted map is drawn in plan');
    this.label(ctx, room.shape === 'custom' ? 'custom outline' : room.shape === 'l' ? 'L-shaped' : 'rectangular',
      14, this.height - 15, 'rgba(148, 170, 194, 0.7)');
    void bounds;
  }

  cornerNote(ctx, text) {
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(148, 170, 194, 0.8)';
    ctx.fillText(text, this.width - 12, this.height - 12);
    ctx.textAlign = 'left';
  }

  drawFooter(ctx) {
    const state = this.state;
    if (!state.heatmap || !state.heatmap.ok) return;
    const map = state.heatmap;
    const stats = map.statistics;
    const unit = map.metric === 'arrival' ? 'ms'
      : map.metric === 'difference' ? 'dB (left − right)'
        : map.metric === 'interference' ? 'dB (coherent − incoherent)'
          : map.metric === 'deviation' ? 'dB from the mean'
            : 'dB';
    const legendWidth = Math.min(220, this.width * 0.42);
    const x = 12;
    const y = this.height - 26;
    const gradient = ctx.createLinearGradient(x, 0, x + legendWidth, 0);
    for (let i = 0; i <= 10; i += 1) gradient.addColorStop(i / 10, heatColour(i / 10));
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, legendWidth, 8);
    ctx.strokeStyle = 'rgba(200, 214, 228, 0.4)';
    ctx.strokeRect(x, y, legendWidth, 8);
    const low = Number.isFinite(stats.minDb) ? stats.minDb : NaN;
    const high = Number.isFinite(stats.maxDb) ? stats.maxDb : NaN;
    const offset = map.normalised ? map.offsetDb : 0;
    this.label(ctx, (Number.isFinite(low) ? fmt(low - offset, 1) : '—') + ' ' + unit,
      x, y - 4, 'rgba(200, 214, 228, 0.85)');
    ctx.textAlign = 'right';
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = 'rgba(200, 214, 228, 0.85)';
    ctx.fillText((Number.isFinite(high) ? fmt(high - offset, 1) : '—') + ' ' + unit,
      x + legendWidth, y - 4);
    ctx.textAlign = 'left';
  }

  label(ctx, text, x, y, colour) {
    if (!text) return;
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = colour || 'rgba(214, 226, 240, 0.85)';
    ctx.fillText(String(text).slice(0, 28), x, y);
  }

  /* ---------- pointer handling ---------- */

  localPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  worldPoint(point) {
    const state = this.state;
    if (!state) return null;
    if (state.view === 'section') {
      const world = this.transform.toWorld(point.x, point.y);
      return { y: world.y, z: world.z };
    }
    if (state.view === '3d') return null;
    return this.transform.toWorld(point.x, point.y);
  }

  nearest(point) {
    const state = this.state;
    if (!state || !this.transform) return null;
    let best = null;
    if (state.view === 'section') {
      const bounds = this.transform.bounds;
      const sectionX = Number.isFinite(state.sectionX)
        ? state.sectionX
        : (bounds.minX + bounds.maxX) / 2;
      for (const speaker of state.speakers) {
        if (Math.abs(speaker.position.x - sectionX) >
          Math.max(1.2, bounds.width * 0.12)) continue;
        const screen = this.transform.toScreen(speaker.position.y, speaker.position.z);
        const distance = Math.hypot(screen.x - point.x, screen.y - point.y);
        if (distance <= 14 && (!best || distance < best.distance)) {
          best = { kind: 'speaker', id: speaker.id, distance };
        }
      }
      return best;
    }
    if (state.view !== 'plan') return null;
    for (const speaker of state.speakers) {
      const screen = this.transform.toScreen(speaker.position.x, speaker.position.y);
      const distance = Math.hypot(screen.x - point.x, screen.y - point.y);
      if (distance <= 14 && (!best || distance < best.distance)) {
        best = { kind: 'speaker', id: speaker.id, distance };
      }
    }
    for (const mic of state.room.mics || []) {
      const screen = this.transform.toScreen(mic.x, mic.y);
      const distance = Math.hypot(screen.x - point.x, screen.y - point.y);
      if (distance <= 12 && (!best || distance < best.distance)) {
        best = { kind: 'mic', id: mic.id, distance };
      }
    }
    if (state.room.shape === 'custom' && state.tool === 'vertex') {
      for (const [index, vertex] of state.room.outline.entries()) {
        const screen = this.transform.toScreen(vertex.x, vertex.y);
        const distance = Math.hypot(screen.x - point.x, screen.y - point.y);
        if (distance <= 11 && (!best || distance < best.distance)) {
          best = { kind: 'vertex', id: String(index), distance };
        }
      }
    }
    return best;
  }

  onDown(event) {
    if (!this.state || !this.transform) return;
    const point = this.localPoint(event);
    this.canvas.setPointerCapture?.(event.pointerId);
    const hit = this.nearest(point);
    const world = this.worldPoint(point);
    const state = this.state;

    if (state.tool === 'mic' && state.view === 'plan' && world) {
      const snapped = this.snap(world);
      if (this.handlers.onAddMic) this.handlers.onAddMic(snapped);
      return;
    }
    if (state.tool === 'ruler' && state.view === 'plan' && world) {
      // Every press with the ruler starts a new measurement, so the last one is
      // replaced rather than left frozen on the plan.
      if (this.handlers.onRuler) this.handlers.onRuler({ a: world, b: world });
      this.drag = { kind: 'ruler', world };
      return;
    }

    if (hit && hit.kind === 'speaker') {
      if (this.handlers.onSelectSpeaker) this.handlers.onSelectSpeaker(hit.id);
      this.drag = { kind: 'speaker', id: hit.id };
      return;
    }
    if (hit && hit.kind === 'mic') {
      if (this.handlers.onSelectMic) this.handlers.onSelectMic(hit.id);
      this.drag = { kind: 'mic', id: hit.id };
      return;
    }
    if (hit && hit.kind === 'vertex') {
      this.drag = { kind: 'vertex', id: hit.id };
      return;
    }
    this.drag = { kind: 'pan', start: point, origin: { ...this.pan } };
  }

  snap(world) {
    const step = Number(this.state && this.state.snapM) || 0;
    if (!(step > 0)) return { x: world.x, y: world.y };
    return {
      x: Math.round(world.x / step) * step,
      y: Math.round(world.y / step) * step,
    };
  }

  onMove(event) {
    if (!this.state || !this.transform) return;
    const point = this.localPoint(event);
    const world = this.worldPoint(point);
    const state = this.state;

    if (state.view === 'plan' && world && this.handlers.onHover) {
      const snapped = this.snap(world);
      this.handlers.onHover({ x: snapped.x, y: snapped.y, screen: point });
      this.pointer = point;
    }

    if (!this.drag) return;
    if (this.drag.kind === 'pan') {
      this.pan = {
        x: this.drag.origin.x + (point.x - this.drag.start.x),
        y: this.drag.origin.y + (point.y - this.drag.start.y),
      };
      this.draw();
      return;
    }
    if (this.drag.kind === 'ruler' && world) {
      if (this.handlers.onRuler) this.handlers.onRuler({ a: this.drag.world, b: world, live: true });
      return;
    }
    if (this.drag.kind === 'speaker' && state.view === 'plan' && world) {
      const snapped = this.snap(world);
      if (this.handlers.onMoveSpeaker) this.handlers.onMoveSpeaker(this.drag.id, snapped);
      return;
    }
    if (this.drag.kind === 'speaker' && state.view === 'section' && world) {
      if (this.handlers.onMoveSpeaker3d) {
        this.handlers.onMoveSpeaker3d(this.drag.id, {
          y: Math.max(0, world.y),
          z: Math.max(0, world.z),
        });
      }
      return;
    }
    if (this.drag.kind === 'mic' && state.view === 'plan' && world) {
      const snapped = this.snap(world);
      if (this.handlers.onMoveMic) this.handlers.onMoveMic(this.drag.id, snapped);
      return;
    }
    if (this.drag.kind === 'vertex' && state.view === 'plan' && world) {
      const snapped = this.snap(world);
      if (this.handlers.onMoveVertex) {
        this.handlers.onMoveVertex(Number(this.drag.id), snapped);
      }
    }
  }

  onUp() {
    const wasDragging = !!this.drag && this.drag.kind !== 'pan';
    this.drag = null;
    if (wasDragging && this.handlers.onDragEnd) this.handlers.onDragEnd();
  }
}

/* ---------- the response chart under the room ---------- */

/**
 * The predicted response at one microphone. Magnitude above, phase below, on the
 * same 20 Hz – 20 kHz log axis the modeler uses. A curve with no valid phase
 * draws the phase pane empty and says why, rather than inventing a line.
 */
export function drawResponseChart(canvas, data) {
  if (!canvas) return;
  const ratio = DPR();
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(160, Math.round(rect.width || canvas.clientWidth || 600));
  const height = Math.max(120, Math.round(rect.height || canvas.clientHeight || 240));
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0a0f16';
  ctx.fillRect(0, 0, width, height);

  const left = 44;
  const right = 12;
  const top = 10;
  const phaseHeight = Math.round((height - top - 24) * 0.3);
  const magBottom = height - phaseHeight - 34;
  const phaseTop = magBottom + 22;
  const phaseBottom = height - 16;
  const plotWidth = width - left - right;

  const logMin = Math.log(CURVE_FMIN);
  const logMax = Math.log(CURVE_FMAX);
  const xOf = (f) => left + ((Math.log(f) - logMin) / (logMax - logMin)) * plotWidth;

  const frequencies = data && data.frequencies ? data.frequencies : [];
  const magDb = data && data.magDb ? data.magDb : [];
  const phaseDeg = data && data.phaseDeg ? data.phaseDeg : null;

  let max = -Infinity;
  for (let i = 0; i < frequencies.length; i += 1) {
    const value = Number(magDb[i]);
    if (Number.isFinite(value)) max = Math.max(max, value);
  }
  if (!Number.isFinite(max)) max = 0;
  const highDb = Math.ceil((max + 6) / 10) * 10;
  const lowDb = highDb - 60;
  const yOfDb = (db) => magBottom - ((db - lowDb) / (highDb - lowDb)) * (magBottom - top);

  ctx.strokeStyle = 'rgba(120, 140, 165, 0.14)';
  for (let db = lowDb; db <= highDb; db += 10) {
    const y = yOfDb(db);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(width - right, y);
    ctx.stroke();
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = 'rgba(148, 170, 194, 0.75)';
    ctx.fillText(db.toFixed(0) + ' dB', 6, y + 3);
  }
  const ticks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  for (const tick of ticks) {
    const x = xOf(tick);
    ctx.strokeStyle = 'rgba(120, 140, 165, 0.1)';
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, phaseBottom);
    ctx.stroke();
    ctx.fillStyle = 'rgba(148, 170, 194, 0.75)';
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(tick >= 1000 ? tick / 1000 + 'k' : String(tick), x - 6, height - 4);
  }

  if (frequencies.length >= 2) {
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < frequencies.length; i += 1) {
      const value = Number(magDb[i]);
      if (!Number.isFinite(value)) { started = false; continue; }
      const x = xOf(frequencies[i]);
      const y = yOfDb(Math.max(lowDb, Math.min(highDb, value)));
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#5ec8ff';
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  // Phase pane.
  ctx.strokeStyle = 'rgba(120, 140, 165, 0.14)';
  for (const angle of [180, 90, 0, -90, -180]) {
    const y = phaseTop + ((180 - angle) / 360) * (phaseBottom - phaseTop);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(width - right, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(148, 170, 194, 0.7)';
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(angle + '°', 6, y + 3);
  }
  if (phaseDeg && frequencies.length >= 2) {
    ctx.beginPath();
    let started = false;
    let previous = null;
    for (let i = 0; i < frequencies.length; i += 1) {
      const value = Number(phaseDeg[i]);
      if (!Number.isFinite(value)) { started = false; previous = null; continue; }
      if (previous !== null && Math.abs(value - previous) > 300) started = false;
      const x = xOf(frequencies[i]);
      const y = phaseTop + ((180 - Math.max(-180, Math.min(180, value))) / 360) * (phaseBottom - phaseTop);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      previous = value;
    }
    ctx.strokeStyle = '#8ef0b5';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  } else {
    ctx.fillStyle = 'rgba(148, 170, 194, 0.8)';
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(data && data.phaseNote ? data.phaseNote : 'no phase in this prediction',
      left + 8, phaseTop + 16);
  }

  if (data && Number.isFinite(data.cursorHz)) {
    const x = xOf(Math.max(CURVE_FMIN, Math.min(CURVE_FMAX, data.cursorHz)));
    ctx.strokeStyle = 'rgba(255, 209, 102, 0.6)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, phaseBottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255, 209, 102, 0.9)';
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(formatFrequency(data.cursorHz), Math.min(width - 70, x + 6), top + 12);
  }

  ctx.fillStyle = 'rgba(148, 170, 194, 0.75)';
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText('magnitude', left + 4, top + 11);
  ctx.fillText('phase', left + 4, phaseTop - 5);
}

/** The sub-array comparison bar: before and after coverage figures. */
export function drawComparisonBars(canvas, rows) {
  if (!canvas) return;
  const ratio = DPR();
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(160, Math.round(rect.width || canvas.clientWidth || 400));
  const height = Math.max(80, Math.round(rect.height || canvas.clientHeight || 140));
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0a0f16';
  ctx.fillRect(0, 0, width, height);
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return;
  const top = 16;
  const rowHeight = Math.min(26, (height - top - 8) / list.length);
  let max = 0;
  for (const row of list) max = Math.max(max, Math.abs(Number(row.value) || 0));
  max = Math.max(1, max);
  for (const [index, row] of list.entries()) {
    const y = top + index * rowHeight;
    ctx.fillStyle = 'rgba(148, 170, 194, 0.85)';
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(String(row.label).slice(0, 22), 6, y + 11);
    const barWidth = ((Math.abs(Number(row.value) || 0) / max) * (width - 180));
    ctx.fillStyle = row.colour || '#5ec8ff';
    ctx.fillRect(120, y + 2, Math.max(1, barWidth), rowHeight - 6);
    ctx.fillStyle = 'rgba(214, 226, 240, 0.9)';
    ctx.fillText((Number(row.value) || 0).toFixed(1) + (row.unit || ''), 124 + barWidth, y + 11);
  }
}
