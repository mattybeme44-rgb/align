/*
 * The subwoofer array's layout checks, run with Node:
 *
 *   node tests/sub-array.mjs
 *
 * Every case has an answer that can be worked out on paper: a 2 × 4 grid
 * numbered 7/5/3/1 over 8/6/4/2 from the left, a 1 × 4 row numbered 4..1, a
 * resize that keeps a cabinet's name, group and slot only while its number
 * survives, and an arrival difference of +0.42 ms against the first measured
 * box. Nothing here is a measurement: the screen reads and stores captures, and
 * the slots themselves are checked in the browser.
 */

import {
  SUB_ARRAY_KEY,
  assignSubArraySlot,
  loadSubArray,
  makeSubArray,
  normalizeSubArray,
  persistSubArray,
  setSubCabinet,
  subArrayArrivals,
  subArrayOrdered,
  subArrayRow,
  subArraySlot,
  subCabinetName,
} from '../js/sub-array.js';

let passed = 0;
let failed = 0;

function report(name, pass, detail) {
  if (pass) passed += 1;
  else failed += 1;
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + ' — ' + detail);
}

function close(value, expected, tolerance) {
  return Number.isFinite(value) && Math.abs(value - expected) <= tolerance;
}

function numbersOf(layout) {
  return layout.cabinets.map((cabinet) => cabinet.number).sort((a, b) => a - b);
}

/* ---------- numbering ---------- */

{
  const layout = makeSubArray(2, 4);
  report('the default array is two rows of four',
    layout.rows === 2 && layout.columns === 4 && layout.cabinets.length === 8,
    layout.rows + ' × ' + layout.columns + ' · ' + layout.cabinets.length + ' cabinets');

  const top = subArrayRow(layout, 0).map((cabinet) => cabinet.number);
  const bottom = subArrayRow(layout, 1).map((cabinet) => cabinet.number);
  report('the top row is numbered in pairs from the right',
    top.join(',') === '7,5,3,1', 'top ' + top.join('/'));
  report('the bottom row is numbered in pairs from the right',
    bottom.join(',') === '8,6,4,2', 'bottom ' + bottom.join('/'));
  report('cabinet 1 is the right-most box of the top row',
    subArrayRow(layout, 0).slice(-1)[0].number === 1,
    'right-most column ' + subArrayRow(layout, 0).slice(-1)[0].column);
  report('every number is used once and runs 1..8',
    numbersOf(layout).join(',') === '1,2,3,4,5,6,7,8',
    numbersOf(layout).join(','));

  const single = makeSubArray(1, 4);
  report('a single row is numbered from the right',
    subArrayRow(single, 0).map((cabinet) => cabinet.number).join(',') === '4,3,2,1',
    subArrayRow(single, 0).map((cabinet) => cabinet.number).join('/'));

  const three = makeSubArray(3, 4);
  report('three rows are numbered row by row from the right',
    subArrayRow(three, 0).map((cabinet) => cabinet.number).join(',') === '4,3,2,1' &&
    subArrayRow(three, 1).map((cabinet) => cabinet.number).join(',') === '8,7,6,5' &&
    subArrayRow(three, 2).map((cabinet) => cabinet.number).join(',') === '12,11,10,9',
    '12 cabinets, right-most box 1 in the top row');

  const clamped = makeSubArray(9, 12);
  report('the grid is clamped to four rows of eight',
    clamped.rows === 4 && clamped.columns === 8 && clamped.cabinets.length === 32,
    clamped.rows + ' × ' + clamped.columns);

  report('the ordered list reads left to right, top row first',
    subArrayOrdered(makeSubArray(2, 2)).map((cabinet) => cabinet.number).join(',') === '3,1,4,2',
    subArrayOrdered(makeSubArray(2, 2)).map((cabinet) => cabinet.number).join('/'));
}

/* ---------- names, groups and slots ---------- */

{
  let layout = makeSubArray(2, 4);
  layout = setSubCabinet(layout, 1, '  Front right  ', 'front row');
  layout = setSubCabinet(layout, 3, 'Sub three', '');
  layout = assignSubArraySlot(layout, [1, 3], 'a');

  report('a cabinet name is trimmed', layout.cabinets.find((entry) => entry.number === 1).label === 'Front right',
    '"' + layout.cabinets.find((entry) => entry.number === 1).label + '"');
  report('a slot letter is stored in upper case', subArraySlot(layout, 1) === 'A' &&
    subArraySlot(layout, 3) === 'A', 'A for cabinets 1 and 3');
  report('a cabinet with no name reads as its number',
    subCabinetName(layout.cabinets.find((entry) => entry.number === 2)) === 'Sub 2',
    subCabinetName(layout.cabinets.find((entry) => entry.number === 2)));

  const smaller = makeSubArray(2, 3, layout);
  report('resizing keeps the names and slots that still belong',
    subCabinetName(smaller.cabinets.find((entry) => entry.number === 1)) === 'Front right' &&
    subArraySlot(smaller, 1) === 'A' && subArraySlot(smaller, 3) === 'A',
    'cabinets 1 and 3 survive a 2 × 3 grid');
  report('resizing keeps a group and drops a cabinet that is gone',
    smaller.cabinets.find((entry) => entry.number === 1).group === 'front row' &&
    !smaller.cabinets.some((entry) => entry.number === 7),
    smaller.cabinets.length + ' cabinets');
  report('a surviving number keeps the box in its new cell',
    smaller.cabinets.find((entry) => entry.number === 3).row === 0 &&
    smaller.cabinets.find((entry) => entry.number === 3).column === 1,
    'cabinet 3 at row 0, column 1');

  const wider = makeSubArray(3, 4, layout);
  report('growing the array keeps the stored names',
    subCabinetName(wider.cabinets.find((entry) => entry.number === 1)) === 'Front right' &&
    subArraySlot(wider, 3) === 'A' && wider.cabinets.length === 12,
    '12 cabinets, the old names kept');

  report('a name is limited to 24 characters',
    setSubCabinet(layout, 1, 'x'.repeat(40), '').cabinets
      .find((entry) => entry.number === 1).label.length === 24,
    '24 characters');
  report('an unknown slot letter is ignored',
    assignSubArraySlot(layout, [2], 'G').slots['2'] === undefined,
    'no slot for G');
  report('an unknown cabinet is ignored',
    assignSubArraySlot(layout, [99], 'B').slots['99'] === undefined &&
    setSubCabinet(layout, 99, 'x', 'y') === layout,
    'nothing changed');

  const cleared = assignSubArraySlot(makeSubArray(2, 2), [], 'B');
  report('an empty selection attaches no slot', Object.keys(cleared.slots).length === 0,
    'no slots');
}

/* ---------- normalized layouts ---------- */

{
  const layout = normalizeSubArray({
    rows: 2,
    columns: 3,
    cabinets: [
      { number: 1, label: 'First', group: 'front', row: 0, column: 2 },
      { number: 9, label: 'Gone', group: 'x', row: 1, column: 0 },
    ],
    slots: { 1: 'B', 9: 'C', 2: 'bogus' },
  });
  report('a stored layout is rebuilt to its size',
    layout.rows === 2 && layout.columns === 3 && layout.cabinets.length === 6,
    layout.rows + ' × ' + layout.columns);
  report('a valid name and slot survive normalising',
    subCabinetName(layout.cabinets.find((entry) => entry.number === 1)) === 'First' &&
    subArraySlot(layout, 1) === 'B', 'cabinet 1 · First · B');
  report('a cabinet outside the grid is dropped',
    !layout.cabinets.some((entry) => entry.number === 9) && layout.slots['9'] === undefined,
    'no cabinet 9');
  report('a junk slot letter is dropped', subArraySlot(layout, 2) === '', 'cabinet 2 has no slot');
  report('a layout with no cabinets falls back to the default',
    normalizeSubArray({}).cabinets.length === 8, '2 × 4');
  report('rows and columns are clamped',
    normalizeSubArray({ rows: 99, columns: 99 }).rows === 4 &&
    normalizeSubArray({ rows: 99, columns: 99 }).columns === 8, '4 × 8');
  report('missing rows and columns come from the cabinets',
    normalizeSubArray({
      cabinets: [{ number: 1, row: 0, column: 0 }, { number: 2, row: 1, column: 2 }],
    }).rows === 2 && normalizeSubArray({
      cabinets: [{ number: 1, row: 0, column: 0 }, { number: 2, row: 1, column: 2 }],
    }).columns === 3,
    '2 rows, 3 columns');
}

/* ---------- arrivals ---------- */

{
  const arrivals = subArrayArrivals([
    { number: 3, name: 'Sub 3', slot: 'A', captureName: 'Capture A', delayMs: 2.00, coherence: 0.91 },
    { number: 1, name: 'Sub 1', slot: 'B', captureName: 'Capture B', delayMs: 2.42, coherence: 0.55 },
    { number: 5, name: 'Sub 5', slot: 'A', captureName: 'Capture A', delayMs: 1.80, coherence: 0.88 },
  ]);
  report('the first measured box is the reference', arrivals.length === 3 && arrivals[0].differenceMs === 0,
    arrivals[0].name + ' is the reference');
  report('a later arrival reads a positive difference',
    close(arrivals[1].differenceMs, 0.42, 1e-9),
    arrivals[1].differenceMs.toFixed(2) + ' ms');
  report('an earlier arrival reads a negative difference',
    close(arrivals[2].differenceMs, -0.20, 1e-9),
    arrivals[2].differenceMs.toFixed(2) + ' ms');
  report('the delay and the coherence come through',
    close(arrivals[1].delayMs, 2.42, 1e-9) && close(arrivals[2].coherence, 0.88, 1e-9),
    '2.42 ms and 88%');
  report('a row with no delay is dropped', subArrayArrivals([{ number: 1, delayMs: null }]).length === 0,
    'nothing measured');
  report('a row without a coherence reports it as unknown',
    Number.isNaN(subArrayArrivals([{ number: 1, delayMs: 1 }])[0].coherence),
    'no coherence figure');
  report('a coherence above 1 is clamped',
    subArrayArrivals([{ number: 1, delayMs: 1, coherence: 1.4 }])[0].coherence === 1,
    '100%');
  report('an empty list is empty', subArrayArrivals(null).length === 0, 'nothing to list');
}

/* ---------- storage ---------- */

{
  const memory = new Map();
  globalThis.window = {
    localStorage: {
      getItem(key) { return memory.has(key) ? memory.get(key) : null; },
      setItem(key, value) { memory.set(key, String(value)); },
      removeItem(key) { memory.delete(key); },
    },
  };

  report('the default layout loads with nothing stored', loadSubArray().cabinets.length === 8,
    '2 × 4');

  let layout = makeSubArray(2, 4);
  layout = setSubCabinet(layout, 1, 'Front right', 'front row');
  layout = assignSubArraySlot(layout, [1], 'C');
  report('a layout is stored', persistSubArray(layout) === true, 'written under ' + SUB_ARRAY_KEY);
  report('the stored file holds the size, the name and the slot',
    (() => {
      const raw = JSON.parse(memory.get(SUB_ARRAY_KEY));
      return raw.rows === 2 && raw.columns === 4 && raw.cabinets.length === 8 &&
        raw.cabinets.find((entry) => entry.number === 1).label === 'Front right' &&
        raw.slots['1'] === 'C';
    })(), 'rows, columns, cabinets and slots');

  const loaded = loadSubArray();
  report('the name and group survive a reload',
    subCabinetName(loaded.cabinets.find((entry) => entry.number === 1)) === 'Front right' &&
    loaded.cabinets.find((entry) => entry.number === 1).group === 'front row',
    'cabinet 1 · Front right · front row');
  report('the slot survives a reload', subArraySlot(loaded, 1) === 'C', 'Cabinet 1 in capture C');

  memory.set(SUB_ARRAY_KEY, '{not json');
  report('a corrupt stored layout falls back to the default', loadSubArray().cabinets.length === 8,
    '2 × 4');

  globalThis.window = {
    localStorage: {
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('blocked'); },
    },
  };
  report('a blocked store is reported rather than claimed',
    persistSubArray(layout) === false && loadSubArray().cabinets.length === 8,
    'false, and the default layout');
  report('a blocked read still gives a default layout', loadSubArray().rows === 2,
    '2 × 4');

  delete globalThis.window;
  report('no browser storage is reported rather than claimed',
    persistSubArray(layout) === false && loadSubArray().cabinets.length === 8,
    'false outside a browser');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
