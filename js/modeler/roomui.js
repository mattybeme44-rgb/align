/*
 * The Room Designer workspace.
 *
 * It shares the modeler's project: the loudspeakers, their gain, delay, polarity,
 * EQ and groups are the same objects the System Data Modeler edits, so a change
 * made here appears there and the other way round. There is no second source
 * list and no second DSP engine.
 *
 * What the screen offers: a room drawn and typed, cabinets placed and aimed, a
 * direct-sound prediction over the audience, virtual microphones, a subwoofer
 * array tool and the arrival table. Every number shown is computed by
 * `acoustics.js` from the room and the modeler's responses.
 */

import {
  CURVE_FMIN,
  CURVE_FMAX,
  formatDelay,
  formatFrequency,
  gridFrequencies,
} from './curve.js';
import { normalizeSource } from './model.js';
import {
  CEILING_TYPES,
  ROOM_TEMPLATES,
  SHAPES,
  SOURCE_ROLES,
  UNITS,
  ceilingHeightAt,
  displayToMetres,
  formatArea,
  formatVolume,
  generateOutline,
  listenerZ,
  metresToDisplay,
  normalizeRoom,
  outlineBounds,
  roleLabel,
  roomMetrics,
  roomTemplate,
  unitSuffix,
  warehouseRoom,
  warehouseSources,
} from './room.js';
import {
  ARRAY_PRESETS,
  BAND_MODES,
  HEAT_FREQUENCIES,
  HEAT_METRICS,
  PREDICTION_MODES,
  arrayAssignments,
  arrayLayout,
  arrivalTable,
  beamwidthAt,
  buildContext,
  computeHeatmap,
  predictResponse,
  referenceReceiver,
} from './acoustics.js';
import { RoomChart, drawComparisonBars, drawResponseChart, roleColour } from './roomchart.js';

const $ = (id) => document.getElementById(id);

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined && content !== null) node.textContent = content;
  return node;
}

function option(value, label) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}

function fillSelect(id, items, value) {
  const select = $(id);
  if (!select) return;
  const list = Array.isArray(items) ? items : [];
  const key = list.map((item) => item.value + ':' + item.label).join('|');
  if (select.dataset.key !== key) {
    select.replaceChildren();
    for (const item of list) select.appendChild(option(item.value, item.label));
    select.dataset.key = key;
  }
  if (value !== undefined && value !== null) {
    const text = String(value);
    if ([...select.options].some((entry) => entry.value === text)) select.value = text;
  }
}

function setValue(id, value) {
  const input = $(id);
  if (input) input.value = String(value);
}

function setText(id, value) {
  const node = $(id);
  if (node) node.textContent = value === undefined || value === null ? '' : String(value);
}

function readNumber(id, fallback) {
  const input = $(id);
  if (!input) return fallback;
  const value = Number(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function readText(id) {
  const input = $(id);
  return input ? String(input.value || '') : '';
}

function readSelect(id) {
  const select = $(id);
  return select ? String(select.value || '') : '';
}

function checked(id) {
  const input = $(id);
  return !!(input && input.checked);
}

function shortLabel(name) {
  return String(name || '')
    .replace(/^(Sub|Main|Mid delay|Rear delay)\s+/i, '')
    .slice(0, 14);
}

function signed(value, digits = 2) {
  if (!Number.isFinite(value)) return '—';
  return (value >= 0 ? '+' : '') + value.toFixed(digits);
}

/**
 * The Room Designer.
 *
 * Options: `modeler` (the existing data modeler, which owns the project),
 * `library` (the capture library), `setStatus` (the app's status pill) and
 * `onOpen`/`onClose` so the measurement screen steps aside behind it.
 */
export function createRoomDesigner(options = {}) {
  const opts = options || {};
  const setStatus = typeof opts.setStatus === 'function' ? opts.setStatus : () => {};
  const library = typeof opts.library === 'function' ? opts.library : () => [];
  const modeler = opts.modeler;

  const workspace = $('rdWorkspace');
  const canvas = $('rdCanvas');

  let active = false;
  let chart = null;
  let observer = null;
  let selectedSourceId = null;
  let selectedMicId = null;
  let selectedStructure = null;
  let tool = 'select';
  let context = null;
  let prediction = null;
  let heatmap = null;
  let arrivals = null;
  let compareBefore = null;
  let recalcQueued = false;
  let bound = false;

  const settings = () => modeler.getProject().room.settings;
  const room = () => modeler.getProject().room;
  const project = () => modeler.getProject();

  function say(message, tone) {
    setText('rdStatus', message);
    setStatus(message, tone || 'ok');
  }

  /* ---------- writing to the shared project ---------- */

  /**
   * Change the shared project through the modeler's own commit path. Every
   * mutator receives the project — sources and room together — because the
   * placed cabinet and its DSP are one object, not two.
   */
  function paint(mutator, message) {
    if (!modeler || typeof modeler.mutate !== 'function') {
      say('The Room Designer needs the data modeler to hold the project.', 'err');
      return;
    }
    if (!modeler.getProject().room) {
      modeler.mutate((next) => { next.room = normalizeRoom(null); }, '');
    }
    modeler.mutate((next) => { mutator(next); }, message || '');
    refreshAll();
  }

  /* ---------- the views ---------- */

  function open() {
    if (!workspace || active) return;
    active = true;
    workspace.hidden = false;
    if (!modeler.getProject().room) {
      modeler.mutate((next) => { next.room = normalizeRoom(null); }, '');
    }
    modeler.getProject().room = normalizeRoom(modeler.getProject().room);
    if (!room().mics.length) {
      const mic = defaultMic();
      modeler.mutate((next) => { next.room.mics.push(mic); next.room.settings.refMicId = mic.id; },
        'Added a first virtual microphone.');
    }
    selectedMicId = room().settings.refMicId || (room().mics[0] && room().mics[0].id) || null;
    selectedSourceId = (project().sources[0] && project().sources[0].id) || null;
    buildSelects();
    bindEvents();
    buildChart();
    setText('rdAcousticNote', PREDICTION_MODES[0].note);
    refreshAll();
    if (typeof opts.onOpen === 'function') opts.onOpen();
    requestAnimationFrame(() => {
      if (chart) chart.resize();
    });
  }

  function close() {
    if (!workspace || !active) return;
    active = false;
    workspace.hidden = true;
    if (observer) observer.disconnect();
    observer = null;
    if (typeof opts.onClose === 'function') opts.onClose();
    say('Closed the Room Designer.', 'ok');
  }

  function buildChart() {
    if (!chart && canvas) {
      chart = new RoomChart(canvas, {
        onSelectSpeaker: (id) => {
          selectedSourceId = id;
          renderSpeakerForm();
          renderSourceList();
          draw();
        },
        onMoveSpeaker: (id, point) => {
          const source = (project().sources || []).find((entry) => entry.id === id);
          if (!source || !source.room) return;
          modeler.mutate((next) => {
            const found = next.sources.find((entry) => entry.id === id);
            if (!found || !found.room) return;
            found.room.x = point.x;
            found.room.y = point.y;
            found.room.z = Math.max(0, Math.min(
              ceilingHeightAt(next.room, point.x, point.y) - 0.2,
              found.room.z,
            ));
          }, '');
          renderSpeakerForm();
          previewPrediction();
        },
        onMoveSpeaker3d: (id, partial) => {
          modeler.mutate((next) => {
            const found = next.sources.find((entry) => entry.id === id);
            if (!found || !found.room) return;
            if (Number.isFinite(partial.y)) found.room.y = Math.max(0, partial.y);
            if (Number.isFinite(partial.z)) found.room.z = Math.max(0, partial.z);
          }, '');
          renderSpeakerForm();
          previewPrediction();
        },
        onSelectMic: (id) => {
          selectedMicId = id;
          renderMicList();
          recalculate();
        },
        onAddMic: (point) => {
          addMic(point);
        },
        onMoveMic: (id, point) => {
          modeler.mutate((next) => {
            const mic = next.room.mics.find((entry) => entry.id === id);
            if (!mic) return;
            mic.x = point.x;
            mic.y = point.y;
            mic.z = listenerZ(next.room, point.x, point.y);
          }, '');
          renderMicList();
          previewPrediction();
        },
        onMoveVertex: (index, point) => {
          modeler.mutate((next) => {
            if (next.room.shape !== 'custom') return;
            const outline = generateOutline(next.room).slice();
            if (!outline[index]) return;
            outline[index] = { x: point.x, y: point.y };
            next.room.outline = outline;
          }, '');
          recalculate();
        },
        onHover: (point) => {
          if (!point) {
            setText('rdReadout', 'move the pointer over the plan to read a position');
            return;
          }
          const units = room().units;
          const z = listenerZ(room(), point.x, point.y);
          setText('rdReadout',
            'x ' + metresToDisplay(point.x, units).toFixed(2) + ' ' + unitSuffix(units) +
            ' · y ' + metresToDisplay(point.y, units).toFixed(2) + ' ' + unitSuffix(units) +
            ' · ear ' + metresToDisplay(z, units).toFixed(2) + ' ' + unitSuffix(units) +
            ' · ceiling ' + metresToDisplay(ceilingHeightAt(room(), point.x, point.y), units)
              .toFixed(2) + ' ' + unitSuffix(units));
        },
        onDragEnd: () => {
          // The heat map is the expensive part: it is computed when a drag ends,
          // not on every pointer move.
          recalculate();
        },
        onRuler: (ruler) => {
          setText('rdRulerNote', 'ruler: ' + metresToDisplay(
            Math.hypot(ruler.b.x - ruler.a.x, ruler.b.y - ruler.a.y), room().units).toFixed(2) +
            ' ' + unitSuffix(room().units) + ' · ' +
            formatDelay((Math.hypot(ruler.b.x - ruler.a.x, ruler.b.y - ruler.a.y) /
              (settings().speedOfSound || 343)) * 1000));
          if (chart) {
            chart.state.ruler = ruler;
            chart.draw();
          }
        },
      });
    }
  }

  function buildSelects() {
    fillSelect('rdUnits', UNITS.map((entry) => ({ value: entry.id, label: entry.label })), room().units);
    fillSelect('rdShape', SHAPES.map((entry) => ({ value: entry.id, label: entry.label })), room().shape);
    fillSelect('rdCeiling', CEILING_TYPES.map((entry) => ({ value: entry.id, label: entry.label })), room().ceiling);
    fillSelect('rdTemplate', ROOM_TEMPLATES.map((entry) => ({ value: entry.id, label: entry.label })), 'empty');
    fillSelect('rdAddRole', SOURCE_ROLES.map((entry) => ({ value: entry.id, label: entry.label })), 'main');
    fillSelect('rdAddKind', [
      { value: 'stage', label: 'Raised stage' },
      { value: 'platform', label: 'Speaker platform' },
      { value: 'obstacle', label: 'Obstacle / structure' },
      { value: 'audience', label: 'Audience area' },
    ], 'stage');
    fillSelect('rdMetric', HEAT_METRICS.map((entry) => ({ value: entry.id, label: entry.label })), 'level');
    fillSelect('rdBandMode', BAND_MODES.map((entry) => ({ value: entry.id, label: entry.label })), 'third');
    fillSelect('rdFrequency', HEAT_FREQUENCIES.map((hz) => ({ value: String(hz), label: formatFrequency(hz) })), '125');
    fillSelect('rdArrayPreset', ARRAY_PRESETS.map((entry) => ({ value: entry.id, label: entry.label })), 'broadside');
    fillSelect('rdSpeakerRole', SOURCE_ROLES.map((entry) => ({ value: entry.id, label: entry.label })), 'main');
    fillSelect('rdSpeakerPolarity', [
      { value: 'normal', label: 'Normal' },
      { value: 'inverted', label: 'Inverted' },
    ], 'normal');
    fillSelect('rdSpeakerTiming', [
      { value: 'geometric', label: 'Geometric arrival' },
      { value: 'measured', label: 'Measured offset' },
    ], 'geometric');
    fillSelect('rdLevelMode', [
      { value: 'relative', label: 'Relative dB' },
      { value: 'absolute', label: 'Estimated SPL' },
    ], 'relative');
    fillSelect('rdNormalize', [
      { value: 'reference', label: 'Reference microphone' },
      { value: 'max', label: 'Maximum in the map' },
    ], 'reference');
    fillSelect('rdPredictionMode', PREDICTION_MODES.map((entry) => ({
      value: entry.id,
      label: entry.label + (entry.implemented ? '' : ' (not implemented)'),
    })), 'direct');
    fillSelect('rdSnap', [
      { value: '0', label: 'Off' },
      { value: '0.1', label: '0.1 m' },
      { value: '0.25', label: '0.25 m' },
      { value: '0.5', label: '0.5 m' },
      { value: '1', label: '1 m' },
    ], String(settings().snapM));
  }

  /* ---------- reading the panels into the project ---------- */

  function units() {
    return room().units;
  }

  function applyRoomDimensions() {
    paint((next) => {
      next.units = readSelect('rdUnits') || next.units;
      next.shape = readSelect('rdShape') || next.shape;
      next.size.widthM = Math.max(1, displayToMetres(readNumber('rdWidth', 0), next.units));
      next.size.lengthM = Math.max(1, displayToMetres(readNumber('rdLength', 0), next.units));
      next.size.notchWidthM = Math.max(0, displayToMetres(readNumber('rdNotchWidth', 0), next.units));
      next.size.notchLengthM = Math.max(0, displayToMetres(readNumber('rdNotchLength', 0), next.units));
      next.wallHeightM = Math.max(1, displayToMetres(readNumber('rdWallHeight', 0), next.units));
      next.riseM = Math.max(0, displayToMetres(readNumber('rdRise', 0), next.units));
      next.ridgeX = Math.max(0, displayToMetres(readNumber('rdRidge', 0), next.units));
      next.ceiling = readSelect('rdCeiling') || next.ceiling;
      // A dimension change reshapes the room. Cabinets keep their coordinates,
      // so a slightly different wall never silently moves the loudspeakers.
      if (next.shape !== 'custom') next.outline = generateOutline(next);
      next.updatedAt = new Date().toISOString();
    }, 'Room geometry updated.');
  }

  /* ---------- drawing ---------- */

  function chartSpeakers() {
    const placedById = new Map((context ? context.speakers : []).map((entry) => [entry.id, entry]));
    return (project().sources || [])
      .filter((source) => source.room)
      .map((source) => {
        const placed = placedById.get(source.id);
        return {
          id: source.id,
          name: source.name,
          shortName: shortLabel(source.name),
          role: source.room.role,
          placement: source.room,
          position: { x: source.room.x, y: source.room.y, z: source.room.z },
          selected: source.id === selectedSourceId,
          hasData: !!placed,
          beamwidthAt: placed ? (frequency) => beamwidthAt(placed.directivity, frequency) : () => NaN,
        };
      });
  }

  function draw() {
    if (!chart || !active) return;
    chart.setState({
      room: room(),
      speakers: chartSpeakers(),
      selectedMicId,
      heatmap,
      view: settings().view || 'plan',
      showHeatmap: checked('chkRdHeatmap'),
      showCoverage: checked('chkRdCoverage'),
      coverageFrequency: Number(readSelect('rdFrequency')) || 1000,
      tool,
      snapM: settings().snapM,
      ruler: chart.state ? chart.state.ruler : null,
      hover: chart.state ? chart.state.hover : null,
      speedOfSound: settings().speedOfSound,
      sectionX: sectionPlane(),
    });
    chart.resize();
  }

  /** The plane the section is cut through: the middle of the room, across it. */
  function sectionPlane() {
    const outline = room().outline || [];
    if (!outline.length) return 0;
    let min = Infinity;
    let max = -Infinity;
    for (const point of outline) {
      min = Math.min(min, point.x);
      max = Math.max(max, point.x);
    }
    return (min + max) / 2;
  }

  /* ---------- the prediction ---------- */

  function recalculate() {
    context = buildContext(project(), room());
    const mic = currentMic();
    const receiver = mic
      ? { x: mic.x, y: mic.y, z: mic.z }
      : { x: 0, y: 0, z: settings().earHeightM };
    prediction = context.ok
      ? predictResponse(context, receiver, {
        frequencies: gridFrequencies(400),
        band: { min: 20, max: 20000 },
      })
      : null;

    if (context.ok && checked('chkRdHeatmap')) {
      const reference = referenceReceiver(room());
      heatmap = computeHeatmap(context, {
        metric: readSelect('rdMetric') || 'level',
        bandMode: readSelect('rdBandMode') || 'third',
        frequencyHz: Number(readSelect('rdFrequency')) || 1000,
        normalizeTo: readSelect('rdNormalize') || 'reference',
        uniformityDb: settings().uniformityDb,
        leftGroupId: readSelect('rdLeftGroup') || '',
        rightGroupId: readSelect('rdRightGroup') || '',
        reference,
      });
    } else {
      heatmap = null;
    }

    arrivals = context.ok ? arrivalTable(context, receiver) : null;
    renderPrediction();
    renderArrivalTable();
    renderMicTable();
    drawResponse();
    draw();
  }

  function scheduleRecalculate() {
    if (recalcQueued) return;
    recalcQueued = true;
    requestAnimationFrame(() => {
      recalcQueued = false;
      if (active) recalculate();
    });
  }

  /**
   * The response at the selected microphone only, with no map. Used while a
   * cabinet or a microphone is being dragged: the curve and the arrival table
   * follow the pointer, and the map is computed once, when the drag ends.
   */
  function previewPrediction() {
    context = buildContext(project(), room());
    if (!context.ok) {
      prediction = null;
      arrivals = null;
      renderPrediction();
      drawResponse();
      draw();
      return;
    }
    const mic = currentMic();
    const receiver = mic
      ? { x: mic.x, y: mic.y, z: mic.z }
      : { x: 0, y: 0, z: settings().earHeightM };
    prediction = predictResponse(context, receiver, {
      frequencies: gridFrequencies(400),
      band: { min: 20, max: 20000 },
    });
    arrivals = arrivalTable(context, receiver);
    renderArrivalTable();
    renderMicTable();
    drawResponse();
    draw();
  }

  function currentMic() {
    const list = room().mics || [];
    return list.find((entry) => entry.id === selectedMicId) || list[0] || null;
  }

  function levelText(value) {
    if (!Number.isFinite(value)) return '—';
    const mode = readSelect('rdLevelMode') || 'relative';
    if (mode === 'absolute') {
      const offset = Number(readNumber('rdLevelOffset', 0)) || 0;
      return (value + offset).toFixed(1) + ' dB SPL est.';
    }
    return signed(value, 1) + ' dB (model)';
  }

  function renderPrediction() {
    const stats = $('rdStatistics');
    if (stats) stats.replaceChildren();
    if (!context || !context.ok) {
      setText('rdPredictionMessage',
        'Nothing to predict yet: place at least one loudspeaker with acoustic data in the room.');
      if (stats) {
        const line = el('p', 'source-hint');
        line.textContent = (context && context.warnings && context.warnings.length)
          ? context.warnings.join(' ')
          : 'Import a response for a loudspeaker, or load the demonstration responses.';
        stats.appendChild(line);
      }
      setText('rdLevelReadout', '—');
      return;
    }
    const messages = [];
    if (context.warnings.length) messages.push(context.warnings.join(' '));
    if (!context.phaseComplete) {
      messages.push('At least one source carries no measured phase, so the complex sum assumes ' +
        'zero phase for it: the levels are a prediction, not an alignment.');
    }
    messages.push('Direct sound only: no reflection, absorption, mode or reverberation is computed.');
    setText('rdPredictionMessage', messages.join(' '));

    if (prediction && prediction.ok) {
      setText('rdLevelReadout', levelText(prediction.levelDb));
    }

    if (!stats) return;
    if (heatmap && heatmap.ok) {
      const s = heatmap.statistics;
      const rows = [
        ['Map points', String(s.points) + ' of ' + (heatmap.cols * heatmap.rows) + ' cells'],
        ['Mean', signed(s.meanDb, 1) + ' dB' + (heatmap.normalised ? ' (model)' : '')],
        ['Range', (Number.isFinite(s.rangeDb) ? s.rangeDb.toFixed(1) : '—') + ' dB'],
        ['Spread (σ)', (Number.isFinite(s.spreadDb) ? s.spreadDb.toFixed(1) : '—') + ' dB'],
        ['Within ±' + s.toleranceDb + ' dB', Number.isFinite(s.withinTolerance)
          ? (s.withinTolerance * 100).toFixed(0) + ' %' : '—'],
        ['Normalised to', heatmap.normalised
          ? (Number.isFinite(s.referenceDb)
            ? 'the reference microphone (' + signed(heatmap.offsetDb, 1) + ' dB)'
            : 'the maximum in the map')
          : 'not normalised'],
      ];
      if (heatmap.metric === 'difference') {
        rows.push(['Groups', heatmap.labels.left + ' − ' + heatmap.labels.right]);
      }
      const table = el('div', 'rd-table');
      for (const [label, value] of rows) {
        const line = el('div', 'rd-table-row');
        line.appendChild(el('span', null, label));
        line.appendChild(el('span', 'rd-table-value', value));
        table.appendChild(line);
      }
      stats.appendChild(table);
    } else {
      const line = el('p', 'source-hint');
      line.textContent = 'The coverage map is switched off. Turn it on to compute it.';
      stats.appendChild(line);
    }
  }

  function renderArrivalTable() {
    const host = $('rdArrivalTable');
    if (!host) return;
    host.replaceChildren();
    if (!arrivals || !arrivals.ok) {
      setText('rdArrivalNote', 'Place loudspeakers and select a microphone to see the arrivals.');
      return;
    }
    const head = el('div', 'rd-table-row rd-table-head');
    head.appendChild(el('span', null, 'Source'));
    head.appendChild(el('span', null, 'Distance'));
    head.appendChild(el('span', null, 'Travel'));
    head.appendChild(el('span', null, 'DSP'));
    head.appendChild(el('span', null, 'Arrival'));
    head.appendChild(el('span', null, 'Suggest'));
    host.appendChild(head);
    for (const row of arrivals.rows) {
      const line = el('div', 'rd-table-row');
      line.appendChild(el('span', null, row.name));
      line.appendChild(el('span', null, row.distanceM.toFixed(2) + ' m'));
      line.appendChild(el('span', null, row.travelMs.toFixed(2) + ' ms'));
      line.appendChild(el('span', null, signed(row.dspDelayMs, 2) + ' ms'));
      line.appendChild(el('span', null, row.totalMs.toFixed(2) + ' ms'));
      line.appendChild(el('span', 'rd-table-value',
        row.suggestedAddMs < 0.005 ? 'aligned' : '+' + row.suggestedAddMs.toFixed(2) + ' ms'));
      host.appendChild(line);
    }
    setText('rdArrivalNote', arrivals.message + ' Span ' + arrivals.spanMs.toFixed(2) +
      ' ms between the first and last arrival.');
  }

  function renderMicTable() {
    const host = $('rdMicTable');
    if (!host) return;
    host.replaceChildren();
    if (!prediction || !prediction.ok) return;
    const head = el('div', 'rd-table-row rd-table-head');
    head.appendChild(el('span', null, 'Source'));
    head.appendChild(el('span', null, 'Level at the mic'));
    head.appendChild(el('span', null, 'Off axis'));
    head.appendChild(el('span', null, 'Beamwidth'));
    host.appendChild(head);
    for (const contribution of prediction.contributions) {
      const line = el('div', 'rd-table-row');
      line.appendChild(el('span', null, contribution.name));
      const band = prediction.frequencies;
      let power = 0;
      for (let i = 0; i < band.length; i += 1) {
        if (band[i] < 100 || band[i] > 10000) continue;
        power += Math.pow(10, contribution.levelDb[i] / 10);
      }
      line.appendChild(el('span', 'rd-table-value',
        Number.isFinite(power) && power > 0 ? signed(10 * Math.log10(power), 1) + ' dB' : '—'));
      line.appendChild(el('span', null, contribution.angles.total.toFixed(1) + '°'));
      line.appendChild(el('span', null, contribution.hasDirectivity
        ? contribution.beamwidthDeg.toFixed(0) + '°' : 'none'));
      host.appendChild(line);
    }
  }

  function drawResponse() {
    const chartCanvas = $('rdChart');
    if (!chartCanvas) return;
    const mic = currentMic();
    setText('rdMicHeading', mic ? mic.name : 'no microphone');
    drawResponseChart(chartCanvas, prediction && prediction.ok
      ? {
        frequencies: prediction.frequencies,
        magDb: prediction.sum.magDb,
        phaseDeg: prediction.phaseValid ? prediction.sum.phaseDeg : null,
        phaseNote: prediction.phaseValid
          ? ''
          : 'phase absent: a source in this sum carries none',
        cursorHz: Number(readSelect('rdFrequency')) || 1000,
      }
      : { frequencies: [], magDb: [], phaseDeg: null });
  }

  /* ---------- the panels ---------- */

  function renderRoomFields() {
    const unitsNow = units();
    fillSelect('rdUnits', UNITS.map((entry) => ({ value: entry.id, label: entry.label })), unitsNow);
    fillSelect('rdShape', SHAPES.map((entry) => ({ value: entry.id, label: entry.label })), room().shape);
    fillSelect('rdCeiling', CEILING_TYPES.map((entry) => ({ value: entry.id, label: entry.label })), room().ceiling);
    setValue('rdWidth', metresToDisplay(room().size.widthM, unitsNow).toFixed(2));
    setValue('rdLength', metresToDisplay(room().size.lengthM, unitsNow).toFixed(2));
    setValue('rdNotchWidth', metresToDisplay(room().size.notchWidthM, unitsNow).toFixed(2));
    setValue('rdNotchLength', metresToDisplay(room().size.notchLengthM, unitsNow).toFixed(2));
    setValue('rdWallHeight', metresToDisplay(room().wallHeightM, unitsNow).toFixed(2));
    setValue('rdRise', metresToDisplay(room().riseM, unitsNow).toFixed(2));
    setValue('rdRidge', metresToDisplay(room().ridgeX, unitsNow).toFixed(2));
    const lShape = room().shape === 'l';
    const custom = room().shape === 'custom';
    const notchRow = $('rdNotchRow');
    if (notchRow) notchRow.hidden = !lShape;
    const ceilingRows = $('rdCeilingRows');
    if (ceilingRows) ceilingRows.hidden = room().ceiling === 'flat';
    const ridgeRow = $('rdRidgeRow');
    if (ridgeRow) ridgeRow.hidden = room().ceiling !== 'aframe';
    const outlineNote = $('rdOutlineNote');
    if (outlineNote) {
      outlineNote.hidden = !custom;
      outlineNote.textContent = custom
        ? 'Custom outline: ' + room().outline.length + ' points. Use the Vertex tool to drag a corner.'
        : '';
    }
    const metrics = roomMetrics(room());
    setText('rdRoomSummary',
      formatArea(metrics.area, unitsNow) + ' floor · ' + formatVolume(metrics.volumeM3, unitsNow) +
      ' estimated volume · ceiling ' +
      metresToDisplay(metrics.minCeilingM, unitsNow).toFixed(1) + '–' +
      metresToDisplay(metrics.maxCeilingM, unitsNow).toFixed(1) + ' ' + unitSuffix(unitsNow) +
      ' · audience ' + formatArea(metrics.audienceArea, unitsNow));
  }

  function renderStructureList() {
    const host = $('rdStructureList');
    if (!host) return;
    host.replaceChildren();
    const groups = [
      ['stage', room().stages || []],
      ['platform', room().platforms || []],
      ['obstacle', room().obstacles || []],
      ['audience', room().audience || []],
    ];
    let any = false;
    for (const [kind, list] of groups) {
      for (const entry of list) {
        any = true;
        const row = el('li', 'rd-list-row');
        const button = el('button', 'rd-list-main', entry.name);
        button.type = 'button';
        const key = kind + ':' + entry.id;
        if (selectedStructure === key) button.classList.add('on');
        button.addEventListener('click', () => {
          selectedStructure = key;
          renderStructureList();
          renderStructureForm();
        });
        row.appendChild(button);
        row.appendChild(el('span', 'rd-list-tag', kind));
        host.appendChild(row);
      }
    }
    if (!any) {
      const empty = el('li', 'rd-list-row');
      empty.appendChild(el('span', 'source-hint', 'No stage, platform, obstacle or audience area yet.'));
      host.appendChild(empty);
    }
    renderStructureForm();
  }

  function findStructure(key) {
    if (!key) return null;
    const [kind, id] = key.split(':');
    const list = kind === 'stage' ? room().stages
      : kind === 'platform' ? room().platforms
        : kind === 'obstacle' ? room().obstacles
          : kind === 'audience' ? room().audience : [];
    const entry = (list || []).find((item) => item.id === id);
    return entry ? { kind, entry } : null;
  }

  function renderStructureForm() {
    const form = $('rdStructForm');
    const found = findStructure(selectedStructure);
    if (!form) return;
    form.hidden = !found;
    if (!found) return;
    const unitsNow = units();
    const entry = found.entry;
    setText('rdStructTitle', roleLabelForKind(found.kind) + ' · ' + entry.name);
    setValue('rdStructName', entry.name);
    setValue('rdStructX0', metresToDisplay(entry.x0, unitsNow).toFixed(2));
    setValue('rdStructY0', metresToDisplay(entry.y0, unitsNow).toFixed(2));
    setValue('rdStructX1', metresToDisplay(entry.x1, unitsNow).toFixed(2));
    setValue('rdStructY1', metresToDisplay(entry.y1, unitsNow).toFixed(2));
    const heightLabel = $('rdStructHeightWord');
    if (heightLabel) {
      heightLabel.textContent = found.kind === 'audience' ? 'Ear height' : 'Height';
    }
    setValue('rdStructHeight', metresToDisplay(
      found.kind === 'audience' ? entry.earHeightM : entry.heightM, unitsNow).toFixed(2));
    const rakedRow = $('rdRakedRow');
    if (rakedRow) rakedRow.hidden = found.kind !== 'audience';
    const raked = $('chkRdRaked');
    if (raked && found.kind === 'audience') raked.checked = !!entry.raked;
    const rise = $('rdRakedRise');
    if (rise && found.kind === 'audience') rise.value = String(entry.risePerMetre || 0);
  }

  function roleLabelForKind(kind) {
    return kind === 'stage' ? 'Stage'
      : kind === 'platform' ? 'Platform'
        : kind === 'obstacle' ? 'Obstacle' : 'Audience area';
  }

  function applyStructure() {
    const found = findStructure(selectedStructure);
    if (!found) return;
    const unitsNow = units();
    paint((next) => {
      const list = found.kind === 'stage' ? next.stages
        : found.kind === 'platform' ? next.platforms
          : found.kind === 'obstacle' ? next.obstacles : next.audience;
      const entry = (list || []).find((item) => item.id === found.entry.id);
      if (!entry) return;
      entry.name = readText('rdStructName').slice(0, 40) || entry.name;
      entry.x0 = displayToMetres(readNumber('rdStructX0', 0), unitsNow);
      entry.y0 = displayToMetres(readNumber('rdStructY0', 0), unitsNow);
      entry.x1 = displayToMetres(readNumber('rdStructX1', 0), unitsNow);
      entry.y1 = displayToMetres(readNumber('rdStructY1', 0), unitsNow);
      const height = displayToMetres(readNumber('rdStructHeight', 0), unitsNow);
      if (found.kind === 'audience') {
        entry.earHeightM = Math.max(0.3, height);
        entry.raked = checked('chkRdRaked');
        entry.risePerMetre = Math.max(0, Number(readNumber('rdRakedRise', 0)));
      } else {
        entry.heightM = Math.max(0, height);
      }
    }, 'Updated ' + found.entry.name + '.');
  }

  function addStructure() {
    const kind = readSelect('rdAddKind');
    const metrics = roomMetrics(room());
    const width = room().size.widthM;
    const length = room().size.lengthM;
    const id = kind + '-' + Date.now().toString(36);
    paint((next) => {
      if (kind === 'stage') {
        next.stages.push({
          id, name: 'Stage ' + (next.stages.length + 1),
          x0: width * 0.12, y0: 0.5, x1: width * 0.88, y1: Math.min(5, length * 0.18),
          heightM: 0.6,
        });
        selectedStructure = 'stage:' + id;
      } else if (kind === 'platform') {
        next.platforms.push({
          id, name: 'Platform ' + (next.platforms.length + 1),
          x0: width * 0.2, y0: Math.min(2, length * 0.1), x1: width * 0.2 + 1.6,
          y1: Math.min(2, length * 0.1) + 1.2, heightM: 1.4,
        });
        selectedStructure = 'platform:' + id;
      } else if (kind === 'obstacle') {
        next.obstacles.push({
          id, name: 'Column ' + (next.obstacles.length + 1),
          x0: width * 0.3, y0: length * 0.5, x1: width * 0.3 + 0.4, y1: length * 0.5 + 0.4,
          heightM: 6, baseM: 0, kind: 'column',
        });
        selectedStructure = 'obstacle:' + id;
      } else {
        next.audience.push({
          id, name: 'Audience ' + (next.audience.length + 1),
          x0: Math.max(0.5, width * 0.06), y0: Math.min(4, length * 0.2),
          x1: width - Math.max(0.5, width * 0.06), y1: length - 0.8,
          earHeightM: 1.2, raked: false, risePerMetre: 0,
        });
        selectedStructure = 'audience:' + id;
      }
    }, 'Added ' + roleLabelForKind(kind).toLowerCase() + ' · ' + formatArea(metrics.area, units()));
  }

  function deleteStructure() {
    const found = findStructure(selectedStructure);
    if (!found) return;
    selectedStructure = null;
    paint((next) => {
      if (found.kind === 'stage') next.stages = next.stages.filter((item) => item.id !== found.entry.id);
      else if (found.kind === 'platform') next.platforms = next.platforms.filter((item) => item.id !== found.entry.id);
      else if (found.kind === 'obstacle') next.obstacles = next.obstacles.filter((item) => item.id !== found.entry.id);
      else next.audience = next.audience.filter((item) => item.id !== found.entry.id);
    }, 'Removed ' + found.entry.name + '.');
  }

  /* ---------- sources ---------- */

  function renderSourceList() {
    const host = $('rdSourceList');
    if (!host) return;
    host.replaceChildren();
    const sources = project().sources || [];
    if (!sources.length) {
      const row = el('li', 'rd-list-row');
      row.appendChild(el('span', 'source-hint', 'No loudspeakers yet. Add one from the library above.'));
      host.appendChild(row);
    }
    for (const source of sources) {
      const placed = !!source.room;
      const model = (project().models || []).find((entry) => entry.id === source.modelId);
      // A source without a named dataset uses its loudspeaker's first one, which
      // is what the modeler's engine does — the list shows the same dataset the
      // prediction will use.
      const dataset = model && ((model.datasets || []).find((entry) => entry.id === source.datasetId) ||
        (model.datasets || [])[0]);
      const row = el('li', 'rd-list-row');
      const button = el('button', 'rd-list-main', source.name);
      button.type = 'button';
      if (source.id === selectedSourceId) button.classList.add('on');
      button.style.borderLeftColor = roleColour(placed ? source.room.role : 'custom');
      button.addEventListener('click', () => {
        selectedSourceId = source.id;
        renderSourceList();
        renderSpeakerForm();
        draw();
      });
      row.appendChild(button);
      const tags = el('span', 'rd-list-tags');
      tags.appendChild(el('span', 'rd-list-tag', placed ? roleLabel(source.room.role) : 'not placed'));
      tags.appendChild(el('span', 'rd-list-tag' + (dataset ? '' : ' warn'),
        dataset ? dataset.provenance || 'data' : 'no data'));
      row.appendChild(tags);
      host.appendChild(row);
    }
    setText('rdSourceSummary', sources.length + ' source' + (sources.length === 1 ? '' : 's') +
      ' · ' + sources.filter((source) => source.room).length + ' placed · ' +
      sources.filter((source) => hasData(source)).length + ' with acoustic data');
    renderSourceStrip();
  }

  function hasData(source) {
    const model = (project().models || []).find((entry) => entry.id === source.modelId);
    if (!model) return false;
    const datasetId = source.datasetId || (model.datasets[0] && model.datasets[0].id);
    return !!(datasetId && (model.datasets || []).some((entry) => entry.id === datasetId));
  }

  function renderSourceStrip() {
    const host = $('rdSourceStrip');
    if (!host) return;
    host.replaceChildren();
    for (const source of project().sources || []) {
      const chip = el('button', 'rd-chip', shortLabel(source.name) || source.name);
      chip.type = 'button';
      chip.style.color = roleColour(source.room ? source.room.role : 'custom');
      if (source.id === selectedSourceId) chip.classList.add('on');
      if (!source.room) chip.classList.add('off');
      chip.title = source.name + (source.room ? '' : ' — not placed');
      chip.addEventListener('click', () => {
        selectedSourceId = source.id;
        renderSourceList();
        renderSpeakerForm();
        draw();
      });
      host.appendChild(chip);
    }
  }

  function renderSpeakerForm() {
    const form = $('rdSpeakerForm');
    const empty = $('rdSpeakerEmpty');
    const source = (project().sources || []).find((entry) => entry.id === selectedSourceId);
    if (!form) return;
    form.hidden = !source;
    if (empty) empty.hidden = !!source;
    if (!source) return;
    const unitsNow = units();
    // An unplaced cabinet is prefilled with where it would go, so the first
    // Apply places it somewhere sensible instead of at the room's origin.
    const seed = source.room || defaultPlacement('main', room().size.widthM, room().size.lengthM);
    setText('rdSpeakerTitle', source.name);
    const model = (project().models || []).find((entry) => entry.id === source.modelId);
    const dataset = model && ((model.datasets || []).find((entry) => entry.id === source.datasetId) ||
      (model.datasets || [])[0]);
    setText('rdSpeakerData', !model ? 'No loudspeaker model attached.'
      : !dataset ? (model.name + ' · no acoustic data yet')
        : (model.name + ' · ' + dataset.label + ' · ' + (dataset.provenance || 'imported') +
          (dataset.hasPhase ? ' · with phase' : ' · magnitude only')));
    setValue('rdSpeakerGain', source.gainDb.toFixed(1));
    setValue('rdSpeakerDelay', source.delayMs.toFixed(2));
    fillSelect('rdSpeakerRole', SOURCE_ROLES.map((entry) => ({ value: entry.id, label: entry.label })),
      source.room ? source.room.role : 'custom');
    const groups = [{ value: '', label: 'No group' }].concat((project().groups || [])
      .map((entry) => ({ value: entry.id, label: entry.name })));
    fillSelect('rdSpeakerGroup', groups, source.groupId || '');
    const placed = !!source.room;
    setText('rdSpeakerPlacement', placed
      ? 'x ' + metresToDisplay(source.room.x, unitsNow).toFixed(2) + ' ' + unitSuffix(unitsNow) +
        ' · y ' + metresToDisplay(source.room.y, unitsNow).toFixed(2) + ' ' + unitSuffix(unitsNow)
      : 'Not placed in the room');
    setValue('rdSpeakerX', metresToDisplay(seed.x, unitsNow).toFixed(2));
    setValue('rdSpeakerY', metresToDisplay(seed.y, unitsNow).toFixed(2));
    setValue('rdSpeakerZ', metresToDisplay(seed.z, unitsNow).toFixed(2));
    setValue('rdSpeakerAimH', Number(seed.aimH || 0).toFixed(1));
    setValue('rdSpeakerAimV', Number(seed.aimV || 0).toFixed(1));
    setValue('rdSpeakerRoll', Number(seed.roll || 0).toFixed(1));
    fillSelect('rdSpeakerPolarity', [
      { value: 'normal', label: 'Normal' },
      { value: 'inverted', label: 'Inverted' },
    ], source.polarity);
    fillSelect('rdSpeakerTiming', [
      { value: 'geometric', label: 'Geometric arrival' },
      { value: 'measured', label: 'Measured offset' },
    ], placed ? source.room.timing : 'geometric');
    setValue('rdSpeakerTimingOffset', placed ? source.room.timingOffsetMs.toFixed(2) : '0');
    const offsetRow = $('rdTimingOffsetRow');
    if (offsetRow) offsetRow.hidden = !placed || source.room.timing !== 'measured';
    const directivity = dataset ? (dataset.directivity || []) : [];
    setText('rdSpeakerDirectivity', directivity.length
      ? directivity.length + ' beamwidth points from the dataset'
      : 'No directivity data: aim moves the position but not the predicted level.');
  }

  function addSpeaker() {
    const modelId = readSelect('rdAddModel');
    const role = readSelect('rdAddRole') || 'main';
    const model = (project().models || []).find((entry) => entry.id === modelId);
    if (!model) {
      say('Choose a loudspeaker in the library first.', 'err');
      return;
    }
    const dataset = (model.datasets || [])[0] || null;
    const width = room().size.widthM;
    const placement = defaultPlacement(role, width, room().size.lengthM);
    let created = null;
    paint((next) => {
      const source = normalizeSource({
        modelId: model.id,
        datasetId: dataset ? dataset.id : '',
        name: model.name,
        room: { ...placement, role },
      });
      created = source;
      next.sources.push(source);
      selectedSourceId = source.id;
    }, 'Placed ' + model.name + ' in the room' + (dataset ? '.' : ' with no acoustic data yet.'));
    if (created) {
      renderSourceList();
      renderSpeakerForm();
    }
  }

  function defaultPlacement(role, width, length) {
    const centre = width / 2;
    if (role === 'sub') return { x: centre, y: 1.6, z: 0.35, aimH: 0, aimV: 0, roll: 0 };
    if (role === 'main') return { x: width * 0.2, y: 1.4, z: 5, aimH: 10, aimV: -8, roll: 0 };
    if (role === 'centre') return { x: centre, y: 0.8, z: 4, aimH: 0, aimV: -6, roll: 0 };
    if (role === 'frontfill') return { x: centre, y: 1, z: 1.4, aimH: 0, aimV: -12, roll: 0 };
    if (role === 'sidefill') return { x: width * 0.08, y: length * 0.3, z: 4, aimH: 70, aimV: -6, roll: 0 };
    if (role === 'mids') return { x: centre, y: length * 0.45, z: 6, aimH: 0, aimV: -6, roll: 0 };
    if (role === 'rear') return { x: centre, y: length * 0.78, z: 6, aimH: 0, aimV: -6, roll: 0 };
    return { x: centre, y: length * 0.5, z: 2, aimH: 0, aimV: 0, roll: 0 };
  }

  function placeSelected() {
    const source = (project().sources || []).find((entry) => entry.id === selectedSourceId);
    if (!source) {
      say('Select a loudspeaker to place.', 'err');
      return;
    }
    if (source.room) {
      say(source.name + ' is already placed at x ' + source.room.x.toFixed(2) + ', y ' +
        source.room.y.toFixed(2) + '.', 'ok');
      return;
    }
    const placement = defaultPlacement('main', room().size.widthM, room().size.lengthM);
    paint((next) => {
      const found = next.sources.find((entry) => entry.id === source.id);
      if (found) found.room = { ...placement, role: 'main', timing: 'geometric', timingOffsetMs: 0 };
    }, 'Placed ' + source.name + ' in the room.');
  }

  function applySpeakerFields() {
    const source = (project().sources || []).find((entry) => entry.id === selectedSourceId);
    if (!source) return;
    const unitsNow = units();
    paint((next) => {
      const found = next.sources.find((entry) => entry.id === source.id);
      if (!found) return;
      found.gainDb = Math.max(-30, Math.min(30, readNumber('rdSpeakerGain', found.gainDb)));
      found.delayMs = Math.max(-50, Math.min(100, readNumber('rdSpeakerDelay', found.delayMs)));
      found.polarity = readSelect('rdSpeakerPolarity') === 'inverted' ? 'inverted' : 'normal';
      found.groupId = readSelect('rdSpeakerGroup') || '';
      const x = displayToMetres(readNumber('rdSpeakerX', 0), unitsNow);
      const y = displayToMetres(readNumber('rdSpeakerY', 0), unitsNow);
      const z = displayToMetres(readNumber('rdSpeakerZ', 0), unitsNow);
      found.room = {
        x, y, z: Math.max(0, z),
        aimH: Math.max(-180, Math.min(180, readNumber('rdSpeakerAimH', 0))),
        aimV: Math.max(-90, Math.min(90, readNumber('rdSpeakerAimV', 0))),
        roll: Math.max(-180, Math.min(180, readNumber('rdSpeakerRoll', 0))),
        role: readSelect('rdSpeakerRole') || 'custom',
        timing: readSelect('rdSpeakerTiming') === 'measured' ? 'measured' : 'geometric',
        timingOffsetMs: Math.max(-50, Math.min(50, readNumber('rdSpeakerTimingOffset', 0))),
      };
    }, 'Updated ' + source.name + ': gain, delay, polarity and placement are shared with the Data Modeler.');
    renderSpeakerForm();
  }

  function deleteSpeaker() {
    const source = (project().sources || []).find((entry) => entry.id === selectedSourceId);
    if (!source) return;
    paint((next) => {
      next.sources = next.sources.filter((entry) => entry.id !== source.id);
    }, 'Removed ' + source.name + ' from the model.');
    selectedSourceId = null;
    renderSpeakerForm();
  }

  /* ---------- drawing the outline ---------- */

  /**
   * Add a corner to a custom plan: the new point starts at the midpoint of the
   * longest edge, so it lands on the outline and can then be dragged out with
   * the Vertex tool instead of jumping somewhere unexpected.
   */
  function addVertex() {
    if (room().shape !== 'custom') {
      say('Switch the shape to “Custom polygon” before adding a corner.', 'err');
      return;
    }
    paint((next) => {
      const outline = generateOutline(next.room).slice();
      let best = 0;
      let longest = -1;
      for (let index = 0; index < outline.length; index += 1) {
        const a = outline[index];
        const b = outline[(index + 1) % outline.length];
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        if (length > longest) {
          longest = length;
          best = index;
        }
      }
      const a = outline[best];
      const b = outline[(best + 1) % outline.length];
      outline.splice(best + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      next.room.outline = outline;
    }, 'Added a corner on the longest wall — drag it with the Vertex tool.');
  }

  function removeVertex() {
    if (room().shape !== 'custom') {
      say('Switch the shape to “Custom polygon” before removing a corner.', 'err');
      return;
    }
    if (room().outline.length <= 3) {
      say('A room polygon needs at least three corners.', 'err');
      return;
    }
    paint((next) => {
      const outline = generateOutline(next.room).slice();
      if (outline.length > 3) outline.pop();
      next.room.outline = outline;
    }, 'Removed the last corner.');
  }

  /* ---------- grouped movement ---------- */

  /**
   * Move a whole group — or every cabinet with the selected one's role — by one
   * offset. Each cabinet keeps its own aim, delay and DSP; only the position
   * changes, so nothing about one box is rewritten by a move of the group.
   */
  function moveGroup() {
    const groupId = readSelect('rdGroupMove');
    const anchor = (project().sources || []).find((entry) => entry.id === selectedSourceId);
    const dx = displayToMetres(readNumber('rdGroupDx', 0), units());
    const dy = displayToMetres(readNumber('rdGroupDy', 0), units());
    if (!dx && !dy) {
      say('Enter how far the group should move (x or y).', 'err');
      return;
    }
    const members = (project().sources || []).filter((entry) => entry.room && (groupId
      ? entry.groupId === groupId
      : !!anchor && !!anchor.room && entry.room.role === anchor.room.role));
    if (!members.length) {
      say(groupId ? 'No placed cabinet is in that group.'
        : 'Select a placed cabinet, or choose a group, so the move knows what to take with it.', 'err');
      return;
    }
    paint((next) => {
      const bounds = outlineBounds(next.room.outline);
      for (const member of members) {
        const found = next.sources.find((entry) => entry.id === member.id);
        if (!found || !found.room) continue;
        found.room.x = Math.max(bounds.minX, Math.min(bounds.maxX, found.room.x + dx));
        found.room.y = Math.max(bounds.minY, Math.min(bounds.maxY, found.room.y + dy));
        found.room.z = Math.max(0, Math.min(
          ceilingHeightAt(next.room, found.room.x, found.room.y) - 0.2,
          found.room.z,
        ));
      }
    }, 'Moved ' + members.length + ' cabinet' + (members.length === 1 ? '' : 's') +
      ' together by ' + metresToDisplay(dx, units()).toFixed(2) + ' / ' +
      metresToDisplay(dy, units()).toFixed(2) + ' ' + unitSuffix(units()) + '.');
  }

  /* ---------- virtual microphones ---------- */

  function defaultMic() {
    const bounds = room().outline;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const point of bounds) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }
    const x = (minX + maxX) / 2;
    const y = minY + (maxY - minY) * 0.4;
    return {
      id: 'mic-' + Date.now().toString(36),
      name: 'Mic ' + ((room().mics || []).length + 1),
      x, y, z: listenerZ(room(), x, y),
      captureId: '', captureName: '', note: '',
    };
  }

  /**
   * The five positions most systems are checked at, once each: left, centre,
   * right across the middle of the audience, and front and rear on the centre
   * line. A name that is already in the room is left alone.
   */
  function addStandardMics() {
    const metrics = roomMetrics(room());
    const bounds = metrics.bounds;
    const width = bounds.maxX - bounds.minX;
    const depth = bounds.maxY - bounds.minY;
    const wanted = [
      ['Left', bounds.minX + width * 0.25, bounds.minY + depth * 0.5],
      ['Centre', bounds.minX + width * 0.5, bounds.minY + depth * 0.5],
      ['Right', bounds.minX + width * 0.75, bounds.minY + depth * 0.5],
      ['Front', bounds.minX + width * 0.5, bounds.minY + depth * 0.15],
      ['Rear', bounds.minX + width * 0.5, bounds.minY + depth * 0.85],
    ];
    const existing = new Set((room().mics || []).map((mic) => mic.name.toLowerCase()));
    let added = 0;
    paint((next) => {
      for (const [name, x, y] of wanted) {
        if (existing.has(name.toLowerCase())) continue;
        next.room.mics.push({
          id: 'mic-' + Date.now().toString(36) + Math.random().toString(16).slice(2, 5),
          name,
          x,
          y,
          z: listenerZ(next.room, x, y),
          captureId: '',
          captureName: '',
          note: '',
        });
        added += 1;
      }
    }, added
      ? 'Added ' + added + ' listening position' + (added === 1 ? '' : 's') + ' across the audience.'
      : 'Left, centre, right, front and rear are already in the room.');
    renderMicList();
    recalculate();
  }

  function addMic(point) {
    const x = point ? point.x : room().size.widthM / 2;
    const y = point ? point.y : room().size.lengthM * 0.4;
    const mic = {
      id: 'mic-' + Date.now().toString(36),
      name: 'Mic ' + ((room().mics || []).length + 1),
      x, y, z: listenerZ(room(), x, y),
      captureId: '', captureName: '', note: '',
    };
    paint((next) => { next.room.mics.push(mic); }, 'Added ' + mic.name + '.');
    selectedMicId = mic.id;
    renderMicList();
    recalculate();
  }

  function renderMicList() {
    const host = $('rdMicList');
    if (!host) return;
    host.replaceChildren();
    const list = room().mics || [];
    if (!list.length) {
      const row = el('li', 'rd-list-row');
      row.appendChild(el('span', 'source-hint', 'No virtual microphone yet.'));
      host.appendChild(row);
    }
    for (const mic of list) {
      const row = el('li', 'rd-list-row');
      const button = el('button', 'rd-list-main', mic.name);
      button.type = 'button';
      if (mic.id === selectedMicId) button.classList.add('on');
      button.addEventListener('click', () => {
        selectedMicId = mic.id;
        renderMicList();
        recalculate();
      });
      row.appendChild(button);
      const tags = el('span', 'rd-list-tags');
      if (mic.captureName) tags.appendChild(el('span', 'rd-list-tag', 'measured: ' + mic.captureName));
      if (mic.id === room().settings.refMicId) tags.appendChild(el('span', 'rd-list-tag', 'reference'));
      row.appendChild(tags);
      host.appendChild(row);
    }

    const mic = currentMic();
    const fields = $('rdMicForm');
    if (fields) fields.hidden = !mic;
    if (mic) {
      const unitsNow = units();
      setText('rdMicTitle', mic.name);
      setValue('rdMicName', mic.name);
      setValue('rdMicX', metresToDisplay(mic.x, unitsNow).toFixed(2));
      setValue('rdMicY', metresToDisplay(mic.y, unitsNow).toFixed(2));
      setValue('rdMicZ', metresToDisplay(mic.z, unitsNow).toFixed(2));
      setValue('rdMicNote', mic.note || '');
      const captures = [{ value: '', label: 'Not associated' }].concat(library().map((entry) => ({
        value: entry.id,
        label: entry.name + (entry.date ? ' · ' + String(entry.date).slice(0, 10) : ''),
      })));
      fillSelect('rdMicCapture', captures, mic.captureId || '');
      setText('rdMicCaptureNote', mic.captureName
        ? 'Associated measurement: “' + mic.captureName + '”. The predicted curve here is ' +
          'computed, not measured; the two are kept apart.'
        : 'No measured capture is associated with this position.');
    }
    const refSelect = $('rdRefMic');
    if (refSelect) {
      fillSelect('rdRefMic', (room().mics || []).map((entry) => ({ value: entry.id, label: entry.name })),
        room().settings.refMicId);
    }
  }

  function applyMicFields() {
    const mic = currentMic();
    if (!mic) return;
    const unitsNow = units();
    paint((next) => {
      const found = next.room.mics.find((entry) => entry.id === mic.id);
      if (!found) return;
      found.name = readText('rdMicName').slice(0, 40) || found.name;
      found.x = displayToMetres(readNumber('rdMicX', 0), unitsNow);
      found.y = displayToMetres(readNumber('rdMicY', 0), unitsNow);
      found.z = Math.max(0.1, displayToMetres(readNumber('rdMicZ', 0), unitsNow));
      found.note = readText('rdMicNote').slice(0, 200);
    }, 'Moved ' + mic.name + '.');
    renderMicList();
  }

  function associateCapture() {
    const mic = currentMic();
    if (!mic) {
      say('Select a virtual microphone first.', 'err');
      return;
    }
    const id = readSelect('rdMicCapture');
    const entry = library().find((item) => item.id === id);
    paint((next) => {
      const found = next.room.mics.find((item) => item.id === mic.id);
      if (!found) return;
      found.captureId = entry ? entry.id : '';
      found.captureName = entry ? entry.name : '';
    }, entry
      ? 'Associated “' + entry.name + '” with ' + mic.name + '. The measurement stays in the ' +
        'capture library; this position only points at it.'
      : 'Cleared the measurement associated with ' + mic.name + '.');
    renderMicList();
  }

  function setReferenceMic() {
    const id = readSelect('rdRefMic');
    paint((next) => { next.room.settings.refMicId = id; },
      'The map is normalised to ' + ((room().mics.find((entry) => entry.id === id) || {}).name || 'no microphone') + '.');
    renderMicList();
  }

  function sendMicToModeler() {
    const mic = currentMic();
    if (!mic) {
      say('Select a virtual microphone first.', 'err');
      return;
    }
    if (!prediction || !prediction.ok) {
      say('There is no predicted response at this position to send.', 'err');
      return;
    }
    const response = {
      frequencies: Array.from(prediction.frequencies),
      magDb: Array.from(prediction.sum.magDb),
      phaseDeg: prediction.phaseValid ? Array.from(prediction.sum.phaseDeg) : null,
      coherence: null,
      fMin: prediction.frequencies[0],
      fMax: prediction.frequencies[prediction.frequencies.length - 1],
      points: prediction.frequencies.length,
    };
    const result = modeler.sendResponse(response, {
      label: 'Room prediction · ' + mic.name,
      importedFrom: 'Room Designer · ' + room().name,
      positionLabel: mic.name,
      venue: room().name,
      note: 'Predicted in the Room Designer at x ' + mic.x.toFixed(2) + ', y ' + mic.y.toFixed(2) +
        ', z ' + mic.z.toFixed(2) + ' m — direct sound only, not a measurement.',
    });
    if (!result || !result.ok) {
      say((result && result.message) || 'The prediction could not be sent.', 'err');
      return;
    }
    say(result.message + ' Opening the Data Modeler.', 'ok');
    close();
    modeler.open();
  }

  /* ---------- the subwoofer array ---------- */

  function renderArrayGroups() {
    const groups = [{ value: '', label: 'All subwoofers in the room' }].concat((project().groups || [])
      .map((entry) => ({ value: entry.id, label: entry.name })));
    fillSelect('rdArrayGroup', groups, readSelect('rdArrayGroup'));
    const moveGroups = [{ value: '', label: 'The selected cabinet’s role' }].concat((project().groups || [])
      .map((entry) => ({ value: entry.id, label: entry.name })));
    fillSelect('rdGroupMove', moveGroups, readSelect('rdGroupMove'));
    const preset = ARRAY_PRESETS.find((entry) => entry.id === readSelect('rdArrayPreset'));
    setText('rdArrayNote', preset ? preset.note : '');
  }

  function arraySources() {
    const groupId = readSelect('rdArrayGroup');
    return (project().sources || []).filter((source) => {
      if (!source.room) return false;
      if (source.room.role !== 'sub' && groupId === '') return false;
      if (groupId && source.groupId !== groupId) return false;
      return true;
    });
  }

  function applyArray() {
    const sources = arraySources();
    if (!sources.length) {
      say('There are no placed subwoofers to arrange.', 'err');
      return;
    }
    const preset = readSelect('rdArrayPreset') || 'broadside';
    if (preset === 'custom') {
      say('The custom arrangement leaves every cabinet where it is.', 'ok');
      return;
    }
    const average = sources.reduce((sum, source) => sum + source.room.x, 0) / sources.length;
    const front = Math.min(...sources.map((source) => source.room.y));
    const height = Math.min(...sources.map((source) => source.room.z));
    const layout = arrayLayout(preset, {
      count: Math.min(sources.length, Math.max(1, Math.round(readNumber('rdArrayCount', sources.length)))),
      spacingM: readNumber('rdArraySpacing', 1.2),
      frequencyHz: readNumber('rdArrayFreq', 80),
      gainDb: readNumber('rdArrayGain', 0),
      polarity: readSelect('rdArrayPolarity') || 'normal',
      speedOfSound: settings().speedOfSound,
      halfWidthM: room().size.widthM * 0.22,
    });
    const assignments = arrayAssignments(sources, layout, { originX: average, originY: front, originZ: height });
    compareBefore = heatmap ? {
      values: Float64Array.from(heatmap.values),
      statistics: { ...heatmap.statistics },
      metric: heatmap.metric,
      frequencyHz: heatmap.frequencyHz,
      cols: heatmap.cols,
      rows: heatmap.rows,
    } : null;
    paint((next) => {
      for (const assignment of assignments) {
        const found = next.sources.find((entry) => entry.id === assignment.id);
        if (!found || !found.room) continue;
        found.room.x = Math.max(0.2, Math.min(next.room.size.widthM - 0.2, assignment.x));
        found.room.y = Math.max(0.2, assignment.y);
        found.room.z = Math.max(0, assignment.z);
        found.delayMs = Math.max(-50, Math.min(50, assignment.delayMs));
        found.polarity = assignment.polarity;
        if (Number.isFinite(assignment.gainDb)) {
          found.gainDb = Math.max(-30, Math.min(30, assignment.gainDb));
        }
      }
    }, 'Applied ' + (ARRAY_PRESETS.find((entry) => entry.id === preset) || {}).label + ' to ' +
      assignments.length + ' subwoofer' + (assignments.length === 1 ? '' : 's') +
      '. Spacing ' + layout.spacingM.toFixed(2) + ' m; quarter wave at ' +
      layout.frequencyHz + ' Hz is ' + layout.quarterWaveM.toFixed(2) + ' m.');
    compareArray();
  }

  function compareArray() {
    const host = $('rdCompareChart');
    const note = $('rdCompareNote');
    if (!host) return;
    drawComparison();
    if (!note) return;
    if (!compareBefore) {
      setText('rdCompareNote', 'Apply an arrangement and this compares the coverage with the one before it. ' +
        'Only coverage figures are compared; nothing is written to a processor.');
      return;
    }
    if (!heatmap || !heatmap.ok) {
      setText('rdCompareNote', 'No current map to compare with the previous arrangement.');
      return;
    }
    const before = compareBefore.statistics;
    const now = heatmap.statistics;
    const rows = [
      'Range ' + (Number.isFinite(before.rangeDb) ? before.rangeDb.toFixed(1) : '—') + ' → ' +
        (Number.isFinite(now.rangeDb) ? now.rangeDb.toFixed(1) : '—') + ' dB',
      'Spread ' + (Number.isFinite(before.spreadDb) ? before.spreadDb.toFixed(1) : '—') + ' → ' +
        (Number.isFinite(now.spreadDb) ? now.spreadDb.toFixed(1) : '—') + ' dB',
      'Within ±' + now.toleranceDb + ' dB ' +
        (Number.isFinite(before.withinTolerance) ? (before.withinTolerance * 100).toFixed(0) : '—') +
        ' → ' + (Number.isFinite(now.withinTolerance) ? (now.withinTolerance * 100).toFixed(0) : '—') + ' %',
    ];
    setText('rdCompareNote', rows.join(' · ') +
      '. Predicted at ' + formatFrequency(heatmap.frequencyHz) + ', direct sound only.');
  }

  function drawComparison() {
    const host = $('rdCompareChart');
    if (!host) return;
    const rows = [];
    if (compareBefore) {
      rows.push({ label: 'Before · range', value: compareBefore.statistics.rangeDb || 0, unit: ' dB', colour: 'rgba(148, 170, 194, 0.8)' });
    }
    if (heatmap && heatmap.ok) {
      rows.push({ label: 'After · range', value: heatmap.statistics.rangeDb || 0, unit: ' dB', colour: '#5ec8ff' });
      rows.push({ label: 'After · spread', value: heatmap.statistics.spreadDb || 0, unit: ' dB', colour: '#8ef0b5' });
    }
    if (compareBefore) {
      rows.push({ label: 'Before · spread', value: compareBefore.statistics.spreadDb || 0, unit: ' dB', colour: 'rgba(148, 170, 194, 0.6)' });
    }
    drawComparisonBars(host, rows);
  }

  /* ---------- the Pioneer example ---------- */

  function loadWarehouse() {
    const created = [];
    paint((next) => {
      next.room = normalizeRoom(warehouseRoom(next.room.units));
      const entries = warehouseSources(next.room);
      for (const entry of entries) {
        let model = next.models.find((candidate) =>
          candidate.manufacturer === entry.manufacturer && candidate.model === entry.model &&
          candidate.name === entry.model);
        if (!model) {
          model = {
            id: 'm-' + Date.now().toString(36) + Math.random().toString(16).slice(2, 6),
            name: entry.model,
            manufacturer: entry.manufacturer,
            model: entry.model,
            type: entry.type,
            impedanceOhm: 8,
            sensitivityDb: 96,
            distanceM: 1,
            referenceDelayMs: 0,
            crossoverText: '',
            directivityText: '',
            specs: '',
            notes: 'Template only: no manufacturer acoustic data is loaded for this loudspeaker.',
            provenance: 'theoretical',
            datasets: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          next.models.push(model);
        }
        const source = normalizeSource({
          modelId: model.id,
          datasetId: '',
          name: entry.name,
          note: entry.note,
          room: {
            x: entry.x, y: entry.y, z: entry.z,
            aimH: entry.aimH, aimV: entry.aimV, roll: 0,
            role: entry.role, timing: 'geometric', timingOffsetMs: 0,
          },
        });
        next.sources.push(source);
        created.push(source);
      }
    }, 'Loaded the Pioneer warehouse example: 41 × 110 ft, A-frame ceiling to 40 ft. ' +
      'The cabinets are template positions with no acoustic data — import a CLF, FRD or ' +
      'measurement for each one before trusting a prediction.');
    selectedSourceId = created.length ? created[0].id : null;
    selectedStructure = null;
    selectedMicId = room().settings.refMicId || (room().mics[0] && room().mics[0].id) || null;
    settings().frequencyHz = 100;
    buildSelects();
    renderRoomFields();
    renderSourceList();
    renderSpeakerForm();
    renderMicList();
    recalculate();
  }

  /* ---------- demonstration responses ---------- */

  function loadDemoResponses() {
    const sources = project().sources || [];
    if (!sources.length) {
      say('Place loudspeakers first, then demonstration responses can be attached to them.', 'err');
      return;
    }
    const frequencies = gridFrequencies(400);
    let count = 0;
    paint((next) => {
      for (const source of next.sources) {
        const modelId = source.modelId;
        let model = next.models.find((entry) => entry.id === modelId);
        const isSub = source.room && source.room.role === 'sub';
        // A model can hold one demonstration response, shared by every cabinet
        // that models the same loudspeaker. A model that already carries real
        // data is left exactly as it is: demonstration data never overwrites a
        // measurement.
        let dataset = model && (model.datasets || []).find((entry) =>
          /DEMONSTRATION/.test(entry.label || ''));
        if (!dataset && model && (model.datasets || []).length) continue;
        if (!dataset) {
          // A clearly labelled demonstration response: a plausible shape and no
          // phase, so every prediction that uses it is a demonstration too.
          const magDb = Array.from(frequencies, (f) => {
            if (isSub) {
              if (f < 25) return -18;
              if (f > 160) return -12;
              return 0;
            }
            if (f < 80) return -12;
            if (f > 12000) return -6;
            return 0;
          });
          dataset = {
            id: 'demo-' + Date.now().toString(36) + Math.random().toString(16).slice(2, 6),
            label: 'DEMONSTRATION response',
            provenance: 'theoretical',
            importedFrom: 'Room Designer demonstration',
            curve: { magDb, phaseDeg: null, coherence: null },
            points: 400,
            hasPhase: false,
            phaseOrigin: 'none',
            fMin: CURVE_FMIN,
            fMax: CURVE_FMAX,
            sampleRate: 0,
            fftSize: 0,
            delayMs: 0,
            conditions: { reference: '', phaseCompensated: false, micLabel: '', venue: '' },
            origin: null,
            directivity: [],
            note: 'DEMO: a shape invented to exercise the prediction engine, not a loudspeaker.',
            importedAt: new Date().toISOString(),
          };
        }
        if (!model) {
          model = {
            id: 'm-' + Date.now().toString(36) + Math.random().toString(16).slice(2, 6),
            name: source.name,
            manufacturer: 'DEMO',
            model: 'DEMO',
            type: isSub ? 'Subwoofer' : 'Full-range',
            impedanceOhm: 8,
            sensitivityDb: 96,
            distanceM: 1,
            referenceDelayMs: 0,
            crossoverText: '',
            directivityText: '',
            specs: 'DEMO',
            notes: 'Demonstration data only.',
            provenance: 'theoretical',
            datasets: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          next.models.push(model);
        }
        if (!model.datasets.some((entry) => entry.id === dataset.id)) {
          model.datasets.push(dataset);
        }
        const found = next.sources.find((entry) => entry.id === source.id);
        if (found) found.datasetId = dataset.id;
        count += 1;
      }
    }, 'Attached ' + count + ' DEMONSTRATION response' + (count === 1 ? '' : 's') +
      '. They are labelled DEMO everywhere and are not manufacturer data.');
    renderSourceList();
    recalculate();
  }

  /* ---------- refresh ---------- */

  /**
   * The modeler's loudspeaker library is the only source of cabinets, so a
   * speaker built in the custom speaker builder — or imported — appears here as
   * soon as it is saved. Nothing is copied into the room project.
   */
  function renderLibrarySelect() {
    const items = (project().models || []).map((model) => {
      const count = (model.datasets || []).length;
      return {
        value: model.id,
        label: model.name + ' · ' + (count
          ? count + ' dataset' + (count === 1 ? '' : 's')
          : 'no acoustic data'),
      };
    });
    const select = $('rdAddModel');
    const previous = select ? select.value : '';
    if (!items.length) {
      fillSelect('rdAddModel',
        [{ value: '', label: 'No loudspeakers yet · build one in the Data Modeler' }], '');
      return;
    }
    fillSelect('rdAddModel', items,
      items.some((item) => item.value === previous) ? previous : items[0].value);
  }

  function refreshAll() {
    if (!active) return;
    renderLibrarySelect();
    renderRoomFields();
    renderStructureList();
    renderSourceList();
    renderSpeakerForm();
    renderMicList();
    renderArrayGroups();
    renderLeftGroups();
    recalculate();
  }

  function renderLeftGroups() {
    const groups = [{ value: '', label: 'Split by the room centre' }].concat((project().groups || [])
      .map((entry) => ({ value: entry.id, label: entry.name })));
    fillSelect('rdLeftGroup', groups, settings().leftGroupId || '');
    fillSelect('rdRightGroup', groups, settings().rightGroupId || '');
  }

  /* ---------- events ---------- */

  function bindEvents() {
    if (bound) return;
    bound = true;

    const on = (id, handler, event) => {
      const node = $(id);
      if (node) node.addEventListener(event || 'click', handler);
    };

    on('btnRdClose', () => close());
    on('btnRdModeler', () => { close(); modeler.open(); });
    on('btnRdSave', () => {
      paint((next) => { next.room.updatedAt = new Date().toISOString(); }, 'Room saved with the project.');
    });
    on('btnRdApplyGeometry', () => applyRoomDimensions());
    on('rdUnits', () => {
      paint((next) => { next.units = readSelect('rdUnits'); }, 'Units set to ' + readSelect('rdUnits') + '.');
    }, 'change');
    on('rdCeiling', () => applyRoomDimensions(), 'change');
    on('rdShape', () => applyRoomDimensions(), 'change');
    on('btnRdApplyTemplate', () => {
      const id = readSelect('rdTemplate');
      if (id === 'warehouse') {
        loadWarehouse();
        return;
      }
      paint((next) => { next.room = roomTemplate(id); },
        'Applied the ' + ((ROOM_TEMPLATES.find((entry) => entry.id === id) || {}).label) + ' template.');
      selectedStructure = null;
      selectedMicId = room().settings.refMicId || (room().mics[0] && room().mics[0].id) || null;
      buildSelects();
      refreshAll();
    });
    on('btnRdWarehouse', () => loadWarehouse());
    on('btnRdDemoResponses', () => loadDemoResponses());
    on('btnRdAddStructure', () => addStructure());
    on('btnRdAddVertex', () => addVertex());
    on('btnRdRemoveVertex', () => removeVertex());
    on('btnRdApplyStructure', () => applyStructure());
    on('btnRdDeleteStructure', () => deleteStructure());
    on('btnRdAddSpeaker', () => addSpeaker());
    on('btnRdPlaceSelected', () => placeSelected());
    on('btnRdApplySpeaker', () => applySpeakerFields());
    on('btnRdDeleteSpeaker', () => deleteSpeaker());
    on('btnRdAddMic', () => addMic(null));
    on('btnRdAddStandardMics', () => addStandardMics());
    on('btnRdMoveGroup', () => moveGroup());
    on('rdPredictionMode', () => {
      const mode = PREDICTION_MODES.find((entry) => entry.id === readSelect('rdPredictionMode'));
      setText('rdAcousticNote', mode ? mode.note : '');
      if (mode && !mode.implemented) {
        say('Room-inclusive prediction is not implemented in this build. No image-source, ' +
          'ray-tracing or modal solver exists, so nothing is drawn for it: the map stays a ' +
          'direct-sound prediction.', 'err');
      }
    }, 'change');
    on('rdSnap', () => {
      paint((next) => { next.room.settings.snapM = Number(readSelect('rdSnap')) || 0; },
        'Grid: ' + (Number(readSelect('rdSnap')) > 0 ? readSelect('rdSnap') + ' m' : 'off') + '.');
    }, 'change');
    on('btnRdApplyMic', () => applyMicFields());
    on('btnRdAssociateCapture', () => associateCapture());
    on('btnRdSendMic', () => sendMicToModeler());
    on('rdRefMic', () => setReferenceMic(), 'change');
    on('btnRdApplyArray', () => applyArray());
    on('btnRdCompareArray', () => compareArray());
    on('rdArrayPreset', () => {
      const preset = ARRAY_PRESETS.find((entry) => entry.id === readSelect('rdArrayPreset'));
      setText('rdArrayNote', preset ? preset.note : '');
    }, 'change');

    for (const [id, value] of [
      ['btnRdViewPlan', 'plan'], ['btnRdViewSection', 'section'], ['btnRdView3d', '3d'],
    ]) {
      on(id, () => {
        settings().view = value;
        paint((next) => { next.room.settings.view = value; }, 'View: ' + value + '.');
        document.querySelectorAll('.rd-view-btn').forEach((button) => {
          button.classList.toggle('on', button.id === id);
        });
        draw();
      });
    }
    for (const [id, value] of [
      ['btnRdToolSelect', 'select'], ['btnRdToolMic', 'mic'], ['btnRdToolRuler', 'ruler'],
      ['btnRdToolVertex', 'vertex'],
    ]) {
      on(id, () => {
        tool = value;
        document.querySelectorAll('.rd-tool-btn').forEach((button) => {
          button.classList.toggle('on', button.id === id);
        });
        if (chart) chart.draw();
      });
    }
    on('chkRdHeatmap', () => scheduleRecalculate(), 'change');
    on('chkRdCoverage', () => draw(), 'change');
    on('rdMetric', () => {
      paint((next) => { next.room.settings.metric = readSelect('rdMetric'); }, '');
      scheduleRecalculate();
    }, 'change');
    on('rdBandMode', () => {
      paint((next) => { next.room.settings.bandMode = readSelect('rdBandMode'); }, '');
      scheduleRecalculate();
    }, 'change');
    on('rdFrequency', () => {
      paint((next) => { next.room.settings.frequencyHz = Number(readSelect('rdFrequency')); }, '');
      scheduleRecalculate();
    }, 'change');
    on('rdNormalize', () => scheduleRecalculate(), 'change');
    on('rdLevelMode', () => { renderPrediction(); drawResponse(); }, 'change');
    on('rdLevelOffset', () => { renderPrediction(); drawResponse(); }, 'input');
    on('rdLeftGroup', () => {
      paint((next) => { next.room.settings.leftGroupId = readSelect('rdLeftGroup'); }, '');
      scheduleRecalculate();
    }, 'change');
    on('rdRightGroup', () => {
      paint((next) => { next.room.settings.rightGroupId = readSelect('rdRightGroup'); }, '');
      scheduleRecalculate();
    }, 'change');
    on('btnRdCalculate', () => recalculate());
    on('btnRdZoomFit', () => {
      if (chart) {
        chart.zoom = 1;
        chart.pan = { x: 0, y: 0 };
        chart.draw();
      }
    });
    on('btnRdExport', () => exportRoom());
    on('btnRdImport', () => $('rdFile')?.click());
    on('rdFile', (event) => importRoom(event), 'change');
  }

  /* ---------- import and export ---------- */

  function exportRoom() {
    const payload = {
      format: 'align-room',
      version: 1,
      exported: new Date().toISOString(),
      room: room(),
      sources: (project().sources || []).filter((source) => source.room).map((source) => ({
        name: source.name,
        modelId: source.modelId,
        datasetId: source.datasetId,
        gainDb: source.gainDb,
        delayMs: source.delayMs,
        polarity: source.polarity,
        groupId: source.groupId,
        room: source.room,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const name = (room().name || 'room').replace(/[^a-z0-9\-_ ]/gi, '').trim().replace(/\s+/g, '-');
    if (opts.share) opts.share(blob, name + '.json', 'Room');
    else {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = name + '.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }
    say('Exported the room geometry and every placed cabinet.', 'ok');
  }

  function importRoom(event) {
    const input = event && event.target;
    const file = input && input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        const candidate = parsed && parsed.room ? parsed.room : parsed;
        if (!candidate || typeof candidate !== 'object') throw new Error('no room');
        const next = normalizeRoom(candidate);
        paint((state) => { state.room = next; }, 'Imported the room “' + next.name + '”.');
        selectedMicId = next.settings.refMicId || (next.mics[0] && next.mics[0].id) || null;
        buildSelects();
        refreshAll();
      } catch (err) {
        say('That file is not a room exported by this app. Nothing was changed.', 'err');
      }
      if (input) input.value = '';
    };
    reader.onerror = () => say('The file could not be read. Nothing was changed.', 'err');
    reader.readAsText(file);
  }

  /* ---------- the workspace ---------- */

  function resize() {
    if (chart) chart.resize();
    drawResponse();
  }

  return {
    open,
    close,
    get active() { return active; },
    resize,
    recalculate: () => { if (active) recalculate(); },
    loadWarehouse,
    loadDemo: loadDemoResponses,
    applyArray,
    sendMicToModeler,
    get room() { return room(); },
    get prediction() { return prediction; },
    get heatmap() { return heatmap; },
    setRoom: (next) => {
      paint((state) => { state.room = normalizeRoom(next); }, 'Room replaced.');
      buildSelects();
      refreshAll();
    },
  };
}
