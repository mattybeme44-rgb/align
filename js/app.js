import { AudioEngine } from './audio-engine.js';
import { Analyser, suggestEq } from './analyser.js';
import { TransferChart, ImpulseChart, targetDb, wrapDegrees, TARGET_CURVES } from './charts.js';
import { buildWaterfall, WaterfallChart } from './waterfall.js';
import { FFT } from './fft.js';
import { LiveSpectrograph, microphoneSpectrum } from './spectrograph.js';
import { buildReflections, buildRoomDecay } from './decay.js';
import { buildSpectrogram, SpectrogramChart } from './spectrogram.js';
import { bandReadings, bandSummary, speakerBalance, formatBalanceFrequency, GroupDelayChart } from './bands.js';
import { loadPresets, persistPresets, newPreset, uniqueCopyName, PRESET_LIMIT } from './presets.js';
import { chartImageBlob, reportPdfBlob, shareOrDownload } from './sharing.js';

const $ = (id) => document.getElementById(id);

const engine = new AudioEngine();

let analyser = null;
let micWin = new Float32Array(0);
let refWin = new Float32Array(0);
let rafId = 0;
let lastAnalysis = 0;
let eqTick = 0;
let starting = false;
let allowStartHere = false;
let jitterWarned = false;
let irDrag = null;
let tfDrag = null;
let lastIrRefresh = 0;
let lastWaterfallBuild = 0;
let lastDecayBuild = 0;
let lastSpectrogramBuild = 0;
let lastGroupDelayBuild = 0;
let lastBandBuild = 0;
let spectrogramRebuildTimer = 0;
let drawRaf = 0;
let spectrographKey = '';

const STORAGE = {
  target: 'align.targetCurve',
  calibration: 'align.levelCalibrationDb',
  spl: 'align.showLevelAsSpl',
  saved: 'align.savedMeasurements.v1',
};

const state = {
  running: false,
  demo: false,
  signal: 'pink',
  level: 0.2,
  sineHz: 1000,
  refMode: 'internal',
  micChannel: 0,
  refChannel: 1,
  fftSize: 16384,
  avgSpeed: 45,
  smoothing: 1 / 6,
  normalize: true,
  compensate: true,
  delayEstimate: 0,
  delayLockedAt: 0,
  delayProbedAt: 0,
  delayAuto: true,
  totalDelayMs: 0,
  snapshot: null,
  snapshotB: null,
  peakHold: null,
  peakHoldArmed: false,
  average: null,
  averageArmed: false,
  averagePower: null,
  averageCaptures: 0,
  saved: [],
  overlaidSavedIds: [],
  presets: [],
  appliedPresetId: null,
  groupDelayOpen: false,
  bandOpen: false,
  target: null,
  calibrationDb: 0,
  showSpl: false,
  showSpectrograph: false,
  noiseFloorDb: null,
  noiseHeadroomDb: null,
  checkingNoise: false,
  gate: { enabled: false, startMs: -0.5, widthMs: 20 },
  results: null,
  eq: [],
  cursorFreq: null,
  inputSource: 'auto',
  waterfallOpen: false,
  waterfallRangeMs: 20,
  waterfallAmplitude: 100,
  waterfall: null,
  reflections: [],
  roomDecay: null,
  spectrogramOpen: false,
  spectrogramRangeMs: 50,
  spectrogram: null,
  // The visible span of each chart, null meaning the whole axis.
  tfZoom: null,
  irZoom: null,
  // The impulse graph refreshes at its own rate; analysis and meters stay live.
  irRefreshSeconds: 1,
  irHeld: false,
  displayedImpulse: null,
};

/* ---------- storage ---------- */

function readString(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw;
  } catch (err) {
    return fallback;
  }
}

function readNumber(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  } catch (err) {
    return fallback;
  }
}

function write(key, value) {
  try {
    if (value === null || value === '') window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, String(value));
  } catch (err) {
    /* private browsing: the app still works, it just forgets */
  }
}

/* ---------- the capture library's stored format ---------- */

// Everything new is saved at this schema; an older entry is filled in and
// written back on the first launch, keeping its magnitude curve.
const SAVED_SCHEMA = 2;

function captureId() {
  return 'm' + Date.now().toString(36) + '-' + Math.random().toString(16).slice(2);
}

function clampPreviewDelay(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return 0;
  return Math.max(-20, Math.min(20, Math.round(value * 20) / 20));
}

/** A uniform array of finite numbers, or null when the data is unusable. */
function numericArray(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const numbers = value.map((entry) => Number(entry));
  return numbers.every((entry) => Number.isFinite(entry)) ? numbers : null;
}

/** Fill in a stored capture's missing fields without dropping the entry. */
function normalizeSavedItem(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const date = typeof source.date === 'string' && !Number.isNaN(new Date(source.date).getTime())
    ? source.date
    : new Date().toISOString();
  const name = typeof source.name === 'string' && source.name.trim()
    ? source.name.trim().slice(0, 80)
    : 'Untitled capture';
  const curve = numericArray(source.curve) || [];
  const phase = numericArray(source.phase);
  const phaseCoherence = numericArray(source.phaseCoherence);
  const phaseCapable = !!(phase && phaseCoherence);
  const fftSize = Number(source.fftSize);
  const sampleRate = Number(source.sampleRate);
  const delayMs = Number(source.delayMs);
  const coherence = Number(source.coherence);
  const polarity = source.polarity === 'normal' || source.polarity === 'inverted'
    ? source.polarity
    : 'unknown';
  const gate = source.gate && typeof source.gate === 'object'
    ? {
        enabled: !!source.gate.enabled,
        startMs: Number.isFinite(Number(source.gate.startMs)) ? Number(source.gate.startMs) : -0.5,
        widthMs: Number.isFinite(Number(source.gate.widthMs)) ? Number(source.gate.widthMs) : 20,
      }
    : null;

  return {
    ...source,
    schema: SAVED_SCHEMA,
    id: typeof source.id === 'string' && source.id ? source.id : captureId(),
    name,
    date,
    source: typeof source.source === 'string' ? source.source : '',
    delayMs: Number.isFinite(delayMs) ? delayMs : 0,
    coherence: Number.isFinite(coherence) ? Math.max(0, Math.min(1, coherence)) : 0,
    polarity,
    fftSize: Number.isFinite(fftSize) && fftSize > 0 ? Math.round(fftSize) : 0,
    sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 0,
    smoothing: typeof source.smoothing === 'string' ? source.smoothing : '',
    reference: typeof source.reference === 'string' ? source.reference : '',
    note: typeof source.note === 'string' ? source.note.slice(0, 160) : '',
    curve,
    phase: phaseCapable ? phase : null,
    phaseCoherence: phaseCapable ? phaseCoherence : null,
    phaseCompensated: !!source.phaseCompensated,
    previewDelayMs: clampPreviewDelay(source.previewDelayMs),
    gate,
  };
}

function loadSaved() {
  let items = [];

  try {
    const raw = window.localStorage.getItem(STORAGE.saved);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      setStatus('Saved captures could not be read — storage does not hold a capture list', 'err');
      return [];
    }
    items = parsed;
  } catch (err) {
    setStatus('Saved captures could not be read from this browser', 'err');
    return [];
  }

  const migrated = items.map(normalizeSavedItem);
  // A magnitude-only capture from the old format is kept as it is, and the
  // upgraded list is written back once so the next launch has the new fields.
  if (items.some((item) => !item || item.schema !== SAVED_SCHEMA)) {
    persistSaved(migrated);
  }
  return migrated;
}

/** Storage trouble is shown beside the list, since the sheet covers the status pill. */
function setLibraryError(message) {
  const el = $('savedError');
  if (!el) return;
  el.textContent = message || '';
  el.hidden = !message;
}

function persistSaved(items = state.saved) {
  try {
    window.localStorage.setItem(STORAGE.saved, JSON.stringify(items));
    setLibraryError('');
    return true;
  } catch (err) {
    const message = 'Could not save the capture library — browser storage is full or blocked. Nothing was changed.';
    setStatus(message, 'err');
    setLibraryError(message);
    return false;
  }
}

state.saved = loadSaved();
state.presets = loadPresets();
state.target = readString(STORAGE.target, '') || null;
state.calibrationDb = readNumber(STORAGE.calibration, 0);
state.showSpl = readString(STORAGE.spl, '0') === '1';

const tfChart = new TransferChart($('tfChart'));
const irChart = new ImpulseChart($('irChart'));
const wfChart = new WaterfallChart($('wfChart'));
const liveSpectrograph = new LiveSpectrograph($('spectrographChart'));
const spectrogramChart = new SpectrogramChart($('spectrogramChart'));
const groupDelayChart = new GroupDelayChart($('groupChart'));

/* ---------- chart spans ---------- */

function frequencyLabel(frequency) {
  return frequency >= 1000
    ? (frequency / 1000).toFixed(2) + ' kHz'
    : frequency.toFixed(0) + ' Hz';
}

function signedMs(value) {
  return (value >= 0 ? '+' : '') + value.toFixed(2);
}

function updateTfSpan() {
  const range = state.tfZoom || { min: 20, max: 20000 };
  $('tfSpan').textContent =
    'showing ' + frequencyLabel(range.min) + ' – ' + frequencyLabel(range.max) + ' · drag to zoom';
  $('btnTfReset').hidden = !state.tfZoom;
}

function updateIrSpan() {
  const range = state.irZoom || { min: -5, max: 55 };
  $('irSpan').textContent =
    'showing ' + range.min.toFixed(1) + ' – ' + range.max.toFixed(1) + ' ms · drag to zoom';
  $('btnIrReset').hidden = !state.irZoom;
}

function updateIrHoldButton() {
  const button = $('btnIrHold');
  if (!button) return;
  const label = state.irHeld ? 'Resume' : 'Hold';
  if (button.textContent !== label) button.textContent = label;
  button.disabled = !state.displayedImpulse;
}

function updatePhaseToggleState() {
  const on = $('chkPhase').checked;
  $('chkPhaseA').disabled = !on;
  $('chkPhaseB').disabled = !on;
  $('capturePhaseRow').classList.toggle('dimmed', !on);
}

function setTfZoom(lower, upper) {
  if (!(upper / lower >= 1.08)) return;
  state.tfZoom = { min: Math.max(20, lower), max: Math.min(20000, upper) };
  state.cursorFreq = null;
  updateCursorReadout();
  updateTfSpan();
  draw();
}

function resetTfZoom() {
  state.tfZoom = null;
  state.cursorFreq = null;
  updateCursorReadout();
  updateTfSpan();
  draw();
}

function setIrZoom(lower, upper) {
  if (!(upper - lower >= 1)) return;
  state.irZoom = { min: lower, max: upper };
  updateIrSpan();
  draw();
}

function resetIrZoom() {
  state.irZoom = null;
  updateIrSpan();
  draw();
}

/** The impulse graph only takes a new frame at its display rate, unless held. */
function syncDisplayedImpulse() {
  if (!state.results) {
    state.displayedImpulse = null;
    state.irHeld = false;
    updateIrHoldButton();
    return;
  }
  if (state.irHeld) return;

  const now = performance.now();
  if (!state.displayedImpulse || now - lastIrRefresh >= state.irRefreshSeconds * 1000) {
    state.displayedImpulse = state.results;
    lastIrRefresh = now;
  }
  updateIrHoldButton();
}

function toggleIrHold() {
  state.irHeld = !state.irHeld;
  if (!state.irHeld) {
    state.displayedImpulse = state.results;
    lastIrRefresh = performance.now();
  }
  updateIrHoldButton();
  draw();
}

/* ---------- status and sharing ---------- */

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.title = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function showAudioHelp(message) {
  const banner = $('audioHelp');
  const text = $('audioHelpText');
  if (!banner || !text) return;
  text.textContent = message;
  banner.hidden = false;
}

function hideAudioHelp() {
  const banner = $('audioHelp');
  if (banner) banner.hidden = true;
}

function updateSheetLock() {
  const open = !$('savedSheet').hidden || !$('waterfallSheet').hidden ||
    !$('meterSheet').hidden || !$('spectrogramSheet').hidden ||
    !$('groupSheet').hidden || !$('bandSheet').hidden || !$('presetsSheet').hidden;
  document.body.classList.toggle('sheet-open', open);
}

function closeSheet(id) {
  const sheet = $(id);
  if (sheet) sheet.hidden = true;
  updateSheetLock();
}

function showSafariBanner() {
  const banner = $('safariBanner');
  if (!banner) return;
  const address = publicAddress();
  const field = $('safariUrl');
  if (field) field.value = address;
  const link = $('openInSafari');
  if (link) link.href = address;

  // A card at the top of the page, not a wall over it: the app still works in
  // this browser — the demo needs no microphone — and hiding everything behind
  // a notice made the page feel broken.
  banner.classList.remove('overlay');
  banner.hidden = false;
}

function hideSafariBanner() {
  const banner = $('safariBanner');
  if (banner) {
    banner.hidden = true;
    banner.classList.remove('overlay');
  }
  updateSheetLock();
}

const INSTALL_HINT_KEY = 'align.install-hint-dismissed';

function isIOS() {
  const ua = navigator.userAgent || '';
  return (
    /\b(iPhone|iPad|iPod)\b/.test(ua) ||
    (/\bMacintosh\b/.test(ua) && (navigator.maxTouchPoints || 0) > 1)
  );
}

/** Launched from a Home Screen icon rather than opened as a browser tab. */
function isStandalone() {
  if (navigator.standalone === true) return true;
  return !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
}

function isLikelyInAppBrowser() {
  if (!isIOS() || isStandalone()) return false;
  const ua = navigator.userAgent || '';
  if (/Safari\//.test(ua) || /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) return false;
  return true;
}

function showPreviewNote() {
  const note = $('previewNote');
  const host = $('previewHost');
  if (host) host.textContent = window.location.hostname;
  if (note) note.hidden = false;
}

function isPrivatePreview() {
  return /--preview\./.test(window.location.hostname);
}

const PUBLIC_URL = 'https://mattybeme44-rgb.github.io/align/';

function publicAddress() {
  return isPrivatePreview() ? PUBLIC_URL : window.location.href;
}

async function copyText(text, fieldId) {
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard');
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    const field = $(fieldId);
    if (field) {
      field.value = text;
      field.select();
      field.setSelectionRange(0, text.length);
    }
    return false;
  }
}

async function copyLink() {
  const copied = await copyText(publicAddress(), 'safariUrl');
  setStatus(
    copied ? 'link copied — paste it into Safari' : 'link ready below — copy it into Safari',
    copied ? 'ok' : 'err',
  );
}

const SHARE_TITLE = 'Align — loudspeaker measurement';
const SHARE_INTRO =
  'Align measures a loudspeaker from a phone: transfer function, delay finder, ' +
  'coherence and EQ suggestions, all on the device.';

async function shareOrCopy(payload, label) {
  if (navigator.share && window.isSecureContext) {
    try {
      await navigator.share(payload);
      setStatus(label + ' shared', 'ok');
      return;
    } catch (err) {
      // Closing the sheet is a decision, not a failure: leave it there.
      if (err && err.name === 'AbortError') return;
    }
  }

  const copied = await copyText(payload.copy || payload.url || payload.text, 'shareField');
  setStatus(
    copied ? label + ' copied — paste it anywhere' : label + ' is in the Share card below',
    copied ? 'ok' : 'err',
  );
}

function shareApp() {
  const url = publicAddress();
  return shareOrCopy(
    {
      title: SHARE_TITLE,
      text: SHARE_INTRO + ' Open the link in Safari, then Share → Add to Home Screen.',
      url,
      copy: url,
    },
    'link',
  );
}

/** What is on screen, as a few lines somebody can read in a message. */
function measurementText(res) {
  const lines = ['Align measurement'];
  lines.push('Delay ' + state.totalDelayMs.toFixed(2) + ' ms');
  if (res.polarityKnown) {
    lines.push('Polarity ' + (res.polarity > 0 ? 'normal' : 'inverted'));
  }
  lines.push('Coherence ' + (meanCoherence(res) * 100).toFixed(0) + '%');
  lines.push(
    (res.sampleRate / 1000).toFixed(1) +
      ' kHz · FFT ' +
      res.fftSize +
      ' · ' +
      res.df.toFixed(1) +
      ' Hz bins',
  );
  if (res.gated) {
    lines.push(
      'Gated ' +
        state.gate.startMs.toFixed(1) +
        '–' +
        (state.gate.startMs + state.gate.widthMs).toFixed(1) +
        ' ms',
    );
  }
  if (state.snapshot) {
    lines.push('Δ vs A ' + (state.totalDelayMs - state.snapshot.delayMs).toFixed(2) + ' ms');
  }
  if (state.snapshotB) {
    lines.push('Δ vs B ' + (state.totalDelayMs - state.snapshotB.delayMs).toFixed(2) + ' ms');
  }
  if (state.eq.length > 0) {
    const bands = state.eq.map((item) => {
      const freq =
        item.freq >= 1000 ? (item.freq / 1000).toFixed(1) + ' kHz' : item.freq.toFixed(0) + ' Hz';
      return freq + ' ' + (item.gain > 0 ? '+' : '') + item.gain.toFixed(1) + ' dB';
    });
    lines.push('EQ: ' + bands.join(', '));
  }
  return lines.join('\n');
}

function shareMeasurement() {
  const res = state.results;
  if (!res) {
    setStatus('nothing to share yet — start a measurement first', 'err');
    return;
  }
  const text = measurementText(res);
  return shareOrCopy(
    {
      title: 'Align measurement · ' + state.totalDelayMs.toFixed(2) + ' ms',
      text,
      url: publicAddress(),
      copy: text + '\n\n' + publicAddress(),
    },
    'measurement',
  );
}

async function copyAppLink() {
  const copied = await copyText(publicAddress(), 'shareField');
  setStatus(
    copied ? 'link copied — paste it anywhere' : 'link is in the Share card below',
    copied ? 'ok' : 'err',
  );
}

async function copyMeasurement() {
  const res = state.results;
  if (!res) {
    setStatus('nothing to copy yet — start a measurement first', 'err');
    return;
  }
  const copied = await copyText(measurementText(res) + '\n\n' + publicAddress(), 'shareField');
  setStatus(
    copied ? 'measurement copied — paste it anywhere' : 'measurement is in the Share card below',
    copied ? 'ok' : 'err',
  );
}

function smoothingLabel() {
  const select = $('selSmooth');
  return select && select.selectedOptions.length ? select.selectedOptions[0].textContent : '—';
}

function referenceLabel() {
  if (state.demo) return 'Demo measurement';
  const select = $('selRef');
  return select && select.selectedOptions.length ? select.selectedOptions[0].textContent : 'generated';
}

/* ---------- CSV ---------- */

function measurementCSV(res) {
  const lines = [];
  lines.push('# Align measurement');
  lines.push('# Sample rate,' + res.sampleRate);
  lines.push('# FFT size,' + res.fftSize);
  lines.push('# Smoothing,' + smoothingLabel());
  lines.push('# Delay ms,' + state.totalDelayMs.toFixed(3));
  lines.push('# Polarity,' + (res.polarityKnown ? (res.polarity > 0 ? 'normal' : 'inverted') : 'unknown'));
  lines.push(
    '# Gate,' +
      (res.gated
        ? state.gate.startMs.toFixed(1) + ' to ' + (state.gate.startMs + state.gate.widthMs).toFixed(1) + ' ms'
        : 'off'),
  );
  lines.push('Frequency (Hz),Magnitude (dB),Phase (deg),Coherence,Impulse (dB)');

  for (let k = 0; k < res.bins; k++) {
    lines.push(
      [
        (k * res.df).toFixed(2),
        res.magDb[k].toFixed(3),
        res.phaseDeg[k].toFixed(2),
        res.coh[k].toFixed(4),
        res.irDb[Math.min(res.fftSize - 1, k)].toFixed(2),
      ].join(','),
    );
  }
  return lines.join('\n');
}

function exportCSV() {
  const res = state.results;
  if (!res) {
    setStatus('nothing to export yet — start a measurement first', 'err');
    return;
  }

  const blob = new Blob([measurementCSV(res)], { type: 'text/csv' });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'align-' + stamp + '.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  setStatus('CSV ready — check Files or your downloads', 'ok');
}

/* ---------- chart image and report ---------- */

function reportFact(label, value) {
  return [label, value || '—'];
}

function reportSettings(res) {
  return [
    reportFact('FFT', String(state.fftSize)),
    reportFact('Smoothing', smoothingLabel()),
    reportFact('Averaging', state.avgSpeed + '%'),
    reportFact('Gate', state.gate.enabled
      ? state.gate.startMs.toFixed(1) + '–' + (state.gate.startMs + state.gate.widthMs).toFixed(1) + ' ms'
      : 'off'),
    reportFact('Signal', SIGNAL_NAMES[state.signal] || state.signal),
    reportFact('Level', Math.round(state.level * 100) + '%'),
    reportFact('Reference', referenceLabel()),
    reportFact('Sampling', (res.sampleRate / 1000).toFixed(1) + ' kHz'),
    reportFact('Calibration', state.calibrationDb.toFixed(1) + ' dB'),
    reportFact('Offset', Number($('numDelay').value || 0).toFixed(2) + ' ms'),
  ];
}

async function shareChartImage() {
  const res = state.results;
  if (!res) {
    setStatus('nothing to share yet — start a measurement first', 'err');
    return;
  }

  try {
    const footer = 'delay ' + state.totalDelayMs.toFixed(2) + ' ms · coherence ' +
      (meanCoherence(res) * 100).toFixed(0) + '%';
    const blob = await chartImageBlob(tfChart.canvas, footer);
    if (!blob) {
      setStatus('could not render the chart image', 'err');
      return;
    }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const result = await shareOrDownload(blob, 'align-chart-' + stamp + '.png', 'Align chart');
    if (result === 'shared') setStatus('chart image shared', 'ok');
    else if (result === 'downloaded') setStatus('chart image downloaded — check your downloads', 'ok');
    else setStatus('chart image ready');
  } catch (err) {
    setStatus('could not share the chart image' + (err && err.message ? ': ' + err.message : ''), 'err');
  }
}

async function shareReport() {
  const res = state.results;
  if (!res) {
    setStatus('nothing to report yet — start a measurement first', 'err');
    return;
  }

  try {
    const facts = [
      reportFact('Delay', state.totalDelayMs.toFixed(2) + ' ms'),
      reportFact('Polarity', res.polarityKnown ? (res.polarity > 0 ? 'normal' : 'inverted') : '—'),
      reportFact('Coherence', (meanCoherence(res) * 100).toFixed(0) + '%'),
      reportFact('Input', levelReadout()),
      reportFact('RT60', state.roomDecay && Number.isFinite(state.roomDecay.overall)
        ? state.roomDecay.overall.toFixed(2) + ' s'
        : '—'),
      reportFact('FFT', String(state.fftSize)),
      reportFact('Rate', (res.sampleRate / 1000).toFixed(1) + ' kHz'),
      reportFact('Gate', state.gate.enabled
        ? state.gate.startMs.toFixed(1) + '–' + (state.gate.startMs + state.gate.widthMs).toFixed(1) + ' ms'
        : 'off'),
      reportFact('Reference', referenceLabel()),
    ];

    const eqLines = state.eq.length
      ? state.eq.map((item) => {
          const freq = item.freq >= 1000
            ? (item.freq / 1000).toFixed(1) + ' kHz'
            : item.freq.toFixed(0) + ' Hz';
          return freq + ' ' + (item.gain > 0 ? '+' : '') + item.gain.toFixed(1) + ' dB';
        })
      : ['Within ±3 dB of the local average.'];

    const blob = await reportPdfBlob({
      chartCanvas: tfChart.canvas,
      dateText: new Date().toLocaleString([], {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      }),
      facts,
      eqLines,
      settings: reportSettings(res),
    });

    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const result = await shareOrDownload(blob, 'align-report-' + stamp + '.pdf', 'Align report');
    if (result === 'shared') setStatus('report shared', 'ok');
    else if (result === 'downloaded') setStatus('report downloaded — check your downloads', 'ok');
    else setStatus('report ready');
  } catch (err) {
    setStatus('could not build the report' + (err && err.message ? ': ' + err.message : ''), 'err');
  }
}

/* ---------- install hint ---------- */

function showInstallHint() {
  const card = $('installCard');
  if (!card) return;

  let dismissed = false;
  try {
    dismissed = window.localStorage.getItem(INSTALL_HINT_KEY) === '1';
  } catch (err) {
    dismissed = false;
  }
  if (!dismissed) card.hidden = false;
}

/* ---------- demo measurement ---------- */

const DEMO_RATE = 48000;
const DEMO_DELAY_MS = 3.7;

let demoRaf = 0;
let demoLast = 0;
let demoSeed = 12345;
let demoFft = null;
let demoHre = null;
let demoHim = null;
let demoRef = null;
let demoMic = null;
let demoXr = null;
let demoXi = null;
let demoMr = null;
let demoMi = null;
let demoLevel = 0.05;

function nextNoise() {
  demoSeed = (demoSeed * 1664525 + 1013904223) >>> 0;
  return demoSeed / 2147483648 - 1;
}

function demoTransfer(n) {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const df = DEMO_RATE / n;
  const delay = Math.round((DEMO_DELAY_MS / 1000) * DEMO_RATE);

  for (let k = 0; k <= n / 2; k++) {
    const f = Math.max(k * df, 1);
    let db = 0;
    db += 3 * Math.exp(-Math.pow(Math.log2(f / 55) / 1.2, 2));
    db -= 4 * Math.exp(-Math.pow(Math.log2(f / 260) / 0.5, 2));
    db += 2.5 * Math.exp(-Math.pow(Math.log2(f / 2400) / 0.7, 2));
    if (f > 14000) db -= ((f - 14000) / 6000) * 12;

    const mag = Math.pow(10, db / 20);
    const phi = (-2 * Math.PI * k * delay) / n;
    re[k] = mag * Math.cos(phi);
    im[k] = mag * Math.sin(phi);

    if (k > 0 && k < n / 2) {
      re[n - k] = re[k];
      im[n - k] = -im[k];
    }
  }
  return { re, im };
}

function demoFrame() {
  const n = state.fftSize;

  if (!demoFft || demoFft.size !== n) {
    demoFft = new FFT(n);
    const transfer = demoTransfer(n);
    demoHre = transfer.re;
    demoHim = transfer.im;
    demoRef = new Float32Array(n);
    demoMic = new Float32Array(n);
    demoXr = new Float64Array(n);
    demoXi = new Float64Array(n);
    demoMr = new Float64Array(n);
    demoMi = new Float64Array(n);
  }

  if (!analyser || analyser.fftSize !== n || analyser.sampleRate !== DEMO_RATE) {
    analyser = new Analyser(n, DEMO_RATE);
    analyser.updateRate = averagingRate();
    state.results = null;
  }

  const ref = demoRef;
  const mic = demoMic;
  const xr = demoXr;
  const xi = demoXi;
  const mr = demoMr;
  const mi = demoMi;

  for (let i = 0; i < n; i++) {
    xr[i] = nextNoise();
    xi[i] = 0;
    ref[i] = xr[i];
  }
  demoFft.forward(xr, xi);

  for (let k = 0; k < n; k++) {
    mr[k] = xr[k] * demoHre[k] - xi[k] * demoHim[k];
    mi[k] = xr[k] * demoHim[k] + xi[k] * demoHre[k];
  }
  demoFft.inverse(mr, mi);

  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = mr[i] * 0.25 + nextNoise() * 0.006;
    mic[i] = v;
    sum += v * v;
  }
  demoLevel = Math.sqrt(sum / n);

  analyser.updateRate = averagingRate();
  analyser.accumulate(mic, ref);

  const res = analyser.results({
    compensate: state.compensate,
    smoothing: state.smoothing,
    normalize: state.normalize,
    gate: state.gate,
  });

  state.results = res;
  if (state.peakHoldArmed) state.peakHold = mergePeakHold(state.peakHold, res);
  syncDisplayedImpulse();
  updateReadouts(res);
  updateInterfaceInfo();
  refreshRoomInsights(false);

  eqTick += 1;
  if (eqTick % 3 === 0) updateEq(res);

  if (state.showSpectrograph) liveSpectrograph.add(microphoneSpectrum(mic, DEMO_RATE));
  refreshWaterfall(false);
  draw();
}

function demoLoop(now) {
  if (!state.demo) {
    demoRaf = 0;
    return;
  }
  demoRaf = requestAnimationFrame(demoLoop);
  if (document.hidden) return;
  const interval = state.fftSize >= 32768 ? 320 : 160;
  if (now - demoLast < interval) return;
  demoLast = now;
  demoFrame();
}

function startDemo() {
  if (starting) return;
  if (state.running) stopAll();

  state.demo = true;
  state.running = true;
  state.delayEstimate = 0;
  state.delayLockedAt = 0;
  state.delayProbedAt = 0;
  state.delayAuto = true;
  state.totalDelayMs = 0;
  state.noiseFloorDb = null;
  state.noiseHeadroomDb = null;
  updateNoiseReadout();
  $('numDelay').value = '0.00';
  jitterWarned = false;
  resetTraces();

  analyser = new Analyser(state.fftSize, DEMO_RATE);
  analyser.updateRate = averagingRate();
  demoFft = null;
  demoLast = 0;
  if (state.showSpectrograph) liveSpectrograph.clear();

  hideSafariBanner();
  hideAudioHelp();
  setStatus('demo measurement — no microphone involved', 'ok');

  const button = $('btnDemo');
  if (button) button.textContent = 'Stop demo';

  updateInterfaceInfo();
  if (!demoRaf) demoRaf = requestAnimationFrame(demoLoop);
}

function stopDemo() {
  if (!state.demo) return;

  state.demo = false;
  state.running = false;
  if (demoRaf) {
    cancelAnimationFrame(demoRaf);
    demoRaf = 0;
  }

  const button = $('btnDemo');
  if (button) button.textContent = 'Demo measurement';

  state.results = null;
  state.totalDelayMs = 0;
  state.delayLockedAt = 0;
  state.delayProbedAt = 0;
  state.waterfall = null;
  syncDisplayedImpulse();
  if (state.showSpectrograph) liveSpectrograph.clear();
  jitterWarned = false;
  $('rdDelay').textContent = '—';
  $('rdCoh').textContent = '—';
  $('rdLevel').textContent = '—';
  $('rdRate').textContent = '—';
  $('irReadout').textContent = '—';
  $('btnWaterfall').disabled = false;
  $('btnExportCsv').disabled = true;
  $('btnShareChart').disabled = true;
  $('btnShareReport').disabled = true;
  resetRoomInsights();
  renderSaved();
  setStatus('idle');
  updateInterfaceInfo();
  draw();
}

function averagingRate() {
  return 0.02 + 0.45 * (state.avgSpeed / 100);
}

function fineSearchRadius(fftSize) {
  return Math.max(1, Math.round(fftSize / 8));
}

function sourceOptions() {
  const value = state.inputSource || 'auto';
  if (value.indexOf('device:') === 0) {
    return { mode: 'auto', deviceId: value.slice('device:'.length) };
  }
  return { mode: value, deviceId: '' };
}

function sourceName() {
  if (state.inputSource === 'phone') return 'the iPhone microphone';
  if (state.inputSource === 'interface') return 'a USB interface';
  return '';
}

function reportInput() {
  if (!engine.modeSatisfied) {
    setStatus('could not use ' + sourceName() + ' — using "' + engine.deviceLabel + '"', 'err');
    return;
  }
  if (engine.exactDeviceRejected) {
    setStatus('iOS used "' + engine.deviceLabel + '" instead of the chosen input', 'err');
    return;
  }
  if (engine.deviceChannels < 2) {
    setStatus('phone microphone · generated reference', 'ok');
    return;
  }
  setStatus(engine.deviceLabel + ' · ' + engine.deviceChannels + ' inputs', 'ok');
}

function buildAnalyser() {
  const rate = state.demo ? DEMO_RATE : engine.sampleRate;
  analyser = new Analyser(state.fftSize, rate);
  analyser.updateRate = averagingRate();
  micWin = new Float32Array(state.fftSize);
  refWin = new Float32Array(state.fftSize);
  state.results = null;
  state.eq = [];
  resetRoomInsights();
}

/* ---------- traces ---------- */

function captureTrace(res) {
  return {
    magDb: Float32Array.from(res.magDb),
    phaseDeg: Float32Array.from(res.phaseDeg),
    coh: Float32Array.from(res.coh),
    bins: res.bins,
    fftSize: res.fftSize,
    sampleRate: res.sampleRate,
  };
}

function overlaidCurves() {
  return state.overlaidSavedIds.map((id) => state.saved.find((item) => item.id === id)).filter(Boolean);
}

function resetTraces() {
  state.snapshot = null;
  state.snapshotB = null;
  $('phaseALabel').hidden = true;
  $('phaseBLabel').hidden = true;
  renderCaptureDelays();
  state.peakHold = null;
  state.peakHoldArmed = false;
  state.average = null;
  state.averageArmed = false;
  state.averagePower = null;
  state.averageCaptures = 0;
  // Saved overlays remain selected through measurement restarts.
  $('btnArmPeak').textContent = 'Arm peak hold';
  $('btnArmAverage').textContent = 'Arm average';
  $('btnCaptureAverage').disabled = true;
  $('rdDelta').textContent = '—';
  $('rdDeltaB').textContent = '—';
  resetRoomInsights();
  renderBalance();
  updateDelayAdvice();
  updateTraceSummary();
}

function renderCaptureDelays() {
  const holder = $('captureDelayControls');
  holder.replaceChildren();
  for (const [label, trace] of [['A', state.snapshot], ['B', state.snapshotB]]) {
    if (!trace) continue;
    const card = document.createElement('div');
    card.className = 'capture-delay';
    const heading = document.createElement('div');
    heading.className = 'row';
    const title = document.createElement('strong');
    title.textContent = 'Capture ' + label + ' · phase delay';
    const readout = document.createElement('span');
    readout.className = 'value-box';
    const controls = document.createElement('div');
    controls.className = 'row';
    const slider = document.createElement('input');
    slider.type = 'range'; slider.min = '-20'; slider.max = '20'; slider.step = '0.05';
    slider.setAttribute('aria-label', 'Capture ' + label + ' preview delay');
    const update = (ms) => {
      trace.previewDelayMs = Math.max(-20, Math.min(20, Math.round(ms * 20) / 20));
      slider.value = String(trace.previewDelayMs);
      readout.textContent = (trace.previewDelayMs >= 0 ? '+' : '') + trace.previewDelayMs.toFixed(2) + ' ms';
      updateCursorReadout(); draw();
    };
    const button = (text, amount) => {
      const el = document.createElement('button'); el.type = 'button'; el.className = 'btn';
      el.textContent = text; el.addEventListener('click', () => update(amount === null ? 0 : trace.previewDelayMs + amount));
      return el;
    };
    slider.addEventListener('input', () => update(Number(slider.value)));
    heading.append(title, readout);
    controls.append(button('−0.1', -0.1), slider, button('+0.1', 0.1), button('Reset', null));
    card.append(heading, controls);
    holder.appendChild(card);
    update(trace.previewDelayMs || 0);
    if (trace.phaseCompensated) {
      const warning = document.createElement('p'); warning.className = 'source-hint';
      warning.textContent = 'Captured with phase compensation on. Turn it off and recapture to compare arrival timing.';
      card.appendChild(warning);
    }
  }
}

function activeCapture() {
  if (state.snapshot) return { label: 'A', trace: state.snapshot };
  if (state.snapshotB) return { label: 'B', trace: state.snapshotB };
  return null;
}

function delayAdvice() {
  const capture = activeCapture();
  if (!capture) return null;
  const delta = state.totalDelayMs - capture.trace.delayMs;
  if (Math.abs(delta) < 0.05) return { label: capture.label, ms: 0, aligned: true };
  // Whichever arrival is earlier is the one to bring back.
  return { label: capture.label, ms: Math.abs(delta), aligned: false, liveEarlier: delta < 0 };
}

function updateDelayAdvice() {
  const title = $('rdAdvice');
  const detail = $('rdAdviceDetail');
  if (!title || !detail) return;
  const advice = delayAdvice();
  if (!advice) {
    title.textContent = '—';
    title.className = 'v';
    detail.textContent = '';
    return;
  }
  if (advice.aligned) {
    title.textContent = 'Aligned';
    title.className = 'v good';
    detail.textContent = 'within 0.05 ms';
    return;
  }
  title.textContent = 'Delay ' + (advice.liveEarlier ? 'live' : advice.label);
  title.className = 'v';
  detail.textContent = advice.ms.toFixed(2) + ' ms · ' + (advice.ms * 343).toFixed(0) + ' mm';
}

function applyRecommendedDelay() {
  const capture = activeCapture();
  if (!capture) {
    setStatus('nothing to align yet — capture A or B first', 'err');
    return;
  }
  const advice = delayAdvice();
  if (!advice || advice.aligned) {
    setStatus('already aligned — within 0.05 ms, nothing to apply', 'ok');
    return;
  }

  // The corrected arrival is now the one the capture stands for.
  capture.trace.delayMs = state.totalDelayMs;
  $('rdDelta').textContent = state.snapshot
    ? (state.totalDelayMs - state.snapshot.delayMs).toFixed(2) + ' ms'
    : '—';
  $('rdDeltaB').textContent = state.snapshotB
    ? (state.totalDelayMs - state.snapshotB.delayMs).toFixed(2) + ' ms'
    : '—';
  updateDelayAdvice();
  renderBalance();
  updateTraceSummary();
  setStatus(
    'applied — ' + capture.label + ' moved onto the live arrival by ' +
    advice.ms.toFixed(2) + ' ms (' + (advice.ms * 343).toFixed(0) +
    ' mm); the pair now reads aligned',
    'ok',
  );
  draw();
}

function renderBalance() {
  const card = $('balanceCard');
  const summary = $('balanceSummary');
  const holder = $('balanceBands');
  if (!card || !summary || !holder) return;

  const balance = speakerBalance(state.snapshot, state.snapshotB);
  if (!balance) {
    card.hidden = true;
    holder.replaceChildren();
    return;
  }

  card.hidden = false;
  summary.textContent = balance.isBalanced
    ? 'Within 2 dB'
    : balance.louder + ' is ' + Math.abs(balance.meanDifference).toFixed(1) + ' dB louder';
  summary.className = 'balance-summary' + (balance.isBalanced ? ' good' : '');
  holder.replaceChildren();

  balance.bands.forEach((band) => {
    const row = document.createElement('div');
    row.className = 'balance-row';
    const frequency = document.createElement('span');
    frequency.className = 'balance-frequency';
    frequency.textContent = formatBalanceFrequency(band.frequency);
    const difference = document.createElement('span');
    difference.className = 'balance-difference';
    difference.textContent = (band.difference >= 0 ? '+' : '') + band.difference.toFixed(1);
    if (!balance.isBalanced) difference.classList.add(band.difference >= 0 ? 'a' : 'b');
    row.append(frequency, difference);
    holder.appendChild(row);
  });
}

function updateTraceSummary() {
  const parts = [];
  if (state.snapshot) {
    parts.push('A · ' + state.snapshot.delayMs.toFixed(2) + ' ms (' +
      signedMs(state.snapshot.previewDelayMs || 0) + ' preview)');
  }
  if (state.snapshotB) {
    parts.push('B · ' + state.snapshotB.delayMs.toFixed(2) + ' ms (' +
      signedMs(state.snapshotB.previewDelayMs || 0) + ' preview)');
  }
  if (state.average) parts.push('avg ' + state.averageCaptures);
  const text = parts.length ? parts.join('  ') : 'no captures yet';
  const summary = $('captureSummary');
  if (summary) summary.textContent = text;
  $('traceSummary').textContent = text;
  $('capturePhaseRow').hidden = !state.snapshot && !state.snapshotB;
  updatePhaseToggleState();
}

function updateGateBadge() {
  for (const id of ['gateBadge', 'gateBadgeIr']) {
    const badge = $(id);
    if (badge) badge.hidden = !state.gate.enabled;
  }
}

function mergePeakHold(held, res) {
  if (!held || held.bins !== res.bins || held.fftSize !== res.fftSize) return captureTrace(res);
  for (let k = 0; k < held.bins; k++) {
    const value = res.magDb[k];
    if (!Number.isFinite(value)) continue;
    if (!Number.isFinite(held.magDb[k]) || value > held.magDb[k]) held.magDb[k] = value;
  }
  return held;
}

function captureA() {
  const res = state.results;
  if (!res) return;
  state.snapshot = Object.assign(captureTrace(res), {
    delayMs: state.totalDelayMs, previewDelayMs: 0, smoothing: smoothingLabel(),
    reference: referenceLabel(), phaseCompensated: state.compensate,
    gate: { enabled: !!state.gate.enabled, startMs: state.gate.startMs, widthMs: state.gate.widthMs },
    polarity: res.polarityKnown ? (res.polarity > 0 ? 'normal' : 'inverted') : 'unknown',
  });
  $('phaseALabel').hidden = false;
  $('chkPhaseA').checked = true;
  $('phaseAdvice').hidden = false;
  renderCaptureDelays();
  renderBalance();
  updateDelayAdvice();
  setStatus('captured A at ' + state.totalDelayMs.toFixed(2) + ' ms', 'ok');
  updateTraceSummary();
  draw();
}

function clearA() {
  state.snapshot = null;
  $('phaseALabel').hidden = true;
  renderCaptureDelays();
  renderBalance();
  updateDelayAdvice();
  $('rdDelta').textContent = '—';
  updateTraceSummary();
  draw();
}

function captureB() {
  const res = state.results;
  if (!res) return;
  state.snapshotB = Object.assign(captureTrace(res), {
    delayMs: state.totalDelayMs, previewDelayMs: 0, smoothing: smoothingLabel(),
    reference: referenceLabel(), phaseCompensated: state.compensate,
    gate: { enabled: !!state.gate.enabled, startMs: state.gate.startMs, widthMs: state.gate.widthMs },
    polarity: res.polarityKnown ? (res.polarity > 0 ? 'normal' : 'inverted') : 'unknown',
  });
  $('phaseBLabel').hidden = false;
  $('chkPhaseB').checked = true;
  $('phaseAdvice').hidden = false;
  renderCaptureDelays();
  renderBalance();
  updateDelayAdvice();
  setStatus('captured B at ' + state.totalDelayMs.toFixed(2) + ' ms', 'ok');
  updateTraceSummary();
  draw();
}

function clearB() {
  state.snapshotB = null;
  $('phaseBLabel').hidden = true;
  renderCaptureDelays();
  renderBalance();
  updateDelayAdvice();
  $('rdDeltaB').textContent = '—';
  updateTraceSummary();
  draw();
}

function armPeakHold() {
  state.peakHoldArmed = true;
  state.peakHold = state.results ? captureTrace(state.results) : null;
  $('btnArmPeak').textContent = 'Re-arm peak hold';
  setStatus(
    state.peakHold
      ? 'peak hold armed — the pinned line only rises from here'
      : 'peak hold armed — waiting for the first frame',
    'ok',
  );
  draw();
}

function clearPeakHold() {
  state.peakHoldArmed = false;
  state.peakHold = null;
  $('btnArmPeak').textContent = 'Arm peak hold';
  setStatus('peak hold cleared', 'ok');
  draw();
}

function armAverage() {
  state.averageArmed = true;
  state.average = null;
  state.averagePower = null;
  state.averageCaptures = 0;
  $('btnArmAverage').textContent = 'Re-arm average';
  $('btnCaptureAverage').disabled = false;
  setStatus('average armed — Capture average adds the live curve', 'ok');
  updateTraceSummary();
  draw();
}

function captureAverage() {
  const res = state.results;
  if (!res) return;

  state.averageArmed = true;
  if (!state.averagePower || state.averagePower.length !== res.bins) {
    state.averagePower = new Float64Array(res.bins);
    state.averageCaptures = 0;
  }

  for (let k = 0; k < res.bins; k++) {
    const db = res.magDb[k];
    if (!Number.isFinite(db)) continue;
    state.averagePower[k] += Math.pow(10, db / 10);
  }
  state.averageCaptures += 1;

  const divisor = state.averageCaptures;
  const trace = captureTrace(res);
  for (let k = 0; k < res.bins; k++) {
    const mean = state.averagePower[k] / divisor;
    trace.magDb[k] = mean > 0 ? 10 * Math.log10(mean) : -140;
  }
  state.average = trace;

  setStatus(
    divisor === 1 ? 'average started with this curve' : 'averaging ' + divisor + ' captures',
    'ok',
  );
  updateTraceSummary();
  draw();
}

function clearAverage() {
  state.averageArmed = false;
  state.average = null;
  state.averagePower = null;
  state.averageCaptures = 0;
  $('btnArmAverage').textContent = 'Arm average';
  $('btnCaptureAverage').disabled = true;
  setStatus('average cleared', 'ok');
  updateTraceSummary();
  draw();
}

/* ---------- saved measurements ---------- */

const SAVED_COLORS = ['#b4a7f7', '#fbb679', '#72c7f2', '#eea4b3', '#a8df9b', '#f7d47b', '#86d5ca', '#d8a691'];

/** The phase preview delay for one saved overlay, used in the library and in Traces. */
function buildPreviewDelayControl(item) {
  const block = document.createElement('div');
  block.className = 'saved-preview-control';

  const heading = document.createElement('div');
  heading.className = 'row';
  const title = document.createElement('strong');
  title.textContent = 'Phase preview';
  const readout = document.createElement('span');
  readout.className = 'hint';
  heading.append(title, readout);

  const controls = document.createElement('div');
  controls.className = 'row';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '-20';
  slider.max = '20';
  slider.step = '0.05';
  slider.value = String(clampPreviewDelay(item.previewDelayMs));
  slider.setAttribute('aria-label', item.name + ' phase preview delay');

  const formatDelay = (value) => (value >= 0 ? '+' : '') + value.toFixed(2) + ' ms';
  let stored = clampPreviewDelay(item.previewDelayMs);
  readout.textContent = formatDelay(stored);

  const paint = (value) => {
    slider.value = String(value);
    readout.textContent = formatDelay(value);
  };

  const commit = (value) => {
    const next = clampPreviewDelay(value);
    const previous = stored;
    item.previewDelayMs = next;
    paint(next);
    draw();
    if (persistSaved()) {
      stored = next;
      renderSavedOverlayControls();
      renderSaved();
      return;
    }
    // The browser refused the write: show the value that is really stored.
    item.previewDelayMs = previous;
    paint(previous);
    draw();
    renderSavedOverlayControls();
    renderSaved();
  };

  slider.addEventListener('input', () => {
    item.previewDelayMs = clampPreviewDelay(slider.value);
    paint(item.previewDelayMs);
    draw();
  });
  slider.addEventListener('change', () => commit(item.previewDelayMs));

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'btn';
  reset.textContent = 'Reset';
  reset.addEventListener('click', () => commit(0));

  controls.append(slider, reset);
  block.append(heading, controls);
  return block;
}

function renderSavedOverlayControls() {
  let holder = $('savedOverlayControls');
  if (!holder) {
    holder = document.createElement('div');
    holder.id = 'savedOverlayControls';
    $('btnSaved').parentElement.after(holder);
  }
  holder.replaceChildren();
  overlaidCurves().forEach((item, index) => {
    const card = document.createElement('div'); card.className = 'capture-delay';
    const heading = document.createElement('div'); heading.className = 'row';
    const name = document.createElement('strong'); name.textContent = item.name;
    name.style.color = SAVED_COLORS[index];
    const remove = document.createElement('button'); remove.className = 'btn'; remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      state.overlaidSavedIds = state.overlaidSavedIds.filter((id) => id !== item.id);
      setLibraryError('');
      renderSavedOverlayControls(); renderSaved(); draw();
    });
    heading.append(name, remove); card.appendChild(heading);
    if (Array.isArray(item.phase) && Array.isArray(item.phaseCoherence)) {
      card.appendChild(buildPreviewDelayControl(item));
      if (item.phaseCompensated) {
        const warning = document.createElement('p'); warning.className = 'source-hint';
        warning.textContent = 'Captured with phase compensation: recapture with it off for arrival timing.';
        card.appendChild(warning);
      }
    } else {
      const note = document.createElement('p'); note.className = 'source-hint';
      note.textContent = 'Magnitude only — saved before phase was stored.';
      card.appendChild(note);
    }
    holder.appendChild(card);
  });
}


/** Magnitude in dB, 400 points log-spaced from 20 Hz to 20 kHz. */
function savedCurve(res) {
  const points = 400;
  const span = Math.log(20000 / 20);
  const values = new Float32Array(points);
  const df = res.sampleRate / res.fftSize;

  for (let i = 0; i < points; i++) {
    const t0 = i / (points - 1);
    const t1 = (i + 1) / (points - 1);
    const f0 = 20 * Math.exp(t0 * span);
    const f1 = Math.min(20000, 20 * Math.exp(t1 * span));
    const k0 = Math.min(res.bins - 1, Math.max(1, Math.floor(f0 / df)));
    const k1 = Math.min(res.bins - 1, Math.max(k0, Math.ceil(f1 / df)));

    let sum = 0;
    let n = 0;
    for (let k = k0; k <= k1; k++) {
      const v = res.magDb[k];
      if (!Number.isFinite(v)) continue;
      sum += Math.pow(10, v / 10);
      n += 1;
    }
    values[i] = n > 0 ? 10 * Math.log10(sum / n) : -140;
  }

  const smoothed = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const a = values[Math.max(0, i - 1)];
    const b = values[i];
    const c = values[Math.min(points - 1, i + 1)];
    smoothed[i] = (a + 2 * b + c) / 4;
  }
  return Array.from(smoothed);
}

function sampleSaved(values, trace) {
  const df = trace.sampleRate / trace.fftSize;
  return Array.from({ length: 400 }, (_, index) => {
    const f = 20 * Math.exp(index / 399 * Math.log(1000));
    const position = Math.min(trace.bins - 1, f / df);
    const low = Math.floor(position), high = Math.min(trace.bins - 1, low + 1);
    return values[low] * (1 - position + low) + values[high] * (position - low);
  });
}

function formatSavedDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === today.toDateString()) return 'Today, ' + time;
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday, ' + time;
  return date.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ', ' + time;
}

function drawSavedThumb(canvas, curve, color) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!curve || curve.length < 2) return;

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < curve.length; i++) {
    const v = curve[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return;

  const span = Math.max(1, max - min);
  const y = (db) => h - 3 - ((db - min) / span) * (h - 6);

  ctx.beginPath();
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * w;
    if (i === 0) ctx.moveTo(x, y(curve[i]));
    else ctx.lineTo(x, y(curve[i]));
  }
  ctx.strokeStyle = color || 'rgba(180,167,247,0.9)';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function captureSettingsText(item) {
  const parts = [];
  if (item.fftSize) parts.push('FFT ' + item.fftSize);
  if (item.sampleRate) parts.push((item.sampleRate / 1000).toFixed(1) + ' kHz');
  if (item.smoothing) parts.push(item.smoothing);
  if (item.reference) parts.push(item.reference);
  if (item.gate && item.gate.enabled) parts.push('gated');
  if (item.source) parts.push(item.source);
  if (item.previewDelayMs) parts.push('preview ' + signedMs(item.previewDelayMs) + ' ms');
  return parts.join(' · ');
}

function renderSaved() {
  const list = $('savedList');
  list.replaceChildren();
  $('savedSubtitle').textContent = 'On this device · ' + state.saved.length + ' saved · ' +
    state.overlaidSavedIds.length + ' overlaid (up to 8)';
  $('btnClearSavedOverlays').disabled = !state.overlaidSavedIds.length;

  const source = $('savedSource').value;
  const available = source === 'live'
    ? !!state.results
    : !!(source === 'a' ? state.snapshot : state.snapshotB);
  $('btnSaveCurrent').disabled = !available;
  $('saveHint').textContent = available
    ? 'A capture is saved with its magnitude, phase, coherence, delay, settings and note in this browser.'
    : 'Nothing to save from that source yet — start a measurement or hold Capture A or B.';

  const query = $('savedSearch').value.trim().toLocaleLowerCase();
  const matches = state.saved.filter((item) => !query ||
    item.name.toLocaleLowerCase().includes(query) ||
    (item.note || '').toLocaleLowerCase().includes(query));

  if (!matches.length) {
    const empty = document.createElement('li');
    empty.className = 'saved-empty';
    empty.textContent = state.saved.length
      ? 'No captures match “' + $('savedSearch').value.trim() + '”.'
      : 'No captures saved yet. Name one above, choose Live, A or B, then Save capture.';
    list.appendChild(empty);
    return;
  }

  matches.forEach((item) => {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    const selection = state.overlaidSavedIds.indexOf(item.id);
    const overlayColor = selection >= 0 ? SAVED_COLORS[selection % SAVED_COLORS.length] : '';
    button.className = 'saved-item' + (selection >= 0 ? ' selected' : '');
    if (overlayColor) button.style.borderColor = overlayColor;

    button.addEventListener('click', () => {
      if (selection >= 0) {
        state.overlaidSavedIds.splice(selection, 1);
      } else if (state.overlaidSavedIds.length >= 8) {
        setStatus('Clear an overlay before adding another (8 maximum)', 'err');
        setLibraryError('Eight overlays are already showing. Clear one to choose another.');
        return;
      } else {
        state.overlaidSavedIds.push(item.id);
        if (item.phase) $('chkPhase').checked = true;
      }
      setLibraryError('');
      renderSaved();
      renderSavedOverlayControls();
      draw();
    });

    const main = document.createElement('div');
    main.className = 'saved-main';

    const delay = document.createElement('div'); delay.className = 'saved-delay';
    delay.textContent = Number(item.delayMs).toFixed(2) + ' ms';

    const meta = document.createElement('div'); meta.className = 'saved-meta';
    const magnitudeState = item.phase ? 'magnitude + phase' : 'magnitude only';
    meta.textContent = 'Coherence ' + Math.round(item.coherence * 100) + '% · ' + magnitudeState;

    const settings = document.createElement('div'); settings.className = 'saved-meta';
    settings.textContent = captureSettingsText(item) || 'no stored settings';

    const name = document.createElement('div'); name.className = 'saved-name'; name.textContent = item.name;

    main.append(delay, meta, settings, name);

    if (item.note) {
      const note = document.createElement('div'); note.className = 'saved-note';
      note.textContent = item.note;
      main.appendChild(note);
    }

    const date = document.createElement('div'); date.className = 'saved-date';
    date.textContent = formatSavedDate(item.date);
    main.appendChild(date);

    const thumb = document.createElement('canvas'); thumb.className = 'saved-thumb';
    thumb.width = 148; thumb.height = 76;
    drawSavedThumb(thumb, item.curve, overlayColor);

    const check = document.createElement('span'); check.className = 'saved-check';
    check.textContent = selection >= 0 ? '✓' : '+';
    check.style.color = overlayColor || '';

    button.append(main, thumb, check);

    const actions = document.createElement('div'); actions.className = 'saved-extra';
    const action = (label, handler) => {
      const control = document.createElement('button'); control.type = 'button';
      control.className = 'btn'; control.textContent = label;
      control.addEventListener('click', handler); actions.appendChild(control);
    };

    action('Rename', () => {
      const answer = window.prompt('Rename capture', item.name);
      if (answer === null) return;
      const newName = answer.trim().slice(0, 80);
      if (!newName) {
        setStatus('Capture name cannot be empty', 'err');
        setLibraryError('Capture name cannot be empty.');
        return;
      }
      const updated = state.saved.map((entry) => entry.id === item.id ? { ...entry, name: newName } : entry);
      if (persistSaved(updated)) {
        state.saved = updated;
        renderSaved();
        renderSavedOverlayControls();
        draw();
      }
    });

    action('Note', () => {
      const answer = window.prompt('Capture note', item.note || '');
      if (answer === null) return;
      const updated = state.saved.map((entry) => entry.id === item.id
        ? { ...entry, note: answer.trim().slice(0, 160) } : entry);
      if (persistSaved(updated)) {
        state.saved = updated;
        renderSaved();
      }
    });

    action('Delete', () => {
      const updated = state.saved.filter((entry) => entry.id !== item.id);
      if (!persistSaved(updated)) return;
      state.saved = updated;
      state.overlaidSavedIds = state.overlaidSavedIds.filter((id) => id !== item.id);
      renderSaved();
      renderSavedOverlayControls();
      draw();
    });

    if (selection >= 0 && Array.isArray(item.phase) && Array.isArray(item.phaseCoherence)) {
      actions.appendChild(buildPreviewDelayControl(item));
    }

    row.append(button, actions);
    list.appendChild(row);
  });
}

function suggestedCaptureName(source) {
  const prefix = source === 'a' ? 'Capture A' : source === 'b' ? 'Capture B' : 'Live';
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return prefix + ' ' + time;
}

function saveCurrent() {
  const source = $('savedSource').value;
  const held = source === 'a' ? state.snapshot : source === 'b' ? state.snapshotB : null;
  const res = held || state.results;
  if (!res) {
    setStatus('Nothing to save from that source', 'err');
    setLibraryError('Nothing to save from that source — start a measurement or hold Capture A or B.');
    return;
  }

  const nameField = $('savedName');
  const name = nameField.value.trim().slice(0, 80);
  if (!name) {
    setStatus('Give the capture a name first', 'err');
    setLibraryError('Give the capture a name before saving it.');
    nameField.focus();
    return;
  }
  const note = $('savedNote').value.trim().slice(0, 160);

  const item = {
    schema: SAVED_SCHEMA,
    id: captureId(),
    name,
    date: new Date().toISOString(),
    source: source === 'live' ? 'Live' : 'Capture ' + source.toUpperCase(),
    delayMs: held ? held.delayMs : state.totalDelayMs,
    coherence: meanCoherence(res),
    polarity: held ? held.polarity : res.polarityKnown ? (res.polarity > 0 ? 'normal' : 'inverted') : 'unknown',
    fftSize: res.fftSize,
    sampleRate: res.sampleRate,
    smoothing: held ? held.smoothing : smoothingLabel(),
    reference: held ? held.reference : referenceLabel(),
    curve: savedCurve(res),
    phase: sampleSaved(res.phaseDeg, res),
    phaseCoherence: sampleSaved(res.coh, res),
    phaseCompensated: held ? held.phaseCompensated : state.compensate,
    previewDelayMs: held ? clampPreviewDelay(held.previewDelayMs) : 0,
    gate: held && held.gate
      ? { ...held.gate }
      : { enabled: !!state.gate.enabled, startMs: state.gate.startMs, widthMs: state.gate.widthMs },
    note,
  };

  const updated = [item, ...state.saved];
  if (!persistSaved(updated)) return;

  state.saved = updated;
  $('savedNote').value = '';
  const suggestion = suggestedCaptureName(source);
  nameField.value = suggestion;
  nameField.dataset.suggestion = suggestion;
  renderSaved();
  setStatus('Saved “' + item.name + '” on this device', 'ok');
}

function openSaved() {
  const nameField = $('savedName');
  const suggestion = suggestedCaptureName($('savedSource').value);
  nameField.value = suggestion;
  nameField.dataset.suggestion = suggestion;
  $('savedNote').value = '';
  setLibraryError('');
  renderSaved();
  $('savedSheet').hidden = false;
  updateSheetLock();
}

/* ---------- measurement presets ---------- */

const SIGNAL_NAMES = {
  pink: 'Pink noise',
  white: 'White noise',
  sine: 'Sine',
  sweep: 'Sine sweep',
  silent: 'Silent',
};

function smoothingName(value) {
  if (!(value > 0)) return 'None';
  return '1/' + Math.round(1 / value) + ' oct';
}

function presetSettingsText(item) {
  return 'FFT ' + item.fftSize + ' · ' + smoothingName(item.smoothing) + ' · ' +
    Math.round(item.averaging) + '% · gate ' + item.gateStartMs.toFixed(0) + '–' +
    (item.gateStartMs + item.gateWidthMs).toFixed(0) + ' ms';
}

function presetSourceText(item) {
  return (SIGNAL_NAMES[item.signal] || 'Pink noise') + ' · ' +
    (item.reference === 'loopback' ? 'loopback reference' : 'generated reference');
}

function setPresetError(message) {
  const el = $('presetsError');
  if (!el) return;
  el.textContent = message || '';
  el.hidden = !message;
}

function currentPresetSettings() {
  return {
    fftSize: state.fftSize,
    averaging: state.avgSpeed,
    smoothing: state.smoothing,
    gateEnabled: state.gate.enabled,
    gateStartMs: state.gate.startMs,
    gateWidthMs: state.gate.widthMs,
    signal: state.signal,
    level: state.level,
    reference: state.refMode,
  };
}

function renderPresets() {
  const list = $('presetList');
  if (!list) return;
  list.replaceChildren();
  $('presetsSubtitle').textContent = state.presets.length
    ? 'Kept in this browser · ' + state.presets.length +
      (state.presets.length === 1 ? ' preset' : ' presets')
    : 'Kept in this browser';

  const query = ($('presetSearch').value || '').trim().toLocaleLowerCase();
  const matches = state.presets.filter((item) => !query ||
    item.name.toLocaleLowerCase().includes(query) ||
    (item.note || '').toLocaleLowerCase().includes(query));

  if (!matches.length) {
    const empty = document.createElement('li');
    empty.className = 'saved-empty';
    empty.textContent = state.presets.length
      ? 'No matching presets.'
      : 'No presets yet. Save the current settings to make a repeatable setup one tap away.';
    list.appendChild(empty);
    return;
  }

  matches.forEach((item) => {
    const row = document.createElement('li');
    row.className = 'preset-item' + (state.appliedPresetId === item.id ? ' applied' : '');

    const main = document.createElement('div');
    main.className = 'preset-main';
    const name = document.createElement('div');
    name.className = 'preset-name';
    name.textContent = item.name;
    const note = document.createElement('div');
    note.className = 'preset-note';
    if (item.note) note.textContent = item.note;
    const settings = document.createElement('div');
    settings.className = 'preset-settings';
    settings.textContent = presetSettingsText(item);
    const source = document.createElement('div');
    source.className = 'preset-source';
    source.textContent = presetSourceText(item) + ' · ' + formatSavedDate(item.date);
    main.append(name, note, settings, source);

    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'btn preset-apply';
    apply.textContent = 'Apply';
    apply.addEventListener('click', () => applyPreset(item));

    const check = document.createElement('span');
    check.className = 'preset-check';
    check.textContent = state.appliedPresetId === item.id ? '✓' : '';
    row.append(main, apply, check);

    const actions = document.createElement('div');
    actions.className = 'saved-extra';
    const action = (label, handler) => {
      const control = document.createElement('button');
      control.type = 'button';
      control.className = 'btn';
      control.textContent = label;
      control.addEventListener('click', handler);
      actions.appendChild(control);
    };

    action(item.note ? 'Edit note' : 'Add note', () => {
      const answer = window.prompt('Preset note', item.note || '');
      if (answer === null) return;
      const noteText = answer.trim().slice(0, 160);
      const updated = state.presets.map((entry) => entry.id === item.id
        ? { ...entry, note: noteText } : entry);
      if (!persistPresets(updated)) {
        setPresetError('Could not save the preset — browser storage is full or blocked.');
        return;
      }
      state.presets = updated;
      setPresetError('');
      renderPresets();
    });

    action('Rename', () => {
      const answer = window.prompt('Rename preset', item.name);
      if (answer === null) return;
      const newName = answer.trim().slice(0, 80);
      if (!newName) {
        setPresetError('Preset name cannot be empty.');
        return;
      }
      const updated = state.presets.map((entry) => entry.id === item.id
        ? { ...entry, name: newName } : entry);
      if (!persistPresets(updated)) {
        setPresetError('Could not save the preset — browser storage is full or blocked.');
        return;
      }
      state.presets = updated;
      setPresetError('');
      renderPresets();
    });

    action('Duplicate', () => {
      const copy = {
        ...item,
        id: 'p' + Date.now().toString(36) + '-' + Math.random().toString(16).slice(2),
        name: uniqueCopyName(state.presets, item.name),
        date: new Date().toISOString(),
      };
      const updated = [copy, ...state.presets].slice(0, PRESET_LIMIT);
      if (!persistPresets(updated)) {
        setPresetError('Could not save the preset — browser storage is full or blocked.');
        return;
      }
      state.presets = updated;
      setPresetError('');
      renderPresets();
    });

    action('Delete', () => {
      const updated = state.presets.filter((entry) => entry.id !== item.id);
      if (!persistPresets(updated)) {
        setPresetError('Could not save the preset — browser storage is full or blocked.');
        return;
      }
      state.presets = updated;
      if (state.appliedPresetId === item.id) state.appliedPresetId = null;
      setPresetError('');
      renderPresets();
    });

    list.appendChild(row);
    const actionRow = document.createElement('li');
    actionRow.className = 'preset-actions-row';
    actionRow.appendChild(actions);
    list.appendChild(actionRow);
  });
}

function savePresetFromCurrent() {
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const answer = window.prompt('Name this preset', 'Preset ' + time);
  if (answer === null) return;
  const name = answer.trim().slice(0, 80);
  if (!name) {
    setPresetError('Preset name cannot be empty.');
    return;
  }

  const preset = newPreset(currentPresetSettings(), name);
  const updated = [preset, ...state.presets].slice(0, PRESET_LIMIT);
  if (!persistPresets(updated)) {
    setPresetError('Could not save the preset — browser storage is full or blocked.');
    setStatus('Could not save the preset — browser storage is full or blocked', 'err');
    return;
  }

  state.presets = updated;
  state.appliedPresetId = preset.id;
  setPresetError('');
  renderPresets();
  setStatus('saved preset “' + preset.name + '”', 'ok');
}

function applyPreset(item) {
  const previousFft = state.fftSize;

  state.fftSize = item.fftSize;
  $('selFft').value = String(item.fftSize);

  state.avgSpeed = item.averaging;
  $('rngAvg').value = String(item.averaging);
  $('lblAvg').textContent = Math.round(item.averaging) + '%';

  state.smoothing = item.smoothing;
  $('selSmooth').value = item.smoothing > 0 ? String(Math.round(1 / item.smoothing)) : '0';

  state.gate.enabled = item.gateEnabled;
  state.gate.startMs = item.gateStartMs;
  state.gate.widthMs = item.gateWidthMs;
  $('chkGate').checked = item.gateEnabled;
  $('numGateStart').value = item.gateStartMs.toFixed(1);
  $('numGateWidth').value = item.gateWidthMs.toFixed(1);
  $('numGateStart').disabled = !item.gateEnabled;
  $('numGateWidth').disabled = !item.gateEnabled;
  invalidateRoomInsights();

  state.signal = item.signal;
  $('selSignal').value = item.signal;
  $('rowSine').hidden = item.signal !== 'sine';
  engine.setSignal(item.signal);

  state.level = item.level;
  $('rngLevel').value = String(Math.round(item.level * 100));
  $('lblLevel').textContent = Math.round(item.level * 100) + '%';
  engine.setLevel(item.level);

  state.refMode = item.reference;
  $('selRef').value = item.reference;
  state.delayEstimate = 0;
  state.delayLockedAt = 0;
  state.delayProbedAt = 0;
  state.delayAuto = true;
  $('numDelay').value = '0.00';

  if (state.running && previousFft !== item.fftSize) {
    buildAnalyser();
  } else if (analyser) {
    analyser.updateRate = averagingRate();
    analyser.reset();
  }

  state.appliedPresetId = item.id;
  if (state.spectrogramOpen) drawSpectrogram();
  renderPresets();
  if (typeof updateDelayAdvice === 'function') updateDelayAdvice();
  setStatus('applied preset “' + item.name + '”', 'ok');
  draw();
}

function openPresets() {
  setPresetError('');
  renderPresets();
  $('presetsSheet').hidden = false;
  updateSheetLock();
}

function closePresets() {
  closeSheet('presetsSheet');
}

/* ---------- waterfall ---------- */

function waterfallOptions() {
  return {
    rangeMs: state.waterfallRangeMs,
    amplitude: state.waterfallAmplitude,
    gate: state.gate,
  };
}

function refreshWaterfall(force) {
  if (!state.waterfallOpen) {
    state.waterfall = null;
    return;
  }
  if (!state.results) {
    state.waterfall = null;
    return;
  }

  const now = performance.now();
  if (!force && now - lastWaterfallBuild < 400) return;
  lastWaterfallBuild = now;
  state.waterfall = buildWaterfall(state.results, state.waterfallRangeMs);
}

function drawWaterfall() {
  wfChart.draw(state.waterfall, waterfallOptions());
}

function updateWaterfallLabels() {
  $('wfRangeValue').textContent = state.waterfallRangeMs.toFixed(0) + ' ms';
  $('wfAmpValue').textContent = state.waterfallAmplitude.toFixed(0) + '%';
  $('wfSubtitle').textContent = 'impulse decay · 0–' + state.waterfallRangeMs.toFixed(0) + ' ms';
}

function openWaterfall() {
  state.waterfallOpen = true;
  $('waterfallSheet').hidden = false;
  updateSheetLock();
  updateWaterfallLabels();
  wfChart.resize();
  refreshWaterfall(true);
  drawWaterfall();
  requestAnimationFrame(() => {
    wfChart.resize();
    drawWaterfall();
  });
}

function closeWaterfall() {
  state.waterfallOpen = false;
  closeSheet('waterfallSheet');
}

/* ---------- reflections, room decay and the decay spectrogram ---------- */

function formatDecayFrequency(frequency) {
  return frequency >= 1000
    ? (frequency / 1000).toFixed(1) + ' kHz'
    : frequency.toFixed(0) + ' Hz';
}

function renderReflections() {
  const list = $('reflectionsList');
  list.replaceChildren();

  if (!state.results) {
    const empty = document.createElement('p');
    empty.className = 'source-hint';
    empty.textContent = 'Start the measurement to see the reflections.';
    list.appendChild(empty);
    return;
  }

  if (!state.reflections.length) {
    const empty = document.createElement('p');
    empty.className = 'source-hint';
    empty.textContent = 'No reflections worth listing — the response dies away after the direct sound.';
    list.appendChild(empty);
    return;
  }

  state.reflections.forEach((reflection) => {
    const row = document.createElement('div');
    row.className = 'reflection-row';
    const delay = document.createElement('span');
    delay.className = 'reflection-delay';
    delay.textContent = reflection.delayMs.toFixed(2) + ' ms';
    const level = document.createElement('span');
    level.className = 'reflection-level';
    level.textContent = reflection.levelDb.toFixed(1) + ' dB';
    row.append(delay, level);
    list.appendChild(row);
  });
}

function renderRoomDecay() {
  const head = $('roomDecayHead');
  const empty = $('roomDecayEmpty');
  const note = $('roomDecayNote');
  const bands = $('roomDecayBands');

  head.hidden = true;
  note.hidden = true;
  bands.replaceChildren();

  if (!state.results) {
    empty.hidden = false;
    empty.textContent = "Start the measurement to read the room's decay.";
    return;
  }

  const decay = state.roomDecay;
  if (!decay || !Number.isFinite(decay.overall)) {
    empty.hidden = false;
    empty.textContent = 'No steady decay to read yet.';
    return;
  }

  empty.hidden = true;
  head.hidden = false;
  $('roomRt60').textContent = decay.overall.toFixed(2) + ' s';

  decay.bands.forEach((band) => {
    const item = document.createElement('div');
    item.className = 'room-decay-band';
    const frequency = document.createElement('span');
    frequency.className = 'room-decay-frequency';
    frequency.textContent = formatDecayFrequency(band.frequency);
    const rt60 = document.createElement('span');
    rt60.className = 'room-decay-time';
    rt60.textContent = band.rt60.toFixed(2) + ' s';
    item.append(frequency, rt60);
    bands.appendChild(item);
  });

  note.hidden = false;
  note.textContent = decay.gated ? 'Read inside the gate.' : 'Read from the whole response.';
}

function resetRoomInsights() {
  state.reflections = [];
  state.roomDecay = null;
  lastDecayBuild = 0;
  renderReflections();
  renderRoomDecay();
}

/**
 * Reflections and the per-band decay read the whole impulse response, so they
 * run a couple of times a second rather than on every analysis frame.
 */
function refreshRoomInsights(force) {
  if (!state.results) {
    resetRoomInsights();
    return;
  }

  const now = performance.now();
  if (!force && now - lastDecayBuild < 2000) return;
  lastDecayBuild = now;

  try {
    state.reflections = buildReflections(state.results);
  } catch (err) {
    state.reflections = [];
  }
  try {
    state.roomDecay = buildRoomDecay(state.results, state.gate);
  } catch (err) {
    state.roomDecay = null;
  }

  renderReflections();
  renderRoomDecay();
}

/** Invalidate by hand but wait for the gesture to settle before recomputing. */
function invalidateRoomInsights() {
  lastDecayBuild = performance.now() - 1700;
}

function updateSpectrogramLabels() {
  const range = Math.round(state.spectrogramRangeMs);
  $('spRangeValue').textContent = range + ' ms';
  $('spSubtitle').textContent = 'impulse decay · 0–' + range + ' ms';
}

function refreshSpectrogram(force) {
  if (!state.spectrogramOpen) {
    state.spectrogram = null;
    return false;
  }

  if (!state.results) {
    const changed = state.spectrogram !== null;
    state.spectrogram = null;
    return changed || !!force;
  }

  const now = performance.now();
  if (!force && now - lastSpectrogramBuild < 500) return false;
  lastSpectrogramBuild = now;

  try {
    state.spectrogram = buildSpectrogram(state.results, state.spectrogramRangeMs);
  } catch (err) {
    state.spectrogram = null;
  }
  return true;
}

function drawSpectrogram() {
  spectrogramChart.draw(state.spectrogram, {
    rangeMs: state.spectrogramRangeMs,
    gate: state.gate,
  });
}

function openSpectrogram() {
  state.spectrogramOpen = true;
  $('spectrogramSheet').hidden = false;
  updateSheetLock();
  updateSpectrogramLabels();
  spectrogramChart.resize();
  refreshSpectrogram(true);
  drawSpectrogram();
  requestAnimationFrame(() => {
    spectrogramChart.resize();
    drawSpectrogram();
  });
}

function closeSpectrogram() {
  state.spectrogramOpen = false;
  closeSheet('spectrogramSheet');
}

function scheduleSpectrogramRebuild() {
  if (spectrogramRebuildTimer) clearTimeout(spectrogramRebuildTimer);
  spectrogramRebuildTimer = setTimeout(() => {
    spectrogramRebuildTimer = 0;
    if (!state.spectrogramOpen) return;
    refreshSpectrogram(true);
    drawSpectrogram();
  }, 80);
}

/* ---------- band table and group delay ---------- */

function renderBandTable() {
  const rows = $('bandRows');
  rows.replaceChildren();
  const summary = $('bandSummary');
  const note = $('bandNote');

  if (!state.results) {
    summary.textContent = '1/3 oct';
    note.textContent = 'Start the measurement to fill the table.';
    return;
  }

  const readings = bandReadings(state.results, state.target);
  const totals = bandSummary(readings);
  const parts = ['1/3 oct'];
  if (totals.overall !== null) parts.push('overall ' + totals.overall.toFixed(1) + ' dB');
  if (totals.coherence !== null) parts.push('coherence ' + (totals.coherence * 100).toFixed(0) + '%');
  summary.textContent = parts.join(' · ');
  note.textContent = state.target
    ? 'Levels are relative; the target column appears when a target curve is chosen.'
    : 'Levels are relative; the target column appears when a target curve is chosen.';

  const header = document.createElement('div');
  header.className = 'band-row band-header';
  ['BAND', 'LEVEL', 'Δ TARGET', 'COH'].forEach((label, index) => {
    const span = document.createElement('span');
    span.textContent = label;
    if (index === 0) span.className = 'band-band';
    else if (index === 1) span.className = 'band-level';
    else if (index === 2) span.className = 'band-target';
    else span.className = 'band-coherence';
    header.appendChild(span);
  });
  rows.appendChild(header);

  readings.forEach((band) => {
    const row = document.createElement('div');
    row.className = 'band-row';

    const bandName = document.createElement('span');
    bandName.className = 'band-band';
    bandName.textContent = formatDecayFrequency(band.frequency);

    const level = document.createElement('span');
    level.className = 'band-level';
    level.textContent = band.levelDb.toFixed(1);
    level.classList.toggle('good', band.coherence > 0.8);
    level.classList.toggle('bad', band.coherence <= 0.5);

    const target = document.createElement('span');
    target.className = 'band-target';
    target.textContent = band.targetDelta === null
      ? '—'
      : (band.targetDelta >= 0 ? '+' : '') + band.targetDelta.toFixed(1);
    if (band.targetDelta !== null) target.classList.toggle('wide', Math.abs(band.targetDelta) > 3);

    const coherence = document.createElement('span');
    coherence.className = 'band-coherence';
    coherence.textContent = (band.coherence * 100).toFixed(0) + '%';
    coherence.classList.toggle('good', band.coherence > 0.8);
    coherence.classList.toggle('bad', band.coherence <= 0.5);

    row.append(bandName, level, target, coherence);
    rows.appendChild(row);
  });
}

function refreshBandTable(force) {
  if (!state.bandOpen) return false;
  const now = performance.now();
  if (!force && now - lastBandBuild < 500) return false;
  lastBandBuild = now;
  renderBandTable();
  return true;
}

function openBands() {
  state.bandOpen = true;
  lastBandBuild = performance.now();
  renderBandTable();
  $('bandSheet').hidden = false;
  updateSheetLock();
}

function closeBands() {
  state.bandOpen = false;
  closeSheet('bandSheet');
}

function updateGroupReadout() {
  const readout = $('groupReadout');
  const freq = groupDelayChart.cursorFreq;
  if (!state.results) {
    readout.textContent = 'Start a measurement to see group delay';
    return;
  }
  if (!freq) {
    readout.textContent = 'Tap the curve';
    return;
  }
  const label = frequencyLabel(freq);
  const value = groupDelayChart.valueAt(freq);
  readout.textContent = value === null
    ? label + ' · no reliable delay'
    : label + ' · ' + (value >= 0 ? '+' : '') + value.toFixed(2) + ' ms';
}

function refreshGroupDelay(force) {
  if (!state.groupDelayOpen) return false;
  if (!state.results) {
    const changed = groupDelayChart.data !== null;
    groupDelayChart.setResult(null);
    return changed || !!force;
  }
  const now = performance.now();
  if (!force && now - lastGroupDelayBuild < 500) return false;
  lastGroupDelayBuild = now;
  const cursor = groupDelayChart.cursorFreq;
  groupDelayChart.setResult(state.results);
  if (cursor) groupDelayChart.cursorFreq = cursor;
  return true;
}

function drawGroupDelay() {
  groupDelayChart.draw();
  updateGroupReadout();
}

function openGroupDelay() {
  state.groupDelayOpen = true;
  $('groupSheet').hidden = false;
  updateSheetLock();
  groupDelayChart.resize();
  refreshGroupDelay(true);
  drawGroupDelay();
  requestAnimationFrame(() => {
    groupDelayChart.resize();
    drawGroupDelay();
  });
}

function closeGroupDelay() {
  state.groupDelayOpen = false;
  closeSheet('groupSheet');
}

/* ---------- gate ---------- */

function setGate(start, width) {
  const clampedWidth = Math.min(Math.max(width, 0.2), 60);
  const clampedStart = Math.min(Math.max(start, -5), 55 - clampedWidth);
  state.gate.startMs = Number.isFinite(clampedStart) ? clampedStart : -0.5;
  state.gate.widthMs = Number.isFinite(clampedWidth) ? clampedWidth : 20;
  $('numGateStart').value = state.gate.startMs.toFixed(1);
  $('numGateWidth').value = state.gate.widthMs.toFixed(1);
  invalidateRoomInsights();
  if (state.spectrogramOpen) drawSpectrogram();
  draw();
}

function applyGateDrag(drag, deltaMs) {
  if (!drag) return;

  const clampStart = (start, width) => Math.min(Math.max(start, -5), 55 - width);
  let start = drag.startMs;
  let width = drag.widthMs;

  if (drag.mode === 'move') {
    start = clampStart(drag.startMs + deltaMs, width);
  } else if (drag.mode === 'start') {
    const end = drag.startMs + drag.widthMs;
    const newStart = Math.min(end - 0.2, drag.startMs + deltaMs);
    width = Math.max(0.2, end - newStart);
    start = clampStart(newStart, width);
  } else {
    width = Math.min(60, Math.max(0.2, drag.widthMs + deltaMs));
    start = clampStart(drag.startMs, width);
  }

  setGate(start, width);
}

function irPoint(event) {
  const rect = irChart.canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function irClampX(x) {
  const layout = irChart.layout;
  if (!layout) return x;
  return Math.min(layout.p.x + layout.p.w, Math.max(layout.p.x, x));
}

$('irChart').addEventListener('pointerdown', (event) => {
  if (!state.results || !irChart.layout) return;
  const point = irPoint(event);
  const plot = irChart.layout.p;
  let mode = 'zoom';

  if (state.gate.enabled) {
    const startX = irChart.xForMs(state.gate.startMs);
    const endX = irChart.xForMs(state.gate.startMs + state.gate.widthMs);
    const insidePlot = point.x >= plot.x && point.x <= plot.x + plot.w;
    const insideGate = point.x > Math.min(startX, endX) && point.x < Math.max(startX, endX);

    if (insidePlot && Math.abs(point.x - startX) <= 16) mode = 'start';
    else if (insidePlot && Math.abs(point.x - endX) <= 16) mode = 'end';
    else if (insideGate && point.y >= plot.y + plot.h - 24) mode = 'move';
  }

  const x = irClampX(point.x);
  irDrag = {
    pointerId: event.pointerId,
    mode,
    x,
    startX: x,
    currentX: x,
    startMs: state.gate.startMs,
    widthMs: state.gate.widthMs,
  };
  irChart.selection = mode === 'zoom' ? { x0: x, x1: x } : null;

  try {
    irChart.canvas.setPointerCapture(event.pointerId);
  } catch (err) {
    /* not every browser needs it */
  }
  event.preventDefault();
});

$('irChart').addEventListener('pointermove', (event) => {
  if (!irDrag || event.pointerId !== irDrag.pointerId) return;
  const point = irPoint(event);

  if (irDrag.mode === 'zoom') {
    irDrag.currentX = irClampX(point.x);
    draw();
    return;
  }

  applyGateDrag(irDrag, (point.x - irDrag.x) * irChart.msPerPixel());
});

function endIrDrag(event) {
  if (!irDrag || event.pointerId !== irDrag.pointerId) return;
  try {
    irChart.canvas.releasePointerCapture(event.pointerId);
  } catch (err) {
    /* the capture may already be gone */
  }

  const drag = irDrag;
  irDrag = null;
  irChart.selection = null;

  if (drag.mode === 'zoom' && Math.abs(drag.currentX - drag.startX) >= 10) {
    const lower = irChart.msAtX(Math.min(drag.startX, drag.currentX));
    const upper = irChart.msAtX(Math.max(drag.startX, drag.currentX));
    setIrZoom(lower, upper);
    return;
  }

  draw();
}

$('irChart').addEventListener('pointerup', endIrDrag);
$('irChart').addEventListener('pointercancel', endIrDrag);

/* ---------- charts ---------- */

/**
 * Ask for a redraw. Several handlers can change the same frame in one gesture
 * — moving the gate, dragging a slider, a fresh analysis frame — so they are
 * coalesced into a single paint per animation frame instead of each redrawing
 * both canvases.
 */
function draw() {
  if (drawRaf) return;
  drawRaf = requestAnimationFrame(() => {
    drawRaf = 0;
    drawNow();
  });
}

function drawNow() {
  const tfRange = state.tfZoom || { min: 20, max: 20000 };
  tfChart.setRange(tfRange.min, tfRange.max);
  tfChart.selection = tfDrag && tfDrag.moved ? { x0: tfDrag.startX, x1: tfDrag.currentX } : null;

  tfChart.draw(state.results, {
    showPhase: $('chkPhase').checked,
    showCoh: $('chkCoh').checked,
    snapshot: state.snapshot,
    secondSnapshot: state.snapshotB,
    peakHold: state.peakHoldArmed ? state.peakHold : null,
    average: state.average,
    averageCount: state.averageCaptures,
    savedCurves: overlaidCurves(),
    showCaptureAPhase: $('chkPhaseA').checked,
    showCaptureBPhase: $('chkPhaseB').checked,
    target: state.target,
    cursorFreq: state.cursorFreq,
  });

  irChart.zoom = state.irZoom;
  irChart.selection = irDrag && irDrag.mode === 'zoom'
    ? { x0: irDrag.startX, x1: irDrag.currentX }
    : null;
  irChart.draw(state.displayedImpulse, { gate: state.gate });
  updateGateBadge();
  updateTraceSummary();

  if (state.waterfallOpen) drawWaterfall();
  if (state.spectrogramOpen && refreshSpectrogram(false)) drawSpectrogram();
  if (state.groupDelayOpen && refreshGroupDelay(false)) drawGroupDelay();
  if (state.bandOpen) refreshBandTable(false);
}

function meanCoherence(res) {
  const df = res.sampleRate / res.fftSize;
  const k0 = Math.max(1, Math.round(200 / df));
  const k1 = Math.min(res.bins - 1, Math.round(10000 / df));
  let sum = 0;
  let count = 0;
  for (let k = k0; k <= k1; k++) {
    sum += res.coh[k];
    count += 1;
  }
  return count > 0 ? sum / count : 0;
}

function analyse() {
  if (!analyser || !engine.running) return;
  if (state.refMode === 'internal' && !engine.refAligned) return;
  const n = analyser.fftSize;
  const written = engine.micWritten;
  const end = written - 512;
  const start = end - n;
  if (start < 0) return;

  engine.readChannel(micWin, start, state.micChannel);

  const refStart = start - state.delayEstimate;
  if (refStart < 0) {
    if (state.delayAuto && state.delayEstimate > 0) {
      state.delayEstimate = 0;
      state.delayLockedAt = 0;
      state.delayProbedAt = 0;
      analyser.reset();
      $('numDelay').value = '0.00';
    }
    return;
  }

  if (state.refMode === 'loopback') {
    engine.readChannel(refWin, refStart, state.refChannel);
  } else {
    engine.readGeneratedRef(refWin, refStart);
  }

  analyser.updateRate = averagingRate();
  const tracking = state.delayAuto && state.delayLockedAt > 0;
  analyser.searchRadius = tracking ? fineSearchRadius(n) : 0;
  analyser.accumulate(micWin, refWin);

  const res = analyser.results({
    compensate: state.compensate,
    smoothing: state.smoothing,
    normalize: state.normalize,
    gate: state.gate,
  });

  state.results = res;
  if (state.peakHoldArmed) state.peakHold = mergePeakHold(state.peakHold, res);

  if (!state.checkingNoise && maybeLockDelay(res)) return;
  syncDisplayedImpulse();
  if (state.showSpectrograph) liveSpectrograph.add(microphoneSpectrum(micWin, engine.sampleRate));
  updateReadouts(res);
  updateInterfaceInfo();
  refreshRoomInsights(false);

  eqTick += 1;
  if (eqTick % 12 === 0) updateEq(res);

  refreshWaterfall(false);
  draw();
}

/* ---------- readouts ---------- */

function noiseFloorText() {
  if (state.noiseFloorDb === null) return null;
  return (state.noiseFloorDb + (state.showSpl ? state.calibrationDb : 0)).toFixed(1) +
    (state.showSpl ? ' dB SPL' : ' dBFS');
}

function noiseHeadroomText() {
  if (state.noiseFloorDb === null || !Number.isFinite(state.noiseHeadroomDb)) return '';
  return state.noiseHeadroomDb >= 0
    ? ' · signal ' + state.noiseHeadroomDb.toFixed(0) + ' dB above it'
    : ' · signal ' + Math.abs(state.noiseHeadroomDb).toFixed(0) + ' dB below the noise floor';
}

function updateNoiseReadout() {
  const floor = noiseFloorText();
  $('rdNoise').textContent = floor || '—';

  const report = $('noiseReport');
  if (!report) return;
  if (!floor) {
    report.textContent = '';
    report.hidden = true;
    return;
  }
  report.textContent = 'Noise floor ' + floor + noiseHeadroomText();
  report.hidden = false;
}

async function checkNoise() {
  if (state.checkingNoise) return;
  if (!engine.running || state.demo) {
    setStatus('Start a real microphone measurement to check noise', 'err');
    return;
  }

  state.checkingNoise = true;
  const button = $('btnCheckNoise');
  button.disabled = true;
  button.textContent = 'Checking…';

  const signal = state.signal;
  const context = engine.ctx;
  const channel = state.micChannel;
  const level = engine.channelLevel[channel] || 0;
  const signalDb = level > 0 ? 20 * Math.log10(level) : -Infinity;
  const samples = [];
  let interrupted = false;

  try {
    engine.setSignal('silent');
    setStatus('Checking room noise — output silent for 3 seconds');
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!engine.running || engine.ctx !== context || state.demo) {
        interrupted = true;
        break;
      }
      // Let the previous stimulus decay before collecting the room.
      if (i >= 5) samples.push(engine.channelLevel[channel] || 0);
    }
  } catch (err) {
    setStatus('Could not check noise: ' + (err && err.message ? err.message : err), 'err');
    return;
  } finally {
    if (!interrupted && engine.running && engine.ctx === context && !state.demo) {
      engine.setSignal(signal);
      // A generated stimulus is a new buffer on restore, so the running
      // average has to start again rather than carry the old correlation.
      if (state.refMode === 'internal' && analyser) analyser.reset();
    }
    state.checkingNoise = false;
    button.disabled = false;
    button.textContent = 'Check noise';
  }

  if (interrupted || !engine.running || !samples.length) return;

  const power = samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length;
  if (!(power > 0)) {
    setStatus('Input stayed silent — check the input routing', 'err');
    return;
  }

  state.noiseFloorDb = 10 * Math.log10(power);
  state.noiseHeadroomDb = Number.isFinite(signalDb) ? signalDb - state.noiseFloorDb : null;
  updateNoiseReadout();
  setStatus('Noise floor ' + noiseFloorText() + noiseHeadroomText(), 'ok');
}

/** Keep the spectrograph's labels honest about where the signal comes from. */
function refreshSpectrographLabels() {
  const key = state.demo ? 'demo' : state.running ? 'live' : 'idle';
  if (key === spectrographKey) return;
  spectrographKey = key;

  const source = $('spectrographSource');
  const note = $('spectrographNote');
  if (source && note) {
    if (key === 'demo') {
      source.textContent = 'demo signal · dBFS · not microphone audio';
      note.textContent = 'The demo generates its own signal, so this is not measured microphone audio. Frequency across, time down.';
    } else {
      source.textContent = 'selected input · dBFS';
      note.textContent = 'Frequency across, time down. This is the selected input, not the impulse-decay spectrogram.';
    }
  }

  liveSpectrograph.setMessage(
    key === 'demo' ? 'Synthetic demo signal' : key === 'live' ? 'Collecting input…' : 'Start the measurement',
  );
}

function setSpectrographShown(show) {
  state.showSpectrograph = !!show;
  $('chkSpectrograph').checked = state.showSpectrograph;
  $('chkSpectrographAnalysis').checked = state.showSpectrograph;
  $('spectrographCard').hidden = !state.showSpectrograph;

  if (!state.showSpectrograph) {
    liveSpectrograph.clear();
    return;
  }
  spectrographKey = '';
  refreshSpectrographLabels();
  liveSpectrograph.draw();
}

function updateLargeMeter() {
  const reading = state.running ? levelReadout() : '— ' + (state.showSpl ? 'dB SPL' : 'dBFS');
  const unit = state.showSpl ? 'dB SPL' : 'dBFS';
  const number = $('meterNumber');
  number.textContent = reading.replace(' ' + unit, '');
  $('meterUnit').textContent = unit;
  $('meterHeading').textContent = state.demo
    ? 'DEMO SIGNAL LEVEL'
    : state.showSpl ? 'SOUND PRESSURE LEVEL' : 'INPUT LEVEL';

  const level = state.demo ? demoLevel : engine.channelLevel[state.micChannel] || 0;
  $('meterLargeBar').style.width = (state.running ? meterPercent(level) : 0) + '%';
  $('btnMeterPower').textContent = state.running ? 'Stop measurement' : 'Start measurement';

  const clipped = !state.demo && engine.running
    ? engine.channelClippedUntil.map((until, i) => until > Date.now() ? i + 1 : null).filter(Boolean)
    : [];
  const clippedNames = clipped.map((number) => 'Input ' + number);
  const clippedSubject = clippedNames.length > 1
    ? clippedNames.slice(0, -1).join(', ') + ' and ' + clippedNames[clippedNames.length - 1]
    : clippedNames[0] || '';
  const warning = clipped.length
    ? clippedSubject + (clipped.length > 1 ? ' are clipping' : ' is clipping') +
      ' — lower the source or interface gain.'
    : '';
  number.classList.toggle('clipped', !!warning);
  $('meterLargeBar').classList.toggle('clipped', !!warning);
  for (const id of ['inputClipping', 'meterClipping']) {
    $(id).textContent = warning;
    $(id).hidden = !warning;
  }

  const source = $('meterSource');
  if (source) {
    if (state.demo) {
      source.textContent = 'Demo measurement: this level is synthetic and not microphone audio.';
    } else if (state.running) {
      source.textContent = 'Selected input ' + (state.micChannel + 1) +
        (state.showSpl
          ? ' · sound pressure using the calibration offset.'
          : ' · dBFS, before calibration.');
    } else {
      source.textContent = 'Start a measurement to read the selected input.';
    }
  }
}

function levelReadout() {
  const level = state.demo ? demoLevel : engine.channelLevel[state.micChannel] || 0;
  const dbfs = level > 0 ? 20 * Math.log10(level) : -Infinity;
  const unit = state.showSpl ? 'dB SPL' : 'dBFS';
  if (!Number.isFinite(dbfs)) return '-inf ' + unit;
  const value = state.showSpl ? dbfs + state.calibrationDb : dbfs;
  return value.toFixed(1) + ' ' + unit;
}

function updateReadouts(res) {
  const offsetMs = (state.delayEstimate / analyser.sampleRate) * 1000;
  const totalMs = offsetMs + res.delayMs;
  state.totalDelayMs = totalMs;

  $('rdDelay').textContent = totalMs.toFixed(2) + ' ms';

  const polarity = $('rdPolarity');
  if (res.polarityKnown) {
    polarity.textContent = res.polarity > 0 ? 'normal' : 'inverted';
    polarity.className = 'v ' + (res.polarity > 0 ? 'good' : 'bad');
  } else {
    polarity.textContent = '—';
    polarity.className = 'v';
  }

  const coherence = meanCoherence(res);
  const coherenceEl = $('rdCoh');
  coherenceEl.textContent = (coherence * 100).toFixed(0) + '%';
  coherenceEl.className = 'v ' + (coherence > 0.8 ? 'good' : coherence > 0.5 ? '' : 'bad');

  if (!state.checkingNoise) {
    if (!state.demo && state.refMode === 'loopback' && state.micChannel === state.refChannel) {
      setStatus('measurement and reference use the same input', 'err');
    } else if (!state.demo && state.refMode === 'loopback' && res.frames > 20 && coherence < 0.2) {
      setStatus('reference input is silent — check the loopback routing', 'err');
    } else if (!state.demo) {
      const jitterMs = (res.delayJitterSamples / res.sampleRate) * 1000;
      if (res.frames > 20 && jitterMs > 2) {
        if (!jitterWarned) {
          jitterWarned = true;
          setStatus(
            'delay keeps moving (' +
              jitterMs.toFixed(1) +
              ' ms) — the path is not steady; lower the level, keep the phone still, or use a cable or USB input',
            'err',
          );
        }
      } else if (jitterWarned) {
        jitterWarned = false;
        reportInput();
      }
    }
  }

  $('rdLevel').textContent = levelReadout();
  updateLargeMeter();
  $('rdRate').textContent = (res.sampleRate / 1000).toFixed(1) + 'k · ' + res.df.toFixed(1) + ' Hz';

  $('rdDelta').textContent = state.snapshot
    ? (totalMs - state.snapshot.delayMs).toFixed(2) + ' ms'
    : '—';
  $('rdDeltaB').textContent = state.snapshotB
    ? (totalMs - state.snapshotB.delayMs).toFixed(2) + ' ms'
    : '—';

  updateDelayAdvice();

  $('irReadout').textContent = 'delay ' + totalMs.toFixed(2) + ' ms';
  $('btnWaterfall').disabled = false;
  $('btnExportCsv').disabled = false;
  $('btnShareChart').disabled = false;
  $('btnShareReport').disabled = false;
  $('btnSaveCurrent').disabled = false;

  updateCursorReadout();
}

function updateCursorReadout() {
  const res = state.results;
  const freq = state.cursorFreq;
  const readout = $('readout');

  if (!res || !freq) {
    readout.textContent = 'tap the plot';
    return;
  }

  const k = Math.min(res.bins - 1, Math.max(0, Math.round(freq / res.df)));
  const label = freq >= 1000 ? (freq / 1000).toFixed(2) + ' kHz' : freq.toFixed(0) + ' Hz';
  let text =
    label +
    ' · ' +
    res.magDb[k].toFixed(1) +
    ' dB · ' +
    wrapDegrees(res.phaseDeg[k]).toFixed(0) +
    '° · coh ' +
    (res.coh[k] * 100).toFixed(0) +
    '%';

  if (state.target) {
    const delta = res.magDb[k] - targetDb(state.target, freq);
    text += ' · Δ target ' + (delta >= 0 ? '+' : '') + delta.toFixed(1) + ' dB';
  }

  const comparisons = [];
  if (state.snapshot) comparisons.push('Δ phase vs A ' + phaseDifference(res, state.snapshot, freq));
  if (state.snapshotB) comparisons.push('Δ phase vs B ' + phaseDifference(res, state.snapshotB, freq));
  if (comparisons.length) text += '\n' + comparisons.join(' · ');

  readout.textContent = text;
}

/**
 * The phase at one frequency, interpolated between the two bins either side and
 * only where both are coherent enough to mean anything.
 */
function coherentPhaseAt(trace, frequency) {
  if (!trace || !(trace.fftSize > 0) || !(trace.bins > 1)) return null;
  const df = trace.sampleRate / trace.fftSize;
  const position = frequency / df;
  if (!(df > 0) || !Number.isFinite(position) || position < 0 || position > trace.bins - 1) return null;

  const lower = Math.floor(position);
  const upper = Math.min(trace.bins - 1, lower + 1);
  if (!(trace.coh[lower] >= 0.35) || !(trace.coh[upper] >= 0.35)) return null;
  if (!Number.isFinite(trace.phaseDeg[lower]) || !Number.isFinite(trace.phaseDeg[upper])) return null;

  const fraction = position - lower;
  return trace.phaseDeg[lower] * (1 - fraction) + trace.phaseDeg[upper] * fraction;
}

/** The live phase minus a held capture's, after that capture's preview delay. */
function phaseDifference(live, held, frequency) {
  const livePhase = coherentPhaseAt(live, frequency);
  const heldPhase = coherentPhaseAt(held, frequency);
  if (livePhase === null || heldPhase === null) return '—';

  const previewed = heldPhase - 360 * frequency * (held.previewDelayMs || 0) / 1000;
  const difference = wrapDegrees(livePhase - previewed);
  return (difference >= 0 ? '+' : '') + difference.toFixed(0) + '°';
}

function meterPercent(rms) {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
}

function updateInterfaceInfo() {
  updateLargeMeter();
  refreshSpectrographLabels();
  const deviceEl = $('rdDevice');
  const channelsEl = $('rdChannels');
  const countEl = $('rdChannelCount');
  const meter1 = $('meter1');
  const meter2 = $('meter2');

  if (state.demo) {
    deviceEl.textContent = 'demo measurement (no microphone)';
    channelsEl.textContent = '1 ch · ' + Math.round(DEMO_RATE / 1000) + ' kHz';
    countEl.textContent = '1 ch';
    meter1.style.width = meterPercent(demoLevel) + '%';
    meter2.style.width = '0%';
    return;
  }

  if (!engine.running) {
    deviceEl.textContent = 'no input yet';
    channelsEl.textContent = '—';
    countEl.textContent = '—';
    meter1.style.width = '0%';
    meter2.style.width = '0%';
    return;
  }

  deviceEl.textContent = engine.deviceLabel || 'audio input';
  const count = engine.deviceChannels || 1;
  channelsEl.textContent = count + ' ch · ' + Math.round(engine.sampleRate / 1000) + ' kHz';
  countEl.textContent = count + ' ch';
  meter1.style.width = meterPercent(engine.channelLevel[0]) + '%';
  meter2.style.width = meterPercent(engine.channelLevel[1]) + '%';
}

function updateEq(res) {
  const list = $('eqList');
  list.textContent = '';

  let items = [];
  try {
    items = suggestEq(res.magDb, res.coh, res.sampleRate, res.fftSize);
  } catch (err) {
    items = [];
  }
  state.eq = items;

  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Response is within ±3 dB of the local average.';
    list.appendChild(li);
    return;
  }

  items.forEach((item) => {
    const li = document.createElement('li');
    const freq = document.createElement('span');
    freq.textContent = item.freq >= 1000 ? (item.freq / 1000).toFixed(1) + ' kHz' : item.freq.toFixed(0) + ' Hz';
    const gain = document.createElement('span');
    gain.textContent = (item.gain > 0 ? '+' : '') + item.gain.toFixed(1) + ' dB';
    li.appendChild(freq);
    li.appendChild(gain);
    list.appendChild(li);
  });
}

/* ---------- running ---------- */

async function startAll() {
  if (starting) return;

  if (state.demo) stopDemo();

  if (inAppBrowser && !allowStartHere) {
    showSafariBanner();
    setStatus('copy this link into Safari first', 'err');
    const banner = $('safariBanner');
    if (banner && banner.scrollIntoView) banner.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }

  starting = true;

  const button = $('btnPower');
  button.disabled = true;
  setStatus('starting…');

  let channels = 1;
  try {
    channels = await engine.start(
      Object.assign(sourceOptions(), { onProgress: (text) => setStatus(text) }),
    );
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    setStatus(message, 'err');
    showAudioHelp('Audio could not start: ' + message);
    engine.stop();
    state.running = false;
    button.textContent = 'Start';
    button.classList.remove('on');
    button.disabled = false;
    starting = false;
    updateInterfaceInfo();
    return;
  }

  buildAnalyser();
  engine.setSignal(state.signal);
  engine.setSineHz(state.sineHz);

  const mono = channels < 2;
  if (mono && state.refMode === 'loopback') {
    state.refMode = 'internal';
    $('selRef').value = 'internal';
  }
  if (mono && state.micChannel !== 0) state.micChannel = 0;

  $('selMicCh').value = String(state.micChannel);
  $('selMicCh').options[1].disabled = mono;
  $('selRef').options[1].disabled = mono;
  $('selRefCh').disabled = mono;

  state.running = true;
  state.delayEstimate = 0;
  state.delayLockedAt = 0;
  state.delayProbedAt = 0;
  state.delayAuto = true;
  state.results = null;
  state.waterfall = null;
  state.noiseFloorDb = null;
  state.noiseHeadroomDb = null;
  updateNoiseReadout();
  jitterWarned = false;
  $('numDelay').value = '0.00';
  resetTraces();
  if (state.showSpectrograph) liveSpectrograph.clear();

  button.textContent = 'Stop';
  button.classList.add('on');
  button.disabled = false;

  hideAudioHelp();
  reportInput();
  updateInterfaceInfo();
  listDevices();
  lastAnalysis = 0;
  starting = false;

  if (!rafId) rafId = requestAnimationFrame(loop);
}

function loop(now) {
  rafId = requestAnimationFrame(loop);
  if (!state.running || document.hidden) return;
  // The noise check silences the source; hold the analysis rather than feed
  // three seconds of silence into the running average.
  if (state.checkingNoise) return;
  if (now - lastAnalysis < 90) return;
  lastAnalysis = now;
  analyse();
}

function stopAll() {
  if (state.demo) stopDemo();
  state.running = false;
  engine.stop();
  state.results = null;
  state.waterfall = null;
  syncDisplayedImpulse();
  if (state.showSpectrograph) liveSpectrograph.clear();
  resetRoomInsights();
  state.delayEstimate = 0;
  state.delayLockedAt = 0;
  state.delayProbedAt = 0;
  jitterWarned = false;
  $('btnWaterfall').disabled = false;
  $('btnExportCsv').disabled = true;
  $('btnShareChart').disabled = true;
  $('btnShareReport').disabled = true;
  renderSaved(); // A/B remain available to name and save after stopping.

  const button = $('btnPower');
  button.textContent = 'Start';
  button.classList.remove('on');
  setStatus('idle');
  updateInterfaceInfo();
  draw();
}

async function listDevices() {
  const select = $('selSource');
  if (!select) return;

  let inputs = [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    inputs = devices.filter((device) => device.kind === 'audioinput' && device.deviceId);
  } catch (err) {
    inputs = [];
  }

  const make = (value, text) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    return option;
  };

  select.textContent = '';
  select.appendChild(make('auto', 'Automatic (system route)'));
  select.appendChild(make('phone', 'iPhone microphone'));
  select.appendChild(make('interface', 'USB audio interface'));

  if (inputs.length > 0) {
    const group = document.createElement('optgroup');
    group.label = 'Detected inputs';
    inputs.forEach((device, index) => {
      group.appendChild(make('device:' + device.deviceId, device.label || 'Input ' + (index + 1)));
    });
    select.appendChild(group);
  }

  const values = Array.prototype.map.call(select.options, (option) => option.value);
  if (values.indexOf(state.inputSource) < 0) state.inputSource = 'auto';
  select.value = state.inputSource;
}

/* ---------- delay probe ---------- */

const PROBE_SIZE = 131072;

function probeDelay() {
  if (!engine.running) return null;
  if (state.refMode === 'internal' && !engine.refAligned) return null;

  const offset = state.delayEstimate;
  const written = engine.micWritten;
  const start = written - 512 - PROBE_SIZE;
  if (start < 0 || start - offset < 0) return null;

  const mic = new Float32Array(PROBE_SIZE);
  const ref = new Float32Array(PROBE_SIZE);

  engine.readChannel(mic, start, state.micChannel);
  if (state.refMode === 'loopback') {
    engine.readChannel(ref, start - offset, state.refChannel);
  } else {
    engine.readGeneratedRef(ref, start - offset);
  }

  const probe = new Analyser(PROBE_SIZE, engine.sampleRate);
  probe.updateRate = 1;
  probe.searchRadius = 0;
  probe.accumulate(mic, ref);
  const res = probe.results({ compensate: false, smoothing: 0, normalize: false });

  const ambiguous = Math.abs(probe.peakIndex) > PROBE_SIZE / 2 - 1024;
  return { samples: offset + probe.peakIndex, confidence: meanCoherence(res), ambiguous };
}

function applyDelayLock(probe) {
  const total = Math.round(probe.samples);
  if (total < 0 && state.refMode !== 'internal') return null;

  state.delayEstimate = total;
  state.delayLockedAt = engine.micWritten;
  if (analyser) analyser.reset();

  const ms = (total / engine.sampleRate) * 1000;
  $('numDelay').value = ms.toFixed(2);
  return ms;
}

function maybeLockDelay(res) {
  if (state.demo || !engine.running || !state.delayAuto) return false;
  if (state.refMode === 'internal' && !engine.refAligned) return false;
  if (state.signal === 'sine') return false;

  const now = engine.micWritten;
  const wait = engine.sampleRate * 2;
  if (now - state.delayLockedAt < wait) return false;
  if (now - state.delayProbedAt < wait) return false;

  const residual = Number.isFinite(res.delayMedianSamples)
    ? Math.abs(res.delayMedianSamples)
    : Infinity;
  if (residual < res.fftSize / 8 - 2) return false;

  const probe = probeDelay();
  if (!probe) return false;
  state.delayProbedAt = now;

  if (probe.ambiguous || probe.confidence < 0.35) return false;
  if (probe.samples < 0 && state.refMode !== 'internal') return false;

  const ms = applyDelayLock(probe);
  if (ms === null) return false;
  setStatus('delay locked at ' + ms.toFixed(2) + ' ms', 'ok');
  return true;
}

function findDelay() {
  if (!engine.running) {
    setStatus('start the audio first', 'err');
    return;
  }

  const probe = probeDelay();
  if (!probe) {
    setStatus('collecting — try again in a moment');
    return;
  }

  if (probe.ambiguous) {
    setStatus('the delay is outside the ' + PROBE_SIZE + '-sample window — check the routing', 'err');
    return;
  }

  const ms = applyDelayLock(probe);
  if (ms === null) {
    setStatus('the reference would be read ahead of the capture — check the routing', 'err');
    return;
  }

  state.delayAuto = false;
  setStatus('delay locked at ' + ms.toFixed(2) + ' ms', 'ok');
}

/* ---------- wiring ---------- */

$('btnPower').addEventListener('click', () => {
  if (state.running && !state.demo) {
    stopAll();
    return;
  }
  startAll();
});

$('selSignal').addEventListener('change', (event) => {
  state.signal = event.target.value;
  $('rowSine').hidden = state.signal !== 'sine';
  engine.setSignal(state.signal);
  if (analyser) analyser.reset();
});

$('rngLevel').addEventListener('input', (event) => {
  const value = Number(event.target.value);
  state.level = value / 100;
  $('lblLevel').textContent = value + '%';
  engine.setLevel(state.level);
});

$('numSine').addEventListener('change', (event) => {
  const hz = Number(event.target.value);
  if (!Number.isFinite(hz) || hz < 20 || hz > 20000) return;
  state.sineHz = hz;
  engine.setSineHz(hz);
  if (analyser) analyser.reset();
});

$('selRef').addEventListener('change', (event) => {
  state.refMode = event.target.value;
  state.delayEstimate = 0;
  state.delayLockedAt = 0;
  state.delayProbedAt = 0;
  state.delayAuto = true;
  $('numDelay').value = '0.00';
  if (analyser) analyser.reset();
  if (state.refMode === 'loopback') setStatus('reference is input 2', 'ok');
});

$('selFft').addEventListener('change', (event) => {
  state.fftSize = Number(event.target.value);
  if (state.running) {
    buildAnalyser();
    setStatus('FFT ' + state.fftSize, 'ok');
  }
});

$('rngAvg').addEventListener('input', (event) => {
  state.avgSpeed = Number(event.target.value);
  $('lblAvg').textContent = state.avgSpeed + '%';
  if (analyser) analyser.updateRate = averagingRate();
});

$('selSmooth').addEventListener('change', (event) => {
  const n = Number(event.target.value);
  state.smoothing = n > 0 ? 1 / n : 0;
});

$('chkNormalize').addEventListener('change', (event) => {
  state.normalize = event.target.checked;
});

$('chkCompensate').addEventListener('change', (event) => {
  state.compensate = event.target.checked;
});

$('chkSpectrograph').addEventListener('change', (event) => {
  setSpectrographShown(event.target.checked);
});
$('chkSpectrographAnalysis').addEventListener('change', (event) => {
  setSpectrographShown(event.target.checked);
});
$('btnLargeMeter').addEventListener('click', () => {
  $('meterSheet').hidden = false;
  updateSheetLock();
  updateLargeMeter();
});
$('btnCloseMeter').addEventListener('click', () => closeSheet('meterSheet'));
$('chkMeterSpl').addEventListener('change', (event) => {
  state.showSpl = event.target.checked;
  $('chkSpl').checked = state.showSpl;
  write(STORAGE.spl, state.showSpl ? '1' : '0');
  $('rdLevel').textContent = levelReadout();
  updateNoiseReadout();
  updateLargeMeter();
});
$('btnMeterPower').addEventListener('click', () => {
  if (state.running) stopAll();
  else startAll();
});
$('chkPhase').addEventListener('change', () => {
  updatePhaseToggleState();
  draw();
});
$('chkCoh').addEventListener('change', () => draw());
$('btnTfReset').addEventListener('click', resetTfZoom);
$('btnIrReset').addEventListener('click', resetIrZoom);
$('btnIrHold').addEventListener('click', toggleIrHold);
$('selIrRefresh').addEventListener('change', (event) => {
  const value = Number(event.target.value);
  if (!Number.isFinite(value) || value <= 0) return;
  state.irRefreshSeconds = value;
  lastIrRefresh = 0;
});
$('btnFindDelay').addEventListener('click', findDelay);
$('btnCheckNoise').addEventListener('click', checkNoise);

$('selTarget').addEventListener('change', (event) => {
  state.target = event.target.value || null;
  write(STORAGE.target, state.target || '');
  $('targetHint').hidden = !state.target;
  updateCursorReadout();
  draw();
});

$('numCalibration').addEventListener('change', (event) => {
  const value = Number(event.target.value);
  if (!Number.isFinite(value)) return;
  state.calibrationDb = value;
  write(STORAGE.calibration, value);
  $('rdLevel').textContent = levelReadout();
  updateNoiseReadout();
  updateLargeMeter();
});

$('chkSpl').addEventListener('change', (event) => {
  state.showSpl = event.target.checked;
  write(STORAGE.spl, state.showSpl ? '1' : '0');
  $('rdLevel').textContent = levelReadout();
  $('chkMeterSpl').checked = state.showSpl;
  updateNoiseReadout();
  updateLargeMeter();
});

$('chkGate').addEventListener('change', (event) => {
  state.gate.enabled = event.target.checked;
  $('numGateStart').disabled = !state.gate.enabled;
  $('numGateWidth').disabled = !state.gate.enabled;
  invalidateRoomInsights();
  if (state.spectrogramOpen) drawSpectrogram();
  draw();
});

$('numGateStart').addEventListener('change', () => {
  const value = parseFloat($('numGateStart').value);
  if (!Number.isFinite(value)) return;
  setGate(value, state.gate.widthMs);
});

$('numGateWidth').addEventListener('change', () => {
  const value = parseFloat($('numGateWidth').value);
  if (!Number.isFinite(value)) return;
  setGate(state.gate.startMs, value);
});

$('numDelay').addEventListener('change', () => {
  const ms = parseFloat($('numDelay').value);
  if (!Number.isFinite(ms)) return;
  const rate = state.demo ? DEMO_RATE : engine.sampleRate;
  state.delayEstimate = Math.round((ms / 1000) * rate);
  state.delayAuto = false;
  state.delayLockedAt = engine.micWritten;
  if (analyser) analyser.reset();
});

$('btnCapture').addEventListener('click', captureA);
$('btnClearA').addEventListener('click', clearA);
$('btnCaptureB').addEventListener('click', captureB);
$('btnClearB').addEventListener('click', clearB);
$('btnArmPeak').addEventListener('click', armPeakHold);
$('btnClearPeak').addEventListener('click', clearPeakHold);
$('btnArmAverage').addEventListener('click', armAverage);
$('btnCaptureAverage').addEventListener('click', captureAverage);
$('btnClearAverage').addEventListener('click', clearAverage);
$('btnSaved').addEventListener('click', openSaved);
$('btnCloseSaved').addEventListener('click', () => closeSheet('savedSheet'));
$('btnSaveCurrent').addEventListener('click', saveCurrent);
$('savedSearch').addEventListener('input', renderSaved);
$('savedSource').addEventListener('change', () => {
  const field = $('savedName');
  const suggestion = suggestedCaptureName($('savedSource').value);
  if (!field.value.trim() || field.value === field.dataset.suggestion) {
    field.value = suggestion;
  }
  field.dataset.suggestion = suggestion;
  renderSaved();
});
for (const id of ['savedName', 'savedNote']) {
  $(id).addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    saveCurrent();
  });
}
$('btnClearSavedOverlays').addEventListener('click', () => {
  state.overlaidSavedIds = [];
  setLibraryError('');
  renderSaved(); renderSavedOverlayControls(); draw();
});
$('chkPhaseA').addEventListener('change', draw);
$('chkPhaseB').addEventListener('change', draw);
$('btnExportCsv').addEventListener('click', exportCSV);
$('btnWaterfall').addEventListener('click', openWaterfall);
$('btnCloseWaterfall').addEventListener('click', closeWaterfall);
$('btnSpectrogram').addEventListener('click', openSpectrogram);
$('btnCloseSpectrogram').addEventListener('click', closeSpectrogram);
$('btnBands').addEventListener('click', openBands);
$('btnCloseBands').addEventListener('click', closeBands);
$('btnGroupDelay').addEventListener('click', openGroupDelay);
$('btnCloseGroup').addEventListener('click', closeGroupDelay);
$('btnApplyDelay').addEventListener('click', applyRecommendedDelay);
$('btnPresets').addEventListener('click', openPresets);
$('btnClosePresets').addEventListener('click', closePresets);
$('btnSavePreset').addEventListener('click', savePresetFromCurrent);
$('presetSearch').addEventListener('input', renderPresets);
$('btnShareChart').addEventListener('click', shareChartImage);
$('btnShareReport').addEventListener('click', shareReport);

function groupPointer(event) {
  if (!state.groupDelayOpen) return;
  const rect = groupDelayChart.canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  groupDelayChart.cursorFreq = groupDelayChart.freqAtX(x);
  updateGroupReadout();
  groupDelayChart.draw();
}
$('groupChart').addEventListener('pointerdown', groupPointer);
$('groupChart').addEventListener('pointermove', groupPointer);

$('wfRange').addEventListener('input', (event) => {
  state.waterfallRangeMs = Number(event.target.value);
  updateWaterfallLabels();
  refreshWaterfall(true);
  drawWaterfall();
});

$('spRange').addEventListener('input', (event) => {
  const value = Number(event.target.value);
  if (!Number.isFinite(value)) return;
  state.spectrogramRangeMs = Math.max(0, Math.min(50, value));
  updateSpectrogramLabels();
  scheduleSpectrogramRebuild();
});

$('wfAmp').addEventListener('input', (event) => {
  state.waterfallAmplitude = Number(event.target.value);
  updateWaterfallLabels();
  drawWaterfall();
});

$('selSource').addEventListener('change', (event) => {
  state.inputSource = event.target.value;
  if (state.running) {
    setStatus('switching input…');
    startAll();
  }
});

$('selMicCh').addEventListener('change', (event) => {
  const channel = Number(event.target.value);
  if (channel === 1 && engine.deviceChannels < 2) {
    event.target.value = '0';
    state.micChannel = 0;
    setStatus('this input has only one channel', 'err');
    return;
  }
  state.micChannel = channel;
  state.noiseFloorDb = null;
  state.noiseHeadroomDb = null;
  updateNoiseReadout();
  if (analyser) analyser.reset();
});

$('selRefCh').addEventListener('change', (event) => {
  state.refChannel = Number(event.target.value);
  if (analyser) analyser.reset();
});

$('btnRestart').addEventListener('click', () => {
  startAll();
});

$('btnHideHelp').addEventListener('click', () => {
  hideAudioHelp();
  setStatus('idle');
});

$('btnCopyLink').addEventListener('click', () => {
  copyLink();
});

$('btnCopySafari').addEventListener('click', () => {
  copyLink();
});

$('btnTryHere').addEventListener('click', () => {
  allowStartHere = true;
  hideSafariBanner();
  setStatus('trying audio in this browser…');
  startAll();
});

$('btnDemo').addEventListener('click', () => {
  if (state.demo) stopDemo();
  else startDemo();
});

$('btnDemoHere').addEventListener('click', () => {
  startDemo();
});

$('btnShare').addEventListener('click', () => {
  shareApp();
});

$('btnShareApp').addEventListener('click', () => {
  shareApp();
});

$('btnCopyApp').addEventListener('click', () => {
  copyAppLink();
});

$('btnShareResult').addEventListener('click', () => {
  shareMeasurement();
});

$('btnCopyResult').addEventListener('click', () => {
  copyMeasurement();
});

$('btnHideInstall').addEventListener('click', () => {
  const card = $('installCard');
  if (card) card.hidden = true;
  try {
    window.localStorage.setItem(INSTALL_HINT_KEY, '1');
  } catch (err) {
    /* private browsing: the card comes back next launch */
  }
});

if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    listDevices();
    if (state.running) setStatus('audio device changed — press Restart', 'err');
  });
}

function tfPoint(event) {
  const rect = tfChart.canvas.getBoundingClientRect();
  return event.clientX - rect.left;
}

$('tfChart').addEventListener('pointerdown', (event) => {
  if (!state.results) return;
  const x = tfPoint(event);
  tfDrag = { pointerId: event.pointerId, startX: x, currentX: x, moved: false };
  state.cursorFreq = tfChart.freqAtX(x);
  updateCursorReadout();
  try {
    tfChart.canvas.setPointerCapture(event.pointerId);
  } catch (err) {
    /* not every browser needs it */
  }
  event.preventDefault();
  draw();
});

function endTfDrag(event) {
  if (!tfDrag || event.pointerId !== tfDrag.pointerId) return;
  try {
    tfChart.canvas.releasePointerCapture(event.pointerId);
  } catch (err) {
    /* the capture may already be gone */
  }

  const drag = tfDrag;
  tfDrag = null;

  if (drag.moved) {
    const lower = tfChart.freqAtX(Math.min(drag.startX, drag.currentX));
    const upper = tfChart.freqAtX(Math.max(drag.startX, drag.currentX));
    if (upper / lower >= 1.08) {
      setTfZoom(lower, upper);
      return;
    }
  }
  draw();
}

$('tfChart').addEventListener('pointermove', (event) => {
  if (!state.results) return;
  const x = tfPoint(event);

  if (tfDrag && event.pointerId === tfDrag.pointerId) {
    tfDrag.currentX = x;
    if (Math.abs(x - tfDrag.startX) >= 10) tfDrag.moved = true;
    if (!tfDrag.moved) {
      state.cursorFreq = tfChart.freqAtX(x);
      updateCursorReadout();
    }
    draw();
    return;
  }

  state.cursorFreq = tfChart.freqAtX(x);
  updateCursorReadout();
  draw();
});

$('tfChart').addEventListener('pointerup', endTfDrag);
$('tfChart').addEventListener('pointercancel', endTfDrag);

$('tfChart').addEventListener('pointerleave', () => {
  if (tfDrag) return;
  state.cursorFreq = null;
  updateCursorReadout();
  draw();
});

window.addEventListener('resize', () => {
  tfChart.resize();
  irChart.resize();
  wfChart.resize();
  spectrogramChart.resize();
  groupDelayChart.resize();
  if (state.showSpectrograph) liveSpectrograph.draw();
  if (state.spectrogramOpen) drawSpectrogram();
  if (state.groupDelayOpen) drawGroupDelay();
  draw();
});

/* ---------- initial state ---------- */

const targetSelect = $('selTarget');
while (targetSelect.options.length > 1) targetSelect.remove(1);
TARGET_CURVES.forEach((curve) => {
  const option = document.createElement('option');
  option.value = curve.id;
  option.textContent = curve.label;
  targetSelect.appendChild(option);
});
targetSelect.value = state.target || '';
$('targetHint').hidden = !state.target;
$('numCalibration').value = state.calibrationDb.toFixed(1);
$('chkSpl').checked = state.showSpl;
$('chkMeterSpl').checked = state.showSpl;
$('chkGate').checked = state.gate.enabled;
$('chkSpectrograph').checked = state.showSpectrograph;
$('chkSpectrographAnalysis').checked = state.showSpectrograph;
setSpectrographShown(state.showSpectrograph);
$('numGateStart').value = state.gate.startMs.toFixed(1);
$('numGateWidth').value = state.gate.widthMs.toFixed(1);
$('numGateStart').disabled = !state.gate.enabled;
$('numGateWidth').disabled = !state.gate.enabled;
$('lblAvg').textContent = state.avgSpeed + '%';

updateTraceSummary();
renderBalance();
updateDelayAdvice();
renderPresets();
const copyrightYear = $('copyrightYear');
if (copyrightYear) copyrightYear.textContent = String(new Date().getFullYear());
updateTfSpan();
updateIrSpan();
updateIrHoldButton();
updatePhaseToggleState();
renderSaved();
renderSavedOverlayControls();
draw();

const inAppBrowser = isLikelyInAppBrowser();
const standalone = isStandalone();
const canCapture = !!(
  navigator.mediaDevices &&
  navigator.mediaDevices.getUserMedia &&
  window.AudioContext
);

const address = publicAddress();
$('safariUrl').value = address;
const shareField = $('shareField');
if (shareField) shareField.value = address;
const openInSafari = $('openInSafari');
if (openInSafari) openInSafari.href = address;

if (inAppBrowser) {
  showSafariBanner();
  if (isPrivatePreview()) {
    showPreviewNote();
    setStatus('preview link is private — publish the app first', 'err');
  } else {
    setStatus('open this page in Safari to measure', 'err');
  }
} else if (!canCapture) {
  setStatus('this browser cannot capture audio', 'err');
  showAudioHelp('This browser has no microphone access. Open the page in Safari to measure.');
  $('btnPower').disabled = true;
} else if (isIOS() && !standalone) {
  showInstallHint();
}

if ('serviceWorker' in navigator && window.isSecureContext) {
  const registerWorker = () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  };
  if (document.readyState === 'complete') registerWorker();
  else window.addEventListener('load', registerWorker);
}
