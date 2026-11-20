/*
 * The Custom Speaker Builder screen.
 *
 * It edits one specification at a time, previews the curve, the coverage
 * approximation and the cabinet from that specification, and saves the result
 * into the Data Modeler's own loudspeaker library — so a cabinet built here is
 * immediately available in the Room Designer, with the same datasets, the same
 * gain, delay, polarity and EQ and the same prediction engine as a measured one.
 *
 * The screen adds no simulation of its own: the numbers it draws come from
 * `speaker-builder.js`, and once saved they are read by `model.js` and
 * `acoustics.js` exactly as an imported dataset is.
 */

import {
  ANGLE_PROFILES,
  COVERAGE_MODELS,
  ENCLOSURE_TYPES,
  LENGTH_UNITS,
  MOUNTINGS,
  SPEAKER_TYPES,
  accuracyBadge,
  accuracyOf,
  applySpecToModel,
  buildDatasets,
  crossoversComplete,
  dataSourcesOf,
  equivalentSixDbWidth,
  exportDefinition,
  lengthToMetres,
  metresToLength,
  newCustomSpeakerModel,
  normalizeSpec,
  parseBeamwidthTable,
  parseDefinition,
  pioneerExample,
  sectionBands,
  sensitivityAt1W,
  sensitivityFromVolts,
  sensitivityFromWatts,
  speakerType,
  splFromPower,
  validateSpec,
  widthsAt,
} from './speaker-builder.js';
import { drawBalloonChart, drawCabinetChart, drawPolarChart, drawResponseChart, curveColour } from './builder-chart.js';
import { datasetBalloon, normalizeModel } from './model.js';
import { createGllFromSpec } from './gll.js';
import { clfDiff, clfFromGll, clfResponse, clfToSpec, parseClf, parseGll } from './clf.js';

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function button(label, className, onClick) {
  const node = el('button', className || 'btn', label);
  node.type = 'button';
  if (typeof onClick === 'function') node.addEventListener('click', onClick);
  return node;
}

function field(labelText, control, className) {
  const label = el('label', className || '');
  label.appendChild(el('span', null, labelText));
  label.appendChild(control);
  return label;
}

function numericInput(value, options = {}) {
  const input = el('input', 'dm-number');
  input.type = 'number';
  input.inputMode = 'decimal';
  input.value = value === null || value === undefined || !Number.isFinite(Number(value))
    ? '' : String(value);
  if (options.step !== undefined) input.step = String(options.step);
  if (options.min !== undefined) input.min = String(options.min);
  if (options.max !== undefined) input.max = String(options.max);
  if (options.title) input.title = options.title;
  input.addEventListener('input', () => {
    const raw = input.value.trim();
    options.onChange(raw === '' ? null : Number(raw));
  });
  return input;
}

function textInput(value, maxLength, onChange, placeholder) {
  const input = el('input', 'dm-text');
  input.type = 'text';
  input.value = value === undefined || value === null ? '' : String(value);
  if (maxLength) input.maxLength = maxLength;
  if (placeholder) input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

function selectInput(items, value, onChange) {
  const select = el('select', 'dm-select');
  for (const item of items) {
    const option = document.createElement('option');
    option.value = String(item.value);
    option.textContent = item.label;
    select.appendChild(option);
  }
  select.value = String(value);
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function checkbox(labelText, checked, onChange) {
  const label = el('label', 'chk');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = !!checked;
  input.addEventListener('change', () => onChange(input.checked));
  label.appendChild(input);
  label.appendChild(el('span', null, labelText));
  return label;
}

function group(title) {
  const box = el('div', 'dm-builder-group');
  box.appendChild(el('h5', null, title));
  return box;
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso || '';
  return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function uniqueName(base, models) {
  const taken = new Set((models || []).map((model) => String(model.name || '').toLowerCase()));
  if (!taken.has(String(base || '').toLowerCase())) return base || 'Unnamed loudspeaker';
  let index = 2;
  while (taken.has((base + ' ' + index).toLowerCase())) index += 1;
  return base + ' ' + index;
}

export function createSpeakerBuilder(options = {}) {
  const opts = options || {};
  const container = $('dmBuilder');
  const summaryLine = $('dmBuilderSummary');
  const getProject = typeof opts.getProject === 'function' ? opts.getProject : () => null;
  const commit = typeof opts.commit === 'function' ? opts.commit : (fn) => { if (typeof fn === 'function') fn(); };
  const say = typeof opts.say === 'function' ? opts.say : () => {};
  const getSelectedModelId = typeof opts.getSelectedModelId === 'function' ? opts.getSelectedModelId : () => '';

  let draft = null;
  let editingId = '';
  let unit = 'mm';
  let message = '';
  let messageKind = '';
  let aim = { h: 0, v: 0 };
  let pendingGll = null; // a GLL whose parts are waiting for a choice
  let clfBands = { minHz: null, maxHz: null }; // the span of the grid to write
  let importedClf = null; // the file a round trip is checked against
  let balloonBandHz = 1000; // the band of the balloon drawn as the sphere
  let refs = {};
  let bound = false;

  function setMessage(text, kind) {
    message = text || '';
    messageKind = kind || '';
  }

  function models() {
    const project = getProject();
    return project && Array.isArray(project.models) ? project.models : [];
  }

  function editingModel() {
    return models().find((model) => model.id === editingId) || null;
  }

  function specFromModel(model) {
    if (!model) return null;
    if (model.generic && typeof model.generic === 'object') return normalizeSpec(model.generic);
    const low = model.datasets && model.datasets[0] && Number(model.datasets[0].fMin) > 0
      ? Number(model.datasets[0].fMin) : 60;
    const high = model.datasets && model.datasets[0] && Number(model.datasets[0].fMax) > 0
      ? Number(model.datasets[0].fMax) : 18000;
    return normalizeSpec({
      name: model.name,
      manufacturer: model.manufacturer,
      modelNumber: model.model,
      type: 'custom',
      band: { fMin: low, fMax: high },
      sensitivity: { at1W: model.sensitivityDb, impedanceOhm: model.impedanceOhm },
      sections: [{
        label: 'Section 1',
        band: { fMin: low, fMax: high },
        sensitivityDb: model.sensitivityDb,
        impedanceOhm: model.impedanceOhm,
      }],
      notes: 'Started from the library entry, which carried no entered specification.',
    });
  }

  /* ---------- state changes ---------- */

  function startNew() {
    importedClf = null;
    draft = normalizeSpec({
      type: 'full-range',
      name: uniqueName('New loudspeaker', models()),
      band: { fMin: 60, fMax: 18000 },
      sections: [{ label: 'Full range', band: { fMin: 60, fMax: 18000 } }],
    });
    editingId = '';
    unit = 'mm';
    aim = { h: 0, v: 0 };
    setMessage('Enter the published figures, then save the cabinet to the library.', 'ok');
    render();
  }

  function loadExample() {
    importedClf = null;
    const example = pioneerExample();
    // Loading the example twice must not make a second identical library entry:
    // an existing example is opened for editing instead.
    const existing = models().find((model) => model.name === example.name);
    if (existing) {
      draft = specFromModel(existing);
      editingId = existing.id;
      unit = 'mm';
      aim = { h: 0, v: 0 };
      setMessage('Opened the saved Pioneer XY-3B example for editing. “Update speaker” keeps it as one ' +
        'library entry; “Save as new” makes a copy.', 'ok');
      render();
      return;
    }
    draft = example;
    editingId = '';
    unit = 'mm';
    aim = { h: 0, v: 0 };
    setMessage('Loaded the Pioneer XY-3B starting values supplied by the operator. These are not independently ' +
      'verified manufacturer data and there is no crossover, phase or polar data for them.', 'ok');
    render();
  }

  function edit(modelId) {
    importedClf = null;
    const model = models().find((entry) => entry.id === modelId);
    if (!model) {
      setMessage('Choose a loudspeaker in the library first.', 'err');
      render();
      return;
    }
    draft = specFromModel(model);
    editingId = model.id;
    setMessage(model.generic
      ? 'Editing “' + model.name + '”. Attached measured or manufacturer data is kept.'
      : '“' + model.name + '” had no entered specification; one started from its library figures.', 'ok');
    render();
  }

  function editSelected() {
    edit(getSelectedModelId());
  }

  function addSection() {
    if (!draft) return;
    const index = draft.sections.length;
    const previous = draft.sections[index - 1];
    const low = previous ? Math.round(Math.max(300, Number(previous.band.fMax) / 4)) : 1000;
    draft.sections.push({
      id: 'sec-' + (index + 1) + '-' + Date.now().toString(36),
      label: 'Section ' + (index + 1),
      band: { fMin: low, fMax: draft.band.fMax },
      sensitivityDb: null,
      maxContinuousDb: null,
      maxPeakDb: null,
      powerW: null,
      impedanceOhm: null,
      offsetMs: null,
      phase: 'unknown',
      note: '',
    });
    draft = normalizeSpec(draft);
    render();
  }

  function removeSection(index) {
    if (!draft || draft.sections.length <= 1) return;
    draft.sections.splice(index, 1);
    if (draft.crossovers.length) {
      draft.crossovers.splice(Math.min(index, draft.crossovers.length - 1), 1);
    }
    draft = normalizeSpec(draft);
    render();
  }

  function addResponsePoint() {
    if (!draft) return;
    draft.response.points.push({ hz: 1000, db: 0 });
    draft.response.mode = 'points';
    render();
  }

  function addBeamPoint() {
    if (!draft) return;
    const current = widthsAt(draft, 1000);
    draft.directivity.points.push({ hz: 1000, hDeg: current.hDeg || 90, vDeg: current.vDeg || 60 });
    draft.directivity.model = 'frequency';
    render();
  }

  /** Read a table of band widths, not a polar measurement: the screen says so. */
  function importBeamTable(input) {
    const file = input && input.files && input.files[0];
    if (!file || !draft) return;
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseBeamwidthTable(String(reader.result || ''));
      if (!parsed.ok) {
        setMessage(parsed.message, 'err');
        render();
        return;
      }
      draft.directivity.model = 'frequency';
      draft.directivity.points = parsed.points;
      setMessage(parsed.message, 'ok');
      render();
    };
    reader.onerror = () => {
      setMessage('That file could not be read.', 'err');
      render();
    };
    reader.readAsText(file);
    input.value = '';
  }

  function changeType(value) {
    if (!draft) return;
    draft.type = value;
    const type = speakerType(value);
    // A subwoofer whose coverage has not been entered starts as the
    // omnidirectional approximation, which is the honest default at those
    // frequencies; it can be changed to any width.
    if (type.sub && draft.directivity.model === 'constant' &&
      Number(draft.directivity.hDeg) === 90 && Number(draft.directivity.vDeg) === 60) {
      draft.directivity.model = 'omni';
    }
    if (type.sections > draft.sections.length) {
      while (draft.sections.length < type.sections) {
        const index = draft.sections.length;
        draft.sections.push({
          id: 'sec-' + (index + 1) + '-' + Date.now().toString(36),
          label: type.sectionLabel + ' ' + (index + 1),
          band: { fMin: draft.band.fMin, fMax: draft.band.fMax },
          sensitivityDb: null,
          maxContinuousDb: null,
          maxPeakDb: null,
          powerW: null,
          impedanceOhm: null,
          offsetMs: null,
          phase: 'unknown',
          note: '',
        });
      }
    }
    draft = normalizeSpec(draft);
    render();
  }

  /* ---------- saving ---------- */

  function save(asNew) {
    if (!draft) return;
    const project = getProject();
    if (!project) {
      setMessage('The model project is not available yet.', 'err');
      render();
      return;
    }
    if (asNew) {
      draft.name = uniqueName(draft.name, project.models);
      editingId = '';
    }
    const validation = validateSpec(draft);
    if (validation.errors.length) {
      setMessage(validation.errors[0], 'err');
      render();
      return;
    }

    if (editingId) {
      const id = editingId;
      const before = (project.models || []).find((model) => model.id === id);
      if (!before) {
        editingId = '';
        save(asNew);
        return;
      }
      const done = commit((next) => {
        const model = (next.models || []).find((entry) => entry.id === id);
        if (!model) return;
        applySpecToModel(model, draft, { note: asNew ? 'Duplicated' : 'Updated in the custom speaker builder' });
      }, 'Updated “' + draft.name + '” in the library.');
      if (done === false) {
        setMessage('The speaker was not saved: browser storage is full or blocked. Nothing was changed.', 'err');
        render();
        return;
      }
      const saved = (getProject().models || []).find((model) => model.id === id);
      if (saved && saved.generic) draft = normalizeSpec(saved.generic);
      setMessage('Saved “' + draft.name + '”. It is in the Room Designer’s library now, together with ' +
        (saved ? saved.datasets.length : 0) + ' dataset' + (saved && saved.datasets.length === 1 ? '' : 's') + '.', 'ok');
    } else {
      const model = newCustomSpeakerModel(draft);
      const done = commit((next) => { next.models.unshift(model); },
        'Added “' + model.name + '” to the loudspeaker library.');
      if (done === false) {
        setMessage('The speaker was not saved: browser storage is full or blocked. Nothing was changed.', 'err');
        render();
        return;
      }
      editingId = model.id;
      draft = model.generic ? normalizeSpec(model.generic) : draft;
      setMessage('Saved “' + model.name + '” with ' + model.datasets.length + ' generated dataset' +
        (model.datasets.length === 1 ? '' : 's') + '. It is available in the Room Designer.', 'ok');
    }
    if (typeof opts.onSaved === 'function') opts.onSaved(editingId);
    render();
  }

  function close() {
    draft = null;
    editingId = '';
    setMessage('', '');
    render();
  }

  function restoreRevision(revision) {
    if (!revision || !revision.spec) return;
    draft = normalizeSpec(revision.spec);
    setMessage('Restored the specification saved on ' + formatTime(revision.savedAt) +
      '. Press Update speaker to keep it.', 'ok');
    render();
  }

  function useDataset(dataset) {
    if (!editingId || !dataset) return;
    commit((next) => {
      const model = (next.models || []).find((entry) => entry.id === editingId);
      if (!model) return;
      if (model.generic) model.generic.preferredDatasetId = dataset.id;
      for (const source of next.sources || []) {
        if (source.modelId === editingId) source.datasetId = dataset.id;
      }
    }, 'Prediction now uses “' + dataset.label + '”.');
    render();
  }

  function attach() {
    if (!editingId) return;
    setMessage('Choose a CLF, FRD, TXT, CSV or WAV file to attach as manufacturer or measured data. ' +
      'The entered specification is kept.', 'ok');
    if (typeof opts.attachData === 'function') opts.attachData(editingId);
    else render();
  }

  function exportCurrent() {
    const model = editingModel();
    if (!model) return;
    const json = exportDefinition(model);
    if (!json) {
      setMessage('There is nothing to export from that loudspeaker.', 'err');
      render();
      return;
    }
    const name = (model.name || 'speaker').replace(/[^a-z0-9._ -]+/gi, '').trim().replace(/\s+/g, '-') + '.json';
    if (typeof opts.share === 'function') {
      opts.share(new Blob([json], { type: 'application/json' }), name.toLowerCase(), 'Speaker definition');
      setMessage('Exported the definition as JSON: the entered specification, its datasets and its revisions.', 'ok');
      render();
    } else {
      setMessage('Sharing a file is not available in this browser, so the definition was not exported.', 'err');
      render();
    }
  }

  function exportGll() {
    if (!draft) return;
    const built = createGllFromSpec(draft, { name: draft.name });
    if (!built.ok) {
      setMessage(built.message, 'err');
      render();
      return;
    }
    if (typeof opts.share !== 'function') {
      setMessage('Sharing a file is not available in this browser, so the GLL was not written.', 'err');
      render();
      return;
    }
    const note = 'Wrote ' + built.summary.responses + ' balloon responses on a ' + built.summary.step +
      '° grid across ' + built.summary.bands + ' third-octave bands, ' + built.summary.fromHz + '–' +
      built.summary.toHz + ' Hz. The file carries Align\u2019s beamwidth model, not a measurement, and it is ' +
      'not AFMG-authorised: EASE SpeakerLab is the only tool that compiles and signs a GLL. ' +
      (built.warnings.length ? built.warnings.join('; ') + '. ' : '') +
      'It has not been opened in EASE.';
    opts.share(new Blob([built.bytes], { type: 'application/octet-stream' }), built.fileName, 'GLL loudspeaker');
    setMessage(note, 'ok');
    render();
  }

  /** Convert one part of a GLL to CLF text and hand it to the share sheet. */
  function writeClf(parsed, format, name, partIndex) {
    const built = clfFromGll(parsed, { format, name, sourceIndex: partIndex, bandRange: clfBands });
    if (!built.ok) {
      setMessage(built.message, 'err');
      render();
      return;
    }
    if (typeof opts.share !== 'function') {
      setMessage('Sharing a file is not available in this browser, so the CLF was not written.', 'err');
      render();
      return;
    }
    const part = built.summary.part;
    setMessage('Converted ' + (part.count > 1 ? 'part ' + part.index + ' of ' + part.count + ' ' : '') +
      '\u201c' + built.summary.label + '\u201d to ' + built.summary.format + ': ' +
      built.summary.bands + ' bands ' + built.summary.fromHz + '\u2013' + built.summary.toHz + ' Hz, ' +
      built.summary.azimuths + ' \u00d7 ' + built.summary.rows + ' polar rows, and the 6 dB widths ' +
      'measured from the file\u2019s own balloon. The GLL was read by Align\u2019s own reader, not AFMG\u2019s ' +
      'SDK, so nothing here is AFMG-authorised.' +
      (built.warnings.length ? ' ' + built.warnings.join('; ') + '.' : ''), 'ok');
    opts.share(new Blob([built.text], { type: 'text/plain' }), built.fileName, 'CLF loudspeaker');
    render();
  }

  /** Read a GLL and convert it, asking which part first when it holds several. */
  function convertGllToClf(input, formatSelect) {
    const file = input && input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const format = formatSelect && formatSelect.value === 'clf1' ? 'clf1' : 'clf2';
      const parsed = parseGll(new Uint8Array(reader.result || []));
      if (!parsed.ok) {
        pendingGll = null;
        setMessage(parsed.message, 'err');
        render();
        return;
      }
      const name = draft ? draft.name : file.name;
      if (parsed.sources.length > 1) {
        pendingGll = { parsed, format, name };
        setMessage('That GLL holds ' + parsed.sources.length + ' parts. Choose one: a multi-way set is ' +
          'distributed by the CLF group as one file per part, so each part is written on its own.', 'ok');
        render();
        return;
      }
      pendingGll = null;
      writeClf(parsed, format, name, 0);
    };
    reader.onerror = () => {
      setMessage('That file could not be read.', 'err');
      render();
    };
    reader.readAsArrayBuffer(file);
    input.value = '';
  }

  /** Load a CLF into the builder as a starting specification. */
  function importClfFile(input) {
    const file = input && input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const clf = parseClf(String(reader.result || ''), file.name);
      if (!clf.ok) {
        setMessage(clf.message, 'err');
        render();
        return;
      }
      const imported = clfToSpec(clf, { fileName: file.name });
      if (!imported.ok) {
        setMessage(imported.message, 'err');
        render();
        return;
      }
      draft = normalizeSpec(imported.spec);
      editingId = '';
      unit = 'mm';
      aim = { h: 0, v: 0 };
      importedClf = { clf, fileName: file.name, balloon: clfResponse(clf).balloon || null };
      // The drift is measured now, while the imported file is still the one being
      // compared, so the operator does not have to ask for it to learn it.
      const trip = clfRoundTripReport(clf, draft, file.name);
      setMessage(imported.message + ' ' + trip.text, 'ok');
      render();
    };
    reader.onerror = () => {
      setMessage('That file could not be read.', 'err');
      render();
    };
    reader.readAsText(file);
    input.value = '';
  }

  /**
   * Rebuild this speaker as a GLL, convert that back to CLF and compare it with
   * the file that was imported. The drift is the loss of going round the circle,
   * so it is measured and stated rather than assumed to be zero.
   */
  /** GLL round trip of one CLF file: the drift, or why it could not be checked. */
  function clfRoundTripReport(clf, spec, label) {
    const built = createGllFromSpec(spec, { name: spec.name });
    if (!built.ok) return { ok: false, text: 'A round trip could not be checked: ' + built.message };
    const parsedGll = parseGll(built.bytes);
    if (!parsedGll.ok) return { ok: false, text: 'A round trip could not be checked: ' + parsedGll.message };
    const back = clfFromGll(parsedGll);
    if (!back.ok) return { ok: false, text: 'A round trip could not be checked: ' + back.message };
    const diff = clfDiff(clf, parseClf(back.text, back.fileName));
    if (!diff.ok) return { ok: false, text: diff.message };
    return {
      ok: true,
      text: 'Round trip \u201c' + label + '\u201d \u2192 GLL \u2192 CLF: ' + diff.message +
        ' The widths are measured from each file\u2019s own balloon, so a narrow band moves its width ' +
        'before its level.',
    };
  }

  function checkClfRoundTrip() {
    if (!importedClf || !draft) return;
    const trip = clfRoundTripReport(importedClf.clf, normalizeSpec(draft), importedClf.fileName);
    setMessage(trip.text, trip.ok ? 'ok' : 'err');
    render();
  }

  /** The sphere to draw: the imported file's own, or one kept with the model's dataset. */
  function balloonOf() {
    if (importedClf && importedClf.balloon) return importedClf.balloon;
    const model = editingModel();
    if (!model) return null;
    const preferredId = model.generic && model.generic.preferredDatasetId;
    const dataset = (model.datasets || []).find((entry) => entry.id === preferredId) ||
      (model.datasets || [])[0];
    return dataset ? datasetBalloon(dataset) : null;
  }

  function importFile(input) {
    const file = input && input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseDefinition(String(reader.result || ''));
      if (!parsed.ok) {
        setMessage(parsed.message, 'err');
        render();
        return;
      }
      const model = normalizeModel(parsed.model);
      if (!model.name || (!model.generic && !model.datasets.length)) {
        setMessage('That definition could not be read as a loudspeaker.', 'err');
        render();
        return;
      }
      const done = commit((next) => {
        next.models.unshift(model);
      }, 'Imported “' + model.name + '” from a definition file.');
      if (done === false) {
        setMessage('The definition was read but not added: browser storage is full or blocked.', 'err');
        render();
        return;
      }
      editingId = model.id;
      draft = model.generic ? normalizeSpec(model.generic) : null;
      setMessage(parsed.message + ' Added to the library without touching the loudspeakers already in it.', 'ok');
      if (typeof opts.onSaved === 'function') opts.onSaved(model.id);
      render();
    };
    reader.onerror = () => {
      setMessage('That file could not be read.', 'err');
      render();
    };
    reader.readAsText(file);
    input.value = '';
  }

  /* ---------- the pictures and the derived text ---------- */

  function drawPreviews(computed) {
    if (!refs.response) return;
    const built = buildDatasets(computed);
    const curves = [];
    let index = 0;
    for (const dataset of built.datasets) {
      if (dataset.sectionId === 'cabinet') continue;
      const section = computed.sections.find((entry) => entry.id === dataset.sectionId);
      curves.push({
        label: section ? section.label : dataset.sectionId,
        magDb: dataset.curve.magDb,
        colour: curveColour(index),
      });
      index += 1;
    }
    const combined = built.datasets.find((dataset) => dataset.sectionId === 'cabinet');
    if (combined) curves.push({ label: 'cabinet power sum', magDb: combined.curve.magDb, colour: '#eceef0', dashed: true });
    // Any measured or manufacturer response attached to the same loudspeaker is
    // drawn over the estimate, so the two can be compared before it is used.
    const model = editingModel();
    if (model) {
      for (const dataset of model.datasets || []) {
        if (dataset.generated || !dataset.curve || !Array.isArray(dataset.curve.magDb)) continue;
        curves.push({
          label: dataset.label,
          magDb: dataset.curve.magDb,
          colour: '#e8b84b',
        });
      }
    }
    drawResponseChart(refs.response, { curves, height: 140 });

    const omni = computed.directivity.model === 'omni';
    const widths = widthsAt(computed, 1000);
    drawPolarChart(refs.polar, {
      hDeg: omni ? 0 : widths.hDeg,
      vDeg: omni ? 0 : widths.vDeg,
      profile: computed.directivity.profile,
      referenceDb: computed.directivity.referenceDb,
      height: 140,
    });
    drawCabinetChart(refs.cabinet, {
      widthM: computed.physical.widthM,
      heightM: computed.physical.heightM,
      depthM: computed.physical.depthM,
      colour: computed.physical.colour,
      hDeg: omni ? 0 : widths.hDeg,
      vDeg: omni ? 0 : widths.vDeg,
      acousticCenter: computed.physical.acousticCenter,
      aimH: aim.h,
      aimV: aim.v,
      height: 150,
    });

    const balloon = balloonOf();
    if (refs.balloonBandRow) refs.balloonBandRow.hidden = !balloon;
    if (refs.balloon && refs.balloonNote) {
      refs.balloon.hidden = !balloon;
      refs.balloonNote.hidden = !balloon;
      if (balloon) {
        drawBalloonChart(refs.balloon, {
          balloon, bandHz: balloonBandHz || 1000, rotationDeg: aim.h, height: 220,
        });
      }
    }

    if (refs.combined) {
      refs.combined.textContent = computed.sections.length > 1
        ? (crossoversComplete(computed)
          ? 'Sections are drawn separately and the power sum is dashed. The power sum assumes no crossover phase.'
          : 'Sections are drawn separately. ' + (built.messages.filter(Boolean)[0] || ''))
        : '';
    }
  }

  function derivedText(computed) {
    if (!refs.derived) return;
    refs.derived.replaceChildren();
    const sensitivity = computed.sensitivity;
    const impedance = Number(sensitivity.impedanceOhm) || 8;
    const parts = [];
    if (sensitivity.at1W !== null && sensitivity.at1W !== undefined) {
      const volts = sensitivityFromWatts(sensitivity.at1W, impedance, sensitivity.volts);
      if (Number.isFinite(volts)) {
        parts.push('≈ ' + volts.toFixed(1) + ' dB SPL at 2.83 V / 1 m into ' + impedance + ' Ω');
      }
    }
    if (sensitivity.atVolts !== null && sensitivity.atVolts !== undefined) {
      const watts = sensitivityFromVolts(sensitivity.atVolts, impedance, sensitivity.volts);
      if (Number.isFinite(watts)) {
        parts.push('≈ ' + watts.toFixed(1) + ' dB SPL at 1 W / 1 m');
      }
    }
    if (sensitivity.at1W !== null && sensitivity.at1W !== undefined &&
      Number(computed.output.powerW) > 0) {
      parts.push(splFromPower(sensitivity.at1W, computed.output.powerW).toFixed(1) +
        ' dB from ' + computed.output.powerW + ' W (a calculation, not a rating)');
    }
    for (const [index, section] of computed.sections.entries()) {
      const level = sensitivityAt1W(computed, index);
      const extra = [];
      if (section.maxPeakDb !== null && section.maxPeakDb !== undefined) extra.push('peak ' + section.maxPeakDb + ' dB');
      if (section.maxContinuousDb !== null && section.maxContinuousDb !== undefined) {
        extra.push('continuous ' + section.maxContinuousDb + ' dB');
      }
      parts.push(section.label + ': ' + level.toFixed(1) + ' dB (1 W / 1 m)' +
        (extra.length ? ' · ' + extra.join(' · ') : ''));
    }
    for (const line of parts) refs.derived.appendChild(el('p', 'dm-sub', line));
    refs.derived.appendChild(el('p', 'dm-sub',
      'The 1 W and 2.83 V figures are not interchangeable: the conversion uses the nominal impedance.'));

    if (refs.directivityText) {
      const omni = computed.directivity.model === 'omni';
      if (omni) {
        refs.directivityText.textContent = 'Omnidirectional approximation: aim is stored and drawn but does ' +
          'not change the predicted level.';
      } else {
        const h6 = equivalentSixDbWidth(computed.directivity.hDeg, computed.directivity.profile,
          computed.directivity.referenceDb);
        const v6 = equivalentSixDbWidth(computed.directivity.vDeg, computed.directivity.profile,
          computed.directivity.referenceDb);
        refs.directivityText.textContent = 'Equivalent 6 dB widths: ' + h6.toFixed(1) + '° horizontal / ' +
          v6.toFixed(1) + '° vertical, used by the room prediction. A width is not a polar balloon.';
      }
    }

    if (refs.dimensions) {
      const physical = computed.physical;
      const volume = physical.widthM * physical.heightM * physical.depthM;
      refs.dimensions.textContent = physical.widthM.toFixed(3) + ' × ' + physical.heightM.toFixed(3) + ' × ' +
        physical.depthM.toFixed(3) + ' m · ' + volume.toFixed(3) + ' m³' +
        (physical.weightKg ? ' · ' + physical.weightKg + ' kg' : '') +
        (physical.acousticCenter
          ? ' · acoustic centre offset ' + physical.acousticCenter.xM.toFixed(2) + ' / ' +
            physical.acousticCenter.yM.toFixed(2) + ' / ' + physical.acousticCenter.zM.toFixed(2) + ' m'
          : ' · acoustic centre not entered');
    }
  }

  function updateAccuracy(computed) {
    if (!refs.accuracy) return;
    const model = editingModel();
    const accuracy = accuracyOf(model || { datasets: buildDatasets(computed).datasets, generic: computed });
    refs.accuracy.replaceChildren();
    refs.accuracy.appendChild(el('p', 'dm-builder-accuracy', accuracy.label.toUpperCase()));
    refs.accuracy.appendChild(el('p', 'dm-sub', accuracy.note));
    if (!model) {
      refs.accuracy.appendChild(el('p', 'dm-sub',
        'Nothing is saved yet, so this label describes the specification being entered.'));
    } else {
      refs.accuracy.appendChild(el('p', 'dm-sub', 'Library badge: ' + accuracyBadge(model)));
    }

    const validation = validateSpec(computed);
    const warnings = refs.warnings;
    if (!warnings) return;
    warnings.replaceChildren();
    for (const error of validation.errors) {
      warnings.appendChild(el('p', 'dm-builder-warn dm-builder-error', error));
    }
    for (const warning of validation.warnings) {
      warnings.appendChild(el('p', 'dm-builder-warn', warning));
    }
  }

  function refresh() {
    if (!draft) return;
    const computed = normalizeSpec(draft);
    if (!computed) return;
    derivedText(computed);
    drawPreviews(computed);
    updateAccuracy(computed);
  }

  /* ---------- the form ---------- */

  function identification() {
    const box = group('Identification');
    const grid = el('div', 'dm-builder-row');
    grid.appendChild(field('Loudspeaker name', textInput(draft.name, 80, (value) => {
      draft.name = value;
      refresh();
    })));
    grid.appendChild(field('Manufacturer', textInput(draft.manufacturer, 60, (value) => {
      draft.manufacturer = value;
      refresh();
    })));
    grid.appendChild(field('Model no.', textInput(draft.modelNumber, 60, (value) => {
      draft.modelNumber = value;
      refresh();
    })));
    grid.appendChild(field('Speaker type', selectInput(
      SPEAKER_TYPES.map((entry) => ({ value: entry.id, label: entry.label })),
      draft.type,
      changeType
    )));
    grid.appendChild(field('Number of drivers', numericInput(draft.driverCount, {
      step: 1, min: 1, max: 64, onChange: (value) => { draft.driverCount = value === null ? 1 : value; refresh(); },
    })));
    grid.appendChild(field('Enclosure type', selectInput(
      ENCLOSURE_TYPES.map((entry) => ({ value: entry.id, label: entry.label })),
      draft.enclosure.type,
      (value) => { draft.enclosure.type = value; refresh(); }
    )));
    grid.appendChild(field('Description', textInput(draft.description, 300, (value) => {
      draft.description = value;
    }), 'dm-builder-wide'));
    box.appendChild(grid);

    const type = speakerType(draft.type);
    box.appendChild(el('p', 'dm-sub', type.note));
    box.appendChild(field('Notes', textInput(draft.notes, 400, (value) => {
      draft.notes = value;
    }), 'dm-builder-wide'));
    box.appendChild(el('p', 'dm-sub', 'Library label: ' + draft.labelCaveat));
    return box;
  }

  function frequencyGroup() {
    const box = group('Frequency characteristics');
    const grid = el('div', 'dm-builder-row');
    grid.appendChild(field('Minimum frequency Hz', numericInput(draft.band.fMin, {
      step: 1, min: 10, max: 20000,
      onChange: (value) => { if (value !== null) draft.band.fMin = value; refresh(); },
    })));
    grid.appendChild(field('Maximum frequency Hz', numericInput(draft.band.fMax, {
      step: 1, min: 10, max: 20000,
      onChange: (value) => { if (value !== null) draft.band.fMax = value; refresh(); },
    })));
    grid.appendChild(field('Tolerance ± dB', numericInput(draft.band.toleranceDb, {
      step: 0.5, min: 0, max: 20, onChange: (value) => { draft.band.toleranceDb = value; refresh(); },
    })));
    grid.appendChild(field('LF rolloff dB/oct', numericInput(draft.response.lowSlope, {
      step: 1, min: 6, max: 48,
      onChange: (value) => { if (value !== null) draft.response.lowSlope = value; refresh(); },
    })));
    grid.appendChild(field('HF rolloff dB/oct', numericInput(draft.response.highSlope, {
      step: 1, min: 6, max: 48,
      onChange: (value) => { if (value !== null) draft.response.highSlope = value; refresh(); },
    })));
    grid.appendChild(field('Response model', selectInput([
      { value: 'flat', label: 'Flat nominal + rolloffs' },
      { value: 'points', label: 'With response points' },
    ], draft.response.mode, (value) => { draft.response.mode = value; render(); })));
    box.appendChild(grid);

    const points = el('div', 'dm-builder-points');
    const head = el('div', 'dm-builder-point dm-builder-point-head');
    head.appendChild(el('span', null, 'Sensitivity Hz'));
    head.appendChild(el('span', null, 'dB'));
    head.appendChild(el('span', null, ''));
    points.appendChild(head);
    for (const [index, point] of draft.response.points.entries()) {
      const row = el('div', 'dm-builder-point');
      row.appendChild(numericInput(point.hz, {
        step: 1, min: 10, max: 20000,
        onChange: (value) => { point.hz = value === null ? point.hz : value; refresh(); },
      }));
      row.appendChild(numericInput(point.db, {
        step: 0.5, min: -40, max: 40,
        onChange: (value) => { point.db = value === null ? 0 : value; refresh(); },
      }));
      row.appendChild(button('×', 'dm-mini dm-danger', () => {
        draft.response.points.splice(index, 1);
        render();
      }));
      points.appendChild(row);
    }
    box.appendChild(points);
    const actions = el('div', 'row btns');
    actions.appendChild(button('Add response point', 'dm-mini', addResponsePoint));
    box.appendChild(actions);
    box.appendChild(el('p', 'dm-sub',
      'The generated curve is a theoretical estimate: flat inside the entered range with the entered rolloffs, ' +
      'plus any frequency-dependent sensitivity points you add. The published tolerance is kept and reported, ' +
      'not drawn as ripple. An attached measured or manufacturer response is overlaid in amber.'));
    return box;
  }

  function sensitivityGroup() {
    const box = group('Sensitivity and output');
    const grid = el('div', 'dm-builder-row');
    grid.appendChild(field('Sensitivity dB at 1 W / 1 m', numericInput(draft.sensitivity.at1W, {
      step: 0.5, min: 40, max: 160,
      onChange: (value) => { draft.sensitivity.at1W = value; refresh(); },
    })));
    grid.appendChild(field('Sensitivity dB at 2.83 V / 1 m', numericInput(draft.sensitivity.atVolts, {
      step: 0.5, min: 40, max: 180,
      onChange: (value) => { draft.sensitivity.atVolts = value; refresh(); },
    })));
    grid.appendChild(field('Nominal impedance Ω', numericInput(draft.sensitivity.impedanceOhm, {
      step: 0.1, min: 0.5, max: 64,
      onChange: (value) => { if (value !== null) draft.sensitivity.impedanceOhm = value; refresh(); },
    })));
    grid.appendChild(field('Maximum continuous SPL dB', numericInput(draft.output.maxContinuousDb, {
      step: 0.5, min: 80, max: 180,
      onChange: (value) => { draft.output.maxContinuousDb = value; refresh(); },
    })));
    grid.appendChild(field('Maximum peak SPL dB', numericInput(draft.output.maxPeakDb, {
      step: 0.5, min: 80, max: 190,
      onChange: (value) => { draft.output.maxPeakDb = value; refresh(); },
    })));
    grid.appendChild(field('Maximum input power W', numericInput(draft.output.powerW, {
      step: 1, min: 1, max: 10000,
      onChange: (value) => { draft.output.powerW = value; refresh(); },
    })));
    box.appendChild(grid);
    refs.derived = el('div', 'dm-builder-derived');
    box.appendChild(refs.derived);
    return box;
  }

  function directivityGroup() {
    const box = group('Directivity');
    const grid = el('div', 'dm-builder-row');
    grid.appendChild(field('Coverage model', selectInput(
      COVERAGE_MODELS.map((entry) => ({ value: entry.id, label: entry.label })),
      draft.directivity.model,
      (value) => { draft.directivity.model = value; render(); }
    )));
    grid.appendChild(field('Horizontal dispersion °', numericInput(draft.directivity.hDeg, {
      step: 1, min: 5, max: 360,
      onChange: (value) => { if (value !== null) draft.directivity.hDeg = value; refresh(); },
    })));
    grid.appendChild(field('Vertical dispersion °', numericInput(draft.directivity.vDeg, {
      step: 1, min: 5, max: 360,
      onChange: (value) => { if (value !== null) draft.directivity.vDeg = value; refresh(); },
    })));
    grid.appendChild(field('Width reference dB', selectInput(
      [3, 6, 10, 12].map((value) => ({ value, label: '−' + value + ' dB' })),
      draft.directivity.referenceDb,
      (value) => { draft.directivity.referenceDb = Number(value); refresh(); }
    )));
    grid.appendChild(field('Angular taper', selectInput(
      ANGLE_PROFILES.map((entry) => ({ value: entry.id, label: entry.label })),
      draft.directivity.profile,
      (value) => { draft.directivity.profile = value; refresh(); }
    )));
    grid.appendChild(field('Coverage reference band', textInput(draft.directivity.referenceBand, 60, (value) => {
      draft.directivity.referenceBand = value;
    }, 'e.g. 1–4 kHz')));
    box.appendChild(grid);

    const profile = ANGLE_PROFILES.find((entry) => entry.id === draft.directivity.profile);
    if (profile) box.appendChild(el('p', 'dm-sub', profile.note));
    refs.directivityText = el('p', 'dm-sub');
    box.appendChild(refs.directivityText);

    if (draft.directivity.model === 'frequency') {
      const points = el('div', 'dm-builder-points');
      const head = el('div', 'dm-builder-point dm-builder-point-head');
      head.appendChild(el('span', null, 'Hz'));
      head.appendChild(el('span', null, 'H°'));
      head.appendChild(el('span', null, 'V°'));
      head.appendChild(el('span', null, ''));
      points.appendChild(head);
      for (const [index, point] of draft.directivity.points.entries()) {
        const row = el('div', 'dm-builder-point');
        row.appendChild(numericInput(point.hz, {
          step: 1, min: 10, max: 20000,
          onChange: (value) => { point.hz = value === null ? point.hz : value; refresh(); },
        }));
        row.appendChild(numericInput(point.hDeg, {
          step: 1, min: 5, max: 360,
          onChange: (value) => { point.hDeg = value === null ? point.hDeg : value; refresh(); },
        }));
        row.appendChild(numericInput(point.vDeg, {
          step: 1, min: 5, max: 360,
          onChange: (value) => { point.vDeg = value === null ? point.vDeg : value; refresh(); },
        }));
        row.appendChild(button('×', 'dm-mini dm-danger', () => {
          draft.directivity.points.splice(index, 1);
          render();
        }));
        points.appendChild(row);
      }
      box.appendChild(points);
      box.appendChild(button('Add beamwidth point', 'dm-mini', addBeamPoint));
    }
    const importRow = el('div', 'row btns');
    const beamInput = el('input');
    beamInput.type = 'file';
    beamInput.accept = '.csv,.txt,text/plain,text/csv';
    beamInput.hidden = true;
    beamInput.addEventListener('change', () => importBeamTable(beamInput));
    importRow.appendChild(beamInput);
    importRow.appendChild(button('Import beamwidth table', 'dm-mini', () => beamInput.click()));
    box.appendChild(importRow);
    box.appendChild(el('p', 'dm-sub',
      'A nominal width is not a complete polar response. Until measured or manufacturer polar data is attached, ' +
      'this is an approximation, and the Room Designer labels it as one. A beamwidth table is read as widths per ' +
      'band (Hz, H°, V°); a full 3D balloon is not read here.'));
    return box;
  }

  function physicalGroup() {
    const box = group('Physical and cabinet');
    const unitSelect = el('div', 'dm-builder-row');
    unitSelect.appendChild(field('Length unit', selectInput(
      LENGTH_UNITS.map((entry) => ({ value: entry.id, label: entry.label })),
      unit,
      (value) => { unit = value; render(); }
    )));
    box.appendChild(unitSelect);

    const grid = el('div', 'dm-builder-row');
    const dimension = (labelText, key) => field(labelText + ' (' + unit + ')', numericInput(
      metresToLength(draft.physical[key], unit), {
        step: 0.1, min: 0.01, max: 20000,
        onChange: (value) => {
          const metres = lengthToMetres(value, unit);
          if (Number.isFinite(metres) && metres > 0) draft.physical[key] = metres;
          refresh();
        },
      }
    ));
    grid.appendChild(dimension('Width', 'widthM'));
    grid.appendChild(dimension('Height', 'heightM'));
    grid.appendChild(dimension('Depth', 'depthM'));
    grid.appendChild(field('Weight kg', numericInput(draft.physical.weightKg, {
      step: 0.1, min: 0, max: 2000,
      onChange: (value) => { draft.physical.weightKg = value; refresh(); },
    })));
    grid.appendChild(field('Mounting', selectInput(
      MOUNTINGS.map((entry) => ({ value: entry.id, label: entry.label })),
      draft.physical.mounting,
      (value) => { draft.physical.mounting = value; refresh(); }
    )));
    grid.appendChild(field('Cabinet colour', (() => {
      const input = el('input', 'dm-builder-colour');
      input.type = 'color';
      input.value = draft.physical.colour;
      input.addEventListener('input', () => { draft.physical.colour = input.value; refresh(); });
      return input;
    })()));
    box.appendChild(grid);

    box.appendChild(checkbox('Rotatable horn', draft.physical.rotatableHorn, (checked) => {
      draft.physical.rotatableHorn = checked;
      refresh();
    }));
    box.appendChild(checkbox('Acoustic centre offset known', !!draft.physical.acousticCenter, (checked) => {
      draft.physical.acousticCenter = checked ? { xM: 0, yM: 0, zM: 0 } : null;
      render();
    }));
    if (draft.physical.acousticCenter) {
      const centre = el('div', 'dm-builder-row');
      const offsetField = (labelText, key) => field(labelText, numericInput(
        Number(draft.physical.acousticCenter[key]) || 0, {
          step: 0.01, min: -10, max: 10,
          onChange: (value) => { draft.physical.acousticCenter[key] = value === null ? 0 : value; refresh(); },
        }
      ));
      centre.appendChild(offsetField('Offset X m', 'xM'));
      centre.appendChild(offsetField('Offset Y m', 'yM'));
      centre.appendChild(offsetField('Offset Z m (behind the baffle)', 'zM'));
      box.appendChild(centre);
    }
    refs.dimensions = el('p', 'dm-sub');
    box.appendChild(refs.dimensions);
    return box;
  }

  function sectionsGroup() {
    const box = group('Sections');
    const list = el('div', 'dm-builder-sections');
    for (const [index, section] of draft.sections.entries()) {
      const card = el('div', 'dm-builder-section');
      const head = el('div', 'dm-builder-section-head');
      head.appendChild(textInput(section.label, 40, (value) => {
        section.label = value || ('Section ' + (index + 1));
      }, 'Section label'));
      if (draft.sections.length > 1) {
        head.appendChild(button('Remove', 'dm-mini dm-danger', () => removeSection(index)));
      }
      card.appendChild(head);

      const grid = el('div', 'dm-builder-row');
      grid.appendChild(field('Low Hz', numericInput(section.band.fMin, {
        step: 1, min: 10, max: 20000,
        onChange: (value) => { if (value !== null) section.band.fMin = value; refresh(); },
      })));
      grid.appendChild(field('High Hz', numericInput(section.band.fMax, {
        step: 1, min: 10, max: 20000,
        onChange: (value) => { if (value !== null) section.band.fMax = value; refresh(); },
      })));
      grid.appendChild(field('Sensitivity dB 1 W', numericInput(section.sensitivityDb, {
        step: 0.5, min: 40, max: 160,
        onChange: (value) => { section.sensitivityDb = value; refresh(); },
      })));
      grid.appendChild(field('Max continuous dB', numericInput(section.maxContinuousDb, {
        step: 0.5, min: 80, max: 180,
        onChange: (value) => { section.maxContinuousDb = value; refresh(); },
      })));
      grid.appendChild(field('Max peak dB', numericInput(section.maxPeakDb, {
        step: 0.5, min: 80, max: 190,
        onChange: (value) => { section.maxPeakDb = value; refresh(); },
      })));
      grid.appendChild(field('Power W', numericInput(section.powerW, {
        step: 1, min: 1, max: 10000,
        onChange: (value) => { section.powerW = value; refresh(); },
      })));
      grid.appendChild(field('Impedance Ω', numericInput(section.impedanceOhm, {
        step: 0.1, min: 0.5, max: 64,
        onChange: (value) => { section.impedanceOhm = value; refresh(); },
      })));
      grid.appendChild(field('Acoustic offset ms', numericInput(section.offsetMs, {
        step: 0.01, min: -50, max: 50,
        onChange: (value) => { section.offsetMs = value; refresh(); },
      })));
      card.appendChild(grid);
      card.appendChild(el('p', 'dm-sub',
        'Phase: unknown (a generic model carries none)' +
        (section.offsetMs === null || section.offsetMs === undefined
          ? ' · acoustic offset: not entered' : '')));

      if (index < draft.sections.length - 1) {
        const crossover = draft.crossovers[index] || { hz: null, slopeDbPerOct: 24 };
        const cross = el('div', 'dm-builder-row');
        cross.appendChild(field('Crossover ' + (index + 1) + '→' + (index + 2) + ' Hz', numericInput(crossover.hz, {
          step: 1, min: 10, max: 20000,
          onChange: (value) => {
            while (draft.crossovers.length <= index) {
              draft.crossovers.push({ hz: null, slopeDbPerOct: 24, family: 'Linkwitz-Riley' });
            }
            draft.crossovers[index].hz = value;
            refresh();
          },
        })));
        cross.appendChild(field('Slope dB/oct', selectInput(
          [12, 18, 24, 36, 48].map((value) => ({ value, label: value + ' dB/oct' })),
          crossover.slopeDbPerOct || 24,
          (value) => {
            while (draft.crossovers.length <= index) {
              draft.crossovers.push({ hz: null, slopeDbPerOct: 24, family: 'Linkwitz-Riley' });
            }
            draft.crossovers[index].slopeDbPerOct = Number(value);
            refresh();
          }
        )));
        card.appendChild(cross);
        card.appendChild(el('p', 'dm-sub',
          'A −3 dB knee at the entered crossover frequency. Without a crossover, the sections are never added together.'));
      }
      list.appendChild(card);
    }
    box.appendChild(list);
    box.appendChild(button('Add section', 'dm-mini', addSection));
    if (draft.sections.length > 1) {
      const bands = sectionBands(draft);
      box.appendChild(el('p', 'dm-sub', bands.length + ' sections · each becomes its own library dataset, ' +
        'so a section can be used and processed as its own source when it has to be.'));
    }
    return box;
  }

  function subwooferGroup() {
    const type = speakerType(draft.type);
    if (!type.sub) return null;
    const box = group('Subwoofer configuration');
    const grid = el('div', 'dm-builder-row');
    grid.appendChild(field('Enclosure', selectInput(
      ENCLOSURE_TYPES.map((entry) => ({ value: entry.id, label: entry.label })),
      draft.enclosure.type,
      (value) => { draft.enclosure.type = value; refresh(); }
    )));
    grid.appendChild(field('Driver configuration', textInput(draft.enclosure.drivers, 120, (value) => {
      draft.enclosure.drivers = value;
    }, 'e.g. 2 × 18 in, push-pull')));
    grid.appendChild(field('Port tuning Hz', numericInput(draft.enclosure.portTuningHz, {
      step: 0.5, min: 5, max: 200,
      onChange: (value) => { draft.enclosure.portTuningHz = value; refresh(); },
    })));
    box.appendChild(grid);
    box.appendChild(el('p', 'dm-sub',
      'The enclosure type, the tuning and the dimensions are recorded, not computed into a response. ' +
      'No enclosure response is inferred from them: enter the published frequency range, sensitivity, ' +
      'maximum SPL and response, and replace the approximation with measured data when you have it.'));
    return box;
  }

  function previewGroup() {
    const box = group('Preview');
    const note = el('p', 'dm-sub',
      'Theoretical estimate from the entered figures. The room prediction uses this same curve and directivity; ' +
      'nothing here is a measurement.');
    box.appendChild(note);

    refs.response = el('canvas', 'dm-builder-canvas');
    refs.response.setAttribute('aria-label', 'Generated magnitude response');
    box.appendChild(refs.response);
    refs.combined = el('p', 'dm-sub');
    box.appendChild(refs.combined);

    refs.polar = el('canvas', 'dm-builder-canvas');
    refs.polar.setAttribute('aria-label', 'Horizontal and vertical coverage approximation');
    box.appendChild(refs.polar);
    box.appendChild(el('p', 'dm-sub',
      'Coverage cuts of the approximation: horizontal left–right, vertical top–bottom, 0 dB at the rim to −30 dB.'));

    const aimRow = el('div', 'dm-builder-row');
    aimRow.appendChild(field('Preview aim H °', numericInput(aim.h, {
      step: 1, min: -180, max: 180,
      onChange: (value) => { aim.h = value === null ? 0 : value; refresh(); },
    })));
    aimRow.appendChild(field('Preview aim V °', numericInput(aim.v, {
      step: 1, min: -90, max: 90,
      onChange: (value) => { aim.v = value === null ? 0 : value; refresh(); },
    })));
    box.appendChild(aimRow);

    refs.cabinet = el('canvas', 'dm-builder-canvas tall');
    refs.cabinet.setAttribute('aria-label', 'Cabinet outline, acoustic centre, coverage angle and aim');
    box.appendChild(refs.cabinet);
    box.appendChild(el('p', 'dm-sub',
      'Cabinet geometry from the entered dimensions: outline, front face, acoustic centre, coverage cone and ' +
      'preview aim. Mounting and aim in a room are set in the Room Designer.'));

    refs.balloonBandRow = el('div', 'dm-builder-row');
    refs.balloonBandRow.appendChild(field('Sphere band Hz', numericInput(balloonBandHz, {
      step: 1, min: 20, max: 20000,
      title: 'The band drawn as the sphere: the nearest band the file has is used',
      onChange: (value) => {
        balloonBandHz = value;
        refresh();
      },
    })));
    box.appendChild(refs.balloonBandRow);

    refs.balloon = el('canvas', 'dm-builder-canvas tall');
    refs.balloon.setAttribute('aria-label', 'Imported balloon drawn as a three-dimensional directivity sphere');
    box.appendChild(refs.balloon);
    refs.balloonNote = el('p', 'dm-sub',
      'A balloon from an imported CLF or GLL file, drawn at the band you choose, 1 kHz unless you set another: the radius at each angle is ' +
      'that angle’s level, on the file’s own angular grid, and the preview aim turns it. ' +
      'Without an imported balloon this panel stays hidden, because there is nothing measured to draw.');
    box.appendChild(refs.balloonNote);

    refs.accuracy = el('div', 'dm-builder-accuracy-block');
    box.appendChild(refs.accuracy);
    refs.warnings = el('div', 'dm-builder-warnings');
    box.appendChild(refs.warnings);
    return box;
  }

  function dataGroup() {
    const model = editingModel();
    if (!model) {
      const box = group('Data sources');
      box.appendChild(el('p', 'dm-sub',
        'Save the speaker first, then measured or manufacturer data can be attached beside the entered ' +
        'specification without replacing it.'));
      return box;
    }
    const box = group('Data sources and prediction');
    box.appendChild(el('p', 'dm-sub',
      'The list follows the data-source hierarchy — measured, manufacturer, then the generic estimate — ' +
      'but nothing is replaced automatically. The dataset marked “used for prediction” is the one each source ' +
      'reads until you choose another here.'));

    const rows = dataSourcesOf(model);
    if (!rows.length) {
      box.appendChild(el('p', 'dm-sub', 'No dataset is attached to this loudspeaker yet.'));
    }
    for (const row of rows) {
      const line = el('div', 'dm-builder-source');
      line.appendChild(el('span', 'dm-builder-source-kind', row.kind.toUpperCase()));
      line.appendChild(el('span', 'dm-builder-source-name', row.label));
      const meta = [
        row.hasPhase ? 'phase' : 'magnitude only',
        row.directivity ? row.directivity + ' beamwidth points' : 'no directivity',
        row.preferred ? 'used for prediction' : '',
      ].filter(Boolean).join(' · ');
      line.appendChild(el('span', 'dm-builder-source-meta', meta));
      if (!row.preferred) {
        line.appendChild(button('Use for prediction', 'dm-mini', () => useDataset(row)));
      }
      box.appendChild(line);
    }

    const actions = el('div', 'row btns');
    actions.appendChild(button('Attach measured or manufacturer data', 'dm-mini', attach));
    box.appendChild(actions);
    box.appendChild(el('p', 'dm-sub',
      'A CLF file brings manufacturer beamwidths; an FRD, TXT, CSV or WAV brings a measured response. ' +
      'A GLL file is read by Align’s own reader, not AFMG’s SDK, and only to convert it to CLF.'));

    const revisions = Array.isArray(model.revisions) ? model.revisions : [];
    if (revisions.length) {
      box.appendChild(el('h5', null, 'Revision history'));
      for (const revision of revisions) {
        const line = el('div', 'dm-builder-revision');
        line.appendChild(el('span', 'dm-builder-source-meta', formatTime(revision.savedAt)));
        line.appendChild(el('span', 'dm-builder-source-name', revision.summary || revision.note));
        line.appendChild(button('Restore', 'dm-mini', () => restoreRevision(revision)));
        box.appendChild(line);
      }
    }
    return box;
  }

  function actionsGroup() {
    const box = group('Save and reuse');
    const row = el('div', 'row btns');
    row.appendChild(button(editingId ? 'Update speaker' : 'Save to library', 'btn btn-power', () => save(false)));
    if (editingId) {
      row.appendChild(button('Save as new', 'btn', () => save(true)));
      row.appendChild(button('Export definition', 'btn', exportCurrent));
    }
    row.appendChild(button('Create GLL', 'btn', exportGll));
    row.appendChild(button('Close', 'btn', close));
    box.appendChild(row);

    const fileRow = el('div', 'row btns');
    const importInput = el('input');
    importInput.type = 'file';
    importInput.accept = '.json,application/json,text/plain';
    importInput.hidden = true;
    importInput.addEventListener('change', () => importFile(importInput));
    fileRow.appendChild(importInput);
    fileRow.appendChild(button('Import definition', 'btn', () => importInput.click()));
    fileRow.appendChild(button('Pioneer XY-3B example', 'btn', loadExample));
    box.appendChild(fileRow);

    const clfRow = el('div', 'row btns');
    const gllInput = el('input');
    gllInput.type = 'file';
    gllInput.accept = '.gll';
    gllInput.hidden = true;
    gllInput.addEventListener('change', () => convertGllToClf(gllInput));
    clfRow.appendChild(gllInput);
    const clfFormat = el('select');
    clfFormat.title = 'CLF format written by the converter';
    for (const choice of [['clf2', 'CLF2 \u00b7 1/3 octave'], ['clf1', 'CLF1 \u00b7 octave']]) {
      const option = el('option', null, choice[1]);
      option.value = choice[0];
      clfFormat.appendChild(option);
    }
    clfRow.appendChild(clfFormat);
    clfRow.appendChild(button('Convert GLL to CLF', 'btn', () => convertGllToClf(gllInput, clfFormat)));
    const clfInput = el('input');
    clfInput.type = 'file';
    clfInput.accept = '.cf1,.cf2,.clf,text/plain';
    clfInput.hidden = true;
    clfInput.addEventListener('change', () => importClfFile(clfInput));
    clfRow.appendChild(clfInput);
    clfRow.appendChild(button('Import CLF', 'btn', () => clfInput.click()));
    if (importedClf) clfRow.appendChild(button('Check CLF round trip', 'btn', checkClfRoundTrip));
    box.appendChild(clfRow);

    // The span is not a button: in the button row these fields were squeezed
    // until a four-digit value no longer fitted, so they get their own row.
    const spanRow = el('div', 'dm-builder-row');
    spanRow.appendChild(field('Bands from Hz', numericInput(clfBands.minHz, {
      step: 1, min: 20, max: 40000, title: 'Leave empty to write every band of the grid',
      onChange: (value) => { clfBands.minHz = value; },
    })));
    spanRow.appendChild(field('to Hz', numericInput(clfBands.maxHz, {
      step: 1, min: 20, max: 40000, title: 'Leave empty to write every band of the grid',
      onChange: (value) => { clfBands.maxHz = value; },
    })));
    box.appendChild(spanRow);

    if (pendingGll) {
      const partsRow = el('div', 'row btns');
      partsRow.appendChild(el('span', 'dm-sub', 'Parts in that GLL:'));
      pendingGll.parsed.sources.forEach((source, index) => {
        partsRow.appendChild(button('Part ' + (index + 1) + ' · ' +
          String(source.label || '').slice(0, 28), 'dm-mini', () => {
          const held = pendingGll;
          pendingGll = null;
          writeClf(held.parsed, held.format, held.name, index);
        }));
      });
      box.appendChild(partsRow);
    }
    box.appendChild(el('p', 'dm-sub',
      'A saved speaker is a library entry like any other: add it as a source, place it in the Room Designer, ' +
      'aim it, set gain, delay, polarity and EQ, and predict its coverage with the same engine.'));
    return box;
  }

  function buildForm() {
    const form = el('div', 'dm-builder-form');
    form.appendChild(identification());
    form.appendChild(frequencyGroup());
    form.appendChild(sensitivityGroup());
    form.appendChild(directivityGroup());
    form.appendChild(physicalGroup());
    form.appendChild(sectionsGroup());
    const sub = subwooferGroup();
    if (sub) form.appendChild(sub);
    form.appendChild(previewGroup());
    form.appendChild(dataGroup());
    form.appendChild(actionsGroup());
    return form;
  }

  /* ---------- the card ---------- */

  function render() {
    if (!container) return;
    refs = {};
    container.replaceChildren();

    const actions = el('div', 'row btns');
    actions.appendChild(button('New speaker', 'btn', startNew));
    actions.appendChild(button('Pioneer XY-3B example', 'btn', loadExample));
    const selected = getSelectedModelId();
    const editButton = button('Edit selected', 'btn', editSelected);
    editButton.disabled = !selected;
    editButton.title = selected ? 'Open the selected library entry in the builder' : 'Select a loudspeaker in the library first';
    actions.appendChild(editButton);
    container.appendChild(actions);

    if (summaryLine) {
      const all = models();
      const generic = all.filter((model) => model.generic).length;
      summaryLine.textContent = all.length
        ? all.length + ' loudspeaker' + (all.length === 1 ? '' : 's') + ' in the library · ' + generic +
          ' built from entered specifications'
        : 'Build a loudspeaker from its published specifications';
    }

    if (message) {
      container.appendChild(el('p', messageKind === 'err' ? 'source-hint clip-warning' : 'source-hint', message));
    }

    if (!draft) {
      container.appendChild(el('p', 'dm-empty',
        'No speaker is being built. Start a new one, load the Pioneer XY-3B example, or edit the loudspeaker ' +
        'selected in the library.'));
      return;
    }

    container.appendChild(buildForm());
    refresh();
  }

  function bindResize() {
    if (bound || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    bound = true;
    window.addEventListener('resize', () => {
      if (!draft || !container || !container.offsetParent) return;
      refresh();
    });
  }

  bindResize();

  return {
    render,
    edit,
    editSelected,
    startNew,
    loadExample,
    get draft() { return draft; },
    get editingId() { return editingId; },
    save: (asNew) => save(!!asNew),
    validate: () => validateSpec(draft || {}),
  };
}
