/*
 * Hardware verification.
 *
 * A guided check of the actual signal path: the interface the browser opened,
 * how many inputs it really delivers, whether those inputs carry independent
 * signals, an electrical loopback through the transfer-function engine, and the
 * three measurement microphones.
 *
 * Two things are kept strictly apart here, and labelled: what the browser
 * REPORTS (device label, channel count, sample rate) and what can be VERIFIED
 * from the samples that arrived. A result is only PASS when measured data
 * satisfies a documented tolerance. Anything the screen could not measure reads
 * UNVERIFIED with the reason, never PASS.
 *
 * Nothing here claims a physical validation. It measures what this device and
 * this interface actually do, on the operator's hardware, when they run it.
 */

import { MultiAnalyser } from './multianalyser.js';
import { Analyser } from './analyser.js';
import { shareOrDownload } from './sharing.js';

export const PASS = 'pass';
export const FAIL = 'fail';
export const UNVERIFIED = 'unverified';

const WORD = { pass: 'PASS', fail: 'FAIL', unverified: 'UNVERIFIED' };

/* Tolerances. Each one is stated on the screen beside the figure it judges. */
export const TOLERANCE = {
  // Electrical loopback, one signal into two inputs of the same interface.
  loopbackCoherence: 0.95,
  loopbackRippleDb: 0.5,
  loopbackDelayMs: 0.1,
  delayAgreementMs: 0.05,
  // Microphones.
  micCoherence: 0.8,
  micSignalDb: -60,
  matchResidualDb: 1.5,
  // Health.
  lateCallbackRatio: 0.02,
  analysisBudgetMs: 250,
};

const BAND_LOW = 200;
const BAND_HIGH = 4000;
const LOOP_LOW = 100;
const LOOP_HIGH = 10000;

function dbOf(level) {
  return level > 0 ? 20 * Math.log10(level) : -Infinity;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[(sorted.length - 1) >> 1];
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

/** Mean and worst |dB| difference against a reference curve, over a band. */
function curveDifference(reference, other, low, high) {
  const bins = reference.bins;
  const df = reference.df;
  const k0 = Math.max(1, Math.round(low / df));
  const k1 = Math.min(bins - 1, Math.round(high / df));
  const differences = [];
  for (let k = k0; k <= k1; k++) {
    const a = reference.magDb[k];
    const b = other.magDb[k];
    if (!finite(a) || !finite(b)) continue;
    differences.push(Math.abs(a - b));
  }
  if (!differences.length) return null;
  return { mean: mean(differences), max: Math.max(...differences), count: differences.length };
}

/** Where a curve sits relative to flat: mean level and ripple about it. */
function flatness(result, low, high) {
  const bins = result.bins;
  const df = result.df;
  const k0 = Math.max(1, Math.round(low / df));
  const k1 = Math.min(bins - 1, Math.round(high / df));
  const values = [];
  const coherences = [];
  for (let k = k0; k <= k1; k++) {
    if (!finite(result.magDb[k])) continue;
    values.push(result.magDb[k]);
    coherences.push(finite(result.coh[k]) ? result.coh[k] : 0);
  }
  if (!values.length) return null;
  const level = mean(values);
  let sum = 0;
  for (const value of values) sum += (value - level) * (value - level);
  return {
    level,
    ripple: Math.sqrt(sum / values.length),
    coherence: mean(coherences),
    bins: values.length,
  };
}

export function createHardwareCheck(options) {
  const opts = options || {};
  const engine = opts.engine;
  const setStatus = typeof opts.setStatus === 'function' ? opts.setStatus : () => {};
  const sourceOptions = typeof opts.sourceOptions === 'function' ? opts.sourceOptions : () => ({});

  const state = {
    active: false,
    running: false,
    fftSize: 16384,
    updateMs: 350,
    delayMode: 'wrapped',
    results: null,
    levels: [0, 0, 0, 0],
    refLevel: 0,
    timings: { accumulate: [], results: [] },
    lateAtStart: 0,
    framesAtStart: 0,
    startedAt: 0,
    loopback: null,
    loopFrom: 0,
    loopTo: 3,
    checked: {},
    matches: [],
  };

  let analyser = null;
  let windows = [];
  let refWindow = null;
  let lastAnalysis = 0;
  let lastRender = 0;
  let raf = 0;
  let deviceListenerBound = false;

  const $ = (id) => document.getElementById(id);

  /* ---------- the DOM ---------- */

  function badge(result) {
    return '<span class="hw-badge hw-' + result + '">' + WORD[result] + '</span>';
  }

  function row(label, value, kind) {
    return '<div class="hw-row"><span>' + label + '</span><b data-kind="' + (kind || '') + '">' +
      (value === undefined || value === null || value === '' ? '—' : value) + '</b></div>';
  }

  function section(id, title, hint) {
    return [
      '<section class="multi-panel hw-section" data-section="' + id + '">',
      '  <div class="hw-head"><h3>' + title + '</h3><span data-badge="' + id + '"></span></div>',
      '  <p class="source-hint">' + hint + '</p>',
      '  <div class="hw-body" data-body="' + id + '"></div>',
      '</section>',
    ].join('');
  }

  function build() {
    const root = $('hwBody');
    if (!root || root.childElementCount) return;
    root.innerHTML = [
      section('interface', '1. Audio interface',
        'What the browser opened, beside what the samples show.'),
      section('inputs', '2. Four independent inputs',
        'Each input needs its own signal. Meters are measured, not reported.'),
      section('reference', '3. Electrical reference',
        'Input 4 carries the reference the transfer function divides by.'),
      section('loopback', '4. Electrical loopback',
        'Patch a line-level output back into two inputs — a Y-lead, or the interface’s own loopback. ' +
        'Never connect an amplifier output to an interface. Keep the level low.'),
      section('microphones', '5. Measurement microphones',
        'Each microphone on its own, then all three together.'),
      section('matching', '6. Calibration and matching',
        'A manufacturer file corrects one microphone. Relative matching aligns B and C onto A.'),
      section('performance', '7. Processing performance',
        'Measured on this device. A modal figure is not a phone figure until it is measured on the phone.'),
      section('interruptions', '8. Interruptions',
        'Work through these with the phone in your hand. Live data is discarded the moment audio stops.'),
      '<p class="source-hint hw-foot" id="hwFoot"></p>',
    ].join('');

    // Loopback controls live under their own section.
    const loopBody = root.querySelector('[data-body="loopback"]');
    if (loopBody) {
      loopBody.innerHTML = [
        '<div class="row hw-controls">',
        '  <label for="selLoopFrom">Signal in</label>',
        '  <select id="selLoopFrom">' + channelOptions(0) + '</select>',
        '  <label for="selLoopTo">compared with</label>',
        '  <select id="selLoopTo">' + channelOptions(3) + '</select>',
        '  <button id="btnRunLoopback" class="btn" type="button">Run loopback check</button>',
        '</div>',
        '<div data-body="loopbackResult"></div>',
      ].join('');
    }

    const perfBody = root.querySelector('[data-body="performance"]');
    if (perfBody) {
      perfBody.innerHTML = [
        '<div class="row hw-controls" id="hwFftChoices">',
        fftButton(8192),
        fftButton(16384),
        fftButton(32768),
        '</div>',
        '<div data-body="perfResult"></div>',
      ].join('');
    }

    const interruptionBody = root.querySelector('[data-body="interruptions"]');
    if (interruptionBody) {
      const steps = [
        ['lock', 'Lock the screen for ten seconds, then unlock'],
        ['switch', 'Switch to another app and back'],
        ['call', 'Take a call, or trigger Siri, then return'],
        ['unplug', 'Unplug the USB hub'],
        ['replug', 'Plug it back in'],
        ['refresh', 'Refresh the browser page'],
      ];
      const widget = ['<div class="hw-checks">'];
      for (const [key, label] of steps) {
        widget.push('<label class="chk"><input type="checkbox" data-step="' + key + '"> ' + label + '</label>');
      }
      widget.push('</div>');
      widget.push('<div data-body="interruptResult"></div>');
      interruptionBody.innerHTML = widget.join('');
    }

    root.querySelector('#btnRunLoopback')?.addEventListener('click', runLoopback);
    root.querySelector('#selLoopFrom')?.addEventListener('change', (event) => {
      state.loopFrom = Number(event.target.value) || 0;
      state.loopback = null;
      render();
    });
    root.querySelector('#selLoopTo')?.addEventListener('change', (event) => {
      state.loopTo = Number(event.target.value) || 0;
      state.loopback = null;
      render();
    });
    for (const size of [8192, 16384, 32768]) {
      $('btnFft' + size)?.addEventListener('click', () => setFftSize(size));
    }
    for (const input of root.querySelectorAll('[data-step]')) {
      input.addEventListener('change', () => {
        state.checked[input.dataset.step] = input.checked;
        render();
      });
    }
    $('btnHwSave')?.addEventListener('click', saveReport);
  }

  function channelOptions(selected) {
    let html = '';
    for (let i = 0; i < 4; i++) {
      html += '<option value="' + i + '"' + (i === selected ? ' selected' : '') + '>Input ' +
        (i + 1) + '</option>';
    }
    return html;
  }

  function fftButton(size) {
    return '<button id="btnFft' + size + '" class="btn' + (size === state.fftSize ? ' on' : '') +
      '" type="button" data-fft="' + size + '">' + size + '</button>';
  }

  /* ---------- audio ---------- */

  function start() {
    if (!engine) return;
    setStatus('opening the interface for verification…');
    engine.start(Object.assign({}, sourceOptions(), { channels: 4 })).then((channels) => {
      state.running = true;
      state.startedAt = Date.now();
      state.lateAtStart = engine.droppedCallbacks || 0;
      buildAnalyser();
      state.loopback = null;
      state.timings = { accumulate: [], results: [] };
      bindDeviceListener();
      const button = $('btnHwStart');
      if (button) {
        button.textContent = 'Stop';
        button.classList.add('on');
      }
      setStatus('capturing ' + channels + ' channel' + (channels === 1 ? '' : 's') +
        ' · run the checks below');
      if (!raf) raf = requestAnimationFrame(run);
      render();
    }).catch((err) => {
      state.running = false;
      setStatus('could not open the interface: ' + (err && err.message ? err.message : err), 'err');
    });
  }

  function stop(reason) {
    state.running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (engine) engine.stop();
    analyser = null;
    state.results = null;
    const button = $('btnHwStart');
    if (button) {
      button.textContent = 'Start the interface check';
      button.classList.remove('on');
    }
    setStatus(reason || 'verification stopped');
    render();
  }

  function buildAnalyser() {
    analyser = new MultiAnalyser(state.fftSize, engine.sampleRate, 3);
    analyser.setUpdateRate(0.1);
    windows = [0, 1, 2].map(() => new Float32Array(state.fftSize));
    refWindow = new Float32Array(state.fftSize);
    state.results = null;
    lastAnalysis = 0;
  }

  function bindDeviceListener() {
    if (deviceListenerBound) return;
    deviceListenerBound = true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.addEventListener) return;
    navigator.mediaDevices.addEventListener('devicechange', () => {
      if (!state.running) return;
      // The input may be gone. Nothing measured from here on belongs to the old
      // configuration, so it is discarded and the check has to be restarted.
      stop('the input device changed — the channel count has to be verified again');
    });
  }

  function analyseFrame() {
    if (!analyser || !engine.running) return;
    const written = engine.micWritten;
    const end = written - 512;
    const start = end - state.fftSize;
    if (start < 0) return;

    const refChannel = 3;
    if (refChannel >= engine.channels) return;
    engine.readChannel(refWindow, start, refChannel);

    const micWindows = [null, null, null];
    for (let i = 0; i < 3; i++) {
      if (i >= engine.channels) continue;
      engine.readChannel(windows[i], start, i);
      micWindows[i] = windows[i];
    }

    const t0 = performance.now();
    analyser.accumulate(micWindows, refWindow);
    const t1 = performance.now();
    const results = analyser.results({
      compensate: false,
      smoothing: 1 / 6,
      normalize: false,
      phaseSmoothing: 1 / 6,
    });
    const t2 = performance.now();

    state.timings.accumulate.push(t1 - t0);
    state.timings.results.push(t2 - t1);
    if (state.timings.accumulate.length > 40) state.timings.accumulate.shift();
    if (state.timings.results.length > 40) state.timings.results.shift();

    state.results = results;
    state.levels = [0, 1, 2, 3].map((channel) => engine.channelLevel[channel] || 0);
    state.refLevel = state.levels[refChannel] || 0;
  }

  function run() {
    if (!state.active) return;
    const now = Date.now();
    if (state.running) {
      if (engine.interrupted || engine.trackIssue) {
        // Stale data is worse than none: drop it and say why.
        stop(engine.interrupted
          ? 'audio was suspended (' + engine.interrupted + ') — the measurement was discarded'
          : (engine.trackIssue || 'the input stopped') + ' — the measurement was discarded');
        return;
      }
      if (!engine.running && state.running) {
        stop('the audio input closed — the measurement was discarded');
        return;
      }
      if (analyser && now - lastAnalysis >= state.updateMs) {
        lastAnalysis = now;
        analyseFrame();
      }
    }
    if (now - lastRender >= 400) {
      lastRender = now;
      render();
    }
    raf = requestAnimationFrame(run);
  }

  /* ---------- judgements ---------- */

  function interfaceResult() {
    if (!state.running || !engine) return { result: UNVERIFIED, why: 'not listening' };
    const channels = engine.channels || 0;
    if (channels >= 4) return { result: PASS, why: channels + ' channels delivered' };
    if (channels > 0) {
      return { result: FAIL, why: 'only ' + channels + ' of the 4 inputs asked for were delivered' };
    }
    return { result: FAIL, why: 'no inputs were delivered' };
  }

  function correlationPairs() {
    const values = engine && engine.channelCorrelation ? engine.channelCorrelation : null;
    if (!values || !state.running) return null;
    return values;
  }

  /** Four inputs: signal on each, level comparable, none identical to another. */
  function inputsResult() {
    if (!state.running || !engine) return { result: UNVERIFIED, why: 'not listening' };
    if ((engine.channels || 0) < 4) {
      return { result: FAIL, why: 'only ' + (engine.channels || 0) + ' inputs were delivered' };
    }
    const silent = [];
    for (let i = 0; i < 4; i++) {
      if (!(state.levels[i] > Math.pow(10, TOLERANCE.micSignalDb / 20))) silent.push(i + 1);
    }
    if (silent.length === 4) return { result: UNVERIFIED, why: 'no signal on any input yet' };
    if (silent.length) {
      return { result: FAIL, why: 'silent: input' + (silent.length > 1 ? 's ' : ' ') + silent.join(', ') };
    }
    const pairs = correlationPairs();
    if (pairs) {
      for (let i = 1; i < 4; i++) {
        if (Math.abs(pairs[i]) > 0.9995) {
          return { result: FAIL, why: 'input ' + (i + 1) + ' carries the same signal as input 1' };
        }
      }
    }
    if (engine.channelDuplicated) {
      return { result: FAIL, why: 'several inputs carry the same signal' };
    }
    return { result: PASS, why: 'four inputs, four independent signals' };
  }

  function referenceResult() {
    if (!state.running) return { result: UNVERIFIED, why: 'not listening' };
    if ((engine.channels || 0) < 4) return { result: UNVERIFIED, why: 'channel 4 was not delivered' };
    const db = dbOf(state.refLevel);
    if (!(state.refLevel > 1e-4)) {
      return { result: UNVERIFIED, why: 'input 4 is silent — connect the reference' };
    }
    const clipped = engine.channelClippedUntil && engine.channelClippedUntil[3] > Date.now();
    if (clipped) return { result: FAIL, why: 'input 4 is clipping — lower the level' };
    return { result: PASS, why: db.toFixed(1) + ' dBFS on input 4' };
  }

  /* ---------- loopback ---------- */

  function loopbackWindows(fromChannel, toChannel, size, frames) {
    const hop = 1024;
    const total = frames * hop + size + 1024;
    if (engine.micWritten < total) return null;
    const start = engine.micWritten - 512 - (frames * hop + size);
    const from = new Float32Array(size);
    const to = new Float32Array(size);
    const analyserLoop = new Analyser(size, engine.sampleRate);
    analyserLoop.updateRate = 0.05;
    analyserLoop.searchRadius = 0;
    for (let frame = 0; frame < frames; frame++) {
      const offset = start + frame * hop;
      engine.readChannel(from, offset, fromChannel);
      engine.readChannel(to, offset, toChannel);
      analyserLoop.accumulate(to, from);
    }
    return {
      result: analyserLoop.results({ compensate: true, smoothing: 0, normalize: false }),
      from,
      to,
    };
  }

  function runLoopback() {
    if (!state.running || !engine || !engine.running) {
      setStatus('start the interface check before running the loopback', 'err');
      return;
    }
    const channels = engine.channels || 0;
    const from = Math.max(0, Math.min(3, state.loopFrom));
    const to = Math.max(0, Math.min(3, state.loopTo));
    if (from === to) {
      setStatus('the loopback needs two different inputs to compare', 'err');
      return;
    }
    if (from >= channels || to >= channels) {
      setStatus('input ' + (Math.max(from, to) + 1) + ' was not delivered by this device', 'err');
      return;
    }

    const levels = [state.levels[from] || 0, state.levels[to] || 0];
    if (!(levels[0] > 1e-5) || !(levels[1] > 1e-5)) {
      state.loopback = {
        result: UNVERIFIED,
        why: 'input' + (levels[0] > 1e-5 ? ' ' + (to + 1) : ' ' + (from + 1)) +
          ' has no signal — patch the output back into both inputs',
        measured: null,
      };
      setStatus('loopback: no signal to compare', 'err');
      render();
      return;
    }

    const frames = 36;
    const runA = loopbackWindows(from, to, 8192, frames);
    const runB = loopbackWindows(from, to, 16384, frames);
    if (!runA || !runB) {
      setStatus('not enough audio buffered yet — let it run for a few seconds and try again', 'err');
      return;
    }

    const flat = flatness(runA.result, LOOP_LOW, LOOP_HIGH);
    const flatB = flatness(runB.result, LOOP_LOW, LOOP_HIGH);
    if (!flat || !flatB) {
      state.loopback = { result: UNVERIFIED, why: 'the loopback curve had no usable bins', measured: null };
      render();
      return;
    }

    const delayA = runA.result.delayMs;
    const delayB = runB.result.delayMs;
    const agreement = Math.abs(delayA - delayB);
    const polarity = runA.result.polarityKnown ? runA.result.polarity : null;

    const faults = [];
    if (flat.coherence < TOLERANCE.loopbackCoherence) {
      faults.push('coherence ' + (flat.coherence * 100).toFixed(1) + '% is below ' +
        (TOLERANCE.loopbackCoherence * 100).toFixed(0) + '%');
    }
    if (flat.ripple > TOLERANCE.loopbackRippleDb) {
      faults.push('ripple ' + flat.ripple.toFixed(2) + ' dB is above ' +
        TOLERANCE.loopbackRippleDb + ' dB');
    }
    if (Math.abs(delayA) > TOLERANCE.loopbackDelayMs) {
      faults.push('delay ' + delayA.toFixed(3) + ' ms is beyond ±' +
        TOLERANCE.loopbackDelayMs + ' ms');
    }
    if (agreement > TOLERANCE.delayAgreementMs) {
      faults.push('the two FFT sizes disagree on the delay by ' + agreement.toFixed(3) + ' ms');
    }
    if (polarity !== null && polarity < 0) {
      faults.push('the two inputs are inverted relative to each other');
    }

    state.loopback = {
      result: faults.length ? FAIL : PASS,
      why: faults.length ? faults.join('; ') : 'flat, coherent, no delay, same polarity',
      measured: {
        level: flat.level,
        ripple: flat.ripple,
        rippleB: flatB.ripple,
        coherence: flat.coherence,
        delayMs: delayA,
        delaySamples: runA.result.delaySamples,
        delayMsB: delayB,
        agreement,
        polarity,
        from,
        to,
        bins: flat.bins,
        rate: engine.sampleRate,
        fftSize: 8192,
      },
    };
    setStatus('loopback ' + WORD[state.loopback.result] + ' — ' + state.loopback.why,
      state.loopback.result === PASS ? 'ok' : 'err');
    render();
  }

  /* ---------- microphones ---------- */

  function micRows() {
    const rows = [];
    for (let i = 0; i < 3; i++) {
      const result = state.results ? state.results[i] : null;
      const levelDb = dbOf(state.levels[i] || 0);
      let verdict = UNVERIFIED;
      let why = 'no measurement yet';
      if (!state.running) {
        why = 'not listening';
      } else if (i >= (engine.channels || 0)) {
        verdict = FAIL;
        why = 'input ' + (i + 1) + ' was not delivered';
      } else if (!(state.levels[i] > Math.pow(10, TOLERANCE.micSignalDb / 20))) {
        verdict = FAIL;
        why = 'silent';
      } else if (result && result.silent) {
        verdict = FAIL;
        why = 'no signal in the current window';
      } else if (result) {
        const coherence = flatness(result, BAND_LOW, BAND_HIGH);
        if (coherence && coherence.coherence >= TOLERANCE.micCoherence) {
          verdict = PASS;
          why = 'coherence ' + (coherence.coherence * 100).toFixed(0) + '%, delay ' +
            result.delayMs.toFixed(2) + ' ms';
        } else {
          verdict = FAIL;
          why = 'coherence ' + (coherence ? (coherence.coherence * 100).toFixed(0) : '—') +
            '% below ' + (TOLERANCE.micCoherence * 100).toFixed(0) + '%';
        }
      }
      rows.push({ letter: 'ABC'[i], verdict, why, levelDb });
    }
    return rows;
  }

  function matchingRows() {
    if (!state.results || !state.results[0]) return null;
    const rows = [];
    for (let i = 1; i < 3; i++) {
      if (!state.results[i]) continue;
      const difference = curveDifference(state.results[0], state.results[i], BAND_LOW, BAND_HIGH);
      if (!difference) continue;
      rows.push({
        letter: 'ABC'[i],
        mean: difference.mean,
        max: difference.max,
        trained: difference.mean <= TOLERANCE.matchResidualDb,
      });
    }
    return rows;
  }

  /* ---------- rendering ---------- */

  function setBadge(id, result) {
    const holder = document.querySelector('[data-badge="' + id + '"]');
    if (!holder) return;
    holder.innerHTML = badge(result);
  }

  function renderSection(id, rows) {
    const body = document.querySelector('[data-body="' + id + '"]');
    if (!body) return;
    body.innerHTML = rows.join('');
  }

  function render() {
    if (!state.active) return;
    const listening = state.running && engine && engine.running;

    // 1. Interface
    const iface = interfaceResult();
    setBadge('interface', iface.result);
    renderSection('interface', [
      row('Device', engine && engine.deviceLabel ? engine.deviceLabel : 'not opened', 'report'),
      row('Channels requested', engine ? String(engine.requestedChannels || 1) : '—', 'requested'),
      row('Channels delivered', engine && listening ? String(engine.channels || 0) : '—', 'report'),
      row('Sample rate', engine && listening ? (engine.sampleRate / 1000).toFixed(1) + ' kHz' : '—', 'report'),
      row('Audio state', engine ? (engine.interrupted ? 'suspended (' + engine.interrupted + ')'
        : listening ? 'running' : 'stopped') : '—', 'verified'),
      row('Verdict', iface.why, 'verified'),
    ]);

    // 2. Inputs
    const inputs = inputsResult();
    setBadge('inputs', inputs.result);
    const meter = (index) => {
      const level = state.levels[index] || 0;
      const ratio = level > 0 ? Math.min(1, Math.max(0, (dbOf(level) + 60) / 60)) : 0;
      const clipped = listening && engine.channelClippedUntil
        && engine.channelClippedUntil[index] > Date.now();
      return '<div class="diag-meter"><b>Input ' + (index + 1) + '</b>' +
        '<span class="diag-bar"><i class="' + (clipped ? 'clip' : '') + '" style="width:' +
        Math.round(ratio * 100) + '%"></i></span>' +
        '<span>' + (listening && index < (engine.channels || 0)
          ? (clipped ? 'CLIP' : (level > 0 ? dbOf(level).toFixed(1) + ' dBFS' : 'silent'))
          : 'not delivered') + '</span></div>';
    };
    const separation = correlationPairs();
    const separationText = separation
      ? [1, 2, 3].map((i) => '1/' + (i + 1) + ' ' + separation[i].toFixed(3)).join(' · ')
      : 'not measured yet';
    renderSection('inputs', [
      [0, 1, 2, 3].map(meter).join(''),
      row('Correlation against input 1', separationText, 'verified'),
      row('Duplicate or mixed channels', engine && engine.channelDuplicated ? 'yes' : 'no', 'verified'),
      row('Clipping', [0, 1, 2, 3].some((i) => listening && engine.channelClippedUntil
        && engine.channelClippedUntil[i] > Date.now()) ? 'on an input' : 'none', 'verified'),
      row('Verdict', inputs.why, 'verified'),
    ]);

    // 3. Reference
    const reference = referenceResult();
    setBadge('reference', reference.result);
    renderSection('reference', [
      row('Level on input 4', listening ? (state.refLevel > 0 ? dbOf(state.refLevel).toFixed(1) + ' dBFS' : 'silent') : '—', 'verified'),
      row('Reference used by the analysers', 'input 4', 'app'),
      row('Verdict', reference.why, 'verified'),
    ]);

    // 4. Loopback
    const loop = state.loopback;
    setBadge('loopback', loop ? loop.result : UNVERIFIED);
    const loopRows = [];
    if (!loop) {
      loopRows.push(row('Status', 'not run — start the check and press Run loopback check', 'verified'));
      loopRows.push(row('Tolerances', 'coherence ≥ ' + TOLERANCE.loopbackCoherence * 100 +
        '%, ripple ≤ ' + TOLERANCE.loopbackRippleDb + ' dB, |delay| ≤ ' +
        TOLERANCE.loopbackDelayMs + ' ms, sizes agree within ' + TOLERANCE.delayAgreementMs + ' ms', 'app'));
    } else if (!loop.measured) {
      loopRows.push(row('Status', loop.why, 'verified'));
    } else {
      const m = loop.measured;
      loopRows.push(row('Compared', 'input ' + (m.from + 1) + ' against input ' + (m.to + 1), 'app'));
      loopRows.push(row('Sample rate', (m.rate / 1000).toFixed(1) + ' kHz · ' + m.bins + ' bins used', 'report'));
      loopRows.push(row('Ripple (expected 0.00 dB, ≤ ' + TOLERANCE.loopbackRippleDb + ')', m.ripple.toFixed(3) + ' dB', 'verified'));
      loopRows.push(row('Mean level', m.level.toFixed(2) + ' dB', 'verified'));
      loopRows.push(row('Coherence (expected 100%, ≥ ' + (TOLERANCE.loopbackCoherence * 100) + '%)',
        (m.coherence * 100).toFixed(1) + '%', 'verified'));
      loopRows.push(row('Delay (expected 0.000 ms)', m.delayMs.toFixed(3) + ' ms · ' +
        (finite(m.delaySamples) ? m.delaySamples.toFixed(2) : '—') + ' samples', 'verified'));
      loopRows.push(row('Delay at 16384', m.delayMsB.toFixed(3) + ' ms · sizes differ by ' +
        m.agreement.toFixed(3) + ' ms', 'verified'));
      loopRows.push(row('Polarity', m.polarity === null ? 'not decided' :
        m.polarity > 0 ? 'normal' : 'inverted', 'verified'));
      loopRows.push(row('Verdict', loop.why, 'verified'));
    }
    renderSection('loopbackResult', loopRows);

    // 5. Microphones
    const mics = micRows();
    const micVerdict = mics.every((item) => item.verdict === PASS) ? PASS
      : mics.some((item) => item.verdict === FAIL) ? FAIL : UNVERIFIED;
    setBadge('microphones', micVerdict);
    renderSection('microphones', mics.map((item) =>
      row('Mic ' + item.letter + (Number.isFinite(item.levelDb) ? ' · ' + item.levelDb.toFixed(1) + ' dBFS' : ''),
        badge(item.verdict) + ' <span class="hw-note">' + item.why + '</span>', 'verified')));

    // 6. Calibration and matching
    const matches = matchingRows();
    const matchVerdict = !matches ? UNVERIFIED
      : matches.some((item) => !item.trained) ? FAIL : PASS;
    setBadge('matching', matchVerdict);
    const matchRows = [];
    if (!matches) {
      matchRows.push(row('Status', 'no three-microphone measurement yet', 'verified'));
    } else {
      for (const item of matches) {
        matchRows.push(row('Mic ' + item.letter + ' vs A',
          'mean ' + item.mean.toFixed(2) + ' dB · worst ' + item.max.toFixed(2) + ' dB', 'verified'));
      }
      const worst = Math.max(...matches.map((item) => item.mean));
      matchRows.push(row('Reading', worst <= TOLERANCE.matchResidualDb
        ? 'the microphones agree within ' + TOLERANCE.matchResidualDb +
          ' dB — any difference is microphone response, not position'
        : 'the microphones differ by more than ' + TOLERANCE.matchResidualDb +
          ' dB — either the capsules are not together or their responses differ; ' +
          'this is acoustic or microphone, not something the app can tell apart for you', 'verified'));
    }
    matchRows.push(row('Manufacturer files', 'one per microphone, removed before matching is applied', 'app'));
    renderSection('matching', matchRows);

    // 7. Performance
    const acc = median(state.timings.accumulate);
    const res = median(state.timings.results);
    const total = acc + res;
    const rate = state.fftSize && engine && engine.sampleRate
      ? engine.sampleRate / state.fftSize : 0;
    const late = listening ? (engine.droppedCallbacks || 0) - state.lateAtStart : 0;
    const windowMs = rate > 0 ? 1000 / rate : 0;
    const budget = total * (1000 / state.updateMs);
    let perfVerdict = UNVERIFIED;
    if (listening && state.timings.accumulate.length > 5) {
      perfVerdict = budget <= TOLERANCE.analysisBudgetMs && late <= 2 ? PASS : FAIL;
    }
    setBadge('performance', perfVerdict);
    renderSection('perfResult', [
      row('FFT size', state.fftSize + ' · ' + windowMs.toFixed(0) + ' ms window · ' +
        rate.toFixed(1) + ' Hz resolution', 'app'),
      row('Analyser time', total ? total.toFixed(2) + ' ms per frame (' +
        acc.toFixed(2) + ' + ' + res.toFixed(2) + ')' : 'no frames yet', 'verified'),
      row('Budget at ' + Math.round(1000 / state.updateMs) + ' updates/s',
        total ? budget.toFixed(1) + ' ms of every 1000 ms (limit ' +
          TOLERANCE.analysisBudgetMs + ')' : '—', 'verified'),
      row('Late audio callbacks', listening ? String(late) : '—', 'verified'),
      row('Updates', Math.round(1000 / state.updateMs) + ' per second', 'app'),
      row('Recommendation', recommendation(total, late), 'verified'),
    ]);

    // 8. Interruptions
    const audioState = !state.running ? 'stopped'
      : engine.interrupted ? 'suspended (' + engine.interrupted + ')'
        : engine.trackIssue ? engine.trackIssue
          : 'running';
    const allChecked = ['lock', 'switch', 'call', 'unplug', 'replug', 'refresh']
      .every((key) => state.checked[key]);
    setBadge('interruptions', state.running && !engine.interrupted && !engine.trackIssue
      ? (allChecked ? PASS : UNVERIFIED)
      : UNVERIFIED);
    renderSection('interruptResult', [
      row('Audio now', audioState, 'verified'),
      row('Measurement after an interruption', 'discarded, never shown as live', 'app'),
      row('Steps ticked',
        ['lock', 'switch', 'call', 'unplug', 'replug', 'refresh']
          .filter((key) => state.checked[key]).length + ' of 6', 'verified'),
      row('What to check', 'after each step, this screen must stop the measurement or ' +
        'discard it; Start again revalidates the channel count before any reading', 'app'),
    ]);

    const foot = $('hwFoot');
    if (foot) {
      foot.textContent = listening
        ? 'Measured from the samples that arrived. A PASS here is a result on this device and this ' +
          'interface; no other hardware is implied.'
        : 'Start the interface check to measure. Nothing on this screen is simulated.';
    }
  }

  function recommendation(frameMs, late) {
    if (!state.running) return 'start the check to measure';
    if (!(frameMs > 0)) return 'no frames yet';
    if (late > 2) {
      return 'late callbacks: use a smaller FFT size and a slower update rate on this device';
    }
    if (frameMs > 180) return 'too slow at this size — use 8192 and check the curve is still readable';
    if (frameMs > 60) return 'workable; 8192 leaves more headroom on this device';
    if (state.fftSize < 16384) return 'headroom to spare — 16384 gives twice the low-frequency resolution';
    if (state.fftSize < 32768) return 'this size is comfortable here; 32768 is worth trying for low end';
    return 'this size is comfortable here';
  }

  function setFftSize(size) {
    state.fftSize = size;
    for (const button of document.querySelectorAll('[data-fft]')) {
      button.classList.toggle('on', Number(button.dataset.fft) === size);
    }
    if (state.running) {
      buildAnalyser();
      state.timings = { accumulate: [], results: [] };
      setStatus('FFT size ' + size + ' — measuring again from scratch');
    }
    render();
  }

  /* ---------- the saved report ---------- */

  function reportLines() {
    const now = new Date().toISOString();
    const lines = [];
    const add = (key, value) => lines.push(key + ': ' + value);
    add('Align hardware verification', now);
    add('Build', 'see version.json');
    add('Browser', navigator.userAgent);
    add('Device', engine && engine.deviceLabel ? engine.deviceLabel : 'not opened');
    add('Channels requested', engine ? String(engine.requestedChannels || 1) : '—');
    add('Channels delivered', engine ? String(engine.channels || 0) : '—');
    add('Sample rate', engine ? String(engine.sampleRate) : '—');
    add('', '');
    add('Interface', WORD[interfaceResult().result] + ' — ' + interfaceResult().why);
    add('Inputs', WORD[inputsResult().result] + ' — ' + inputsResult().why);
    add('Reference', WORD[referenceResult().result] + ' — ' + referenceResult().why);

    const loop = state.loopback;
    if (!loop) {
      add('Loopback', 'UNVERIFIED — not run');
    } else if (!loop.measured) {
      add('Loopback', 'UNVERIFIED — ' + loop.why);
    } else {
      const m = loop.measured;
      add('Loopback', WORD[loop.result] + ' — ' + loop.why);
      add('  ripple', m.ripple.toFixed(3) + ' dB (tolerance ' + TOLERANCE.loopbackRippleDb + ')');
      add('  coherence', (m.coherence * 100).toFixed(1) + '% (tolerance ' +
        (TOLERANCE.loopbackCoherence * 100) + '%)');
      add('  delay', m.delayMs.toFixed(3) + ' ms (tolerance ±' + TOLERANCE.loopbackDelayMs + ')');
      add('  delay 16384', m.delayMsB.toFixed(3) + ' ms, agreement ' + m.agreement.toFixed(3) + ' ms');
      add('  polarity', m.polarity === null ? 'not decided' : m.polarity > 0 ? 'normal' : 'inverted');
    }

    for (const item of micRows()) {
      add('Mic ' + item.letter, WORD[item.verdict] + ' — ' + item.why);
    }
    const matches = matchingRows();
    if (matches) {
      for (const item of matches) {
        add('Mic ' + item.letter + ' vs A', 'mean ' + item.mean.toFixed(2) + ' dB, worst ' +
          item.max.toFixed(2) + ' dB');
      }
    } else {
      add('Matching', 'UNVERIFIED — no three-microphone measurement');
    }

    const acc = median(state.timings.accumulate);
    const res = median(state.timings.results);
    add('', '');
    add('FFT size', String(state.fftSize));
    add('Analyser time', (acc + res).toFixed(2) + ' ms per frame (' + acc.toFixed(2) + ' + ' +
      res.toFixed(2) + ')');
    add('Late callbacks', String(state.running ? (engine.droppedCallbacks || 0) - state.lateAtStart : 0));
    add('Audio at the end', state.running ? (engine.interrupted || 'running') : 'stopped');
    add('Interruption steps ticked',
      ['lock', 'switch', 'call', 'unplug', 'replug', 'refresh'].filter((key) => state.checked[key]).join(', ') || 'none');
    lines.push('');
    lines.push('A PASS means measured data met the stated tolerance on this device and interface.');
    lines.push('It is not a claim about any other hardware.');
    return lines.join('\n');
  }

  function saveReport() {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const blob = new Blob([reportLines() + '\n'], { type: 'text/plain' });
    shareOrDownload(blob, 'Align hardware check ' + stamp + '.txt', 'Align hardware check')
      .then((result) => {
        setStatus(result === 'downloaded' ? 'report downloaded' : 'report ready to share', 'ok');
      })
      .catch(() => setStatus('this browser would not share or download the report', 'err'));
  }

  /* ---------- lifecycle ---------- */

  function open() {
    state.active = true;
    // Only one screen may hold the audio graph, so the other one is told first.
    if (typeof opts.onOpen === 'function') opts.onOpen();
    const section = $('hwWorkspace');
    if (section) section.hidden = false;
    build();
    render();
    setStatus('hardware verification ready — start the interface check');
    lastAnalysis = 0;
    lastRender = 0;
    raf = requestAnimationFrame(run);
  }

  function close() {
    if (state.running) stop('verification closed');
    state.active = false;
    const section = $('hwWorkspace');
    if (section) section.hidden = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (typeof opts.onClose === 'function') opts.onClose();
  }

  return {
    open,
    close,
    start,
    stop,
    get active() {
      return state.active;
    },
    get running() {
      return state.running;
    },
    state,
    reportLines,
    // The judgements read state and engine only, so they can be exercised
    // without a screen. tests/hardware.mjs uses them.
    judgements: { interfaceResult, inputsResult, referenceResult, flatness, curveDifference },
    runLoopback,
  };
}
