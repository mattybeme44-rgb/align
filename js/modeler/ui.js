/*
 * The System Data Modeler workspace.
 *
 * This is the screen: the library, the model workspace, the charts, the DSP
 * chain, the optimizer, the comparison and the exports. Every number on it is
 * computed by the engine in this folder from data that was imported or measured
 * here — nothing on this screen is a drawn decoration.
 *
 * The screen only reads the measurement app: the capture library and the live
 * measurement are offered as sources of data, and nothing is ever written back
 * into the measurement, the audio path or a processor.
 */

import {
  CURVE_FMIN,
  CURVE_FMAX,
  GRID_POINTS,
  SPEED_OF_SOUND,
  describeResponseText,
  formatDelay,
  formatFrequency,
  formatRangeText,
  fractionalOctaveSmooth,
  gridFrequency,
  parseResponseText,
  pathLengthMm,
  resampleResponse,
} from './curve.js';
import {
  MODEL_TYPES,
  OBJECTIVES,
  PROVENANCES,
  bandTable,
  compareSum,
  emptyProject,
  evaluateSystem,
  findDataset,
  groupDelay,
  newModel,
  normalizeDataset,
  normalizeProject,
  normalizeSource,
  optimizeAlignment,
  provenanceLabel,
  synthesizeImpulse,
} from './model.js';
import {
  CROSSOVER_FAMILIES,
  CROSSOVER_SLOPES,
  FILTER_KINDS,
  chainExportText,
  designCrossover,
  filterKind,
  filterText,
  newFilter,
  signed,
} from './filters.js';
import { ModelerChart, TRACE_COLORS } from './chart.js';
import { impulseToResponse, parseWav } from './wav.js';
import { loadLayout, loadProject, persistLayout } from './store.js';

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function numberInput(value, step, min, max) {
  const input = el('input', 'dm-number');
  input.type = 'number';
  input.value = String(value);
  if (step !== undefined) input.step = String(step);
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  input.inputMode = 'decimal';
  return input;
}

function selectFrom(items, value) {
  const select = el('select', 'dm-select');
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = item.label;
    select.appendChild(option);
  }
  select.value = value;
  return select;
}

function button(label, className, dataset) {
  const node = el('button', className || 'btn', label);
  node.type = 'button';
  if (dataset) for (const [key, value] of Object.entries(dataset)) node.dataset[key] = value;
  return node;
}

function formatTraceLevel(value) {
  if (!Number.isFinite(value)) return '—';
  return (value >= 0 ? '+' : '') + value.toFixed(1) + ' dB';
}

/**
 * A stored capture as a response on the grid. A capture taken with delay
 * compensation carries phase with the arrival removed; the measured phase is put
 * back so a modelled delay means the same thing on both curves.
 */
function responseFromSaved(item) {
  const count = Array.isArray(item.curve) ? item.curve.length : 0;
  if (count < 2) return null;
  const frequencies = [];
  const magDb = [];
  for (let i = 0; i < count; i += 1) {
    const value = Number(item.curve[i]);
    if (!Number.isFinite(value)) return null;
    frequencies.push(gridFrequency(i, count));
    magDb.push(value);
  }
  let phaseDeg = null;
  if (Array.isArray(item.phase) && item.phase.length === count) {
    phaseDeg = item.phase.map(Number);
    const delayMs = Number(item.delayMs);
    if (item.phaseCompensated && Number.isFinite(delayMs)) {
      phaseDeg = phaseDeg.map((value, index) => value - (360 * frequencies[index] * delayMs) / 1000);
    }
  }
  return {
    frequencies,
    magDb,
    phaseDeg,
    coherence: Array.isArray(item.phaseCoherence) && item.phaseCoherence.length === count
      ? item.phaseCoherence.map((value) => Math.max(0, Math.min(1, Number(value))))
      : null,
    fMin: frequencies[0],
    fMax: frequencies[count - 1],
    points: count,
    sampleRate: Number(item.sampleRate) || 0,
    fftSize: Number(item.fftSize) || 0,
    delayMs: Number(item.delayMs) || 0,
    label: item.name || 'Capture',
  };
}

/** A live (or held) analyser result as a response, on its own linear bins. */
function responseFromAnalyser(source) {
  const res = source && source.results ? source.results : source;
  if (!res || !res.magDb) return null;
  const sampleRate = Number(res.sampleRate) || 0;
  const fftSize = Number(res.fftSize) || 0;
  const df = Number(res.df) > 0 ? Number(res.df) : sampleRate && fftSize ? sampleRate / fftSize : 0;
  if (!(df > 0)) return null;

  const frequencies = [];
  const magDb = [];
  const phaseDeg = [];
  const coherence = [];
  let hasPhase = true;
  let hasCoherence = true;
  const compensated = !!source.compensated;
  const delayMs = Number(source.delayMs) || 0;

  for (let k = 1; k < res.magDb.length; k += 1) {
    const frequency = k * df;
    if (!(frequency > 0) || frequency > Math.min(22000, sampleRate / 2 - 1)) continue;
    const magnitude = Number(res.magDb[k]);
    if (!Number.isFinite(magnitude)) continue;
    frequencies.push(frequency);
    magDb.push(magnitude);
    if (hasPhase && res.phaseDeg && Number.isFinite(Number(res.phaseDeg[k]))) {
      let phase = Number(res.phaseDeg[k]);
      if (compensated) phase -= (360 * frequency * delayMs) / 1000;
      phaseDeg.push(phase);
    } else hasPhase = false;
    if (hasCoherence && res.coh && Number.isFinite(Number(res.coh[k]))) {
      coherence.push(Math.max(0, Math.min(1, Number(res.coh[k]))));
    } else hasCoherence = false;
  }

  if (frequencies.length < 8) return null;
  return {
    frequencies,
    magDb,
    phaseDeg: hasPhase ? phaseDeg : null,
    coherence: hasCoherence ? coherence : null,
    fMin: frequencies[0],
    fMax: frequencies[frequencies.length - 1],
    points: frequencies.length,
    sampleRate,
    fftSize,
    delayMs,
    label: source.label || 'Live measurement',
  };
}

/**
 * The modeler.
 *
 * Options: `setStatus` (the app's status pill), `library` (the saved capture
 * entries), `live` (the running measurement, or null), `held` (the A–F captures),
 * and `onOpen`/`onClose` so the measurement steps aside behind the workspace.
 */
export function createDataModeler(options = {}) {
  const opts = options || {};
  const setStatus = typeof opts.setStatus === 'function' ? opts.setStatus : () => {};
  const libraryProvider = typeof opts.library === 'function' ? opts.library : () => [];
  const liveProvider = typeof opts.live === 'function' ? opts.live : () => null;
  const heldProvider = typeof opts.held === 'function' ? opts.held : () => [];

  const workspace = $('dmWorkspace');
  const chartCanvas = $('dmChart');

  let project = loadProject();
  let canSave = true;
  let active = false;
  let chart = null;
  let observer = null;

  let selectedModelId = null;
  let selectedSourceId = null;
  let selectedDatasetId = null;
  let cursorFrequency = 1000;
  let lastEvaluation = null;
  let optimizerResult = null;
  let comparison = null;
  let pendingFile = null;
  let pendingText = '';
  let editSnapshot = null;

  const layout = loadLayout();
  layout.docks = layout.docks || {};
  layout.collapsed = layout.collapsed || {};
  layout.colors = layout.colors || {};
  layout.visible = layout.visible || {};
  layout.phaseVisible = layout.phaseVisible || {};

  const past = [];
  const future = [];

  /* ---------- saving ---------- */

  function saveLayout() {
    persistLayout(layout);
  }

  function say(message, kind) {
    const line = $('dmStatus');
    if (line && message) line.textContent = message;
    if (message) setStatus(message, kind || 'ok');
  }

  function applyDocks() {
    const columns = {
      left: $('dmColLeft'),
      centre: $('dmColCentre'),
      right: $('dmColRight'),
    };
    for (const card of document.querySelectorAll('.dm-card')) {
      const id = card.dataset.card;
      const dock = layout.docks[id] || card.dataset.dock || 'left';
      const column = columns[dock] || columns.left;
      if (column && card.parentElement !== column) column.appendChild(card);
      const select = card.querySelector('.dm-dock');
      if (select) select.value = dock;
      card.classList.toggle('collapsed', !!layout.collapsed[id]);
    }
  }

  function bindCards() {
    for (const card of document.querySelectorAll('.dm-card')) {
      const id = card.dataset.card;
      const dock = card.querySelector('.dm-dock');
      if (dock && !dock.dataset.bound) {
        dock.dataset.bound = '1';
        dock.addEventListener('change', () => {
          layout.docks[id] = dock.value;
          saveLayout();
          applyDocks();
        });
      }
      const collapse = card.querySelector('.dm-collapse');
      if (collapse && !collapse.dataset.bound) {
        collapse.dataset.bound = '1';
        collapse.addEventListener('click', () => {
          layout.collapsed[id] = !layout.collapsed[id];
          saveLayout();
          applyDocks();
        });
      }
    }
  }

  /* ---------- history ---------- */

  function refreshHistory() {
    const undo = $('btnDmUndo');
    const redo = $('btnDmRedo');
    if (undo) undo.disabled = !past.length;
    if (redo) redo.disabled = !future.length;
  }

  function pushHistory(serialised) {
    past.push(serialised);
    if (past.length > 40) past.shift();
    future.length = 0;
    refreshHistory();
  }

  function commit(mutator, message) {
    const before = JSON.stringify(project);
    mutator(project);
    const ok = opts.persist ? opts.persist(project) : true;
    if (ok === false) {
      project = normalizeProject(JSON.parse(before));
      say('Could not save the model project — browser storage is full or blocked. Nothing was changed.', 'err');
      renderAll();
      return;
    }
    pushHistory(before);
    renderAll();
    if (message) say(message, 'ok');
  }

  function undo() {
    if (!past.length) return;
    const current = JSON.stringify(project);
    project = normalizeProject(JSON.parse(past.pop()));
    future.push(current);
    opts.persist ? opts.persist(project) : null;
    renderAll();
    say('Undone.', 'ok');
  }

  function redo() {
    if (!future.length) return;
    const current = JSON.stringify(project);
    project = normalizeProject(JSON.parse(future.pop()));
    past.push(current);
    opts.persist ? opts.persist(project) : null;
    renderAll();
    say('Redone.', 'ok');
  }

  /* ---------- the library ---------- */

  function colorFor(id, index) {
    return layout.colors[id] || TRACE_COLORS[index % TRACE_COLORS.length];
  }

  function selectedModel() {
    return project.models.find((model) => model.id === selectedModelId) || null;
  }

  function selectedSource() {
    return project.sources.find((source) => source.id === selectedSourceId) || null;
  }

  function renderLibrary() {
    const list = $('dmLibraryList');
    const summary = $('dmLibrarySummary');
    if (!list) return;
    list.replaceChildren();

    const query = ($('dmLibrarySearch') && $('dmLibrarySearch').value || '').trim().toLowerCase();
    const models = project.models.filter((model) => !query ||
      (model.name + ' ' + model.manufacturer + ' ' + model.model + ' ' + model.notes).toLowerCase().includes(query));

    if (summary) {
      summary.textContent = project.models.length + ' loudspeaker' + (project.models.length === 1 ? '' : 's') +
        ' · ' + project.models.reduce((sum, model) => sum + model.datasets.length, 0) + ' measured responses';
    }

    if (!models.length) {
      const empty = el('li', 'dm-empty',
        project.models.length
          ? 'No loudspeaker matches that search.'
          : 'The library is empty. Import a measured response to create the first loudspeaker.');
      list.appendChild(empty);
      return;
    }

    for (const model of models) {
      const item = el('li', 'dm-model');
      item.dataset.model = model.id;
      if (model.id === selectedModelId) item.classList.add('on');

      const head = el('div', 'dm-model-head');
      const pick = button(model.name, 'dm-model-name', { pick: model.id });
      head.appendChild(pick);
      const badge = el('span', 'dm-badge', provenanceLabel(model.provenance));
      head.appendChild(badge);
      const meta = el('span', 'dm-model-meta',
        [model.manufacturer, model.model, model.type,
          model.datasets.length + ' dataset' + (model.datasets.length === 1 ? '' : 's')]
          .filter(Boolean).join(' · '));
      head.appendChild(meta);
      item.appendChild(head);

      for (const dataset of model.datasets) {
        const row = el('div', 'dm-dataset');
        row.dataset.dataset = dataset.id;
        const label = el('button', 'dm-dataset-name', dataset.label);
        label.type = 'button';
        label.dataset.datasetPick = dataset.id;
        label.dataset.modelPick = model.id;
        if (dataset.id === selectedDatasetId && model.id === selectedModelId) label.classList.add('on');
        row.appendChild(label);
        const info = el('span', 'dm-dataset-meta',
          [provenanceLabel(dataset.provenance),
            dataset.hasPhase ? 'phase' : 'magnitude only',
            formatRangeText(dataset.fMin, dataset.fMax),
            dataset.conditions && dataset.conditions.venue,
            dataset.conditions && dataset.conditions.micLabel,
            dataset.importedFrom].filter(Boolean).join(' · '));
        row.appendChild(info);
        const add = button('Use as source', 'dm-mini', { use: dataset.id, useModel: model.id });
        row.appendChild(add);
        item.appendChild(row);
      }

      const actions = el('div', 'dm-model-actions');
      actions.appendChild(button('Edit', 'dm-mini', { edit: model.id }));
      const exportButton = button('Export dataset', 'dm-mini', { export: model.id });
      exportButton.disabled = !model.datasets.length;
      actions.appendChild(exportButton);
      actions.appendChild(button('Delete', 'dm-mini dm-danger', { remove: model.id }));
      item.appendChild(actions);
      list.appendChild(item);
    }
  }

  function renderModelForm() {
    const form = $('dmModelForm');
    if (!form) return;
    const model = selectedModel();
    form.hidden = !model;
    if (!model) return;

    const set = (id, value) => { const field = $(id); if (field) field.value = value; };
    set('dmEditName', model.name);
    set('dmEditManufacturer', model.manufacturer);
    set('dmEditNumber', model.model);
    set('dmEditType', model.type);
    set('dmEditImpedance', model.impedanceOhm);
    set('dmEditSensitivity', model.sensitivityDb);
    set('dmEditDistance', model.distanceM);
    set('dmEditDelay', model.referenceDelayMs);
    set('dmEditCrossover', model.crossoverText);
    set('dmEditDirectivity', model.directivityText);
    set('dmEditSpecs', model.specs);
    set('dmEditNotes', model.notes);
    set('dmEditProvenance', model.provenance);
    const title = $('dmModelFormTitle');
    if (title) title.textContent = model.name;
  }

  function renderAddSelects() {
    const modelSelect = $('dmAddModel');
    const datasetSelect = $('dmAddDataset');
    if (modelSelect) {
      modelSelect.replaceChildren();
      for (const model of project.models) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.name;
        modelSelect.appendChild(option);
      }
      if (selectedModelId) modelSelect.value = selectedModelId;
    }
    if (datasetSelect) {
      datasetSelect.replaceChildren();
      const model = project.models.find((entry) => entry.id === (modelSelect && modelSelect.value)) ||
        selectedModel();
      for (const dataset of model ? model.datasets : []) {
        const option = document.createElement('option');
        option.value = dataset.id;
        option.textContent = dataset.label + (dataset.hasPhase ? '' : ' (magnitude only)');
        datasetSelect.appendChild(option);
      }
    }
  }

  /* ---------- sources and groups ---------- */

  function renderSources() {
    const list = $('dmSourceList');
    if (!list) return;
    list.replaceChildren();
    const summary = $('dmSourceSummary');
    if (summary) {
      const active = project.sources.filter((source) => !source.muted).length;
      summary.textContent = project.sources.length + ' source' + (project.sources.length === 1 ? '' : 's') +
        ' · ' + active + ' in the sum';
    }

    if (!project.sources.length) {
      list.appendChild(el('li', 'dm-empty',
        'No sources yet. Add one from the library, or import a measured response first.'));
      return;
    }

    for (const [index, source] of project.sources.entries()) {
      const row = el('li', 'dm-source');
      row.dataset.source = source.id;
      if (source.id === selectedSourceId) row.classList.add('on');

      const head = el('div', 'dm-source-head');
      const pick = button((index + 1) + '. ' + source.name, 'dm-source-name', { sourcePick: source.id });
      head.appendChild(pick);
      const swatch = el('input', 'dm-swatch');
      swatch.type = 'color';
      swatch.value = colorFor(source.id, index);
      swatch.dataset.color = source.id;
      swatch.title = 'Trace colour';
      head.appendChild(swatch);
      row.appendChild(head);

      const found = findDataset(project, source.modelId, source.datasetId);
      const meta = el('span', 'dm-source-meta',
        [found.dataset ? found.dataset.label : 'no dataset',
          found.dataset && !found.dataset.hasPhase ? 'magnitude only' : '',
          project.groups.find((group) => group.id === source.groupId)?.name || 'no group',
          source.filters.length + ' filter' + (source.filters.length === 1 ? '' : 's')]
          .filter(Boolean).join(' · '));
      row.appendChild(meta);

      const controls = el('div', 'dm-source-controls');
      const gainWrap = el('label', 'dm-field');
      gainWrap.appendChild(el('span', null, 'Gain'));
      const gain = numberInput(source.gainDb, 0.1, -30, 30);
      gain.dataset.sourceGain = source.id;
      gainWrap.appendChild(gain);
      controls.appendChild(gainWrap);

      const delayWrap = el('label', 'dm-field');
      delayWrap.appendChild(el('span', null, 'Delay ms'));
      const delay = numberInput(source.delayMs, 0.01, -50, 100);
      delay.dataset.sourceDelay = source.id;
      delayWrap.appendChild(delay);
      controls.appendChild(delayWrap);

      const polarity = selectFrom([{ value: 'normal', label: 'Normal' }, { value: 'inverted', label: 'Inverted' }],
        source.polarity);
      polarity.dataset.sourcePolarity = source.id;
      controls.appendChild(polarity);

      const groupSelect = selectFrom([{ value: '', label: 'No group' }].concat(
        project.groups.map((group) => ({ value: group.id, label: group.name }))), source.groupId || '');
      groupSelect.dataset.sourceGroup = source.id;
      controls.appendChild(groupSelect);

      const mute = el('button', source.muted ? 'dm-mini on' : 'dm-mini', 'Mute');
      mute.type = 'button';
      mute.dataset.mute = source.id;
      controls.appendChild(mute);
      const solo = el('button', source.soloed ? 'dm-mini on' : 'dm-mini', 'Solo');
      solo.type = 'button';
      solo.dataset.solo = source.id;
      controls.appendChild(solo);
      const remove = button('Remove', 'dm-mini dm-danger', { removeSource: source.id });
      controls.appendChild(remove);
      row.appendChild(controls);

      if (source.muted) row.classList.add('muted');
      list.appendChild(row);
    }
  }

  function renderGroups() {
    const list = $('dmGroupList');
    if (!list) return;
    list.replaceChildren();
    if (!project.groups.length) {
      list.appendChild(el('li', 'dm-empty', 'No groups. A group adds gain, delay and polarity to its sources.'));
    }
    for (const group of project.groups) {
      const row = el('li', 'dm-group');
      row.dataset.group = group.id;
      const name = el('input', 'dm-text');
      name.type = 'text';
      name.value = group.name;
      name.maxLength = 40;
      name.dataset.groupName = group.id;
      row.appendChild(name);

      const gain = numberInput(group.gainDb, 0.1, -24, 24);
      gain.dataset.groupGain = group.id;
      gain.title = 'Group gain, dB';
      row.appendChild(gain);
      const delay = numberInput(group.delayMs, 0.01, -100, 100);
      delay.dataset.groupDelay = group.id;
      delay.title = 'Group delay, ms';
      row.appendChild(delay);

      const polarity = selectFrom([{ value: 'normal', label: 'Normal' }, { value: 'inverted', label: 'Inverted' }],
        group.polarity);
      polarity.dataset.groupPolarity = group.id;
      row.appendChild(polarity);

      const mute = el('button', group.muted ? 'dm-mini on' : 'dm-mini', 'Mute');
      mute.type = 'button';
      mute.dataset.groupMute = group.id;
      row.appendChild(mute);
      row.appendChild(button('Delete', 'dm-mini dm-danger', { removeGroup: group.id }));
      list.appendChild(row);
    }
  }

  function renderPositions() {
    const list = $('dmPositionList');
    const select = $('dmPositionSelect');
    if (list) {
      list.replaceChildren();
      for (const position of project.positions) {
        const row = el('li', 'dm-position');
        row.dataset.position = position.id;
        const label = el('input', 'dm-text');
        label.type = 'text';
        label.value = position.label;
        label.maxLength = 40;
        label.dataset.positionLabel = position.id;
        row.appendChild(label);
        const weight = numberInput(position.weight, 0.05, 0, 1);
        weight.dataset.positionWeight = position.id;
        weight.title = 'Weight in a multi-position prediction';
        row.appendChild(weight);
        if (project.positions.length > 1) {
          row.appendChild(button('Delete', 'dm-mini dm-danger', { removePosition: position.id }));
        }
        list.appendChild(row);
      }
    }
    if (select) {
      select.replaceChildren();
      for (const position of project.positions) {
        const option = document.createElement('option');
        option.value = position.id;
        option.textContent = position.label;
        select.appendChild(option);
      }
      select.value = project.settings.positionId || project.positions[0].id;
    }

    const matrix = $('dmPositionMatrix');
    if (matrix) {
      matrix.replaceChildren();
      if (project.positions.length < 2 || !project.sources.length) {
        matrix.hidden = true;
      } else {
        matrix.hidden = false;
        const head = el('div', 'dm-matrix-head');
        head.appendChild(el('span', null, 'Source'));
        for (const position of project.positions) head.appendChild(el('span', null, position.label));
        matrix.appendChild(head);
        for (const source of project.sources) {
          const row = el('div', 'dm-matrix-row');
          row.appendChild(el('span', 'dm-matrix-name', source.name));
          const model = project.models.find((entry) => entry.id === source.modelId);
          for (const position of project.positions) {
            const chosen = (source.positionDatasets && source.positionDatasets[position.id]) || '';
            const items = [{ value: '', label: 'Same as main' }].concat(
              (model ? model.datasets : []).map((dataset) => ({ value: dataset.id, label: dataset.label })));
            const cell = selectFrom(items, chosen);
            cell.dataset.positionDataset = source.id + '|' + position.id;
            row.appendChild(cell);
          }
          matrix.appendChild(row);
        }
      }
    }
  }

  /* ---------- the DSP chain ---------- */

  function renderChain() {
    const list = $('dmChainList');
    const title = $('dmChainTitle');
    const source = selectedSource();
    if (title) title.textContent = source ? source.name : 'no source selected';
    if (!list) return;
    list.replaceChildren();

    if (!source) {
      list.appendChild(el('p', 'dm-empty', 'Select a source in the Sources panel to design its DSP chain.'));
      return;
    }

    if (!source.filters.length) {
      list.appendChild(el('p', 'dm-empty', 'No filters. Add one, or design a crossover section below.'));
    }

    for (const [index, filter] of source.filters.entries()) {
      const info = filterKind(filter.kind);
      const row = el('div', 'dm-filter');
      row.dataset.filter = filter.id;

      const on = el('input');
      on.type = 'checkbox';
      on.checked = filter.enabled;
      on.dataset.filterEnabled = filter.id;
      on.title = 'In this chain';
      row.appendChild(on);

      const kind = selectFrom(FILTER_KINDS.map((entry) => ({ value: entry.id, label: entry.label })), filter.kind);
      kind.dataset.filterKind = filter.id;
      row.appendChild(kind);

      if (info.id !== 'gain') {
        const frequency = numberInput(filter.frequency, 1, 10, 20000);
        frequency.dataset.filterFrequency = filter.id;
        frequency.title = 'Frequency, Hz';
        row.appendChild(frequency);
      }
      if (info.gain) {
        const gain = numberInput(filter.gainDb, 0.1, -24, 24);
        gain.dataset.filterGain = filter.id;
        gain.title = 'Gain, dB';
        row.appendChild(gain);
      }
      if (info.q) {
        const q = numberInput(filter.q, 0.01, 0.1, 10);
        q.dataset.filterQ = filter.id;
        q.title = 'Q';
        row.appendChild(q);
      }

      row.appendChild(el('span', 'dm-filter-text', filterText(filter)));
      const up = button('↑', 'dm-mini', { filterUp: filter.id });
      up.title = 'Move earlier in the chain';
      row.appendChild(up);
      const down = button('↓', 'dm-mini', { filterDown: filter.id });
      down.title = 'Move later in the chain';
      row.appendChild(down);
      row.appendChild(button('×', 'dm-mini dm-danger', { removeFilter: filter.id }));
      list.appendChild(row);
    }
  }

  /* ---------- the picture ---------- */

  function buildChart() {
    if (!chartCanvas) return;
    if (!chart) {
      chart = new ModelerChart(chartCanvas);
      chart.bindEvents();
      chart.onHover = ({ frequency }) => {
        if (!frequency) return;
        cursorFrequency = frequency;
        renderReadout();
        renderSummation();
      };
      chart.onRangeChange = (range) => {
        const span = $('dmSpanText');
        if (span) span.textContent = formatRangeText(range.min, range.max) + ' · drag to zoom';
      };
    } else {
      chart.resize();
    }
    if (typeof ResizeObserver === 'function' && !observer) {
      const parent = chartCanvas.parentElement || chartCanvas;
      observer = new ResizeObserver(() => {
        if (!chart) return;
        chart.resize();
        chart.draw();
      });
      observer.observe(parent);
    }
  }

  function effectivePropagation() {
    const settings = project.settings;
    const propagation = settings.propagation || {};
    return {
      enabled: !!propagation.enabled,
      referenceDistanceM: Number(propagation.referenceDistanceM) || 1,
      speedOfSound: Number(propagation.speedOfSound) || SPEED_OF_SOUND,
    };
  }

  function evaluationOptions() {
    return {
      positionId: project.settings.positionId,
      propagation: effectivePropagation(),
      sampleRate: 48000,
    };
  }

  function renderChart() {
    if (!chart) return;
    const settings = project.settings;
    const evaluation = evaluateSystem(project, evaluationOptions());
    lastEvaluation = evaluation;

    const traces = [];
    const sources = evaluation.responses;
    for (const [index, response] of sources.entries()) {
      const gd = groupDelay(response.frequencies, response.phaseDeg, response.magDb, {
        coherence: response.coherence,
        coherenceThreshold: settings.coherenceThreshold,
        nullDepthDb: settings.nullDepthDb,
      });
      const id = response.id;
      traces.push({
        id,
        label: response.name,
        color: colorFor(id, index),
        kind: 'source',
        magDb: response.magDb,
        phaseDeg: response.phaseDeg,
        phaseValid: response.phaseValid,
        groupDelayMs: response.phaseValid ? gd : null,
        frequencies: response.frequencies,
        visible: layout.visible[id] !== false && (settings.showIndividual !== false),
        phaseVisible: layout.phaseVisible[id] !== false,
        width: 1.4,
      });
    }

    const sum = evaluation.sum;
    if (sum) {
      const gd = groupDelay(sum.frequencies, sum.phaseDeg, sum.magDb, {
        coherenceThreshold: settings.coherenceThreshold,
        nullDepthDb: settings.nullDepthDb,
      });
      traces.push({
        id: 'sum',
        label: 'Sum',
        color: layout.colors.sum || '#ffb15d',
        kind: 'sum',
        magDb: sum.magDb,
        phaseDeg: sum.phaseDeg,
        phaseValid: sum.assumedPhase === 0,
        groupDelayMs: sum.assumedPhase === 0 ? gd : null,
        frequencies: sum.frequencies,
        visible: layout.visible.sum !== false && settings.showSum !== false,
        phaseVisible: layout.phaseVisible.sum !== false,
        width: 2.3,
      });
    }

    if (comparison && comparison.predicted) {
      traces.push({
        id: 'measured',
        label: 'Measured',
        color: layout.colors.measured || '#9dcfa3',
        kind: 'measured',
        magDb: comparison.predicted.measuredMagDb,
        phaseDeg: comparison.predicted.measuredPhaseDeg,
        phaseValid: !!(comparison.dataset && comparison.dataset.hasPhase),
        groupDelayMs: null,
        frequencies: comparison.predicted.frequencies,
        visible: layout.visible.measured !== false,
        phaseVisible: layout.phaseVisible.measured !== false,
        width: 1.5,
        dash: [5, 4],
      });
      traces.push({
        id: 'difference',
        label: 'A − B',
        color: layout.colors.difference || '#db796f',
        kind: 'difference',
        magDb: comparison.predicted.errors,
        phaseDeg: null,
        groupDelayMs: null,
        frequencies: comparison.predicted.frequencies,
        visible: layout.visible.difference !== false,
        width: 1.6,
      });
    }

    let impulse = null;
    if (project.settings.view === 'impulse' && sum) {
      const result = synthesizeImpulse(sum, { sampleRate: 48000, bins: 8192 });
      impulse = result.ok ? result.envelope : null;
    }

    chart.setMode(project.settings.view || 'transfer');
    chart.setPhaseMode(project.settings.phaseMode || 'wrapped');
    chart.setDbSpan(project.settings.dbSpan || 0);
    chart.smoothingOctaves = Number(project.settings.smoothing) || 0;
    chart.setTraces(traces);
    chart.setImpulse(impulse);
    chart.draw();

    renderTraceChips(traces);
    renderReadout();
    return evaluation;
  }

  function renderTraceChips(traces) {
    const holder = $('dmTraceChips');
    if (!holder) return;
    holder.replaceChildren();
    for (const trace of traces) {
      const chip = el('div', 'dm-chip-row');
      const toggle = el('button', trace.visible === false ? 'dm-chip off' : 'dm-chip', trace.label);
      toggle.type = 'button';
      toggle.dataset.traceVisible = trace.id;
      toggle.title = 'Show or hide this trace';
      chip.appendChild(toggle);

      const phase = el('button', trace.phaseVisible === false ? 'dm-mini off' : 'dm-mini', 'φ');
      phase.type = 'button';
      phase.dataset.tracePhase = trace.id;
      phase.title = 'Show or hide its phase';
      chip.appendChild(phase);

      const swatch = el('input', 'dm-swatch');
      swatch.type = 'color';
      swatch.value = trace.color;
      swatch.dataset.traceColor = trace.id;
      swatch.title = 'Trace colour';
      chip.appendChild(swatch);
      holder.appendChild(chip);
    }
  }

  function renderReadout() {
    const readout = $('dmReadout');
    if (!readout) return;
    const frequency = cursorFrequency;
    const lines = ['at ' + formatFrequency(frequency)];

    for (const response of (lastEvaluation ? lastEvaluation.responses : [])) {
      const index = nearestIndex(response.frequencies, frequency);
      if (index < 0) continue;
      const parts = [formatTraceLevel(response.magDb[index])];
      if (response.phaseValid) {
        parts.push('phase ' + wrap(response.phaseDeg[index]).toFixed(0) + '°');
      }
      lines.push(response.name + ' ' + parts.join(' · '));
    }
    if (lastEvaluation && lastEvaluation.sum) {
      const sum = lastEvaluation.sum;
      const index = nearestIndex(sum.frequencies, frequency);
      if (index >= 0) {
        lines.push('sum ' + formatTraceLevel(sum.magDb[index]) +
          (sum.assumedPhase ? ' · phase assumed' : ' · phase ' + wrap(sum.phaseDeg[index]).toFixed(0) + '°'));
      }
    }
    readout.textContent = lines.join('   ');
  }

  function nearestIndex(frequencies, wanted) {
    if (!frequencies || !frequencies.length) return -1;
    let lo = 0;
    let hi = frequencies.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (frequencies[mid] <= wanted) lo = mid;
      else hi = mid;
    }
    return Math.abs(frequencies[lo] - wanted) <= Math.abs(frequencies[hi] - wanted) ? lo : hi;
  }

  function wrap(degrees) {
    let value = Number(degrees) % 360;
    if (value > 180) value -= 360;
    if (value < -180) value += 360;
    return value;
  }

  /* ---------- summation at the cursor ---------- */

  function renderSummation() {
    const holder = $('dmSumTable');
    const number = $('dmSumNumber');
    if (!holder) return;
    holder.replaceChildren();
    if (number) number.textContent = formatFrequency(cursorFrequency);

    const evaluation = lastEvaluation || evaluateSystem(project, evaluationOptions());
    if (!evaluation.responses.length) {
      holder.appendChild(el('p', 'dm-empty', 'No source is in the sum yet.'));
      const nulls = $('dmNullList');
      if (nulls) nulls.replaceChildren();
      return;
    }

    const head = el('div', 'dm-sum-row head');
    for (const label of ['Source', 'Level', 'Delay', 'Polarity', 'Chain']) head.appendChild(el('span', null, label));
    holder.appendChild(head);

    for (const response of evaluation.responses) {
      const index = nearestIndex(response.frequencies, cursorFrequency);
      const row = el('div', 'dm-sum-row');
      row.appendChild(el('span', null, response.name));
      row.appendChild(el('span', null, index >= 0 ? formatTraceLevel(response.magDb[index]) : '—'));
      row.appendChild(el('span', null, formatDelay(response.settings.delayMs)));
      row.appendChild(el('span', null, response.settings.inverted ? 'inverted' : 'normal'));
      row.appendChild(el('span', null, response.filters.length + ' filter' + (response.filters.length === 1 ? '' : 's')));
      holder.appendChild(row);
    }

    if (evaluation.sum) {
      const index = nearestIndex(evaluation.sum.frequencies, cursorFrequency);
      const row = el('div', 'dm-sum-row total');
      row.appendChild(el('span', null, 'Complex sum'));
      row.appendChild(el('span', null, index >= 0 ? formatTraceLevel(evaluation.sum.magDb[index]) : '—'));
      row.appendChild(el('span', null, evaluation.sum.activeIds.length + ' sources'));
      row.appendChild(el('span', null, evaluation.sum.assumedPhase
        ? evaluation.sum.assumedPhase + ' without measured phase'
        : 'phase on every source'));
      holder.appendChild(row);
    }

    const nulls = $('dmNullList');
    if (nulls) {
      nulls.replaceChildren();
      const sum = evaluation.sum;
      if (sum) {
        const band = { min: 100, max: 10000 };
        const statistics = [];
        let mean = 0;
        let count = 0;
        for (let i = 0; i < sum.frequencies.length; i += 1) {
          if (sum.frequencies[i] < band.min || sum.frequencies[i] > band.max) continue;
          mean += sum.magDb[i];
          count += 1;
        }
        mean = count ? mean / count : 0;
        for (let i = 1; i < sum.frequencies.length - 1; i += 1) {
          const f = sum.frequencies[i];
          if (f < band.min || f > band.max) continue;
          if (sum.magDb[i] > sum.magDb[i - 1] || sum.magDb[i] > sum.magDb[i + 1]) continue;
          if (sum.magDb[i] > mean - 6) continue;
          statistics.push({ hz: f, depth: sum.magDb[i] - mean });
        }
        statistics.sort((a, b) => a.depth - b.depth);
        for (const entry of statistics.slice(0, 5)) {
          nulls.appendChild(el('li', null,
            formatFrequency(entry.hz) + ' · ' + entry.depth.toFixed(1) + ' dB below the mean of 100 Hz – 10 kHz'));
        }
        if (!statistics.length) {
          nulls.appendChild(el('li', 'dm-empty', 'No deep cancellation null in 100 Hz – 10 kHz.'));
        }
      }
    }

    const note = $('dmSumMessage');
    if (note) {
      const assumed = evaluation.responses.filter((response) => !response.phaseValid).length;
      note.textContent = assumed
        ? assumed + ' of ' + evaluation.responses.length + ' sources carry no measured phase: the sum ' +
          'assumes zero phase at each of them, so it is a prediction, not a verification.'
        : 'Every source carries measured phase, so the sum is the coherent complex sum of the curves.';
      note.hidden = false;
    }
  }

  /* ---------- the optimizer ---------- */

  function renderOptimizerSelects() {
    const sources = project.sources;
    const items = sources.map((source) => ({ value: source.id, label: source.name }));
    for (const id of ['dmOptReference', 'dmOptTarget']) {
      const select = $(id);
      if (!select) continue;
      const previous = select.value;
      select.replaceChildren();
      if (!items.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'no sources';
        select.appendChild(option);
        continue;
      }
      for (const item of items) {
        const option = document.createElement('option');
        option.value = item.value;
        option.textContent = item.label;
        select.appendChild(option);
      }
      if (items.some((item) => item.value === previous)) select.value = previous;
    }
  }

  function sourceResponseById(id) {
    const evaluation = evaluateSystem(project, evaluationOptions());
    return evaluation.responses.find((response) => response.id === id) || null;
  }

  function runOptimizer() {
    const reference = sourceResponseById($('dmOptReference') ? $('dmOptReference').value : '');
    const target = sourceResponseById($('dmOptTarget') ? $('dmOptTarget').value : '');
    if (!reference || !target) {
      setOptimizerMessage('Choose two sources that both carry a modelled response.', true);
      return;
    }
    if (reference.id === target.id) {
      setOptimizerMessage('A source cannot be aligned to itself — choose a different target.', true);
      return;
    }

    const band = {
      min: Number($('dmOptBandLow') && $('dmOptBandLow').value) || 1000,
      max: Number($('dmOptBandHigh') && $('dmOptBandHigh').value) || 2000,
    };
    const delay = {
      min: Number($('dmOptDelayMin') && $('dmOptDelayMin').value) || -20,
      max: Number($('dmOptDelayMax') && $('dmOptDelayMax').value) || 20,
      stepMs: Number($('dmOptDelayStep') && $('dmOptDelayStep').value) || 0.05,
    };

    const result = optimizeAlignment({
      reference,
      target,
      band,
      delay,
      focusFrequency: Number($('dmOptFocus') && $('dmOptFocus').value) || Math.sqrt(band.min * band.max),
      polarity: $('dmOptPolarity') ? $('dmOptPolarity').value : 'auto',
      objective: $('dmOptObjective') ? $('dmOptObjective').value : 'sum',
      weights: {
        low: Number($('dmOptLow') && $('dmOptLow').value) || 0,
        mid: Number($('dmOptMid') && $('dmOptMid').value) || 1,
        high: Number($('dmOptHigh') && $('dmOptHigh').value) || 0,
      },
    });

    if (!result.ok) {
      optimizerResult = null;
      setOptimizerMessage(result.message, true);
      renderOptimizerResult();
      return;
    }
    optimizerResult = result;
    optimizerResult.referenceId = reference.id;
    optimizerResult.targetId = target.id;
    optimizerResult.objective = result.objective;
    renderOptimizerResult();
    const apply = $('btnDmApplyOptimizer');
    if (apply) apply.disabled = false;
    setOptimizerMessage('Aligned ' + target.name + ' to ' + reference.name + ' over ' +
      formatRangeText(band.min, band.max) + '.', false);
  }

  function setOptimizerMessage(message, bad) {
    const line = $('dmOptMessage');
    if (!line) return;
    line.textContent = message || '';
    line.hidden = !message;
    line.classList.toggle('clip-warning', !!bad);
  }

  function renderOptimizerResult() {
    const holder = $('dmOptResult');
    const alternatives = $('dmOptAlternatives');
    if (!holder) return;
    holder.replaceChildren();
    if (alternatives) alternatives.replaceChildren();
    if (!optimizerResult) {
      holder.appendChild(el('p', 'dm-empty', 'Run the alignment to get a recommended delay.'));
      return;
    }

    const best = optimizerResult.best;
    const rows = [
      ['Recommended delay', formatDelay(best.delayMs) + ' (advance)'],
      ['Path length', pathLengthMm(best.delayMs).toFixed(0) + ' mm'],
      ['Polarity', best.polarity],
      ['Predicted summation', formatTraceLevel(best.gainDb) + ' over the louder source'],
      ['Worst point in band', formatTraceLevel(best.worstDb)],
      ['Phase error', Number.isFinite(best.phaseErrorDeg) ? best.phaseErrorDeg.toFixed(0) + '°' : 'no phase'],
      ['Confidence', optimizerResult.confidence.level + ' — ' + optimizerResult.confidence.note],
    ];
    for (const [label, value] of rows) {
      const row = el('div', 'dm-opt-row');
      row.appendChild(el('span', 'dm-opt-key', label));
      row.appendChild(el('span', 'dm-opt-value', value));
      holder.appendChild(row);
    }

    if (best.nulls.length) {
      const list = el('ul', 'dm-nulls');
      for (const entry of best.nulls) {
        list.appendChild(el('li', null,
          'cancellation near ' + formatFrequency(entry.hz) + ' at ' + entry.depthDb.toFixed(1) + ' dB'));
      }
      holder.appendChild(el('p', 'dm-sub', 'What this delay leaves behind'));
      holder.appendChild(list);
    }

    if (alternatives) {
      for (const alternative of optimizerResult.alternatives) {
        const row = el('div', 'dm-opt-row');
        row.appendChild(el('span', 'dm-opt-key', formatDelay(alternative.delayMs) + ' · ' + alternative.polarity));
        row.appendChild(el('span', 'dm-opt-value',
          formatTraceLevel(alternative.gainDb) + ' summation, worst ' + formatTraceLevel(alternative.worstDb)));
        alternatives.appendChild(row);
      }
    }

    const tradeoff = $('dmOptTradeoff');
    if (tradeoff) {
      tradeoff.textContent = optimizerResult.tradeoff;
      tradeoff.hidden = false;
    }
  }

  function applyOptimizer() {
    if (!optimizerResult) {
      setOptimizerMessage('There is no recommendation to apply.', true);
      return;
    }
    const target = project.sources.find((source) => source.id === optimizerResult.targetId);
    if (!target) {
      setOptimizerMessage('The target source is no longer in the project.', true);
      return;
    }
    const delayMs = optimizerResult.best.delayMs;
    const polarity = optimizerResult.best.polarity;
    commit(() => {
      target.delayMs = Math.max(-50, Math.min(100, Number(target.delayMs) + delayMs));
      if ($('chkDmApplyPolarity') && $('chkDmApplyPolarity').checked) target.polarity = polarity;
    }, 'Applied ' + formatDelay(delayMs) + ' to ' + target.name + ' — check it against a measurement.');
    optimizerResult = null;
    renderOptimizerResult();
    const apply = $('btnDmApplyOptimizer');
    if (apply) apply.disabled = true;
  }

  /* ---------- prediction vs measurement ---------- */

  function compareOptions() {
    const items = [];
    for (const model of project.models) {
      for (const dataset of model.datasets) {
        items.push({ value: 'model:' + model.id + ':' + dataset.id, label: model.name + ' · ' + dataset.label });
      }
    }
    for (const entry of libraryProvider()) {
      items.push({ value: 'capture:' + entry.id, label: 'Capture · ' + entry.name + (entry.phase ? '' : ' (magnitude only)') });
    }
    for (const held of heldProvider()) {
      if (!held || !held.trace) continue;
      items.push({ value: 'held:' + held.label, label: 'Held · ' + held.label });
    }
    return items;
  }

  function renderCompareSelect() {
    const select = $('dmCompareSelect');
    if (!select) return;
    const previous = select.value;
    const items = compareOptions();
    select.replaceChildren();
    if (!items.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'no measured response in the library';
      select.appendChild(option);
      return;
    }
    for (const item of items) {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = item.label;
      select.appendChild(option);
    }
    if (items.some((item) => item.value === previous)) select.value = previous;
  }

  function resolveCompareTrace(value) {
    if (!value) return null;
    if (value.startsWith('model:')) {
      const [, modelId, datasetId] = value.split(':');
      const found = findDataset(project, modelId, datasetId);
      return found.dataset || null;
    }
    if (value.startsWith('capture:')) {
      const id = value.slice(8);
      const entry = libraryProvider().find((item) => item.id === id);
      if (!entry) return null;
      const response = responseFromSaved(entry);
      if (!response) return null;
      const resampled = resampleResponse(response);
      if (!resampled.ok) return null;
      const dataset = normalizeDataset({
        label: entry.name,
        provenance: 'measured',
        importedFrom: 'Capture library',
        curve: {
          magDb: Array.from(resampled.magDb),
          phaseDeg: resampled.phaseDeg ? Array.from(resampled.phaseDeg) : null,
          coherence: resampled.coherence ? Array.from(resampled.coherence) : null,
        },
        sampleRate: response.sampleRate,
        fftSize: response.fftSize,
        delayMs: response.delayMs,
      });
      return dataset;
    }
    if (value.startsWith('held:')) {
      const label = value.slice(5);
      const held = heldProvider().find((entry) => entry && entry.label === label);
      if (!held || !held.trace) return null;
      const response = responseFromAnalyser({ results: held.trace, delayMs: held.trace.delayMs, label });
      if (!response) return null;
      const resampled = resampleResponse(response);
      if (!resampled.ok) return null;
      return normalizeDataset({
        label: 'Capture ' + label,
        provenance: 'measured',
        importedFrom: 'Held capture',
        curve: {
          magDb: Array.from(resampled.magDb),
          phaseDeg: resampled.phaseDeg ? Array.from(resampled.phaseDeg) : null,
          coherence: resampled.coherence ? Array.from(resampled.coherence) : null,
        },
        sampleRate: response.sampleRate,
        fftSize: response.fftSize,
        delayMs: response.delayMs,
      });
    }
    return null;
  }

  function runComparison() {
    const evaluation = lastEvaluation || evaluateSystem(project, evaluationOptions());
    if (!evaluation.sum) {
      setCompareMessage('There is nothing predicted yet — add at least one source.', true);
      return;
    }
    const select = $('dmCompareSelect');
    const dataset = resolveCompareTrace(select ? select.value : '');
    if (!dataset) {
      setCompareMessage('Choose a measured response that carries data.', true);
      return;
    }
    const band = {
      min: Number($('dmCompareLow') && $('dmCompareLow').value) || 100,
      max: Number($('dmCompareHigh') && $('dmCompareHigh').value) || 10000,
    };
    const stats = compareSum(evaluation.sum, dataset, band, {
      coherenceThreshold: project.settings.coherenceThreshold,
    });
    if (!stats) {
      setCompareMessage('That response could not be compared — it carries no usable points.', true);
      return;
    }
    comparison = { stats, dataset, band, evaluation };
    renderComparison();
    renderChart();
    setCompareMessage('Compared over ' + formatRangeText(band.min, band.max) + ' — ' + stats.count + ' points.', false);
  }

  function setCompareMessage(message, bad) {
    const line = $('dmCompareMessage');
    if (!line) return;
    line.textContent = message || '';
    line.hidden = !message;
    line.classList.toggle('clip-warning', !!bad);
  }

  function renderComparison() {
    const summary = $('dmCompareSummary');
    const table = $('dmCompareTable');
    if (summary) summary.replaceChildren();
    if (table) table.replaceChildren();
    if (!comparison) {
      if (summary) summary.textContent = 'No comparison yet.';
      return;
    }
    const { stats, dataset, band } = comparison;
    const measuredTrace = datasetTraceOf(dataset);
    if (!measuredTrace) return;

    comparison.predicted = {
      frequencies: stats.frequencies,
      measuredMagDb: stats.measuredDb,
      measuredPhaseDeg: stats.measuredPhase,
      errors: stats.errors,
    };

    if (summary) {
      const rows = [
        ['Compared over', formatRangeText(band.min, band.max) + ' · ' + stats.count + ' points'],
        ['Mean error', Number.isFinite(stats.meanDb) ? signed(stats.meanDb) + ' dB' : '—'],
        ['RMS error', Number.isFinite(stats.rmsDb) ? stats.rmsDb.toFixed(1) + ' dB' : '—'],
        ['Largest deviation', Number.isFinite(stats.worstDb)
          ? signed(stats.worstDb) + ' dB at ' + formatFrequency(stats.worstHz) : '—'],
        ['Phase', stats.phase
          ? 'mean ' + stats.phase.meanDeg.toFixed(0) + '° · worst ' + stats.phase.worstDeg.toFixed(0) +
            '° at ' + formatFrequency(stats.phase.worstHz)
          : 'no phase in both curves'],
      ];
      for (const [label, value] of rows) {
        const row = el('div', 'dm-opt-row');
        row.appendChild(el('span', 'dm-opt-key', label));
        row.appendChild(el('span', 'dm-opt-value', value));
        summary.appendChild(row);
      }
    }

    if (table) {
      const rows = bandTable(comparison.evaluation.sum.frequencies, comparison.evaluation.sum.magDb,
        measuredTrace.magDb, band);
      const head = el('div', 'dm-band-row head');
      for (const label of ['Band', 'Predicted', 'Measured', 'Error']) head.appendChild(el('span', null, label));
      table.appendChild(head);
      for (const row of rows) {
        if (!Number.isFinite(row.meanDb)) continue;
        const line = el('div', 'dm-band-row');
        line.appendChild(el('span', null, formatFrequency(row.centre)));
        line.appendChild(el('span', null, row.meanDb.toFixed(1)));
        line.appendChild(el('span', null,
          Number.isFinite(row.differenceDb) ? (row.meanDb - row.differenceDb).toFixed(1) : '—'));
        line.appendChild(el('span', null, Number.isFinite(row.differenceDb) ? signed(row.differenceDb) : '—'));
        table.appendChild(line);
      }
    }
  }

  function datasetTraceOf(dataset) {
    if (!dataset || !dataset.curve) return null;
    const count = dataset.curve.magDb.length;
    const frequencies = [];
    for (let i = 0; i < count; i += 1) frequencies.push(gridFrequency(i, count));
    return {
      frequencies,
      magDb: Float64Array.from(dataset.curve.magDb),
      phaseDeg: Array.isArray(dataset.curve.phaseDeg) ? Float64Array.from(dataset.curve.phaseDeg) : null,
      coherence: Array.isArray(dataset.curve.coherence) ? Float64Array.from(dataset.curve.coherence) : null,
    };
  }

  /* ---------- snapshots ---------- */

  function renderSnapshots() {
    const list = $('dmSnapshotList');
    if (!list) return;
    list.replaceChildren();
    if (!project.snapshots.length) {
      list.appendChild(el('li', 'dm-empty', 'No snapshot yet. Save one to compare two arrangements.'));
      return;
    }
    for (const snapshot of project.snapshots) {
      const row = el('li', 'dm-snapshot');
      row.appendChild(el('span', 'dm-snapshot-name', snapshot.name));
      row.appendChild(el('span', 'dm-snapshot-meta',
        snapshot.data.sources.length + ' sources · ' + new Date(snapshot.savedAt).toLocaleString()));
      row.appendChild(button('Recall', 'dm-mini', { recall: snapshot.id }));
      row.appendChild(button('Delete', 'dm-mini dm-danger', { removeSnapshot: snapshot.id }));
      list.appendChild(row);
    }
  }

  function saveSnapshot() {
    const field = $('dmSnapshotName');
    const name = field ? field.value.trim() : '';
    if (!name) {
      say('A snapshot needs a name.', 'err');
      return;
    }
    commit(() => {
      project.snapshots.unshift({
        id: 'snap-' + Date.now().toString(36),
        name: name.slice(0, 60),
        savedAt: new Date().toISOString(),
        data: {
          sources: JSON.parse(JSON.stringify(project.sources)),
          groups: JSON.parse(JSON.stringify(project.groups)),
          positions: JSON.parse(JSON.stringify(project.positions)),
          settings: JSON.parse(JSON.stringify(project.settings)),
          optimizer: optimizerResult
            ? { delayMs: optimizerResult.best.delayMs, polarity: optimizerResult.best.polarity,
              targetId: optimizerResult.targetId, objective: optimizerResult.objective }
            : null,
        },
      });
      project.snapshots = project.snapshots.slice(0, 30);
    }, 'Saved the snapshot “' + name + '”.');
    if (field) field.value = '';
  }

  function recallSnapshot(id) {
    const snapshot = project.snapshots.find((entry) => entry.id === id);
    if (!snapshot) return;
    commit(() => {
      project.sources = JSON.parse(JSON.stringify(snapshot.data.sources));
      project.groups = JSON.parse(JSON.stringify(snapshot.data.groups));
      project.positions = snapshot.data.positions.length
        ? JSON.parse(JSON.stringify(snapshot.data.positions))
        : project.positions;
      project.settings = { ...project.settings, ...snapshot.data.settings };
    }, 'Recalled “' + snapshot.name + '”.');
    optimizerResult = null;
    renderOptimizerResult();
  }

  /* ---------- import ---------- */

  function importDataset(response, meta) {
    const built = buildDataset(response, meta);
    if (!built.ok) {
      say(built.message, 'err');
      return null;
    }
    const dataset = built.dataset;
    let model = meta.modelId ? project.models.find((entry) => entry.id === meta.modelId) : null;
    commit(() => {
      if (!model) {
        model = newModel({
          name: meta.label || 'Imported loudspeaker',
          manufacturer: meta.manufacturer || '',
          type: meta.type || 'Custom',
          provenance: meta.provenance,
          notes: meta.note || '',
        });
        project.models.unshift(model);
      }
      model.datasets.unshift(dataset);
      model.datasets = model.datasets.slice(0, 24);
      model.updatedAt = new Date().toISOString();
      if (meta.provenance) model.provenance = meta.provenance;
      selectedModelId = model.id;
      selectedDatasetId = dataset.id;
    }, 'Imported “' + dataset.label + '” — ' + dataset.points + ' points, ' +
      formatRangeText(dataset.fMin, dataset.fMax) + (dataset.hasPhase ? ' with phase.' : ', magnitude only.'));
    renderAll();
    return dataset;
  }

  function buildDataset(response, meta) {
    const resampled = resampleResponse(response);
    if (!resampled.ok) return { ok: false, message: resampled.message };
    const dataset = normalizeDataset({
      label: meta.label,
      provenance: meta.provenance,
      importedFrom: meta.importedFrom,
      curve: {
        magDb: Array.from(resampled.magDb),
        phaseDeg: resampled.phaseDeg ? Array.from(resampled.phaseDeg) : null,
        coherence: resampled.coherence ? Array.from(resampled.coherence) : null,
      },
      fMin: resampled.sourceRange.min,
      fMax: resampled.sourceRange.max,
      sampleRate: meta.sampleRate,
      fftSize: meta.fftSize,
      delayMs: meta.delayMs,
      phaseOrigin: resampled.phaseValid ? 'measured' : 'none',
      conditions: meta.conditions || {},
      note: [meta.note, resampled.message].filter(Boolean).join(' · '),
    });
    if (!dataset) return { ok: false, message: 'That response could not be modelled.' };
    return { ok: true, dataset };
  }

  function setImportMessage(message, bad) {
    const line = $('dmImportMessage');
    if (!line) return;
    line.textContent = message || '';
    line.hidden = !message;
    line.classList.toggle('clip-warning', !!bad);
  }

  function showMapping(described, name, text) {
    pendingFile = described;
    pendingText = text;
    const block = $('dmMapBlock');
    if (!block) return;
    block.hidden = false;

    const title = $('dmMapTitle');
    if (title) {
      title.textContent = name + ' · ' + described.rowCount + ' rows' +
        (described.headerRow ? ' · header “' + described.headerRow.slice(0, 60) + '”' : ' · no header');
    }

    const items = described.labels.map((label, index) => ({ value: String(index), label: (index + 1) + '. ' + label }));
    const none = [{ value: '-1', label: 'none' }];

    const set = (id, items2, value) => {
      const select = $(id);
      if (!select) return;
      select.replaceChildren();
      for (const item of items2) {
        const option = document.createElement('option');
        option.value = item.value;
        option.textContent = item.label;
        select.appendChild(option);
      }
      select.value = String(value);
    };

    const mapping = described.mapping || {};
    set('dmMapFrequency', items, mapping.frequency !== undefined ? mapping.frequency : 0);
    set('dmMapMagnitude', items, mapping.magnitude !== undefined ? mapping.magnitude : 1);
    set('dmMapPhase', none.concat(items), mapping.phase !== undefined ? mapping.phase : -1);
    set('dmMapCoherence', none.concat(items), mapping.coherence !== undefined ? mapping.coherence : -1);

    const unit = (id, value) => { const select = $(id); if (select) select.value = value; };
    unit('dmMapFrequencyUnit', mapping.frequencyUnit || 'Hz');
    unit('dmMapMagnitudeUnit', mapping.magnitudeUnit || 'dB');
    unit('dmMapPhaseUnit', mapping.phaseUnit || 'deg');

    const preview = $('dmMapPreview');
    if (preview) {
      preview.replaceChildren();
      const head = el('div', 'dm-map-row head');
      for (const label of described.labels) head.appendChild(el('span', null, label));
      preview.appendChild(head);
      for (const row of described.preview) {
        const line = el('div', 'dm-map-row');
        for (let index = 0; index < described.labels.length; index += 1) {
          line.appendChild(el('span', null, row[index] !== undefined ? row[index] : ''));
        }
        preview.appendChild(line);
      }
    }

    const nameField = $('dmDatasetName');
    if (nameField) nameField.value = name.replace(/\.[^.]+$/, '');
  }

  function readMapping() {
    const value = (id, fallback) => {
      const select = $(id);
      return select ? Number(select.value) : fallback;
    };
    return {
      frequency: value('dmMapFrequency', 0),
      magnitude: value('dmMapMagnitude', 1),
      phase: value('dmMapPhase', -1),
      coherence: value('dmMapCoherence', -1),
      frequencyUnit: $('dmMapFrequencyUnit') ? $('dmMapFrequencyUnit').value : 'Hz',
      magnitudeUnit: $('dmMapMagnitudeUnit') ? $('dmMapMagnitudeUnit').value : 'dB',
      phaseUnit: $('dmMapPhaseUnit') ? $('dmMapPhaseUnit').value : 'deg',
    };
  }

  function applyMapping() {
    if (!pendingFile) return;
    const parsed = parseResponseText(pendingText, { mapping: readMapping() });
    if (!parsed.ok) {
      setImportMessage(parsed.message, true);
      return;
    }
    pendingFile = null;
    const block = $('dmMapBlock');
    if (block) block.hidden = true;
    const nameField = $('dmDatasetName');
    const name = nameField && nameField.value.trim() ? nameField.value.trim() : 'Imported response';
    const modelSelect = $('dmDatasetModel');
    const provenance = $('dmDatasetProvenance') ? $('dmDatasetProvenance').value : 'measured';

    const dataset = importDataset(parsed.response, {
      label: name,
      provenance,
      importedFrom: parsed.labels.length ? 'Imported file' : 'Imported file',
      modelId: modelSelect && modelSelect.value !== 'new' ? modelSelect.value : '',
      sampleRate: 0,
      fftSize: 0,
      delayMs: 0,
      note: parsed.message,
    });
    if (dataset) {
      setImportMessage('Read ' + parsed.points + ' points from ' + formatRangeText(parsed.response.fMin, parsed.response.fMax) +
        '.' + (parsed.message ? ' ' + parsed.message + '.' : ''), false);
    }
  }

  function renderFileMappingSelects() {
    const modelSelect = $('dmDatasetModel');
    if (!modelSelect) return;
    modelSelect.replaceChildren();
    const option = document.createElement('option');
    option.value = 'new';
    option.textContent = 'New loudspeaker from this file';
    modelSelect.appendChild(option);
    for (const model of project.models) {
      const entry = document.createElement('option');
      entry.value = model.id;
      entry.textContent = model.name;
      modelSelect.appendChild(entry);
    }
    if (selectedModelId) modelSelect.value = selectedModelId;
  }

  function handleFile(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const name = file.name || 'response';
    const lower = name.toLowerCase();

    if (lower.endsWith('.trf')) {
      setImportMessage('A Smaart .trf file is not read here — the format is proprietary. ' +
        'Export the trace from Smaart as text or FRD, or import the running measurement directly.', true);
      return;
    }

    const finish = (text) => {
      const described = describeResponseText(text);
      if (!described.ok) {
        setImportMessage(described.message, true);
        return;
      }
      showMapping(described, name, text);
      setImportMessage('Read ' + described.rowCount + ' rows — check the columns below before importing.', false);
    };

    if (lower.endsWith('.wav')) {
      const reader = new FileReader();
      reader.onload = () => {
        const parsed = parseWav(reader.result);
        if (!parsed.ok) {
          setImportMessage(parsed.message, true);
          return;
        }
        const transformed = impulseToResponse(parsed.samples, parsed.sampleRate, { beforeMs: 1, widthMs: 20 });
        if (!transformed.ok) {
          setImportMessage(transformed.message, true);
          return;
        }
        const block = $('dmMapBlock');
        if (block) block.hidden = true;
        pendingFile = null;
        const nameField = $('dmDatasetName');
        const label = nameField && nameField.value.trim() ? nameField.value.trim() : name.replace(/\.[^.]+$/, '');
        importDataset(transformed.response, {
          label,
          provenance: 'measured',
          importedFrom: 'WAV impulse · ' + Math.round(parsed.sampleRate) + ' Hz',
          modelId: $('dmDatasetModel') && $('dmDatasetModel').value !== 'new'
            ? $('dmDatasetModel').value : '',
          sampleRate: parsed.sampleRate,
          fftSize: transformed.fftSize,
          delayMs: 0,
          note: transformed.message,
        });
        setImportMessage('Read the impulse at ' + transformed.peakMs.toFixed(2) + ' ms · ' +
          transformed.message, false);
      };
      reader.onerror = () => setImportMessage('That file could not be read.', true);
      reader.readAsArrayBuffer(file);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => finish(String(reader.result || ''));
    reader.onerror = () => setImportMessage('That file could not be read.', true);
    reader.readAsText(file);
  }

  function importFromSaved() {
    const select = $('dmCaptureSelect');
    const id = select ? select.value : '';
    const modelSelect = $('dmDatasetModel');

    if (id.startsWith('held:')) {
      const label = id.slice(5);
      const held = heldProvider().find((entry) => entry && entry.label === label);
      if (!held || !held.trace) {
        setImportMessage('That held capture is no longer in the measurement.', true);
        return;
      }
      const response = responseFromAnalyser({
        results: held.trace,
        delayMs: held.trace.delayMs,
        compensated: !!held.trace.phaseCompensated,
        label: 'Capture ' + label,
      });
      if (!response) {
        setImportMessage('That held capture carries no usable bins.', true);
        return;
      }
      importDataset(response, {
        label: 'Capture ' + label,
        provenance: 'measured',
        importedFrom: 'Held capture ' + label,
        modelId: modelSelect && modelSelect.value !== 'new' ? modelSelect.value : '',
        sampleRate: response.sampleRate,
        fftSize: response.fftSize,
        delayMs: response.delayMs,
        conditions: { micLabel: 'Capture ' + label, phaseCompensated: !!held.trace.phaseCompensated },
        note: held.trace.phaseCompensated ? 'delay was compensated; its arrival was put back' : '',
      });
      setImportMessage('Imported held capture ' + label +
        (response.phaseDeg ? ' with its measured phase.' : ' as magnitude only.'), false);
      return;
    }

    const entry = libraryProvider().find((item) => item.id === id);
    if (!entry) {
      setImportMessage('Choose a capture from the library first.', true);
      return;
    }
    const response = responseFromSaved(entry);
    if (!response) {
      setImportMessage('That capture holds no usable curve.', true);
      return;
    }
    importDataset(response, {
      label: entry.name,
      provenance: 'measured',
      importedFrom: 'Capture library' + (entry.date ? ' · ' + new Date(entry.date).toLocaleDateString() : ''),
      modelId: modelSelect && modelSelect.value !== 'new' ? modelSelect.value : '',
      sampleRate: response.sampleRate,
      fftSize: response.fftSize,
      delayMs: response.delayMs,
      conditions: {
        venue: entry.venue || '',
        event: entry.event || '',
        micLabel: entry.micPosition && entry.micPosition.label ? entry.micPosition.label : '',
        micDistanceM: entry.micPosition ? entry.micPosition.distanceM : null,
        micHeightM: entry.micPosition ? entry.micPosition.heightM : null,
        device: entry.inputs && entry.inputs.device ? entry.inputs.device : '',
        channels: entry.inputs && entry.inputs.channelsDetected ? entry.inputs.channelsDetected : '',
        reference: entry.reference || '',
        calibrationName: entry.calibration && entry.calibration.name ? entry.calibration.name : '',
        calibrationOffsetDb: entry.calibration ? entry.calibration.offsetDb : null,
        phaseCompensated: entry.phaseCompensated === true,
        measuredAt: entry.date || '',
      },
      note: entry.note || '',
    });
    setImportMessage('Imported “' + entry.name + '”' +
      (response.phaseDeg ? ' with its measured phase.' : ' as magnitude only.'), false);
  }

  function importLive() {
    const live = liveProvider();
    if (!live || !live.results) {
      setImportMessage('No measurement is running — start one in Align first, or use the demo.', true);
      return;
    }
    const response = responseFromAnalyser(live);
    if (!response) {
      setImportMessage('The running measurement carries no usable bins yet.', true);
      return;
    }
    const modelSelect = $('dmDatasetModel');
    importDataset(response, {
      label: live.label || 'Live measurement',
      provenance: 'measured',
      importedFrom: 'Live measurement · ' + (live.results.fftSize || '') + ' FFT',
      modelId: modelSelect && modelSelect.value !== 'new' ? modelSelect.value : '',
      sampleRate: response.sampleRate,
      fftSize: response.fftSize,
      delayMs: response.delayMs,
      conditions: {
        device: live.device || '',
        channels: live.channels || '',
        reference: live.reference || '',
        calibrationName: live.calibration || '',
        micLabel: live.micLabel || '',
        phaseCompensated: live.compensated === true,
      },
      note: live.compensated ? 'delay was compensated; its arrival was put back' : '',
    });
    setImportMessage('Imported the running measurement' +
      (response.phaseDeg ? ' with phase.' : ' as magnitude only.'), false);
  }

  /* ---------- exports ---------- */

  function download(text, filename, title) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    if (typeof opts.share === 'function') opts.share(blob, filename, title);
    else {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }
  }

  function exportCsv() {
    const evaluation = lastEvaluation || evaluateSystem(project, evaluationOptions());
    if (!evaluation.responses.length) {
      setReportMessage('There is nothing to export yet — add a source.', true);
      return;
    }
    const lines = [];
    lines.push('# Align System Data Modeler — predicted system');
    lines.push('# ' + new Date().toISOString());
    lines.push('# complex sum of ' + evaluation.responses.length + ' modelled source' +
      (evaluation.responses.length === 1 ? '' : 's'));
    if (evaluation.sum && evaluation.sum.assumedPhase) {
      lines.push('# ' + evaluation.sum.assumedPhase + ' source(s) carry no measured phase: zero phase assumed there');
    }
    lines.push('# ' + evaluation.responses.map((response) => response.name).join(' | '));
    const head = ['frequency_hz'];
    for (const response of evaluation.responses) head.push(response.name + '_mag_db', response.name + '_phase_deg');
    head.push('sum_mag_db', 'sum_phase_deg');
    lines.push(head.join(','));

    const frequencies = evaluation.responses[0].frequencies;
    for (let i = 0; i < frequencies.length; i += 1) {
      const row = [frequencies[i].toFixed(2)];
      for (const response of evaluation.responses) {
        row.push(Number.isFinite(response.magDb[i]) ? response.magDb[i].toFixed(2) : '',
          response.phaseValid && Number.isFinite(response.phaseDeg[i])
            ? wrap(response.phaseDeg[i]).toFixed(1) : '');
      }
      if (evaluation.sum) {
        row.push(Number.isFinite(evaluation.sum.magDb[i]) ? evaluation.sum.magDb[i].toFixed(2) : '',
          evaluation.sum.assumedPhase === 0 && Number.isFinite(evaluation.sum.phaseDeg[i])
            ? wrap(evaluation.sum.phaseDeg[i]).toFixed(1) : '');
      }
      lines.push(row.join(','));
    }
    download(lines.join('\n'), 'align-model-system.csv', 'Predicted system');
    setReportMessage('Exported the predicted system as CSV.', false);
  }

  function exportFrd() {
    const evaluation = lastEvaluation || evaluateSystem(project, evaluationOptions());
    if (!evaluation.sum) {
      setReportMessage('There is nothing to export yet — add a source.', true);
      return;
    }
    const lines = ['# Align System Data Modeler — predicted sum', '# frequency magnitude_dB phase_deg'];
    for (let i = 0; i < evaluation.sum.frequencies.length; i += 1) {
      lines.push(evaluation.sum.frequencies[i].toFixed(2) + ' ' +
        evaluation.sum.magDb[i].toFixed(2) + ' ' +
        wrap(evaluation.sum.phaseDeg[i]).toFixed(2));
    }
    download(lines.join('\n'), 'align-model-sum.frd', 'Predicted sum');
    setReportMessage('Exported the predicted sum as an FRD curve.', false);
  }

  function exportReport() {
    const evaluation = lastEvaluation || evaluateSystem(project, evaluationOptions());
    const lines = [];
    lines.push('Align — System Data Modeler report');
    lines.push('Generated ' + new Date().toLocaleString());
    lines.push('');
    lines.push('Loudspeakers in the library: ' + project.models.length);
    for (const model of project.models) {
      lines.push('  ' + model.name + ' · ' + [model.manufacturer, model.model, model.type].filter(Boolean).join(' · ') +
        ' · ' + provenanceLabel(model.provenance));
      for (const dataset of model.datasets) {
        lines.push('    ' + dataset.label + ' · ' + (dataset.hasPhase ? 'phase' : 'magnitude only') +
          ' · ' + formatRangeText(dataset.fMin, dataset.fMax) + ' · ' + provenanceLabel(dataset.provenance));
      }
    }
    lines.push('');
    lines.push('Sources in the model (' + project.sources.length + '):');
    for (const response of evaluation.responses) {
      lines.push('  ' + response.name + ' · gain ' + signed(response.settings.gainDb) + ' dB · delay ' +
        formatDelay(response.settings.delayMs) + ' · ' + (response.settings.inverted ? 'inverted' : 'normal') +
        ' · ' + response.filters.length + ' filter(s)');
    }
    if (evaluation.missing.length) {
      lines.push('  Not in the sum (no dataset): ' + evaluation.missing.join(', '));
    }
    if (evaluation.sum) {
      lines.push('');
      lines.push('Predicted sum: ' + evaluation.sum.activeIds.length + ' sources' +
        (evaluation.sum.assumedPhase ? ' · ' + evaluation.sum.assumedPhase + ' without measured phase' : ''));
      const statistics = curveStatisticsOf(evaluation.sum);
      lines.push('  Mean level 100 Hz – 10 kHz: ' + formatTraceLevel(statistics.meanDb));
      lines.push('  Deepest null: ' + (Number.isFinite(statistics.dipDb)
        ? formatFrequency(statistics.dipHz) + ' at ' + formatTraceLevel(statistics.dipDb) : 'none'));
    }
    if (optimizerResult) {
      lines.push('');
      lines.push('Alignment: ' + formatDelay(optimizerResult.best.delayMs) + ' · ' + optimizerResult.best.polarity +
        ' · ' + optimizerResult.objective + ' · ' + optimizerResult.confidence.level);
      lines.push('  ' + optimizerResult.confidence.note);
      lines.push('  ' + optimizerResult.tradeoff);
    }
    if (comparison) {
      lines.push('');
      lines.push('Prediction against measurement over ' + formatRangeText(comparison.band.min, comparison.band.max) + ':');
      lines.push('  Mean error ' + signed(comparison.stats.meanDb) + ' dB · RMS ' +
        comparison.stats.rmsDb.toFixed(1) + ' dB · largest ' + signed(comparison.stats.worstDb) + ' dB at ' +
        formatFrequency(comparison.stats.worstHz));
    }
    lines.push('');
    lines.push('A prediction from stored curves. Nothing here is written to a processor or a speaker.');
    download(lines.join('\n'), 'align-model-report.txt', 'System Data Modeler report');
    setReportMessage('Exported the report.', false);
  }

  function curveStatisticsOf(sum) {
    let mean = 0;
    let count = 0;
    let dip = Infinity;
    let dipHz = NaN;
    let peak = -Infinity;
    for (let i = 0; i < sum.frequencies.length; i += 1) {
      const f = sum.frequencies[i];
      if (f < 100 || f > 10000) continue;
      const value = sum.magDb[i];
      if (!Number.isFinite(value)) continue;
      mean += value;
      count += 1;
      if (value < dip) { dip = value; dipHz = f; }
      if (value > peak) peak = value;
    }
    return {
      meanDb: count ? mean / count : NaN,
      dipDb: count ? dip : NaN,
      dipHz,
      peakDb: count ? peak : NaN,
    };
  }

  function exportDataset(modelId) {
    const model = project.models.find((entry) => entry.id === modelId);
    if (!model || !model.datasets.length) {
      say('That loudspeaker has no measured response to export.', 'err');
      return;
    }
    const dataset = model.datasets[0];
    const lines = ['# ' + model.name + ' · ' + dataset.label,
      '# ' + (dataset.hasPhase ? 'with measured phase' : 'magnitude only'),
      '# ' + formatRangeText(dataset.fMin, dataset.fMax),
      'frequency_hz,magnitude_db,phase_deg'];
    for (let i = 0; i < dataset.curve.magDb.length; i += 1) {
      const frequency = gridFrequency(i, dataset.curve.magDb.length);
      if (frequency < dataset.fMin || frequency > dataset.fMax) continue;
      lines.push(frequency.toFixed(2) + ',' + Number(dataset.curve.magDb[i]).toFixed(2) + ',' +
        (dataset.curve.phaseDeg ? wrap(dataset.curve.phaseDeg[i]).toFixed(1) : ''));
    }
    download(lines.join('\n'), 'align-model-dataset.csv', 'Modelled dataset');
    say('Exported the first measured response of ' + model.name + '.', 'ok');
  }

  function exportProject() {
    const payload = {
      kind: 'align-model-project',
      version: 1,
      exported: new Date().toISOString(),
      project,
    };
    download(JSON.stringify(payload, null, 2), 'align-model-project.json', 'System Data Modeler project');
    setReportMessage('Exported the complete project.', false);
  }

  /* ---------- the report/status line ---------- */

  function setReportMessage(message, bad) {
    const line = $('dmReportMessage');
    if (!line) return;
    line.textContent = message || '';
    line.hidden = !message;
    line.classList.toggle('clip-warning', !!bad);
  }

  /* ---------- render everything ---------- */

  function renderViewOptions() {
    const settings = project.settings;
    const set = (id, value) => { const field = $(id); if (field && field.type !== 'checkbox') field.value = value; };
    set('dmView', settings.view || 'transfer');
    set('dmPhaseMode', settings.phaseMode || 'wrapped');
    set('dmDbSpan', String(settings.dbSpan || 0));
    set('dmSmoothing', String(settings.smoothing || 0));
    const position = $('dmPositionSelect');
    if (position) position.hidden = project.positions.length < 2;

    const individual = $('chkDmIndividual');
    if (individual) individual.checked = settings.showIndividual !== false;
    const sumToggle = $('chkDmSum');
    if (sumToggle) sumToggle.checked = settings.showSum !== false;

    const propagation = $('chkDmPropagation');
    if (propagation) propagation.checked = !!(settings.propagation && settings.propagation.enabled);
    const reference = $('dmRefDistance');
    if (reference) reference.value = String((settings.propagation && settings.propagation.referenceDistanceM) || 1);
    const speed = $('dmSoundSpeed');
    if (speed) speed.value = String((settings.propagation && settings.propagation.speedOfSound) || SPEED_OF_SOUND);

    const span = $('dmSpanText');
    if (chart && span) span.textContent = formatRangeText(chart.range.min, chart.range.max) + ' · drag to zoom';
  }

  function renderAll() {
    renderLibrary();
    renderModelForm();
    renderAddSelects();
    renderSources();
    renderGroups();
    renderPositions();
    renderChain();
    renderOptimizerSelects();
    renderCompareSelect();
    renderFileMappingSelects();
    renderSnapshots();
    renderViewOptions();
    renderComparison();
    renderChart();
    renderSummation();
    renderOptimizerResult();
    refreshHistory();
    renderImportSources();
  }

  function renderImportSources() {
    const select = $('dmCaptureSelect');
    if (!select) return;
    const previous = select.value;
    const items = [];
    for (const entry of libraryProvider()) items.push({ value: entry.id, label: entry.name });
    for (const held of heldProvider()) {
      if (!held || !held.trace) continue;
      items.push({ value: 'held:' + held.label, label: 'Held capture ' + held.label });
    }
    select.replaceChildren();
    if (!items.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'the capture library is empty';
      select.appendChild(option);
      return;
    }
    for (const item of items) {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = item.label;
      select.appendChild(option);
    }
    if (items.some((item) => item.value === previous)) select.value = previous;
  }

  /* ---------- events ---------- */

  function sourceField(field, id, value, live) {
    const source = project.sources.find((entry) => entry.id === id);
    if (!source) return;
    if (live) {
      if (field === 'gain') source.gainDb = Math.max(-30, Math.min(30, Number(value) || 0));
      else if (field === 'delay') source.delayMs = Math.max(-50, Math.min(100, Number(value) || 0));
      else if (field === 'polarity') source.polarity = value === 'inverted' ? 'inverted' : 'normal';
      else if (field === 'group') source.groupId = value;
      opts.persist ? opts.persist(project) : null;
      renderChart();
      renderSummation();
      updateSourceMeta(source);
      return;
    }
    commit(() => {
      if (field === 'gain') source.gainDb = Math.max(-30, Math.min(30, Number(value) || 0));
      else if (field === 'delay') source.delayMs = Math.max(-50, Math.min(100, Number(value) || 0));
      else if (field === 'polarity') source.polarity = value === 'inverted' ? 'inverted' : 'normal';
      else if (field === 'group') source.groupId = value;
    }, '');
  }

  function updateSourceMeta(source) {
    const row = document.querySelector('.dm-source[data-source="' + source.id + '"] .dm-source-meta');
    if (!row) return;
    const found = findDataset(project, source.modelId, source.datasetId);
    row.textContent = [
      found.dataset ? found.dataset.label : 'no dataset',
      found.dataset && !found.dataset.hasPhase ? 'magnitude only' : '',
      project.groups.find((group) => group.id === source.groupId)?.name || 'no group',
      source.filters.length + ' filter' + (source.filters.length === 1 ? '' : 's'),
    ].filter(Boolean).join(' · ');
  }

  function filterField(field, id, value, live) {
    const source = selectedSource();
    if (!source) return;
    const filter = source.filters.find((entry) => entry.id === id);
    if (!filter) return;
    const apply = () => {
      if (field === 'kind') {
        filter.kind = filterKind(value).id;
      } else if (field === 'frequency') {
        filter.frequency = Math.max(10, Math.min(20000, Number(value) || 1000));
      } else if (field === 'gain') {
        filter.gainDb = Math.max(-24, Math.min(24, Number(value) || 0));
      } else if (field === 'q') {
        filter.q = Math.max(0.1, Math.min(10, Number(value) || 0.7071));
      } else if (field === 'enabled') {
        filter.enabled = !!value;
      }
    };
    if (live) {
      apply();
      opts.persist ? opts.persist(project) : null;
      renderChart();
      renderChainSummary(filter);
      return;
    }
    commit(apply, '');
  }

  function renderChainSummary(filter) {
    const row = document.querySelector('.dm-filter[data-filter="' + filter.id + '"] .dm-filter-text');
    if (row) row.textContent = filterText(filter);
  }

  function bindEvents() {
    if (!workspace || workspace.dataset.bound) return;
    workspace.dataset.bound = '1';

    $('btnDmClose')?.addEventListener('click', close);
    $('btnDmUndo')?.addEventListener('click', undo);
    $('btnDmRedo')?.addEventListener('click', redo);

    $('btnDmNewProject')?.addEventListener('click', () => {
      if (!window.confirm('Start a new model project? The current source arrangement is replaced, and the loudspeaker library is kept.')) return;
      commit((next) => {
        const fresh = emptyProject();
        next.sources = fresh.sources;
        next.groups = fresh.groups;
        next.positions = fresh.positions;
        next.settings = fresh.settings;
      }, 'Started a new project — the loudspeaker library is untouched.');
      selectedSourceId = null;
      selectedModelId = null;
      optimizerResult = null;
      comparison = null;
      renderComparison();
      renderOptimizerResult();
    });

    $('btnDmSaveProject')?.addEventListener('click', () => {
      const ok = opts.persist ? opts.persist(project) : false;
      if (ok) say('Saved the project in this browser.', 'ok');
      else say('Could not save the project — browser storage is full or blocked.', 'err');
    });

    $('btnDmExportProject')?.addEventListener('click', exportProject);
    $('btnDmImportProject')?.addEventListener('click', () => $('dmProjectFile')?.click());

    $('dmProjectFile')?.addEventListener('change', (event) => {
      const input = event.target;
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        let parsed = null;
        try {
          parsed = JSON.parse(String(reader.result || ''));
        } catch (err) {
          say('That is not an Align model project — the JSON could not be read.', 'err');
          return;
        }
        const loaded = parsed && parsed.project ? parsed.project : parsed;
        if (!loaded || typeof loaded !== 'object' || !Array.isArray(loaded.sources)) {
          say('That file does not hold a model project.', 'err');
          return;
        }
        const next = normalizeProject(loaded);
        commit(() => {
          project.models = next.models.length ? next.models : project.models;
          project.sources = next.sources;
          project.groups = next.groups;
          project.positions = next.positions;
          project.settings = next.settings;
          project.snapshots = next.snapshots;
        }, 'Imported the project: ' + next.sources.length + ' sources and ' +
          next.models.length + ' loudspeakers.');
        optimizerResult = null;
        renderOptimizerResult();
      };
      reader.onerror = () => say('That file could not be read.', 'err');
      reader.readAsText(file);
      input.value = '';
    });

    $('dmLibrarySearch')?.addEventListener('input', renderLibrary);

    $('dmLibraryList')?.addEventListener('click', (event) => {
      const target = event.target.closest('button');
      if (!target) return;
      const data = target.dataset;
      if (data.pick) {
        selectedModelId = data.pick;
        const model = selectedModel();
        selectedDatasetId = model && model.datasets[0] ? model.datasets[0].id : null;
        renderLibrary();
        renderModelForm();
        renderAddSelects();
        return;
      }
      if (data.datasetPick) {
        selectedModelId = data.modelPick;
        selectedDatasetId = data.datasetPick;
        renderLibrary();
        renderModelForm();
        renderAddSelects();
        return;
      }
      if (data.use) {
        addSourceFromModel(data.useModel, data.use);
        return;
      }
      if (data.edit) {
        selectedModelId = data.edit;
        renderLibrary();
        renderModelForm();
        return;
      }
      if (data.export) {
        exportDataset(data.export);
        return;
      }
      if (data.remove) {
        const model = project.models.find((entry) => entry.id === data.remove);
        if (!model) return;
        if (!window.confirm('Delete “' + model.name + '” and its ' + model.datasets.length +
          ' measured response(s)? Sources using it lose their curve.')) return;
        commit(() => {
          project.models = project.models.filter((entry) => entry.id !== data.remove);
        }, 'Deleted ' + model.name + '.');
        if (selectedModelId === data.remove) selectedModelId = null;
        renderAll();
      }
    });

    $('btnDmCreateModel')?.addEventListener('click', () => {
      const name = ($('dmNewName')?.value || '').trim();
      if (!name) {
        say('A loudspeaker needs a name.', 'err');
        return;
      }
      const model = newModel({
        name,
        manufacturer: ($('dmNewManufacturer')?.value || '').trim(),
        type: 'Custom',
        provenance: 'measured',
      });
      commit(() => { project.models.unshift(model); }, 'Created ' + model.name + '.');
      selectedModelId = model.id;
      const field = $('dmNewName');
      if (field) field.value = '';
      const manufacturer = $('dmNewManufacturer');
      if (manufacturer) manufacturer.value = '';
      renderAll();
    });

    $('btnDmApplyModel')?.addEventListener('click', () => {
      const model = selectedModel();
      if (!model) return;
      commit(() => {
        model.name = ($('dmEditName')?.value || '').trim() || model.name;
        model.manufacturer = ($('dmEditManufacturer')?.value || '').trim();
        model.model = ($('dmEditNumber')?.value || '').trim();
        model.type = MODEL_TYPES.includes($('dmEditType')?.value) ? $('dmEditType').value : model.type;
        model.impedanceOhm = Number($('dmEditImpedance')?.value) || 8;
        model.sensitivityDb = Number($('dmEditSensitivity')?.value) || 96;
        model.distanceM = Number($('dmEditDistance')?.value) || 1;
        model.referenceDelayMs = Number($('dmEditDelay')?.value) || 0;
        model.crossoverText = ($('dmEditCrossover')?.value || '').trim();
        model.directivityText = ($('dmEditDirectivity')?.value || '').trim();
        model.specs = ($('dmEditSpecs')?.value || '').trim();
        model.notes = ($('dmEditNotes')?.value || '').trim();
        model.provenance = PROVENANCES.some((entry) => entry.id === $('dmEditProvenance')?.value)
          ? $('dmEditProvenance').value : model.provenance;
        model.updatedAt = new Date().toISOString();
      }, 'Saved the loudspeaker details.');
    });

    $('btnDmDeleteModel')?.addEventListener('click', () => {
      const model = selectedModel();
      if (!model) return;
      if (!window.confirm('Delete “' + model.name + '”?')) return;
      commit(() => {
        project.models = project.models.filter((entry) => entry.id !== model.id);
      }, 'Deleted ' + model.name + '.');
      selectedModelId = null;
      renderAll();
    });

    $('dmAddModel')?.addEventListener('change', renderAddSelects);

    $('btnDmAddSource')?.addEventListener('click', () => {
      const modelSelect = $('dmAddModel');
      const datasetSelect = $('dmAddDataset');
      addSourceFromModel(modelSelect ? modelSelect.value : '', datasetSelect ? datasetSelect.value : '');
    });

    $('btnDmImportFile')?.addEventListener('click', () => $('dmFile')?.click());
    $('dmFile')?.addEventListener('change', (event) => {
      handleFile(event.target);
      event.target.value = '';
    });
    $('btnDmImportCapture')?.addEventListener('click', importFromSaved);
    $('btnDmImportLive')?.addEventListener('click', importLive);
    $('btnDmMapApply')?.addEventListener('click', applyMapping);
    $('btnDmMapCancel')?.addEventListener('click', () => {
      pendingFile = null;
      const block = $('dmMapBlock');
      if (block) block.hidden = true;
      setImportMessage('', false);
    });

    $('dmSourceList')?.addEventListener('click', (event) => {
      const target = event.target.closest('button');
      if (!target) return;
      const data = target.dataset;
      if (data.sourcePick) {
        selectedSourceId = data.sourcePick;
        renderSources();
        renderChain();
        return;
      }
      if (data.mute) {
        const source = project.sources.find((entry) => entry.id === data.mute);
        if (!source) return;
        commit(() => { source.muted = !source.muted; }, '');
      } else if (data.solo) {
        const source = project.sources.find((entry) => entry.id === data.solo);
        if (!source) return;
        commit(() => { source.soloed = !source.soloed; }, '');
      } else if (data.removeSource) {
        commit(() => {
          project.sources = project.sources.filter((entry) => entry.id !== data.removeSource);
        }, 'Removed the source.');
        if (selectedSourceId === data.removeSource) selectedSourceId = null;
        renderAll();
      }
    });

    $('dmSourceList')?.addEventListener('input', (event) => {
      const target = event.target;
      if (target.dataset.sourceGain) {
        sourceField('gain', target.dataset.sourceGain, target.value, true);
      } else if (target.dataset.sourceDelay) {
        sourceField('delay', target.dataset.sourceDelay, target.value, true);
      } else if (target.dataset.sourcePolarity !== undefined && target.tagName === 'SELECT') {
        sourceField('polarity', target.dataset.sourcePolarity, target.value, true);
        renderChain();
      } else if (target.dataset.sourceGroup !== undefined) {
        sourceField('group', target.dataset.sourceGroup, target.value, true);
      }
    });

    $('dmSourceList')?.addEventListener('change', (event) => {
      const target = event.target;
      if (target.dataset.sourceGain) sourceField('gain', target.dataset.sourceGain, target.value, false);
      else if (target.dataset.sourceDelay) sourceField('delay', target.dataset.sourceDelay, target.value, false);
      else if (target.dataset.sourcePolarity !== undefined && target.tagName === 'SELECT') {
        sourceField('polarity', target.dataset.sourcePolarity, target.value, false);
      } else if (target.dataset.sourceGroup !== undefined) {
        sourceField('group', target.dataset.sourceGroup, target.value, false);
      }
    });

    $('dmSourceList')?.addEventListener('input', (event) => {
      if (event.target.dataset.color) {
        layout.colors[event.target.dataset.color] = event.target.value;
        saveLayout();
        renderChart();
      }
    });

    $('btnDmAddGroup')?.addEventListener('click', () => {
      const name = ($('dmGroupName')?.value || '').trim();
      if (!name) {
        say('A group needs a name.', 'err');
        return;
      }
      commit(() => {
        project.groups.push({
          id: 'g-' + Date.now().toString(36),
          name: name.slice(0, 40),
          gainDb: 0,
          delayMs: 0,
          polarity: 'normal',
          muted: false,
        });
      }, 'Added the group “' + name + '”.');
      const field = $('dmGroupName');
      if (field) field.value = '';
    });

    $('dmGroupList')?.addEventListener('input', (event) => {
      const target = event.target;
      const data = target.dataset;
      const group = project.groups.find((entry) => entry.id === (data.groupName || data.groupGain || data.groupDelay || data.groupPolarity));
      if (!group) return;
      if (data.groupName !== undefined) group.name = target.value.slice(0, 40) || group.name;
      else if (data.groupGain !== undefined) group.gainDb = Math.max(-24, Math.min(24, Number(target.value) || 0));
      else if (data.groupDelay !== undefined) group.delayMs = Math.max(-100, Math.min(100, Number(target.value) || 0));
      else if (data.groupPolarity !== undefined) group.polarity = target.value === 'inverted' ? 'inverted' : 'normal';
      opts.persist ? opts.persist(project) : null;
      renderChart();
      renderSummation();
    });

    $('dmGroupList')?.addEventListener('change', (event) => {
      const target = event.target;
      const data = target.dataset;
      const group = project.groups.find((entry) => entry.id === (data.groupName || data.groupGain || data.groupDelay || data.groupPolarity));
      if (!group) return;
      commit(() => {
        if (data.groupName !== undefined) group.name = target.value.slice(0, 40) || group.name;
        else if (data.groupGain !== undefined) group.gainDb = Math.max(-24, Math.min(24, Number(target.value) || 0));
        else if (data.groupDelay !== undefined) group.delayMs = Math.max(-100, Math.min(100, Number(target.value) || 0));
        else if (data.groupPolarity !== undefined) group.polarity = target.value === 'inverted' ? 'inverted' : 'normal';
      }, '');
    });

    $('dmGroupList')?.addEventListener('click', (event) => {
      const data = event.target.closest('button')?.dataset || {};
      if (data.groupMute) {
        const group = project.groups.find((entry) => entry.id === data.groupMute);
        if (!group) return;
        commit(() => { group.muted = !group.muted; }, '');
      } else if (data.removeGroup) {
        commit(() => {
          project.groups = project.groups.filter((entry) => entry.id !== data.removeGroup);
          for (const source of project.sources) {
            if (source.groupId === data.removeGroup) source.groupId = '';
          }
        }, 'Removed the group; its sources keep their own settings.');
      }
    });

    $('btnDmAddPosition')?.addEventListener('click', () => {
      const label = ($('dmPositionName')?.value || '').trim();
      if (!label) {
        say('A measuring position needs a name.', 'err');
        return;
      }
      commit(() => {
        project.positions.push({
          id: 'p-' + Date.now().toString(36),
          label: label.slice(0, 40),
          weight: 1,
        });
      }, 'Added the position “' + label + '”.');
      const field = $('dmPositionName');
      if (field) field.value = '';
    });

    $('dmPositionList')?.addEventListener('input', (event) => {
      const target = event.target;
      if (target.dataset.positionLabel) {
        const position = project.positions.find((entry) => entry.id === target.dataset.positionLabel);
        if (!position) return;
        position.label = target.value.slice(0, 40) || position.label;
        opts.persist ? opts.persist(project) : null;
      } else if (target.dataset.positionWeight) {
        const position = project.positions.find((entry) => entry.id === target.dataset.positionWeight);
        if (!position) return;
        position.weight = Math.max(0, Math.min(1, Number(target.value) || 0));
        opts.persist ? opts.persist(project) : null;
      }
    });

    $('dmPositionList')?.addEventListener('change', (event) => {
      const target = event.target;
      if (target.dataset.positionLabel) {
        const position = project.positions.find((entry) => entry.id === target.dataset.positionLabel);
        if (position) commit(() => { position.label = target.value.slice(0, 40) || position.label; }, '');
      } else if (target.dataset.positionWeight) {
        const position = project.positions.find((entry) => entry.id === target.dataset.positionWeight);
        if (position) commit(() => { position.weight = Math.max(0, Math.min(1, Number(target.value) || 0)); }, '');
      }
    });

    $('dmPositionList')?.addEventListener('click', (event) => {
      const data = event.target.closest('button')?.dataset || {};
      if (data.removePosition) {
        commit(() => {
          project.positions = project.positions.filter((entry) => entry.id !== data.removePosition);
          for (const source of project.sources) {
            if (source.positionDatasets) delete source.positionDatasets[data.removePosition];
          }
          if (project.positions.length && !project.positions.some((entry) => entry.id === project.settings.positionId)) {
            project.settings.positionId = project.positions[0].id;
          }
        }, 'Removed the position.');
      }
    });

    $('dmPositionMatrix')?.addEventListener('change', (event) => {
      const key = event.target.dataset.positionDataset;
      if (!key) return;
      const [sourceId, positionId] = key.split('|');
      const source = project.sources.find((entry) => entry.id === sourceId);
      if (!source) return;
      commit(() => {
        source.positionDatasets = source.positionDatasets || {};
        if (event.target.value) source.positionDatasets[positionId] = event.target.value;
        else delete source.positionDatasets[positionId];
      }, '');
    });

    $('dmView')?.addEventListener('change', () => {
      commit(() => { project.settings.view = $('dmView').value; }, '');
    });
    $('dmPhaseMode')?.addEventListener('change', () => {
      commit(() => { project.settings.phaseMode = $('dmPhaseMode').value; }, '');
    });
    $('dmDbSpan')?.addEventListener('change', () => {
      commit(() => { project.settings.dbSpan = Number($('dmDbSpan').value) || 0; }, '');
    });
    $('dmSmoothing')?.addEventListener('change', () => {
      commit(() => { project.settings.smoothing = Number($('dmSmoothing').value) || 0; }, '');
    });
    $('dmPositionSelect')?.addEventListener('change', () => {
      commit(() => { project.settings.positionId = $('dmPositionSelect').value; }, '');
    });
    $('chkDmIndividual')?.addEventListener('change', () => {
      commit(() => { project.settings.showIndividual = $('chkDmIndividual').checked; }, '');
    });
    $('chkDmSum')?.addEventListener('change', () => {
      commit(() => { project.settings.showSum = $('chkDmSum').checked; }, '');
    });
    $('chkDmPropagation')?.addEventListener('change', () => {
      commit(() => {
        project.settings.propagation = {
          ...(project.settings.propagation || {}),
          enabled: $('chkDmPropagation').checked,
        };
      }, '');
    });
    $('dmRefDistance')?.addEventListener('change', () => {
      commit(() => {
        project.settings.propagation = {
          ...(project.settings.propagation || {}),
          referenceDistanceM: Math.max(0.1, Number($('dmRefDistance').value) || 1),
        };
      }, '');
    });
    $('dmSoundSpeed')?.addEventListener('change', () => {
      commit(() => {
        project.settings.propagation = {
          ...(project.settings.propagation || {}),
          speedOfSound: Math.max(200, Math.min(500, Number($('dmSoundSpeed').value) || SPEED_OF_SOUND)),
        };
      }, '');
    });

    $('dmTraceChips')?.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      const data = button.dataset;
      if (data.traceVisible) {
        layout.visible[data.traceVisible] = !(layout.visible[data.traceVisible] !== false);
        saveLayout();
        renderChart();
      } else if (data.tracePhase) {
        layout.phaseVisible[data.tracePhase] = !(layout.phaseVisible[data.tracePhase] !== false);
        saveLayout();
        renderChart();
      }
    });

    $('dmTraceChips')?.addEventListener('input', (event) => {
      if (event.target.dataset.traceColor) {
        layout.colors[event.target.dataset.traceColor] = event.target.value;
        saveLayout();
        renderChart();
      }
    });

    $('btnDmZoomReset')?.addEventListener('click', () => {
      if (!chart) return;
      chart.resetRange();
      renderViewOptions();
      chart.draw();
    });

    $('btnDmAddFilter')?.addEventListener('click', () => {
      const source = selectedSource();
      if (!source) {
        say('Select a source before adding a filter.', 'err');
        return;
      }
      if (source.filters.length >= 24) {
        say('A chain holds at most 24 filters — remove one first.', 'err');
        return;
      }
      const kind = $('dmFilterKind') ? $('dmFilterKind').value : 'peaking';
      const filter = newFilter(kind, 1000);
      commit(() => { source.filters.push(filter); }, 'Added ' + filterText(filter) + '.');
    });

    $('dmChainList')?.addEventListener('input', (event) => {
      const target = event.target;
      const data = target.dataset;
      if (data.filterEnabled) filterField('enabled', data.filterEnabled, target.checked, true);
      else if (data.filterFrequency) filterField('frequency', data.filterFrequency, target.value, true);
      else if (data.filterGain) filterField('gain', data.filterGain, target.value, true);
      else if (data.filterQ) filterField('q', data.filterQ, target.value, true);
      else if (data.filterKind) filterField('kind', data.filterKind, target.value, true);
    });

    $('dmChainList')?.addEventListener('change', (event) => {
      const target = event.target;
      const data = target.dataset;
      if (data.filterEnabled) filterField('enabled', data.filterEnabled, target.checked, false);
      else if (data.filterFrequency) filterField('frequency', data.filterFrequency, target.value, false);
      else if (data.filterGain) filterField('gain', data.filterGain, target.value, false);
      else if (data.filterQ) filterField('q', data.filterQ, target.value, false);
      else if (data.filterKind) filterField('kind', data.filterKind, target.value, false);
    });

    $('dmChainList')?.addEventListener('click', (event) => {
      const data = event.target.closest('button')?.dataset || {};
      const source = selectedSource();
      if (data.removeFilter) {
        if (!source) return;
        commit(() => {
          source.filters = source.filters.filter((filter) => filter.id !== data.removeFilter);
        }, 'Removed a filter.');
      } else if (data.filterUp && source) {
        const index = source.filters.findIndex((filter) => filter.id === data.filterUp);
        if (index <= 0) return;
        commit(() => {
          const list = source.filters;
          [list[index - 1], list[index]] = [list[index], list[index - 1]];
        }, 'Moved the filter earlier.');
      } else if (data.filterDown && source) {
        const index = source.filters.findIndex((filter) => filter.id === data.filterDown);
        if (index < 0 || index >= source.filters.length - 1) return;
        commit(() => {
          const list = source.filters;
          [list[index + 1], list[index]] = [list[index], list[index + 1]];
        }, 'Moved the filter later.');
      }
    });

    $('btnDmDesignCrossover')?.addEventListener('click', () => {
      const source = selectedSource();
      if (!source) {
        say('Select a source before designing a crossover.', 'err');
        return;
      }
      const result = designCrossover({
        family: $('dmCrossFamily') ? $('dmCrossFamily').value : 'Linkwitz-Riley',
        slope: Number($('dmCrossSlope') ? $('dmCrossSlope').value : 24),
        type: $('dmCrossType') ? $('dmCrossType').value : 'highPass',
        frequency: Number($('dmCrossFrequency') ? $('dmCrossFrequency').value : 80),
        lowFrequency: Number($('dmCrossHigh') && $('dmCrossHigh').value) || 0,
      });
      if (!result.ok) {
        setChainMessage(result.message, true);
        return;
      }
      const room = 24 - source.filters.length;
      if (room <= 0) {
        setChainMessage('The chain is full — remove a filter before designing a crossover.', true);
        return;
      }
      const filters = result.filters.slice(0, room);
      commit(() => { source.filters.push(...filters); },
        'Designed ' + filters.length + ' section(s) into ' + source.name + '.');
      setChainMessage(result.message ||
        'Designed ' + filters.length + ' section(s) — trim each frequency if the cabinets need it.', false);
    });

    $('btnDmBypassChain')?.addEventListener('click', () => {
      const source = selectedSource();
      if (!source) return;
      const anyOn = source.filters.some((filter) => filter.enabled);
      commit(() => {
        for (const filter of source.filters) filter.enabled = !anyOn;
      }, anyOn ? 'Bypassed the chain.' : 'Put the chain back in.');
    });

    $('btnDmClearChain')?.addEventListener('click', () => {
      const source = selectedSource();
      if (!source || !source.filters.length) return;
      if (!window.confirm('Remove all ' + source.filters.length + ' filters from ' + source.name + '?')) return;
      commit(() => { source.filters = []; }, 'Cleared the chain.');
    });

    $('btnDmExportChain')?.addEventListener('click', () => {
      const source = selectedSource();
      if (!source || !source.filters.length) {
        setChainMessage('There is no filter in the chain to export.', true);
        return;
      }
      const text = chainExportText(source.filters, 48000);
      download(text, 'align-model-chain.txt', 'DSP chain');
      setChainMessage('Exported the chain as text and biquads.', false);
    });

    $('btnDmCopyChain')?.addEventListener('click', async () => {
      const source = selectedSource();
      if (!source || !source.filters.length) {
        setChainMessage('There is no filter in the chain to copy.', true);
        return;
      }
      const text = chainExportText(source.filters, 48000);
      try {
        await navigator.clipboard.writeText(text);
        setChainMessage('The chain is on the clipboard.', false);
      } catch (err) {
        setChainMessage('This browser would not let the chain be copied.', true);
      }
    });

    $('btnDmRemoveSource')?.addEventListener('click', () => {
      const source = selectedSource();
      if (!source) return;
      commit(() => {
        project.sources = project.sources.filter((entry) => entry.id !== source.id);
      }, 'Removed ' + source.name + '.');
      selectedSourceId = null;
      renderAll();
    });

    $('btnDmRunOptimizer')?.addEventListener('click', runOptimizer);
    $('btnDmApplyOptimizer')?.addEventListener('click', applyOptimizer);

    $('btnDmCompare')?.addEventListener('click', runComparison);
    $('btnDmClearCompare')?.addEventListener('click', () => {
      comparison = null;
      renderComparison();
      renderChart();
      setCompareMessage('', false);
    });

    $('btnDmSaveSnapshot')?.addEventListener('click', saveSnapshot);
    $('dmSnapshotList')?.addEventListener('click', (event) => {
      const data = event.target.closest('button')?.dataset || {};
      if (data.recall) recallSnapshot(data.recall);
      else if (data.removeSnapshot) {
        commit(() => {
          project.snapshots = project.snapshots.filter((entry) => entry.id !== data.removeSnapshot);
        }, 'Deleted the snapshot.');
      }
    });

    $('btnDmExportCsv')?.addEventListener('click', exportCsv);
    $('btnDmExportFrd')?.addEventListener('click', exportFrd);
    $('btnDmExportReport')?.addEventListener('click', exportReport);

    // A number typed into a field updates the picture at once; the history entry
    // is taken when the field is left, so typing is not forty undo steps.
    workspace.addEventListener('focusin', (event) => {
      if (event.target.matches('input,select')) editSnapshot = JSON.stringify(project);
    });
    workspace.addEventListener('focusout', (event) => {
      if (editSnapshot && event.target.matches('input,select')) {
        const now = JSON.stringify(project);
        if (now !== editSnapshot) {
          pushHistory(editSnapshot);
          opts.persist ? opts.persist(project) : null;
        }
        editSnapshot = null;
      }
    });
  }

  function setChainMessage(message, bad) {
    const line = $('dmChainMessage');
    if (!line) return;
    line.textContent = message || '';
    line.hidden = !message;
    line.classList.toggle('clip-warning', !!bad);
  }

  function addSourceFromModel(modelId, datasetId) {
    const model = project.models.find((entry) => entry.id === modelId);
    if (!model) {
      say('Choose a loudspeaker first.', 'err');
      return;
    }
    const dataset = (model.datasets || []).find((entry) => entry.id === datasetId) || model.datasets[0];
    if (!dataset) {
      say('“' + model.name + '” has no measured response yet — import one first.', 'err');
      return;
    }
    const source = normalizeSource({
      modelId: model.id,
      datasetId: dataset.id,
      name: model.name + (model.datasets.length > 1 ? ' · ' + dataset.label : ''),
    });
    commit(() => { project.sources.push(source); },
      'Added ' + source.name + ' to the model.' + (dataset.hasPhase ? '' : ' It carries no measured phase.'));
    selectedSourceId = source.id;
    renderAll();
  }

  /* ---------- the workspace itself ---------- */

  function open() {
    if (!workspace || active) return;
    active = true;
    workspace.hidden = false;
    buildChart();
    bindCards();
    applyDocks();
    bindEvents();
    renderAll();
    if (typeof opts.onOpen === 'function') opts.onOpen();
    requestAnimationFrame(() => {
      if (chart) {
        chart.resize();
        chart.draw();
      }
    });
  }

  function close() {
    if (!workspace || !active) return;
    active = false;
    workspace.hidden = true;
    if (typeof opts.onClose === 'function') opts.onClose();
    say('Closed the System Data Modeler.', 'ok');
  }

  /* ---------- keeping the library rows in step ---------- */

  function refreshDynamicSources() {
    renderImportSources();
    renderCompareSelect();
  }

  function setProject(next) {
    project = normalizeProject(next);
    renderAll();
  }

  function init() {
    if (!workspace) return;
    const kindSelect = $('dmFilterKind');
    if (kindSelect && !kindSelect.options.length) {
      for (const kind of FILTER_KINDS) {
        const option = document.createElement('option');
        option.value = kind.id;
        option.textContent = kind.label;
        kindSelect.appendChild(option);
      }
      kindSelect.value = 'peaking';
    }
    const familySelect = $('dmCrossFamily');
    if (familySelect && !familySelect.options.length) {
      for (const family of CROSSOVER_FAMILIES) {
        const option = document.createElement('option');
        option.value = family;
        option.textContent = family;
        familySelect.appendChild(option);
      }
      familySelect.value = 'Linkwitz-Riley';
    }
    const slopeSelect = $('dmCrossSlope');
    if (slopeSelect && !slopeSelect.options.length) {
      for (const slope of CROSSOVER_SLOPES) {
        const option = document.createElement('option');
        option.value = String(slope);
        option.textContent = slope + ' dB/oct';
        slopeSelect.appendChild(option);
      }
      slopeSelect.value = '24';
    }
    const objectiveSelect = $('dmOptObjective');
    if (objectiveSelect && !objectiveSelect.options.length) {
      for (const objective of OBJECTIVES) {
        const option = document.createElement('option');
        option.value = objective.id;
        option.textContent = objective.label;
        objectiveSelect.appendChild(option);
      }
      objectiveSelect.value = 'sum';
    }
    const provenanceSelect = $('dmDatasetProvenance');
    if (provenanceSelect && !provenanceSelect.options.length) {
      for (const provenance of PROVENANCES) {
        const option = document.createElement('option');
        option.value = provenance.id;
        option.textContent = provenance.label;
        provenanceSelect.appendChild(option);
      }
      provenanceSelect.value = 'measured';
    }
    const typeSelect = $('dmEditType');
    if (typeSelect && !typeSelect.options.length) {
      for (const type of MODEL_TYPES) {
        const option = document.createElement('option');
        option.value = type;
        option.textContent = type;
        typeSelect.appendChild(option);
      }
      typeSelect.value = 'Custom';
    }
    const editProvenance = $('dmEditProvenance');
    if (editProvenance && !editProvenance.options.length) {
      for (const provenance of PROVENANCES) {
        const option = document.createElement('option');
        option.value = provenance.id;
        option.textContent = provenance.label;
        editProvenance.appendChild(option);
      }
      editProvenance.value = 'measured';
    }
  }

  init();

  return {
    open,
    close,
    get active() { return active; },
    refresh: () => { if (active) renderAll(); },
    refreshSources: () => { if (active) refreshDynamicSources(); },
    get project() { return project; },
    setProject,
    load: (next) => { setProject(next); },
  };
}
