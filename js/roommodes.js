/*
 * The room's standing waves: worked out from the dimensions, listed, and marked
 * under the measured curve so a peak can be matched to the mode that explains it.
 *
 * Geometry only. A mode is where energy collects; what the microphone measures
 * also depends on the speaker, its position and the absorption in the room, so
 * nothing here is presented as a prediction of the curve. The numbers are the
 * classic rectangular-room solution: f = (c/2)·√((i/L)² + (j/W)² + (k/H)²).
 */

export const SPEED_OF_SOUND = 343;
export const ROOM_MODE_KEY = 'align.roomModes.v1';
export const MODE_LOW_HZ = 20;
export const MODE_HIGH_HZ = 300;
export const MODE_LIMIT = 30;

/** Axial waves are the strong ones; tangential and oblique give way to them. */
const TYPE_WEIGHTS = { axial: 1, tangential: 0.72, oblique: 0.45 };

const TYPE_LABELS = { axial: 'Axial', tangential: 'Tangential', oblique: 'Oblique' };

const BAND_RATIO = Math.pow(2, 1 / 6);

const BAND_CENTRES = [
  25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
  1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000,
];

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * Every mode up to `maxHz`, strongest first.
 *
 * `room` is { widthM, lengthM, heightM }. Each entry carries the frequency, its
 * type, the orders that make it ("L2W1H1") and a strength from 0 to 1 that only
 * orders the list: axial before tangential before oblique, and lower before
 * higher.
 */
export function computeRoomModes(room, options = {}) {
  const widthM = positive(room && room.widthM, 3.6);
  const lengthM = positive(room && room.lengthM, 4.2);
  const heightM = positive(room && room.heightM, 2.4);
  const speed = positive(options.speedOfSound, SPEED_OF_SOUND);
  const maxHz = positive(options.maxHz, MODE_HIGH_HZ);
  const limit = positive(options.limit, MODE_LIMIT);

  const half = speed / 2;
  const modes = [];

  for (let i = 0; i <= 12; i += 1) {
    for (let j = 0; j <= 12; j += 1) {
      for (let k = 0; k <= 12; k += 1) {
        const orders = i + j + k;
        if (orders === 0) continue;
        const frequency = half * Math.sqrt(
          (i / lengthM) * (i / lengthM) + (j / widthM) * (j / widthM) + (k / heightM) * (k / heightM));
        if (!(frequency >= MODE_LOW_HZ) || frequency > maxHz) continue;

        const axes = (i ? 1 : 0) + (j ? 1 : 0) + (k ? 1 : 0);
        const type = axes === 1 ? 'axial' : axes === 2 ? 'tangential' : 'oblique';
        const orderLabel = (i ? 'L' + i : '') + (j ? 'W' + j : '') + (k ? 'H' + k : '');
        // Strongest first: an axial wave outranks a tangential one at the same
        // frequency, and every mode gives way a little as the frequency rises.
        const falloff = 1 - (frequency - MODE_LOW_HZ) / Math.max(1, maxHz - MODE_LOW_HZ);
        const strength = TYPE_WEIGHTS[type] * (0.55 + 0.45 * Math.max(0, Math.min(1, falloff)));

        modes.push({
          frequency: Math.round(frequency * 10) / 10,
          type,
          typeLabel: TYPE_LABELS[type],
          order: orders,
          orderLabel,
          strength: Math.round(strength * 100) / 100,
        });
      }
    }
  }

  modes.sort((a, b) => (b.strength - a.strength) || (a.frequency - b.frequency));
  return modes.slice(0, limit);
}

/** The third-octave centre nearest a frequency, from the app's own ladder. */
export function nearestBandCentre(frequency) {
  if (!Number.isFinite(frequency) || frequency <= 0) return null;
  let best = null;
  let distance = Infinity;
  for (const centre of BAND_CENTRES) {
    const gap = Math.abs(Math.log(centre / frequency));
    if (gap < distance) {
      distance = gap;
      best = centre;
    }
  }
  return best;
}

/**
 * The measured level and coherence in the band around a frequency.
 *
 * `res` is the app's result: magDb per bin, df, bins and coh. The level is the
 * mean of the bins inside the third-octave band, relative to the average band
 * from 200 Hz to 2 kHz, so it reads as the deviation the curve shows.
 */
export function measuredBand(res, frequency) {
  if (!res || !(res.bins > 2) || !(res.df > 0) || !res.magDb) return null;
  const low = Math.max(1, Math.floor((frequency / BAND_RATIO) / res.df));
  const high = Math.min(res.bins - 1, Math.ceil((frequency * BAND_RATIO) / res.df));
  if (!(high >= low)) return null;

  let sum = 0;
  let count = 0;
  let coherence = 0;
  for (let k = low; k <= high; k += 1) {
    const level = res.magDb[k];
    if (!Number.isFinite(level)) continue;
    sum += level;
    if (res.coh && Number.isFinite(res.coh[k])) coherence += res.coh[k];
    count += 1;
  }
  if (!count) return null;

  let referenceSum = 0;
  let referenceCount = 0;
  for (const centre of BAND_CENTRES) {
    if (centre < 200 || centre > 2000) continue;
    const band = bandMean(res, centre);
    if (band === null) continue;
    referenceSum += band;
    referenceCount += 1;
  }
  const reference = referenceCount ? referenceSum / referenceCount : 0;

  return {
    frequency,
    levelDb: sum / count,
    deviationDb: (sum / count) - reference,
    coherence: count ? coherence / count : 0,
  };
}

function bandMean(res, frequency) {
  const low = Math.max(1, Math.floor((frequency / BAND_RATIO) / res.df));
  const high = Math.min(res.bins - 1, Math.ceil((frequency * BAND_RATIO) / res.df));
  if (!(high >= low)) return null;
  let sum = 0;
  let count = 0;
  for (let k = low; k <= high; k += 1) {
    if (!Number.isFinite(res.magDb[k])) continue;
    sum += res.magDb[k];
    count += 1;
  }
  return count ? sum / count : null;
}

/* ---------- what the operator typed, kept between visits ---------- */

export function loadRoomDimensions() {
  try {
    const raw = window.localStorage.getItem(ROOM_MODE_KEY);
    const stored = raw ? JSON.parse(raw) : null;
    if (!stored || typeof stored !== 'object') return null;
    const widthM = positive(stored.widthM, 0);
    const lengthM = positive(stored.lengthM, 0);
    const heightM = positive(stored.heightM, 0);
    if (!widthM || !lengthM || !heightM) return null;
    return { widthM, lengthM, heightM };
  } catch (error) {
    return null;
  }
}

export function persistRoomDimensions(room) {
  try {
    window.localStorage.setItem(ROOM_MODE_KEY, JSON.stringify({
      widthM: positive(room && room.widthM, 3.6),
      lengthM: positive(room && room.lengthM, 4.2),
      heightM: positive(room && room.heightM, 2.4),
    }));
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * A room the Room Designer has saved, if there is one.
 *
 * The Designer keeps its state in the modeler's own storage; the shape it uses
 * is a room with `size.widthM`, `size.lengthM` and `wallHeightM`. Anything else
 * is ignored rather than guessed at.
 */
export function savedRoomDimensions() {
  const keys = ['align.roomDesigner.v1', 'align.modeler.room.v1', 'align.modeler.project.v1'];
  for (const key of keys) {
    let stored = null;
    try {
      const raw = window.localStorage.getItem(key);
      stored = raw ? JSON.parse(raw) : null;
    } catch (error) {
      stored = null;
    }
    const room = stored && typeof stored === 'object'
      ? (stored.room && typeof stored.room === 'object' ? stored.room : stored)
      : null;
    if (!room) continue;
    const size = room.size && typeof room.size === 'object' ? room.size : room;
    const widthM = positive(size.widthM, positive(room.widthM, 0));
    const lengthM = positive(size.lengthM, positive(room.lengthM, 0));
    const heightM = positive(room.wallHeightM, positive(room.heightM, positive(size.heightM, 0)));
    if (widthM && lengthM && heightM) return { widthM, lengthM, heightM };
  }
  return null;
}


/* ---------- the screen ---------- */

const MEASURED_COLOUR = '#a6f14d';
const MODE_COLOUR = '#ffb04d';
const AXIS_COLOUR = 'rgba(139, 149, 166, 0.9)';
const GRID_COLOUR = 'rgba(148, 180, 255, 0.10)';

function formatHz(frequency) {
  if (!Number.isFinite(frequency)) return '—';
  return Math.abs(frequency - Math.round(frequency)) < 0.05
    ? frequency.toFixed(0) + ' Hz'
    : frequency.toFixed(1) + ' Hz';
}

function formatShort(frequency) {
  if (!Number.isFinite(frequency)) return '';
  return Math.abs(frequency - Math.round(frequency)) < 0.05
    ? frequency.toFixed(0)
    : frequency.toFixed(1);
}

function prepare(canvas) {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (!(rect.width > 20) || !(rect.height > 20)) return null;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  return { context, width, height };
}

/**
 * The Room modes sheet.
 *
 * `measurement` returns the running result (or null): it is only read, for the
 * curve and for the level in each mode's band. Nothing here writes to the
 * measurement, the gate or the captures.
 */
export function createRoomModes(options = {}) {
  const opts = options || {};
  const measurement = typeof opts.measurement === 'function' ? opts.measurement : () => null;
  const setStatus = typeof opts.setStatus === 'function' ? opts.setStatus : () => {};
  const $ = (id) => document.getElementById(id);

  const savedRoom = savedRoomDimensions();
  const typed = loadRoomDimensions();
  let room = typed || savedRoom || { widthM: 3.6, lengthM: 4.2, heightM: 2.4 };
  let source = typed ? 'typed' : savedRoom ? 'designer' : 'none';

  function readFields() {
    const widthM = positive($('rmWidth') && $('rmWidth').value, room.widthM);
    const lengthM = positive($('rmLength') && $('rmLength').value, room.lengthM);
    const heightM = positive($('rmHeight') && $('rmHeight').value, room.heightM);
    room = { widthM, lengthM, heightM };
    source = 'typed';
    persistRoomDimensions(room);
  }

  function updateSourceNote() {
    const note = $('rmSource');
    if (!note) return;
    note.textContent = source === 'designer'
      ? 'Taken from the Room Designer when a room is saved.'
      : source === 'typed'
        ? 'The dimensions you entered, kept on this device.'
        : 'No saved room yet — enter the dimensions you are measuring in.';
  }

  function renderRows() {
    const list = $('rmRows');
    const count = $('rmCount');
    if (!list) return;

    const res = measurement();
    const modes = computeRoomModes(room);
    if (count) {
      count.textContent = modes.length
        ? modes.length + (modes.length === 1 ? ' mode' : ' modes') + ' · 20–300 Hz'
        : 'no modes in this range';
    }

    list.replaceChildren();
    if (!modes.length) {
      const empty = document.createElement('p');
      empty.className = 'source-hint';
      empty.textContent = 'No mode falls between 20 Hz and 300 Hz for these dimensions.';
      list.appendChild(empty);
      return;
    }

    modes.forEach((mode, index) => {
      const row = document.createElement('div');
      row.className = 'rm-row' + (index < 4 ? ' rm-strong' : '');

      const frequency = document.createElement('span');
      frequency.className = 'rm-freq';
      frequency.textContent = formatHz(mode.frequency);

      const type = document.createElement('span');
      type.className = 'rm-type';
      type.textContent = mode.typeLabel + ' · ' + mode.orderLabel;

      const bar = document.createElement('span');
      bar.className = 'rm-bar';
      const fill = document.createElement('i');
      fill.style.width = Math.round(Math.max(6, Math.min(100, mode.strength * 100))) + '%';
      bar.appendChild(fill);

      const centre = nearestBandCentre(mode.frequency);
      const band = res && centre ? measuredBand(res, centre) : null;
      const reading = document.createElement('span');
      reading.className = 'rm-dev';
      const value = document.createElement('b');
      if (band && band.coherence >= 0.35) {
        value.textContent = (band.deviationDb >= 0 ? '+' : '') + band.deviationDb.toFixed(1) + ' dB';
      } else {
        value.textContent = '—';
        if (!band || band.coherence < 0.35) reading.classList.add('rm-dev-none');
      }
      const at = document.createElement('span');
      at.className = 'rm-at';
      at.textContent = centre ? 'at ' + formatShort(centre) + ' Hz' : '';
      reading.append(value, at);

      row.append(frequency, type, bar, reading);
      list.appendChild(row);
    });
  }

  function draw() {
    const frame = prepare($('rmChart'));
    if (!frame) return;
    const { context, width, height } = frame;
    context.fillStyle = '#0b0f12';
    context.fillRect(0, 0, width, height);

    const pad = { left: 34, right: 12, top: 14, bottom: 34 };
    const plotWidth = Math.max(10, width - pad.left - pad.right);
    const plotHeight = Math.max(10, height - pad.top - pad.bottom);
    const lowHz = MODE_LOW_HZ;
    const highHz = MODE_HIGH_HZ;
    const span = Math.log(highHz / lowHz);
    const xFor = (frequency) => pad.left + (Math.log(frequency / lowHz) / span) * plotWidth;

    const res = measurement();
    let minDb = -60;
    let maxDb = 0;
    if (res && res.magDb && res.df > 0) {
      minDb = Infinity;
      maxDb = -Infinity;
      for (let k = 1; k < res.bins; k += 1) {
        const frequency = k * res.df;
        if (frequency < lowHz || frequency > highHz) continue;
        const value = res.magDb[k];
        if (!Number.isFinite(value)) continue;
        if (value < minDb) minDb = value;
        if (value > maxDb) maxDb = value;
      }
      if (!Number.isFinite(minDb) || !Number.isFinite(maxDb) || maxDb - minDb < 12) {
        const middle = Number.isFinite(minDb) && Number.isFinite(maxDb) ? (minDb + maxDb) / 2 : -30;
        minDb = middle - 6;
        maxDb = middle + 6;
      } else {
        minDb -= 4;
        maxDb += 4;
      }
    }
    const yFor = (db) => pad.top + ((maxDb - db) / (maxDb - minDb)) * plotHeight;

    context.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.textBaseline = 'middle';

    const stepDb = Math.max(10, Math.ceil((maxDb - minDb) / 5 / 10) * 10);
    for (let db = Math.ceil(minDb / stepDb) * stepDb; db <= maxDb; db += stepDb) {
      const y = yFor(db);
      context.strokeStyle = GRID_COLOUR;
      context.beginPath();
      context.moveTo(pad.left, Math.round(y) + 0.5);
      context.lineTo(pad.left + plotWidth, Math.round(y) + 0.5);
      context.stroke();
      context.fillStyle = AXIS_COLOUR;
      context.textAlign = 'right';
      context.fillText((db > 0 ? '+' : '') + db, pad.left - 5, y);
    }
    context.fillStyle = AXIS_COLOUR;
    context.textAlign = 'right';
    context.fillText('dB', pad.left - 5, pad.top - 4);

    const modes = computeRoomModes(room);
    for (const mode of modes) {
      const x = xFor(mode.frequency);
      context.strokeStyle = MODE_COLOUR;
      context.globalAlpha = 0.85;
      context.beginPath();
      context.moveTo(Math.round(x) + 0.5, pad.top);
      context.lineTo(Math.round(x) + 0.5, pad.top + plotHeight);
      context.stroke();
      context.globalAlpha = 1;
    }

    // The mode labels along the axis, kept clear of each other.
    context.textAlign = 'center';
    context.fillStyle = MODE_COLOUR;
    let lastLabelX = -Infinity;
    const labelled = modes.slice(0, 8).sort((a, b) => a.frequency - b.frequency);
    for (const mode of labelled) {
      const x = xFor(mode.frequency);
      if (x - lastLabelX < 26) continue;
      lastLabelX = x;
      context.fillText(formatShort(mode.frequency), x, pad.top + plotHeight + 12);
    }

    context.fillStyle = AXIS_COLOUR;
    context.textAlign = 'left';
    context.fillText(String(lowHz), pad.left, pad.top + plotHeight + 26);
    context.textAlign = 'right';
    context.fillText(String(highHz), pad.left + plotWidth, pad.top + plotHeight + 26);
    context.textAlign = 'center';
    context.fillText('Frequency (Hz)', pad.left + plotWidth / 2, pad.top + plotHeight + 26);

    if (res && res.magDb && res.df > 0) {
      context.strokeStyle = MEASURED_COLOUR;
      context.lineWidth = 1.6;
      context.beginPath();
      let started = false;
      for (let k = 1; k < res.bins; k += 1) {
        const frequency = k * res.df;
        if (frequency < lowHz || frequency > highHz) continue;
        const value = res.magDb[k];
        if (!Number.isFinite(value)) continue;
        const x = xFor(frequency);
        const y = yFor(Math.min(maxDb, Math.max(minDb, value)));
        if (!started) {
          context.moveTo(x, y);
          started = true;
        } else {
          context.lineTo(x, y);
        }
      }
      context.stroke();
      context.lineWidth = 1;
    } else {
      context.fillStyle = AXIS_COLOUR;
      context.textAlign = 'center';
      context.font = '11px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      context.fillText('Start a measurement to draw the curve here',
        pad.left + plotWidth / 2, pad.top + plotHeight / 2);
    }
  }

  function render() {
    if ($('rmWidth')) $('rmWidth').value = room.widthM.toFixed(2);
    if ($('rmLength')) $('rmLength').value = room.lengthM.toFixed(2);
    if ($('rmHeight')) $('rmHeight').value = room.heightM.toFixed(2);
    updateSourceNote();
    renderRows();
    draw();
  }

  function open() {
    const sheet = $('roomModesSheet');
    if (!sheet) return;
    render();
    sheet.hidden = false;
    if (typeof opts.onOpen === 'function') opts.onOpen();
    requestAnimationFrame(draw);
  }

  function close() {
    const sheet = $('roomModesSheet');
    if (sheet) sheet.hidden = true;
    if (typeof opts.onClose === 'function') opts.onClose();
  }

  function wire() {
    for (const id of ['rmWidth', 'rmLength', 'rmHeight']) {
      const field = $(id);
      if (!field) continue;
      const handler = () => {
        readFields();
        updateSourceNote();
        renderRows();
        draw();
      };
      field.addEventListener('change', handler);
      field.addEventListener('input', handler);
    }
    const closeButton = $('btnCloseRoomModes');
    if (closeButton) closeButton.addEventListener('click', close);
  }

  wire();

  return {
    open,
    close,
    render,
    draw,
    modes: () => computeRoomModes(room),
    room: () => Object.assign({}, room),
    setDimensions(next) {
      room = {
        widthM: positive(next && next.widthM, room.widthM),
        lengthM: positive(next && next.lengthM, room.lengthM),
        heightM: positive(next && next.heightM, room.heightM),
      };
      source = 'typed';
      persistRoomDimensions(room);
      render();
    },
  };
}
