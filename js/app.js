import { AudioEngine } from './audio-engine.js';
import { Analyser, suggestEq } from './analyser.js';
import { TransferChart, ImpulseChart } from './charts.js';

const $ = (id) => document.getElementById(id);

const engine = new AudioEngine();

let analyser = null;
let micWin = new Float32Array(0);
let refWin = new Float32Array(0);
let rafId = 0;
let lastAnalysis = 0;
let eqTick = 0;

const state = {
  running: false,
  signal: 'pink',
  level: 0.35,
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
  totalDelayMs: 0,
  snapshot: null,
  results: null,
  cursorFreq: null,
  deviceId: '',
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

function averagingRate() {
  return 0.02 + 0.45 * (state.avgSpeed / 100);
}

function buildAnalyser() {
  analyser = new Analyser(state.fftSize, engine.sampleRate);
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
  if (state.refMode === 'loopback') {
    engine.readChannel(refWin, refStart, state.refChannel);
  } else {
    engine.readGeneratedRef(refWin, refStart);
  }

  analyser.updateRate = averagingRate();
  analyser.accumulate(micWin, refWin);

  const res = analyser.results({
    compensate: state.compensate,
    smoothing: state.smoothing,
    normalize: state.normalize,
  });

  state.results = res;
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
  polarity.textContent = res.polarity > 0 ? 'normal' : 'inverted';
  polarity.className = 'v ' + (res.polarity > 0 ? 'good' : 'bad');

  const coherence = meanCoherence(res);
  const coherenceEl = $('rdCoh');
  coherenceEl.textContent = (coherence * 100).toFixed(0) + '%';
  coherenceEl.className = 'v ' + (coherence > 0.8 ? 'good' : coherence > 0.5 ? '' : 'bad');

  if (state.refMode === 'loopback' && state.micChannel === state.refChannel) {
    setStatus('measurement and reference use the same input', 'err');
  } else if (state.refMode === 'loopback' && res.frames > 20 && coherence < 0.2) {
    setStatus('reference input is silent — check the loopback routing', 'err');
  }

  const level = engine.channelLevel[state.micChannel] || 0;
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
  const button = $('btnPower');
  button.disabled = true;
  setStatus('starting…');

  let channels = 1;
  try {
    channels = await engine.start(state.deviceId);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    setStatus(message, 'err');
    showAudioHelp('Audio could not start: ' + message);
    state.running = false;
    button.textContent = 'Start';
    button.classList.remove('on');
    button.disabled = false;
    updateInterfaceInfo();
    return;
  }

  buildAnalyser();
  engine.setSignal(state.signal);
  engine.setSineHz(state.sineHz);
  engine.setLevel(state.level);

  // The iPhone microphone is a single input: it can only work with the
  // generated reference, and only channel 1 exists.
  if (channels < 2) {
    if (state.refMode === 'loopback') {
      state.refMode = 'internal';
      $('selRef').value = 'internal';
    }
    if (state.micChannel !== 0) {
      state.micChannel = 0;
      $('selMicCh').value = '0';
    }
  }

  state.running = true;
  state.delayEstimate = 0;
  $('numDelay').value = '0.00';
  state.snapshot = null;
  state.results = null;

  button.textContent = 'Stop';
  button.classList.add('on');
  button.disabled = false;

  hideAudioHelp();
  setStatus('running', 'ok');
  if (engine.exactDeviceRejected) {
    setStatus('iOS used "' + engine.deviceLabel + '" instead of the chosen device', 'err');
  } else if (engine.deviceChannels < 2) {
    setStatus('phone microphone · generated reference', 'ok');
  }
  updateInterfaceInfo();
  listDevices();
  lastAnalysis = 0;

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
  state.running = false;
  engine.stop();
  state.results = null;
  state.snapshot = null;
  state.delayEstimate = 0;

  const button = $('btnPower');
  button.textContent = 'Start';
  button.classList.remove('on');
  setStatus('idle');
  updateInterfaceInfo();
  draw();
}


async function listDevices() {
  const select = $('selInput');
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === 'audioinput');
    const current = state.deviceId;

    select.textContent = '';
    const fallback = document.createElement('option');
    fallback.value = '';
    fallback.textContent = 'Default input';
    select.appendChild(fallback);

    inputs.forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || 'Input ' + (index + 1);
      select.appendChild(option);
    });

    select.value = current;
  } catch (err) {
    /* enumeration is best effort */
  }
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

function findDelay() {
  if (!engine.running) {
    setStatus('start the audio first', 'err');
    return;
  }

  if (state.refMode === 'internal' && !engine.refAligned) {
    setStatus('collecting — try again in a moment');
    return;
  }

  const n = 65536;
  const offset = state.delayEstimate;
  const written = engine.micWritten;
  const start = written - 512 - n;
  if (start - offset < 0) {
    setStatus('collecting — try again in a moment');
    return;
  }

  const mic = new Float32Array(n);
  const ref = new Float32Array(n);

  engine.readChannel(mic, start, state.micChannel);
  if (state.refMode === 'loopback') {
    engine.readChannel(ref, start - offset, state.refChannel);
  } else {
    engine.readGeneratedRef(ref, start - offset);
  }

  const probe = new Analyser(n, engine.sampleRate);
  probe.updateRate = 1;
  probe.accumulate(mic, ref);
  probe.results({ compensate: false, smoothing: 0, normalize: false });

  const total = offset + probe.peakIndex;
  state.delayEstimate = Math.round(total);
  if (analyser) analyser.reset();

  const ms = (state.delayEstimate / engine.sampleRate) * 1000;
  $('numDelay').value = ms.toFixed(2);
  setStatus('delay locked at ' + ms.toFixed(2) + ' ms', 'ok');
}

$('btnPower').addEventListener('click', () => {
  if (state.running) stopAll();
  else startAll();
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
  state.delayEstimate = Math.round((ms / 1000) * engine.sampleRate);
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

$('selInput').addEventListener('change', (event) => {
  state.deviceId = event.target.value;
  if (state.running) setStatus('press Restart to use this input', '');
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

$('btnCopyLink').addEventListener('click', async () => {
  const link = window.location.href;
  try {
    await navigator.clipboard.writeText(link);
    setStatus('link copied — paste it into Safari', 'ok');
  } catch (err) {
    window.prompt('Copy this link, then open it in Safari', link);
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

if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.AudioContext) {
  setStatus('this browser cannot capture audio', 'err');
  showAudioHelp('This browser has no microphone access. Open the page in Safari to measure.');
  $('btnPower').disabled = true;
}
