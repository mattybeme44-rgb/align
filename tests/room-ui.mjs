/*
 * Room Designer screen check, run with Node:
 *
 *   node tests/room-ui.mjs
 *
 * The workspace is built against a stub document with no layout — every element
 * it looks up, a canvas whose drawing calls go nowhere — and then the Pioneer
 * warehouse project is loaded into it, demonstration responses are attached to
 * its cabinets, the map and the response are computed, a subwoofer array is
 * applied and a virtual microphone is sent to the Data Modeler.
 *
 * It proves the wiring runs, that every element the screen asks for is named in
 * index.html, and that there are no duplicate ids. It is not a browser: nobody
 * taps a button and no pointer moves, so a layout can still be wrong on a
 * phone. The maths is checked by tests/room.mjs.
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
    if (property === 'createLinearGradient' || property === 'createRadialGradient') {
      return () => ({ addColorStop() {} });
    }
    if (property === 'createImageData') {
      return (width, height) => ({ data: new Uint8ClampedArray(Math.max(1, width * height * 4)) });
    }
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

const canvasIds = new Set(['rdCanvas', 'rdChart', 'rdCompareChart', 'dmChart', 'dmSweep']);

const elements = new Map();
globalThis.document = {
  getElementById(id) {
    if (!elements.has(id)) {
      elements.set(id, makeNode(canvasIds.has(id) || id.includes('Chart') ? 'canvas' : 'div'));
    }
    return elements.get(id);
  },
  createElement(tag) { return makeNode(tag); },
  querySelectorAll() { return []; },
  querySelector() { return null; },
  addEventListener() {},
  createElementNS() { return makeNode('canvas'); },
};
globalThis.window = {
  devicePixelRatio: 2,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  confirm: () => true,
};
globalThis.requestAnimationFrame = (callback) => callback(0);
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.Path2D = class {
  moveTo() {}
  lineTo() {}
  closePath() {}
};

const { createDataModeler } = await import('../js/modeler/ui.js');
const { createRoomDesigner } = await import('../js/modeler/roomui.js');

let modelerOpen = false;
let roomOpen = false;

const modeler = createDataModeler({
  setStatus() {},
  library: () => [],
  live: () => null,
  held: () => [],
  persist: () => true,
  share() {},
  onOpen: () => { modelerOpen = true; },
  onClose: () => { modelerOpen = false; },
});

const roomDesigner = createRoomDesigner({
  modeler,
  library: () => [{
    id: 'cap-1',
    name: 'FOH centre capture',
    date: new Date().toISOString(),
    curve: new Array(400).fill(-6),
    delayMs: 2,
  }],
  setStatus() {},
  share() {},
  onOpen: () => { roomOpen = true; },
  onClose: () => { roomOpen = false; },
});

try {
  roomDesigner.open();
  report('The Room Designer opens', roomDesigner.active && roomOpen,
    'active ' + roomDesigner.active + ', project room “' + roomDesigner.room.name + '”');
} catch (error) {
  report('The Room Designer opens', false, 'threw: ' + (error && error.message));
}

try {
  document.getElementById('chkRdHeatmap').checked = true;
  roomDesigner.loadWarehouse();
  const sources = modeler.project.sources;
  const room = modeler.project.room;
  report('The Pioneer warehouse loads into the shared project',
    sources.length === 16 && Math.abs(room.size.widthM - 41 / 3.280839895) < 0.01 &&
      room.ceiling === 'aframe' && room.mics.length === 3,
    sources.length + ' cabinets, ' + room.size.widthM.toFixed(2) + ' × ' +
      room.size.lengthM.toFixed(2) + ' m, ' + room.mics.length + ' microphones');
} catch (error) {
  report('The Pioneer warehouse loads into the shared project', false, 'threw: ' + (error && error.stack));
}

try {
  roomDesigner.loadDemo();
  const withData = modeler.project.sources.filter((source) => source.datasetId);
  const labelled = modeler.project.models
    .filter((model) => model.datasets.length)
    .every((model) => model.datasets.every((dataset) =>
      /DEMONSTRATION/.test(dataset.label) && dataset.provenance === 'theoretical'));
  report('Demonstration responses are attached and labelled',
    withData.length === 16 && labelled,
    withData.length + ' cabinets with data, every dataset labelled DEMONSTRATION and theoretical');
} catch (error) {
  report('Demonstration responses are attached and labelled', false, 'threw: ' + (error && error.message));
}

try {
  roomDesigner.recalculate();
  const map = roomDesigner.heatmap;
  const prediction = roomDesigner.prediction;
  report('The map and the response are computed',
    !!map && map.ok && !!prediction && prediction.ok &&
      Number.isFinite(map.statistics.rangeDb) && map.computed > 100,
    (map ? map.cols + '×' + map.rows + ' map, ' + map.computed + ' cells, range ' +
      map.statistics.rangeDb.toFixed(1) + ' dB' : 'no map') +
      (prediction ? ', ' + prediction.contributions.length + ' contributions at the microphone' : ''));
} catch (error) {
  report('The map and the response are computed', false, 'threw: ' + (error && error.message));
}

try {
  const before = roomDesigner.heatmap ? roomDesigner.heatmap.statistics.rangeDb : NaN;
  document.getElementById('rdArrayPreset').value = 'endfire';
  document.getElementById('rdArrayCount').value = '8';
  document.getElementById('rdArraySpacing').value = '1.07';
  document.getElementById('rdArrayFreq').value = '80';
  roomDesigner.applyArray();
  const after = roomDesigner.heatmap ? roomDesigner.heatmap.statistics.rangeDb : NaN;
  const delayed = modeler.project.sources.filter((source) => source.room && source.room.role === 'sub' && source.delayMs > 0);
  report('The end-fire array is applied to the cabinets',
    delayed.length >= 7 && Number.isFinite(before) && Number.isFinite(after),
    delayed.length + ' subwoofers delayed, range ' + before.toFixed(1) + ' → ' + after.toFixed(1) + ' dB');
} catch (error) {
  report('The end-fire array is applied to the cabinets', false, 'threw: ' + (error && error.message));
}

try {
  document.getElementById('rdMicCapture').value = 'cap-1';
  document.getElementById('btnRdAssociateCapture').value = '';
  roomDesigner.recalculate();
  const mic = roomDesigner.room.mics.find((entry) => entry.id === roomDesigner.room.settings.refMicId);
  report('A reference microphone exists for the map', !!mic,
    mic ? 'reference “' + mic.name + '” at ' + mic.x.toFixed(1) + ', ' + mic.y.toFixed(1) + ' m' : 'none');
} catch (error) {
  report('A reference microphone exists for the map', false, 'threw: ' + (error && error.message));
}

try {
  const before = modeler.project.models.length;
  const result = roomDesigner.sendMicToModeler();
  const added = modeler.project.models.length - before;
  const theoretical = modeler.project.models.some((model) =>
    model.datasets.some((dataset) => /Room prediction/.test(dataset.label) &&
      dataset.provenance === 'theoretical'));
  report('A virtual microphone is sent to the Data Modeler',
    added >= 1 && theoretical && !roomDesigner.active,
    'models ' + before + ' → ' + modeler.project.models.length +
      ', prediction stored as theoretical data');
  void result;
} catch (error) {
  report('A virtual microphone is sent to the Data Modeler', false, 'threw: ' + (error && error.message));
}

try {
  roomDesigner.open();
  const shape = roomDesigner.room.shape;
  roomDesigner.setRoom({
    name: 'Custom room',
    shape: 'custom',
    outline: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 8 }, { x: 6, y: 8 }, { x: 6, y: 16 }, { x: 0, y: 16 }],
    wallHeightM: 5,
    ceiling: 'aframe',
    riseM: 4,
    ridgeX: 6,
  });
  report('A custom room is accepted', roomDesigner.room.shape === 'custom' &&
    roomDesigner.room.outline.length === 6,
    'was ' + shape + ', now ' + roomDesigner.room.shape + ' with ' +
      roomDesigner.room.outline.length + ' points');
} catch (error) {
  report('A custom room is accepted', false, 'threw: ' + (error && error.message));
}

/* Every element the screen asks for must be named, exactly once, in index.html. */
try {
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../js/modeler/roomui.js', import.meta.url), 'utf8');
  const wanted = new Set();
  for (const pattern of [
    /\$\('([A-Za-z0-9_-]+)'\)/g,
    /(?:setValue|setText|readNumber|readText|readSelect|fillSelect|checked|on)\('([A-Za-z0-9_-]+)'/g,
  ]) {
    for (const match of source.matchAll(pattern)) wanted.add(match[1]);
  }
  const present = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]));
  const missing = [...wanted].filter((id) => !present.has(id));
  report('Every element the screen reads is in index.html', missing.length === 0,
    wanted.size + ' elements checked, ' + (missing.length ? 'missing ' + missing.join(', ') : 'none missing'));

  const duplicates = [...html.matchAll(/ id="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((id, index, list) => list.indexOf(id) !== index);
  report('No duplicate ids in index.html', duplicates.length === 0,
    duplicates.length ? 'duplicated: ' + [...new Set(duplicates)].join(', ') : 'none');
} catch (error) {
  report('Every element the screen reads is in index.html', false, 'threw: ' + (error && error.message));
}

try {
  roomDesigner.close();
  report('The Room Designer closes', !roomDesigner.active && !roomOpen,
    'active ' + roomDesigner.active);
} catch (error) {
  report('The Room Designer closes', false, 'threw: ' + (error && error.message));
}

console.log('');
console.log(passed + ' passed · ' + failed + ' failed');
if (failed) process.exitCode = 1;
