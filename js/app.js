import { AudioEngine } from './audio-engine.js';
import { Analyser, suggestEq } from './analyser.js';
import { TransferChart, ImpulseChart } from './charts.js';
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
  results: null,
  cursorFreq: null,
  inputSource: 'auto',
};

const tfChart = new TransferChart($('tfChart'));
const irChart = new ImpulseChart($('irChart'));

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

function showSafariBanner() {
  const banner = $('safariBanner');
  if (!banner) return;
  const address = publicAddress();
  const field = $('safariUrl');
  if (field) field.value = address;
  const link = $('openInSafari');
  if (link) link.href = address;
  banner.classList.add('overlay');
  banner.hidden = false;
  document.body.classList.add('sheet-open');
}

function hideSafariBanner() {
  const banner = $('safariBanner');
  if (banner) {
    banner.hidden = true;
    banner.classList.remove('overlay');
  }
  document.body.classList.remove('sheet-open');
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

/**
 * True for a browser another app hosts on iOS (a chat app's own browser, say).
 * Those cannot open the microphone: iOS dismisses the whole web view instead,
 * which looks like the app quitting. Safari can, so the page has to move there.
 * An installed Home Screen app is not one of these.
 */
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

/** A --preview address only opens inside FreeMilk; Safari sees it as private. */
function isPrivatePreview() {
  return /--preview\./.test(window.location.hostname);
}

/**
 * Where people should actually measure from. Never hand out a private preview
 * address: Safari answers "this preview is private" and the app looks broken.
 */
const PUBLIC_URL = 'https://mattybeme44-rgb.github.io/align/';

function publicAddress() {
  return isPrivatePreview() ? PUBLIC_URL : window.location.href;
}

async function copyLink() {
  const link = publicAddress();
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard');
    await navigator.clipboard.writeText(link);
    setStatus('link copied — paste it into Safari', 'ok');
  } catch (err) {
    const field = $('safariUrl');
    if (field) {
      field.value = link;
      field.select();
      field.setSelectionRange(0, link.length);
    }
    setStatus('link ready below — copy it into Safari', 'err');
  }
}

/** Offer Add to Home Screen once, in Safari, until it is dismissed. */
function showInstallHint() {
  const card = $('installCard');
  if (!card) return;

  let dismissed = false;
  try {
    dismissed = window.localStorage.getItem(INSTALL_HINT_KEY) === '1';
  } catch (err) {
    /* private browsing: show it, it just will not stay dismissed */
    dismissed = false;
  }
  if (!dismissed) card.hidden = false;
}

/*
 * Demo measurement: the same analysis path the microphone feeds, driven by a
 * synthetic speaker — a little room gain low down, a dip near 260 Hz, presence
 * around 2.4 kHz, a soft top-octave roll-off and 3.7 ms of propagation delay.
 * Nothing is captured and no permission is asked for, so this works in any
 * browser, including ones that cannot open the microphone.
 */
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
  });

  state.results = res;
  updateReadouts(res);
  updateInterfaceInfo();

  eqTick += 1;
  if (eqTick % 3 === 0) updateEq(res);

  draw();
}

function demoLoop(now) {
  if (!state.demo) {
    demoRaf = 0;
    return;
  }
  demoRaf = requestAnimationFrame(demoLoop);
  // Bigger windows cost more to transform, so average them a little slower.
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
  state.snapshot = null;
  $('numDelay').value = '0.00';
  $('rdDelta').textContent = '—';
  jitterWarned = false;

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
  jitterWarned = false;
  $('rdDelay').textContent = '—';
  $('rdCoh').textContent = '—';
  $('rdLevel').textContent = '—';
  $('rdRate').textContent = '—';
  $('irReadout').textContent = '—';
  setStatus('idle');
  updateInterfaceInfo();
  draw();
}

function averagingRate() {
  return 0.02 + 0.45 * (state.avgSpeed / 100);
}

/**
 * How far from zero the fine delay search looks once the coarse offset is known.
 *
 * The short window then only has to follow the delay around the offset already
 * locked in, so it never has to decide between two branches of the circular
 * correlation — which is what made the reading jump while the phone microphone
 * and the phone speaker were both in use. Until there is an offset to follow,
 * the whole window is searched, exactly as before.
 */
function fineSearchRadius(fftSize) {
  return Math.max(1, Math.round(fftSize / 8));
}

/** What to ask the engine for, from the Input source choice. */
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

/** Say which input the engine actually got, not which one was asked for. */
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
}

function draw() {
  tfChart.draw(state.results, {
    showPhase: $('chkPhase').checked,
    showCoh: $('chkCoh').checked,
    snapshot: state.snapshot,
    cursorFreq: state.cursorFreq,
  });
  irChart.draw(state.results);
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
    // The offset has outgrown the capture buffer — a path whose latency keeps
    // drifting in one direction. Start the coarse search again rather than
    // freezing on the last frame.
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
  // Once the coarse offset is locked in, the short window only follows it; a
  // hand-typed offset is the operator's own number, so it keeps the full window.
  const tracking = state.delayAuto && state.delayLockedAt > 0;
  analyser.searchRadius = tracking ? fineSearchRadius(n) : 0;
  analyser.accumulate(micWin, refWin);

  const res = analyser.results({
    compensate: state.compensate,
    smoothing: state.smoothing,
    normalize: state.normalize,
  });

  state.results = res;
  // A lock re-aligns the reference, so this frame's numbers describe the old
  // alignment: skip the readout until the next one.
  if (maybeLockDelay(res)) return;
  updateReadouts(res);
  updateInterfaceInfo();

  eqTick += 1;
  if (eqTick % 12 === 0) updateEq(res);

  draw();
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
    // Coherence is too low for the sign of the peak to mean anything.
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
    // A steady path holds the peak to within a sample or two. A wandering one
    // is not noise in the analysis, it is the path itself moving — a Bluetooth
    // link's buffer, or the phone's own speaker leaking into its microphone —
    // and no amount of averaging makes that delay trustworthy.
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

  const level = state.demo ? demoLevel : engine.channelLevel[state.micChannel] || 0;
  $('rdLevel').textContent = (level > 0 ? (20 * Math.log10(level)).toFixed(1) : '-inf') + ' dBFS';

  $('rdRate').textContent = (res.sampleRate / 1000).toFixed(1) + 'k · ' + res.df.toFixed(1) + ' Hz';

  const deltaEl = $('rdDelta');
  deltaEl.textContent = state.snapshot ? (totalMs - state.snapshot.delayMs).toFixed(2) + ' ms' : '—';

  $('irReadout').textContent = 'delay ' + totalMs.toFixed(2) + ' ms';
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

async function startAll() {
  if (starting) return;

  if (state.demo) stopDemo();

  // Asking an in-app browser for the microphone is what makes iOS close it,
  // so point at Safari first instead of losing the page.
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
  // The level needs no setting here: the engine already holds it, and a target
  // on the gain node now would cut the fade-in short.

  // A single-input source (the iPhone microphone) can only work with the
  // generated reference, and it only offers input 1.
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
  state.snapshot = null;
  state.results = null;
  jitterWarned = false;
  $('numDelay').value = '0.00';

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
  if (!state.running) return;
  if (now - lastAnalysis < 90) return;
  lastAnalysis = now;
  analyse();
}

function stopAll() {
  if (state.demo) stopDemo();
  state.running = false;
  engine.stop();
  state.results = null;
  state.snapshot = null;
  state.delayEstimate = 0;
  state.delayLockedAt = 0;
  state.delayProbedAt = 0;
  jitterWarned = false;

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
  readout.textContent =
    label +
    ' · ' +
    res.magDb[k].toFixed(1) +
    ' dB · ' +
    res.phaseDeg[k].toFixed(0) +
    '° · coh ' +
    (res.coh[k] * 100).toFixed(0) +
    '%';
}

const PROBE_SIZE = 131072;

/**
 * Read one long window pair and find the delay it holds.
 * Returns { samples, confidence, ambiguous } in samples, or null before there
 * is enough audio captured to fill the window.
 *
 * This is the measurement that decides which branch of the circular
 * correlation the short window then tracks. It has to look at the whole window,
 * so it is also the one that has to be big enough: 131072 samples is 2.7 s at
 * 48 kHz, which covers the round trip through the phone speaker and back into
 * the phone microphone with room to spare.
 */
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

  // A peak right at the edge of the probe may really belong outside it, which
  // would put the lock a whole window out. Say so instead of locking onto it.
  const ambiguous = Math.abs(probe.peakIndex) > PROBE_SIZE / 2 - 1024;
  return { samples: offset + probe.peakIndex, confidence: meanCoherence(res), ambiguous };
}

/** Store a coarse offset and let the analyser start over from it. */
function applyDelayLock(probe) {
  const total = Math.round(probe.samples);
  // A negative offset would have the reference read ahead of the capture,
  // which is silence: leave the display alone instead of breaking it. The
  // generated reference is a periodic buffer, though, so a negative offset is
  // just an earlier point in the same loop and reads back fine.
  if (total < 0 && state.refMode !== 'internal') return null;

  state.delayEstimate = total;
  state.delayLockedAt = engine.micWritten;
  if (analyser) analyser.reset();

  const ms = (total / engine.sampleRate) * 1000;
  $('numDelay').value = ms.toFixed(2);
  return ms;
}

/**
 * Lock the coarse delay by itself, and keep it locked.
 *
 * Once an offset is locked in, the short window only follows the delay within a
 * fraction of itself; a true offset outside that neighbourhood then reads as a
 * residual sitting on the edge of it. That edge is the signal to measure the
 * whole thing again with the long probe. Doing it this way means the delay is
 * found once and then only nudged, instead of the short window trying to choose
 * between two branches of the circular correlation and hopping between them —
 * the number "going all over the place" that used to happen with a Bluetooth
 * output, and with the phone's own speaker and microphone.
 */
function maybeLockDelay(res) {
  if (state.demo || !engine.running || !state.delayAuto) return false;
  if (state.refMode === 'internal' && !engine.refAligned) return false;
  // A sine correlates with every period of itself, so there is no one delay to
  // lock on: leave that to the operator.
  if (state.signal === 'sine') return false;

  const now = engine.micWritten;
  const wait = engine.sampleRate * 2;
  if (now - state.delayLockedAt < wait) return false;
  if (now - state.delayProbedAt < wait) return false;

  // A residual past an eighth of a window is where the peak starts being
  // clipped by the fine search, or where the full window's peak flips between
  // two branches: either way the true delay is not being read. The median of
  // the last few frames is used rather than the smoothed value, which
  // approaches that point without ever quite reaching it.
  const residual = Number.isFinite(res.delayMedianSamples)
    ? Math.abs(res.delayMedianSamples)
    : Infinity;
  if (residual < res.fftSize / 8 - 2) return false;

  const probe = probeDelay();
  // Not enough audio yet. Leave delayProbedAt alone so the next frame tries
  // again rather than waiting another two seconds.
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

$('numDelay').addEventListener('change', () => {
  const ms = parseFloat($('numDelay').value);
  if (!Number.isFinite(ms)) return;
  const rate = state.demo ? DEMO_RATE : engine.sampleRate;
  state.delayEstimate = Math.round((ms / 1000) * rate);
  // A number typed in by hand is the answer from now on: stop re-locking.
  state.delayAuto = false;
  state.delayLockedAt = engine.micWritten;
  if (analyser) analyser.reset();
});

$('btnCapture').addEventListener('click', () => {
  const res = state.results;
  if (!res) return;
  state.snapshot = {
    magDb: Float32Array.from(res.magDb),
    phaseDeg: Float32Array.from(res.phaseDeg),
    coh: Float32Array.from(res.coh),
    bins: res.bins,
    fftSize: res.fftSize,
    sampleRate: res.sampleRate,
    delayMs: state.totalDelayMs,
  };
  setStatus('captured A at ' + state.totalDelayMs.toFixed(2) + ' ms', 'ok');
  draw();
});

$('btnClearA').addEventListener('click', () => {
  state.snapshot = null;
  $('rdDelta').textContent = '—';
  draw();
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
  draw();
});

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
const openInSafari = $('openInSafari');
if (openInSafari) openInSafari.href = address;

if (inAppBrowser) {
  // Say it before Start is pressed: pressing it here closes the page.
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

// Keep a copy of the app for launching with no signal. Optional throughout:
// a browser without service workers, or a refusal, changes nothing here.
if ('serviceWorker' in navigator && window.isSecureContext) {
  const registerWorker = () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  };
  if (document.readyState === 'complete') registerWorker();
  else window.addEventListener('load', registerWorker);
}
