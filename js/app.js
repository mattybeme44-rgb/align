import { AudioEngine } from './audio-engine.js';
import { Analyser, suggestEq } from './analyser.js';
import { TransferChart, ImpulseChart, targetDb, wrapDegrees, TARGET_CURVES } from './charts.js';
import { buildWaterfall, WaterfallChart } from './waterfall.js';
import { FFT } from './fft.js';

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
let gateDrag = null;
let lastWaterfallBuild = 0;
let drawRaf = 0;

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
  overlaidSavedId: null,
  target: null,
  calibrationDb: 0,
  showSpl: false,
  gate: { enabled: false, startMs: -0.5, widthMs: 20 },
  results: null,
  eq: [],
  cursorFreq: null,
  inputSource: 'auto',
  waterfallOpen: false,
  waterfallRangeMs: 20,
  waterfallAmplitude: 100,
  waterfall: null,
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

function loadSaved() {
  try {
    const raw = window.localStorage.getItem(STORAGE.saved);
    if (!raw) return [];
    const items = JSON.parse(raw);
    return Array.isArray(items) ? items.slice(0, 20) : [];
  } catch (err) {
    return [];
  }
}

function persistSaved() {
  try {
    window.localStorage.setItem(STORAGE.saved, JSON.stringify(state.saved.slice(0, 20)));
  } catch (err) {
    /* storage full or blocked: keep the session's list in memory */
  }
}

state.saved = loadSaved();
state.target = readString(STORAGE.target, '') || null;
state.calibrationDb = readNumber(STORAGE.calibration, 0);
state.showSpl = readString(STORAGE.spl, '0') === '1';

const tfChart = new TransferChart($('tfChart'));
const irChart = new ImpulseChart($('irChart'));
const wfChart = new WaterfallChart($('wfChart'));

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
  const open = !$('savedSheet').hidden || !$('waterfallSheet').hidden;
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
  updateReadouts(res);
  updateInterfaceInfo();

  eqTick += 1;
  if (eqTick % 3 === 0) updateEq(res);

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
  $('numDelay').value = '0.00';
  jitterWarned = false;
  resetTraces();

  analyser = new Analyser(state.fftSize, DEMO_RATE);
  analyser.updateRate = averagingRate();
  demoFft = null;
  demoLast = 0;

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
  jitterWarned = false;
  $('rdDelay').textContent = '—';
  $('rdCoh').textContent = '—';
  $('rdLevel').textContent = '—';
  $('rdRate').textContent = '—';
  $('irReadout').textContent = '—';
  $('btnWaterfall').disabled = false;
  $('btnExportCsv').disabled = true;
  $('btnSaveCurrent').disabled = true;
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

function overlaidCurve() {
  const item = state.saved.find((entry) => entry.id === state.overlaidSavedId);
  return item && Array.isArray(item.curve) ? item.curve : null;
}

function resetTraces() {
  state.snapshot = null;
  state.snapshotB = null;
  state.peakHold = null;
  state.peakHoldArmed = false;
  state.average = null;
  state.averageArmed = false;
  state.averagePower = null;
  state.averageCaptures = 0;
  state.overlaidSavedId = null;
  $('btnArmPeak').textContent = 'Arm peak hold';
  $('btnArmAverage').textContent = 'Arm average';
  $('btnCaptureAverage').disabled = true;
  $('rdDelta').textContent = '—';
  $('rdDeltaB').textContent = '—';
  updateTraceSummary();
}

function updateTraceSummary() {
  const parts = [];
  if (state.snapshot) parts.push('A');
  if (state.snapshotB) parts.push('B');
  if (state.average) parts.push('avg ' + state.averageCaptures);
  const text = parts.length ? parts.join(' + ') + ' captured' : 'no captures yet';
  $('captureSummary').textContent = text;
  $('traceSummary').textContent = text;
}

function updateGateBadge() {
  const badge = $('gateBadge');
  if (badge) badge.hidden = !state.gate.enabled;
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
  state.snapshot = Object.assign(captureTrace(res), { delayMs: state.totalDelayMs });
  setStatus('captured A at ' + state.totalDelayMs.toFixed(2) + ' ms', 'ok');
  updateTraceSummary();
  draw();
}

function clearA() {
  state.snapshot = null;
  $('rdDelta').textContent = '—';
  updateTraceSummary();
  draw();
}

function captureB() {
  const res = state.results;
  if (!res) return;
  state.snapshotB = Object.assign(captureTrace(res), { delayMs: state.totalDelayMs });
  setStatus('captured B at ' + state.totalDelayMs.toFixed(2) + ' ms', 'ok');
  updateTraceSummary();
  draw();
}

function clearB() {
  state.snapshotB = null;
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

/** Magnitude in dB, 400 points log-spaced from 20 Hz to 20 kHz. */
function savedCurve(res) {
  const points = 400;
  const span = Math.log(20000 / 20);
  const values = new Float32Array(points);

  for (let i = 0; i < points; i++) {
    const t0 = i / (points - 1);
    const t1 = (i + 1) / (points - 1);
    const f0 = 20 * Math.exp(t0 * span);
    const f1 = Math.min(20000, 20 * Math.exp(t1 * span));
    const k0 = Math.max(1, Math.floor(f0 / res.df));
    const k1 = Math.min(res.bins - 1, Math.max(k0, Math.ceil(f1 / res.df)));

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

function drawSavedThumb(canvas, curve) {
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
  ctx.strokeStyle = 'rgba(180,167,247,0.9)';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function renderSaved() {
  const list = $('savedList');
  list.textContent = '';

  $('savedSubtitle').textContent = state.saved.length
    ? 'Kept on this device · ' + state.saved.length + (state.saved.length === 1 ? ' measurement' : ' measurements')
    : 'Kept on this device';

  $('btnSaveCurrent').disabled = !state.results;
  $('saveHint').textContent = state.results
    ? 'A measurement is saved with the FFT size, smoothing and reference mode it was taken with.'
    : 'Take a measurement first — Start, or Demo measurement.';

  if (!state.saved.length) {
    const empty = document.createElement('li');
    empty.className = 'saved-empty';
    empty.textContent =
      'No measurements saved yet. A measurement you save is kept with its delay, coherence and settings, and its curve can be laid behind the live trace to compare.';
    list.appendChild(empty);
    return;
  }

  state.saved.forEach((item) => {
    const row = document.createElement('li');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'saved-item' + (item.id === state.overlaidSavedId ? ' selected' : '');
    button.addEventListener('click', () => {
      state.overlaidSavedId = state.overlaidSavedId === item.id ? null : item.id;
      renderSaved();
      draw();
      if (state.overlaidSavedId) closeSheet('savedSheet');
    });

    const main = document.createElement('div');
    main.className = 'saved-main';

    const delay = document.createElement('div');
    delay.className = 'saved-delay';
    delay.textContent = item.delayMs.toFixed(2) + ' ms';

    const meta = document.createElement('div');
    meta.className = 'saved-meta';
    const parts = [];
    if (item.polarity && item.polarity !== 'unknown') parts.push('Polarity ' + item.polarity);
    parts.push('Coherence ' + Math.round(item.coherence * 100) + '%');
    meta.textContent = parts.join(' · ');

    const name = document.createElement('div');
    name.className = 'saved-name';
    name.textContent = item.name;

    const date = document.createElement('div');
    date.className = 'saved-date';
    date.textContent = formatSavedDate(item.date);

    main.append(delay, meta, name, date);

    const thumb = document.createElement('canvas');
    thumb.className = 'saved-thumb';
    thumb.width = 148;
    thumb.height = 76;
    drawSavedThumb(thumb, item.curve);

    const check = document.createElement('span');
    check.className = 'saved-check';
    check.textContent = item.id === state.overlaidSavedId ? '✓' : '›';

    button.append(main, thumb, check);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'saved-delete';
    remove.textContent = 'Delete';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      state.saved = state.saved.filter((entry) => entry.id !== item.id);
      if (state.overlaidSavedId === item.id) state.overlaidSavedId = null;
      persistSaved();
      renderSaved();
      draw();
    });

    row.append(button, remove);
    list.appendChild(row);
  });
}

function saveCurrent() {
  const res = state.results;
  if (!res) {
    setStatus('nothing to save yet — start a measurement first', 'err');
    return;
  }

  const suggestion =
    'Measurement ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const answer = window.prompt('Name this measurement', suggestion);
  if (answer === null) return;
  const name = answer.trim() || suggestion;

  const item = {
    id: 'm' + Date.now() + '-' + Math.random().toString(16).slice(2),
    name,
    date: new Date().toISOString(),
    delayMs: state.totalDelayMs,
    coherence: meanCoherence(res),
    polarity: res.polarityKnown ? (res.polarity > 0 ? 'normal' : 'inverted') : 'unknown',
    fftSize: res.fftSize,
    sampleRate: res.sampleRate,
    smoothing: smoothingLabel(),
    reference: referenceLabel(),
    curve: savedCurve(res),
  };

  state.saved.unshift(item);
  state.saved = state.saved.slice(0, 20);
  persistSaved();
  renderSaved();
  setStatus('saved “' + item.name + '”', 'ok');
}

function openSaved() {
  renderSaved();
  $('savedSheet').hidden = false;
  updateSheetLock();
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

/* ---------- gate ---------- */

function setGate(start, width) {
  const clampedWidth = Math.min(Math.max(width, 0.2), 60);
  const clampedStart = Math.min(Math.max(start, -5), 55 - clampedWidth);
  state.gate.startMs = Number.isFinite(clampedStart) ? clampedStart : -0.5;
  state.gate.widthMs = Number.isFinite(clampedWidth) ? clampedWidth : 20;
  $('numGateStart').value = state.gate.startMs.toFixed(1);
  $('numGateWidth').value = state.gate.widthMs.toFixed(1);
  draw();
}

function applyGateDrag(deltaMs) {
  if (!gateDrag) return;

  const clampStart = (start, width) => Math.min(Math.max(start, -5), 55 - width);
  let start = state.gate.startMs;
  let width = state.gate.widthMs;

  if (gateDrag.mode === 'move') {
    start = clampStart(gateDrag.startMs + deltaMs, width);
  } else if (gateDrag.mode === 'start') {
    const end = gateDrag.startMs + gateDrag.widthMs;
    const newStart = Math.min(end - 0.2, gateDrag.startMs + deltaMs);
    width = Math.max(0.2, end - newStart);
    start = clampStart(newStart, width);
  } else {
    width = Math.min(60, Math.max(0.2, gateDrag.widthMs + deltaMs));
    start = clampStart(gateDrag.startMs, width);
  }

  setGate(start, width);
}

function endGateDrag(event) {
  if (!gateDrag || event.pointerId !== gateDrag.pointerId) return;
  try {
    irChart.canvas.releasePointerCapture(event.pointerId);
  } catch (err) {
    /* the capture may already be gone */
  }
  gateDrag = null;
  draw();
}

$('irChart').addEventListener('pointerdown', (event) => {
  if (!state.gate.enabled || !state.results) return;
  const rect = irChart.canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  gateDrag = {
    pointerId: event.pointerId,
    x,
    mode: irChart.gateModeAt(x, state.gate),
    startMs: state.gate.startMs,
    widthMs: state.gate.widthMs,
  };
  try {
    irChart.canvas.setPointerCapture(event.pointerId);
  } catch (err) {
    /* not every browser needs it */
  }
  event.preventDefault();
});

$('irChart').addEventListener('pointermove', (event) => {
  if (!gateDrag || event.pointerId !== gateDrag.pointerId) return;
  const rect = irChart.canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  applyGateDrag((x - gateDrag.x) * irChart.msPerPixel());
});

$('irChart').addEventListener('pointerup', endGateDrag);
$('irChart').addEventListener('pointercancel', endGateDrag);

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
  tfChart.draw(state.results, {
    showPhase: $('chkPhase').checked,
    showCoh: $('chkCoh').checked,
    snapshot: state.snapshot,
    secondSnapshot: state.snapshotB,
    peakHold: state.peakHoldArmed ? state.peakHold : null,
    average: state.average,
    averageCount: state.averageCaptures,
    savedCurve: overlaidCurve(),
    target: state.target,
    cursorFreq: state.cursorFreq,
  });
  irChart.draw(state.results, { gate: state.gate });
  updateGateBadge();
  updateTraceSummary();

  if (state.waterfallOpen) drawWaterfall();
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

  if (maybeLockDelay(res)) return;
  updateReadouts(res);
  updateInterfaceInfo();

  eqTick += 1;
  if (eqTick % 12 === 0) updateEq(res);

  refreshWaterfall(false);
  draw();
}

/* ---------- readouts ---------- */

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

  $('rdLevel').textContent = levelReadout();
  $('rdRate').textContent = (res.sampleRate / 1000).toFixed(1) + 'k · ' + res.df.toFixed(1) + ' Hz';

  $('rdDelta').textContent = state.snapshot
    ? (totalMs - state.snapshot.delayMs).toFixed(2) + ' ms'
    : '—';
  $('rdDeltaB').textContent = state.snapshotB
    ? (totalMs - state.snapshotB.delayMs).toFixed(2) + ' ms'
    : '—';

  $('irReadout').textContent = 'delay ' + totalMs.toFixed(2) + ' ms';
  $('btnWaterfall').disabled = false;
  $('btnExportCsv').disabled = false;
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

  readout.textContent = text;
}

function meterPercent(rms) {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
}

function updateInterfaceInfo() {
  const deviceEl = $('rdDevice');
  const channelsEl = $('rdChannels');
  const meter1 = $('meter1');
  const meter2 = $('meter2');

  if (state.demo) {
    deviceEl.textContent = 'demo measurement (no microphone)';
    channelsEl.textContent = '1 ch · ' + Math.round(DEMO_RATE / 1000) + ' kHz';
    meter1.style.width = meterPercent(demoLevel) + '%';
    meter2.style.width = '0%';
    return;
  }

  if (!engine.running) {
    deviceEl.textContent = 'no input yet';
    channelsEl.textContent = '—';
    meter1.style.width = '0%';
    meter2.style.width = '0%';
    return;
  }

  deviceEl.textContent = engine.deviceLabel || 'audio input';
  const count = engine.deviceChannels || 1;
  channelsEl.textContent = count + ' ch · ' + Math.round(engine.sampleRate / 1000) + ' kHz';
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
  jitterWarned = false;
  $('numDelay').value = '0.00';
  resetTraces();

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
  state.delayEstimate = 0;
  state.delayLockedAt = 0;
  state.delayProbedAt = 0;
  jitterWarned = false;
  $('btnWaterfall').disabled = false;
  $('btnExportCsv').disabled = true;
  $('btnSaveCurrent').disabled = true;
  resetTraces();

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

$('chkPhase').addEventListener('change', () => draw());
$('chkCoh').addEventListener('change', () => draw());
$('btnFindDelay').addEventListener('click', findDelay);

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
});

$('chkSpl').addEventListener('change', (event) => {
  state.showSpl = event.target.checked;
  write(STORAGE.spl, state.showSpl ? '1' : '0');
  $('rdLevel').textContent = levelReadout();
});

$('chkGate').addEventListener('change', (event) => {
  state.gate.enabled = event.target.checked;
  $('numGateStart').disabled = !state.gate.enabled;
  $('numGateWidth').disabled = !state.gate.enabled;
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
$('btnExportCsv').addEventListener('click', exportCSV);
$('btnWaterfall').addEventListener('click', openWaterfall);
$('btnCloseWaterfall').addEventListener('click', closeWaterfall);

$('wfRange').addEventListener('input', (event) => {
  state.waterfallRangeMs = Number(event.target.value);
  updateWaterfallLabels();
  refreshWaterfall(true);
  drawWaterfall();
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

$('tfChart').addEventListener('pointermove', (event) => {
  if (!state.results) return;
  const rect = tfChart.canvas.getBoundingClientRect();
  state.cursorFreq = tfChart.freqAtX(event.clientX - rect.left);
  updateCursorReadout();
  draw();
});

$('tfChart').addEventListener('pointerleave', () => {
  state.cursorFreq = null;
  updateCursorReadout();
  draw();
});

window.addEventListener('resize', () => {
  tfChart.resize();
  irChart.resize();
  wfChart.resize();
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
$('chkGate').checked = state.gate.enabled;
$('numGateStart').value = state.gate.startMs.toFixed(1);
$('numGateWidth').value = state.gate.widthMs.toFixed(1);
$('numGateStart').disabled = !state.gate.enabled;
$('numGateWidth').disabled = !state.gate.enabled;
$('lblAvg').textContent = state.avgSpeed + '%';

updateTraceSummary();
renderSaved();
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
