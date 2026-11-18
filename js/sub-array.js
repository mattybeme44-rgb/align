/*
 * The subwoofer array as it stands in the room: a rows × columns grid numbered
 * from the right, what the operator calls each cabinet, and which capture slot
 * holds that cabinet's own measurement.
 *
 * Only the layout is kept here — rows, columns, a name, a group and a slot
 * letter per box. The captures themselves live in the measurement app's slots
 * A–F, so this module never touches the measurement, the gate or the audio path.
 *
 * The numbering is the touring convention the native tool uses: with two rows
 * each column is a pair numbered from the right-hand end, 1/3/5/7 along the top
 * and 2/4/6/8 along the bottom; with any other row count the numbering runs
 * from the right of each row.
 */

export const SUB_ARRAY_KEY = 'align.subArray.v1';
export const SUB_ARRAY_ROWS = 2;
export const SUB_ARRAY_COLUMNS = 4;
export const SUB_ARRAY_MAX_ROWS = 4;
export const SUB_ARRAY_MAX_COLUMNS = 8;
export const SUB_ARRAY_SLOTS = ['A', 'B', 'C', 'D', 'E', 'F'];
export const SUB_ARRAY_NAME_LIMIT = 24;

function clampInt(value, low, high, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(high, Math.max(low, Math.round(number)));
}

function text(value, limit) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, limit);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

/** What the operator calls a cabinet: the entered name, or its number. */
export function subCabinetName(cabinet) {
  const label = cabinet && typeof cabinet.label === 'string' ? cabinet.label.trim() : '';
  if (label) return label;
  const number = Number(cabinet && cabinet.number);
  return 'Sub ' + (Number.isFinite(number) ? number : '?');
}

/** The number of one cell: the pairing convention when there are two rows. */
function numberFor(rows, columns, row, column) {
  if (rows === 2) return 1 + 2 * (columns - 1 - column) + row;
  return row * columns + (columns - column);
}

/**
 * A grid of the given size. Numbering is rebuilt from the right, and any name,
 * group or capture slot that still belongs to a cabinet is kept.
 */
export function makeSubArray(rows, columns, previous = null) {
  const rowCount = clampInt(rows, 1, SUB_ARRAY_MAX_ROWS, SUB_ARRAY_ROWS);
  const columnCount = clampInt(columns, 1, SUB_ARRAY_MAX_COLUMNS, SUB_ARRAY_COLUMNS);
  const old = previous && Array.isArray(previous.cabinets) ? previous : null;
  const cabinets = [];

  for (let column = 0; column < columnCount; column += 1) {
    for (let row = 0; row < rowCount; row += 1) {
      const number = numberFor(rowCount, columnCount, row, column);
      const before = old
        ? old.cabinets.find((entry) => entry && Number(entry.number) === number) || null
        : null;
      cabinets.push({
        number,
        label: text(before && before.label, SUB_ARRAY_NAME_LIMIT),
        group: text(before && before.group, SUB_ARRAY_NAME_LIMIT),
        row,
        column,
      });
    }
  }

  const known = new Set(cabinets.map((entry) => entry.number));
  const slots = {};
  if (old && old.slots && typeof old.slots === 'object') {
    for (const [key, value] of Object.entries(old.slots)) {
      const number = Number(key);
      const letter = String(value || '').toUpperCase();
      if (!known.has(number) || !SUB_ARRAY_SLOTS.includes(letter)) continue;
      slots[String(number)] = letter;
    }
  }

  cabinets.sort((left, right) =>
    (left.row === right.row ? left.column - right.column : left.row - right.row));
  return { rows: rowCount, columns: columnCount, cabinets, slots };
}

/**
 * Read a stored layout back. The grid is rebuilt from its size, so a hand-edited
 * row or column cannot leave two cabinets in one cell; only the names, groups
 * and slot letters that still belong to a cabinet are taken from the file.
 */
export function normalizeSubArray(raw) {
  if (!raw || typeof raw !== 'object') {
    return makeSubArray(SUB_ARRAY_ROWS, SUB_ARRAY_COLUMNS);
  }
  const cabinets = Array.isArray(raw.cabinets) ? raw.cabinets : [];
  let rows = Number(raw.rows);
  let columns = Number(raw.columns);

  if (!Number.isFinite(rows) || rows < 1) {
    rows = 0;
    for (const entry of cabinets) {
      const row = Number(entry && entry.row);
      if (Number.isFinite(row) && row + 1 > rows) rows = row + 1;
    }
    if (rows < 1) rows = SUB_ARRAY_ROWS;
  }
  if (!Number.isFinite(columns) || columns < 1) {
    columns = 0;
    for (const entry of cabinets) {
      const column = Number(entry && entry.column);
      if (Number.isFinite(column) && column + 1 > columns) columns = column + 1;
    }
    if (columns < 1) columns = SUB_ARRAY_COLUMNS;
  }

  return makeSubArray(rows, columns, {
    cabinets,
    slots: raw.slots && typeof raw.slots === 'object' ? raw.slots : {},
  });
}

/** The cabinets on screen left to right, top row first. */
export function subArrayOrdered(layout) {
  return ((layout && layout.cabinets) || []).slice().sort((left, right) =>
    (left.row === right.row ? left.column - right.column : left.row - right.row));
}

export function subArrayRow(layout, row) {
  return subArrayOrdered(layout).filter((cabinet) => cabinet.row === Number(row));
}

export function subArraySlot(layout, number) {
  const slots = (layout && layout.slots) || {};
  const value = slots[String(number)];
  return SUB_ARRAY_SLOTS.includes(value) ? value : '';
}

/** Set one cabinet's name and group, trimmed as the field allows. */
export function setSubCabinet(layout, number, label, group) {
  const base = layout && Array.isArray(layout.cabinets)
    ? layout
    : makeSubArray(SUB_ARRAY_ROWS, SUB_ARRAY_COLUMNS);
  const wanted = Number(number);
  if (!base.cabinets.some((entry) => entry.number === wanted)) return base;
  return {
    ...base,
    cabinets: base.cabinets.map((entry) => (entry.number === wanted
      ? {
          ...entry,
          label: text(label, SUB_ARRAY_NAME_LIMIT),
          group: text(group, SUB_ARRAY_NAME_LIMIT),
        }
      : entry)),
  };
}

/** Attach one capture slot to every selected cabinet. */
export function assignSubArraySlot(layout, numbers, letter) {
  const base = layout && Array.isArray(layout.cabinets)
    ? layout
    : makeSubArray(SUB_ARRAY_ROWS, SUB_ARRAY_COLUMNS);
  const wanted = String(letter || '').toUpperCase();
  if (!SUB_ARRAY_SLOTS.includes(wanted)) return base;
  const known = new Set(base.cabinets.map((entry) => entry.number));
  const slots = { ...(base.slots || {}) };
  for (const number of numbers || []) {
    const value = Number(number);
    if (!known.has(value)) continue;
    slots[String(value)] = wanted;
  }
  return { ...base, slots };
}

/**
 * What each measured cabinet reads, in cabinet order: the first measured box is
 * the reference, and every later or earlier arrival is stated against it. A
 * positive difference means that box arrives later, so the earlier one is the
 * cabinet to delay.
 */
export function subArrayArrivals(entries) {
  const list = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    // An empty field is missing, not zero: `Number(null)` would turn a capture
    // with no delay into a box that arrives at 0.00 ms.
    const delay = finiteNumber(entry && entry.delayMs);
    if (!Number.isFinite(delay)) continue;
    const coherence = finiteNumber(entry && entry.coherence);
    list.push({
      number: Number(entry && entry.number) || 0,
      name: String((entry && entry.name) || ''),
      slot: String((entry && entry.slot) || ''),
      captureName: String((entry && entry.captureName) || ''),
      delayMs: delay,
      coherence: Number.isFinite(coherence) ? Math.max(0, Math.min(1, coherence)) : NaN,
    });
  }
  if (!list.length) return [];
  const reference = list[0].delayMs;
  return list.map((row) => ({ ...row, differenceMs: row.delayMs - reference }));
}

export function loadSubArray() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return makeSubArray(SUB_ARRAY_ROWS, SUB_ARRAY_COLUMNS);
    }
    const raw = window.localStorage.getItem(SUB_ARRAY_KEY);
    if (!raw) return makeSubArray(SUB_ARRAY_ROWS, SUB_ARRAY_COLUMNS);
    return normalizeSubArray(JSON.parse(raw));
  } catch (err) {
    return makeSubArray(SUB_ARRAY_ROWS, SUB_ARRAY_COLUMNS);
  }
}

/** Writes the layout, or reports that the browser refused the write. */
export function persistSubArray(layout) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    window.localStorage.setItem(SUB_ARRAY_KEY, JSON.stringify(normalizeSubArray(layout)));
    return true;
  } catch (err) {
    return false;
  }
}
