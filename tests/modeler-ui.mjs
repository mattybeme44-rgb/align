/*
 * System Data Modeler screen check, run with Node:
 *
 *   node tests/modeler-ui.mjs
 *
 * The workspace is built against a stub document — every element the module
 * looks up, a canvas whose drawing calls go nowhere, storage that keeps
 * nothing — and then a real project of two subwoofers is loaded into it and
 * drawn in all four graph modes. It proves the screen's wiring runs without
 * throwing and that every element it asks for is named. It is not a browser:
 * nobody taps a button, no pointer moves, and a layout can still be wrong on a
 * phone. The maths is checked by tests/modeler.mjs; this is the wiring.
 */

let passed = 0;
let failed = 0;

function report(name, pass, detail) {
  if (pass) passed += 1;
  else failed += 1;
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + ' — ' + detail);
}

const ctx = new Proxy({}, {
  get(target, property) {
    if (property === 'measureText') return () => ({ width: 24 });
    if (property === 'canvas') return null;
    return () => {};
  },
  set() { return true; },
});

function makeNode(tag = 'div') {
  const node = {
    tagName: tag.toUpperCase(),
    children: [], options: [], dataset: {}, style: {},
    className: '', textContent: '', hidden: false, value: '', checked: false,
    disabled: false, maxLength: 0, type: '', title: '', width: 800, height: 600,
    classList: {
      add() {}, remove() {}, toggle() {}, contains() { return false; },
    },
    appendChild(child) {
      if (this.tagName === 'SELECT') this.options.push(child);
      else this.children.push(child);
      return child;
    },
    append(...kids) { this.children.push(...kids); },
    prepend(child) { this.children.unshift(child); },
    replaceChildren(...kids) {
      this.children = kids;
      if (this.tagName === 'SELECT') this.options = kids;
    },
    addEventListener() {}, removeEventListener() {}, click() {}, focus() {},
    setPointerCapture() {},
    getBoundingClientRect() { return { width: 900, height: 620, left: 0, top: 0 }; },
  };
  node.parentElement = null;
  if (tag === 'canvas') {
    node.getContext = () => ctx;
    node.parentElement = { appendChild() {}, addEventListener() {} };
  }
  return node;
}

const elements = new Map();
globalThis.document = {
  getElementById(id) {
    if (!elements.has(id)) {
      elements.set(id, makeNode(id.endsWith('Chart') ? 'canvas' : 'div'));
    }
    return elements.get(id);
  },
  createElement(tag) { return makeNode(tag); },
  querySelectorAll() { return []; },
  querySelector() { return null; },
  addEventListener() {},
};
globalThis.window = {
  devicePixelRatio: 2,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  confirm: () => true,
};
globalThis.requestAnimationFrame = (callback) => callback(0);
globalThis.ResizeObserver = class { observe() {} disconnect() {} };

const { createDataModeler } = await import('../js/modeler/ui.js');
const { gridFrequencies } = await import('../js/modeler/curve.js');

const frequencies = gridFrequencies(400);
const dataset = {
  id: 'd1',
  label: 'Sub 1 measured',
  provenance: 'measured',
  curve: {
    magDb: Array.from(frequencies, (frequency) =>
      -3 - Math.log10(Math.max(frequency, 20) / 20) * 2),
    phaseDeg: Array.from(frequencies, (frequency) => -360 * frequency * 0.002),
    coherence: Array.from(frequencies, () => 0.9),
  },
  fMin: 20,
  fMax: 20000,
  sampleRate: 48000,
  fftSize: 16384,
  delayMs: 2,
};

const model = {
  id: 'm1',
  name: 'Pioneer XY-218HS-B',
  manufacturer: 'Pioneer',
  model: 'XY-218HS-B',
  type: 'Subwoofer',
  impedanceOhm: 8,
  sensitivityDb: 99,
  distanceM: 2,
  referenceDelayMs: 0,
  datasets: [dataset],
};

let opened = false;
const modeler = createDataModeler({
  setStatus() {},
  library: () => [],
  live: () => null,
  held: () => [],
  persist: () => true,
  share() {},
  onOpen: () => { opened = true; },
  onClose: () => { opened = false; },
});

try {
  modeler.open();
  report('The workspace opens', modeler.active && opened, 'active ' + modeler.active);
} catch (error) {
  report('The workspace opens', false, 'threw: ' + (error && error.message));
}

try {
  modeler.setProject({
    models: [model],
    sources: [
      {
        id: 's1', modelId: 'm1', datasetId: 'd1', name: 'Sub 1', groupId: '',
        gainDb: 0, delayMs: 3, polarity: 'normal', muted: false, soloed: false, filters: [],
      },
      {
        id: 's2', modelId: 'm1', datasetId: 'd1', name: 'Sub 2', groupId: '',
        gainDb: -2, delayMs: 3.5, polarity: 'inverted', muted: false, soloed: false,
        filters: [{ id: 'f1', kind: 'lowPass', frequency: 80, gainDb: 0, q: 0.7071, enabled: true }],
      },
    ],
    groups: [],
    positions: [{ id: 'centre', label: 'Centre', weight: 1 }],
    settings: {},
  });
  const loaded = modeler.project;
  report('A project of two real datasets is loaded',
    loaded.models.length === 1 && loaded.sources.length === 2 &&
      loaded.models[0].datasets[0].curve.magDb.length === 400,
    loaded.sources.length + ' sources, ' +
      (loaded.models[0] ? loaded.models[0].datasets[0].curve.magDb.length : 0) + ' points');
} catch (error) {
  report('A project of two real datasets is loaded', false, 'threw: ' + (error && error.message));
}

for (const view of ['transfer', 'groupdelay', 'impulse', 'difference']) {
  try {
    modeler.project.settings.view = view;
    modeler.project.settings.phaseMode = view === 'transfer' ? 'unwrapped' : 'wrapped';
    modeler.project.settings.smoothing = 0.166667;
    modeler.project.settings.dbSpan = 40;
    modeler.refresh();
    report('The ' + view + ' graph is drawn', true, 'drawn without throwing');
  } catch (error) {
    report('The ' + view + ' graph is drawn', false, 'threw: ' + (error && error.message));
  }
}

/* Every element the screen asks for must be named in index.html. */
try {
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../js/modeler/ui.js', import.meta.url), 'utf8');
  const wanted = new Set([...source.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((match) => match[1]));
  const present = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]));
  const missing = [...wanted].filter((id) => !present.has(id));
  report('Every element the screen reads is in index.html', missing.length === 0,
    wanted.size + ' elements checked, ' + (missing.length ? 'missing ' + missing.join(', ') : 'none missing'));
} catch (error) {
  report('Every element the screen reads is in index.html', false, 'threw: ' + (error && error.message));
}

try {
  modeler.close();
  report('The workspace closes', !modeler.active && !opened, 'active ' + modeler.active);
} catch (error) {
  report('The workspace closes', false, 'threw: ' + (error && error.message));
}

console.log('');
console.log(passed + ' passed · ' + failed + ' failed');
if (failed) process.exitCode = 1;
