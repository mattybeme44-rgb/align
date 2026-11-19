/*
 * Graph Appearance — one configuration that every graph reads from.
 *
 * This module owns how measurement graphs are *drawn*: trace brightness,
 * saturation, thickness, opacity, glow, graph background, gridline contrast,
 * axis and label brightness, coherence intensity and cursor visibility, plus
 * named presets, per-graph overrides and custom presets kept between sessions.
 *
 * It never touches a number the measurement produced. Every helper here takes
 * a colour or a line width and returns a drawing value; the analyser's arrays,
 * the DSP and the timing are none of its business. There is no global CSS
 * filter — each stroke is adjusted individually, so interface panels, meters
 * and heatmap legends keep their own colours.
 */

const STORAGE_KEY = 'align.graphAppearance.v1';

/**
 * The base trace palette. Every graphing component reads these as its starting
 * colours: electric cyan, bright mint, warm amber, brilliant blue, violet,
 * magenta, lime and yellow, each distinct from its neighbours.
 */
export const PALETTE = {
  trace: '#2fe6ff',                       // live magnitude — electric cyan
  phase: '#2bf2b6',                       // live phase — vibrant mint
  coh: '#ffb54a',                         // coherence — warm amber
  ghost: 'rgba(232, 250, 255, 0.92)',     // capture A — bright ice
  ghostB: 'rgba(84, 172, 255, 0.94)',     // capture B — brilliant blue
  ghostC: 'rgba(186, 132, 255, 0.94)',    // capture C — saturated violet
  ghostD: 'rgba(255, 176, 82, 0.94)',     // capture D — warm orange
  ghostE: 'rgba(56, 228, 245, 0.92)',     // capture E — cyan-sky
  ghostF: 'rgba(255, 92, 200, 0.94)',     // capture F — rich magenta
  peak: 'rgba(47, 230, 255, 0.36)',       // peak hold — cyan pin
  average: '#ff7ad1',                     // running average — pink
  overlay: '#bb93ff',                     // saved overlays — purple
  savedColors: ['#bb93ff', '#ffb36b', '#5ec8ff', '#ff8fb8', '#7de87a', '#ffe066', '#5fded4', '#e8a68f'],
  target: 'rgba(206, 222, 240, 0.52)',    // target curve — cool grey-blue
  cursor: 'rgba(255, 138, 110, 0.62)',    // cursor — coral
  sumTrace: '#ffd24a',                    // predicted sum — yellow
  halo: 'rgba(8, 12, 20, 0.92)',          // laid under traces so crossings stay separate
  bg: '#0b101a',
};

const DEFAULTS = {
  preset: 'Vibrant',
  brightness: 95,      // 80 = natural colour strength; higher pushes traces brighter
  saturation: 135,     // 100 = base saturation
  thickness: 'medium', // thin | medium | thick | custom
  thicknessPx: 2.2,    // used when thickness is custom
  opacity: 100,        // 100 = fully drawn
  glow: 'subtle',      // off | subtle | enhanced
  background: 30,      // graph panel brightness, 0 = near black, 100 = light professional
  gridMajor: 62,       // major gridline contrast
  gridMinor: 52,       // minor gridline contrast
  axis: 88,            // axis and label brightness
  coherence: 100,      // coherence display intensity
  cursor: 100,         // cursor and marker visibility
};

/** Named presets. Each is a complete global configuration. */
const PRESETS = {
  'Studio Dark':    { brightness: 80,  saturation: 100, thickness: 'medium', opacity: 100, glow: 'off',
                      background: 32,  gridMajor: 55, gridMinor: 45, axis: 75,
                      coherence: 100, cursor: 100 },
  'High Visibility':{ brightness: 95,  saturation: 118, thickness: 'medium', opacity: 100, glow: 'subtle',
                      background: 26,  gridMajor: 70, gridMinor: 55, axis: 90,
                      coherence: 100, cursor: 100 },
  'Daylight':       { brightness: 100, saturation: 92,  thickness: 'thick',  opacity: 100, glow: 'off',
                      background: 78,  gridMajor: 88, gridMinor: 72, axis: 100,
                      coherence: 100, cursor: 100 },
  'Vibrant':        { brightness: 95,  saturation: 135, thickness: 'medium', opacity: 100, glow: 'subtle',
                      background: 30,  gridMajor: 60, gridMinor: 48, axis: 85,
                      coherence: 100, cursor: 100 },
  'Minimal Technical': { brightness: 60, saturation: 55, thickness: 'thin', opacity: 85, glow: 'off',
                      background: 20,  gridMajor: 30, gridMinor: 18, axis: 55,
                      coherence: 70,  cursor: 70 },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ---------- storage ---------- */

function readStore() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

function writeStore(data) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch (err) {
    return false;
  }
}

/* ---------- colour maths ---------- */

function parseColor(str) {
  const text = String(str).trim();
  if (text[0] === '#') {
    let hex = text.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: 1,
    };
  }
  const match = text.match(/^rgba?\(([^)]+)\)$/);
  if (match) {
    const parts = match[1].split(',').map((part) => parseFloat(part));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  return null;
}

const clamp8 = (v) => clamp(Math.round(v), 0, 255);

/**
 * Brightness scales the colour away from black (so a hue keeps its character),
 * saturation pulls every channel toward or away from its own luminance.
 */
function adjust(rgb, cfg) {
  const bright = clamp(cfg.brightness / 80, 0.1, 1.8); // 80 = natural strength
  const sat = clamp(cfg.saturation / 100, 0, 1.6);
  let r = rgb.r * bright;
  let g = rgb.g * bright;
  let b = rgb.b * bright;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  r = lum + (r - lum) * sat;
  g = lum + (g - lum) * sat;
  b = lum + (b - lum) * sat;
  return { r: clamp8(r), g: clamp8(g), b: clamp8(b) };
}

function build(cfg, colorOrKey, alphaOverride) {
  const base = PALETTE[colorOrKey] !== undefined ? PALETTE[colorOrKey] : colorOrKey;
  const parsed = parseColor(base) || parseColor('#9fb4c8');
  const { r, g, b } = adjust(parsed, cfg);
  const alpha = alphaOverride !== undefined ? alphaOverride : clamp(parsed.a * (cfg.opacity / 100), 0, 1);
  return `rgba(${r}, ${g}, ${b}, ${Number(alpha.toFixed(3))})`;
}

/* ---------- module state ---------- */

const stored = readStore();
let global_ = Object.assign({}, DEFAULTS, stored.config || {});
let overrides = stored.overrides || {};
let customs = Array.isArray(stored.custom) ? stored.custom.slice(0, 12) : [];
let active = global_;
let listeners = [];
let revision = 0;
const cache = new Map();

function persist() {
  return writeStore({ config: global_, overrides, custom: customs });
}

function changed() {
  revision += 1;
  cache.clear();
  persist();
  for (const listener of listeners) {
    try { listener(); } catch (err) { /* one bad listener must not stop the rest */ }
  }
}

export const appearance = {
  /** The vibrant base palette, exported so every graphing component shares it. */
  PALETTE,

  /** The global configuration (a copy — mutate through set/applyPreset). */
  config: () => Object.assign({}, global_),

  presetNames: () => Object.keys(PRESETS),

  customPresets: () => customs.map((item) => item.name),

  applyPreset(name) {
    const preset = PRESETS[name];
    if (!preset) return false;
    global_ = Object.assign({}, DEFAULTS, preset, { preset: name });
    changed();
    return true;
  },

  /** Patch the global configuration (or the override for `scope`, if given). */
  set(patch, scope) {
    const keys = Object.keys(patch || {});
    if (!keys.length) return;
    if (scope && scope !== 'global') {
      // The override inherits the global look and patches on top of it, so
      // moving one slider never resets the keys that were not touched.
      const current = this.cfgFor(scope);
      for (const key of keys) {
        if (key in DEFAULTS) current[key] = patch[key];
      }
      overrides[scope] = current;
    } else {
      for (const key of keys) {
        if (key in DEFAULTS) global_[key] = patch[key];
        if (key === 'brightness' || key === 'saturation' || key === 'thickness' ||
            key === 'opacity' || key === 'glow') {
          global_.preset = 'custom';
        }
      }
    }
    changed();
  },

  /** The effective configuration for one graph: its override merged over global. */
  cfgFor(key) {
    if (!key || key === 'global' || !overrides[key]) return global_;
    return Object.assign({}, global_, overrides[key]);
  },

  /** Graphs call this at the start of a draw and the matching end. */
  beginGraph(key) { active = this.cfgFor(key); },
  endGraph() { active = global_; },

  clearOverride(key) {
    if (!overrides[key]) return;
    delete overrides[key];
    changed();
  },

  hasOverride: (key) => Boolean(overrides[key]),

  reset() {
    global_ = Object.assign({}, DEFAULTS, PRESETS['Vibrant'], { preset: 'Vibrant' });
    overrides = {};
    changed();
  },

  saveCustomPreset(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return false;
    customs = customs.filter((item) => item.name !== trimmed);
    customs.unshift({ name: trimmed, config: Object.assign({}, global_) });
    if (customs.length > 12) customs.length = 12;
    changed();
    return true;
  },

  applyCustomPreset(name) {
    const found = customs.find((item) => item.name === name);
    if (!found) return false;
    global_ = Object.assign({}, DEFAULTS, found.config, { preset: name });
    changed();
    return true;
  },

  deleteCustomPreset(name) {
    customs = customs.filter((item) => item.name !== name);
    changed();
  },

  subscribe(listener) {
    listeners.push(listener);
  },

  /* ---------- values the graphs draw with ---------- */

  /** Colour adjusted for the active graph: brightness, saturation, opacity. */
  colorize(colorOrKey) {
    const cfg = active;
    const key = colorOrKey + '|' + revision;
    if (cache.has(key)) return cache.get(key);
    const out = build(cfg, colorOrKey);
    cache.set(key, out);
    return out;
  },

  /** Line width scaled by the trace thickness setting. */
  width(px) {
    const cfg = active;
    const base = typeof px === 'number' && px > 0 ? px : 1;
    if (cfg.thickness === 'thin') return base * 0.85;
    if (cfg.thickness === 'thick') return base * 1.35;
    if (cfg.thickness === 'custom') return Math.max(0.5, cfg.thicknessPx);
    return base;
  },

  /** A colour rebuilt with an exact alpha (traces' opacity still applies). */
  rgba(colorOrKey, alpha) {
    return build(active, colorOrKey, clamp(alpha * (active.opacity / 100), 0, 1));
  },

  panelBg() {
    const t = clamp(global_.background / 100, 0, 1);
    // Dark charcoal → deep navy → lighter professional blue.
    const stops = [[10, 12, 18], [16, 23, 37], [42, 52, 72]];
    const segment = t < 0.5 ? 0 : 1;
    const local = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
    const from = stops[segment];
    const to = stops[segment + 1];
    const mix = (a, b) => Math.round(a + (b - a) * local);
    return `rgb(${mix(from[0], to[0])}, ${mix(from[1], to[1])}, ${mix(from[2], to[2])})`;
  },

  panelBorder: () => `rgba(160, 190, 255, ${0.08 + (global_.background / 100) * 0.10})`,

  gridMajor: () => `rgba(178, 200, 255, ${0.05 + (global_.gridMajor / 100) * 0.28})`,
  gridMinor: () => `rgba(178, 200, 255, ${0.03 + (global_.gridMinor / 100) * 0.15})`,
  gridZero: () => `rgba(200, 216, 255, ${0.16 + (global_.gridMajor / 100) * 0.30})`,

  axisText: () => `rgba(226, 236, 248, ${0.30 + (global_.axis / 100) * 0.70})`,
  axisDim: () => `rgba(178, 194, 214, ${0.22 + (global_.axis / 100) * 0.55})`,

  /** Coherence displays keep their values; only their drawing intensity moves. */
  coherenceFactor: () => clamp(global_.coherence / 100, 0, 1.2),

  cursorColor: () => `rgba(255, 138, 110, ${0.15 + (global_.cursor / 100) * 0.65})`,
  cursorWidth(px) {
    return (typeof px === 'number' && px > 0 ? px : 1) * (0.8 + (global_.cursor / 100) * 0.6);
  },

  /** The glow pass strength, or null when glow is off. The crisp line is
   *  always stroked last at its exact width, so glow never blurs the trace. */
  glowStrength() {
    if (global_.glow === 'subtle') return { width: 3.0, alpha: 0.18 };
    if (global_.glow === 'enhanced') return { width: 5.2, alpha: 0.30 };
    return null;
  },

  /* ---------- the Display panel ---------- */

  bindPanel() {
    if (typeof document === 'undefined') return;
    const $ = (id) => document.getElementById(id);
    const presetRow = $('gapPresetRow');
    if (!presetRow) return;

    const scope = () => $('selGapScope').value;
    const cfgNow = () => this.cfgFor(scope());

    const reflect = () => {
      const cfg = cfgNow();
      const link = (id, key) => {
        $(id).value = cfg[key];
        $('gap' + id.replace('gap', '') + 'Val').textContent = String(cfg[key]);
      };
      link('gapBrightness', 'brightness');
      link('gapSaturation', 'saturation');
      link('gapOpacity', 'opacity');
      link('gapBackground', 'background');
      link('gapGrid', 'gridMajor');
      link('gapGridMinor', 'gridMinor');
      link('gapAxis', 'axis');
      link('gapCoherence', 'coherence');
      link('gapCursor', 'cursor');
      $('selGapThickness').value = cfg.thickness;
      $('numGapThickness').hidden = cfg.thickness !== 'custom';
      if (cfg.thickness === 'custom') $('numGapThickness').value = cfg.thicknessPx;
      $('selGapGlow').value = cfg.glow;
      $('btnGapClearOverride').hidden = scope() === 'global' || !this.hasOverride(scope());
      renderPresets();
    };

    const renderPresets = () => {
      presetRow.textContent = '';
      for (const name of this.presetNames()) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn' + (global_.preset === name ? ' on' : '');
        button.textContent = name;
        button.addEventListener('click', () => this.applyPreset(name));
        presetRow.appendChild(button);
      }
      const customRow = $('gapCustomRow');
      customRow.textContent = '';
      for (const name of this.customPresets()) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'btn' + (global_.preset === name ? ' on' : '');
        chip.textContent = name + ' ✕';
        chip.title = 'Apply · click ✕ area twice to delete';
        chip.addEventListener('click', (event) => {
          if (event.offsetX > chip.offsetWidth - 18 && customs.some((item) => item.name === name)) {
            this.deleteCustomPreset(name);
          } else {
            this.applyCustomPreset(name);
          }
        });
        customRow.appendChild(chip);
      }
      customRow.hidden = customs.length === 0;
    };

    const slider = (id, key) => {
      $(id).addEventListener('input', (event) => {
        this.set({ [key]: Number(event.target.value) }, scope());
      });
    };
    slider('gapBrightness', 'brightness');
    slider('gapSaturation', 'saturation');
    slider('gapOpacity', 'opacity');
    slider('gapBackground', 'background');
    slider('gapGrid', 'gridMajor');
    slider('gapGridMinor', 'gridMinor');
    slider('gapAxis', 'axis');
    slider('gapCoherence', 'coherence');
    slider('gapCursor', 'cursor');

    $('selGapThickness').addEventListener('change', (event) => {
      this.set({ thickness: event.target.value }, scope());
    });
    $('numGapThickness').addEventListener('input', (event) => {
      this.set({ thicknessPx: Number(event.target.value) || 2 }, scope());
    });
    $('selGapGlow').addEventListener('change', (event) => {
      this.set({ glow: event.target.value }, scope());
    });
    $('selGapScope').addEventListener('change', reflect);
    $('btnGapClearOverride').addEventListener('click', () => this.clearOverride(scope()));
    $('btnGapDefaults').addEventListener('click', () => this.reset());
    $('btnGapSave').addEventListener('click', () => {
      if (this.saveCustomPreset($('gapPresetName').value)) $('gapPresetName').value = '';
    });

    this.subscribe(reflect);
    reflect();
  },
};
