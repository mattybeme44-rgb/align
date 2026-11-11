/*
 * Named groups of measurement settings kept in this browser: FFT size,
 * averaging, smoothing, gate, signal, level and reference. A preset can be
 * applied in one tap, renamed, annotated, duplicated or deleted.
 */

export const PRESET_KEY = 'align.presets.v1';
export const PRESET_LIMIT = 20;

function presetId() {
  return 'p' + Date.now().toString(36) + '-' + Math.random().toString(16).slice(2);
}

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizePreset(raw) {
  const item = raw && typeof raw === 'object' ? raw : {};
  return {
    id: typeof item.id === 'string' && item.id ? item.id : presetId(),
    name: typeof item.name === 'string' && item.name.trim()
      ? item.name.trim().slice(0, 80)
      : 'Untitled preset',
    date: typeof item.date === 'string' && !Number.isNaN(new Date(item.date).getTime())
      ? item.date
      : new Date().toISOString(),
    fftSize: [8192, 16384, 32768, 65536].includes(Number(item.fftSize)) ? Number(item.fftSize) : 16384,
    averaging: Math.min(100, Math.max(0, finite(item.averaging, 45))),
    smoothing: [0, 1 / 24, 1 / 12, 1 / 6, 1 / 3].includes(Number(item.smoothing))
      ? Number(item.smoothing)
      : 1 / 6,
    gateEnabled: !!item.gateEnabled,
    gateStartMs: finite(item.gateStartMs, -0.5),
    gateWidthMs: finite(item.gateWidthMs, 20),
    signal: ['pink', 'white', 'sine', 'sweep', 'silent'].includes(item.signal) ? item.signal : 'pink',
    level: Math.min(1, Math.max(0, finite(item.level, 0.2))),
    reference: item.reference === 'loopback' ? 'loopback' : 'internal',
    note: typeof item.note === 'string' ? item.note.slice(0, 160) : '',
  };
}

export function loadPresets() {
  try {
    const raw = window.localStorage.getItem(PRESET_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, PRESET_LIMIT).map(normalizePreset);
  } catch (err) {
    return [];
  }
}

export function persistPresets(items) {
  try {
    window.localStorage.setItem(PRESET_KEY, JSON.stringify(items.slice(0, PRESET_LIMIT)));
    return true;
  } catch (err) {
    return false;
  }
}

export function newPreset(settings, name) {
  return normalizePreset({
    name,
    date: new Date().toISOString(),
    ...settings,
  });
}

export function uniqueCopyName(items, name) {
  const base = name + ' copy';
  let candidate = base;
  let number = 2;
  while (items.some((item) => item.name.toLocaleLowerCase() === candidate.toLocaleLowerCase())) {
    candidate = base + ' ' + number;
    number += 1;
  }
  return candidate;
}
