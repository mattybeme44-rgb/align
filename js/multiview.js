import { MultiAnalyser } from './multianalyser.js';
import { MultiChart, MULTI_COLORS } from './multichart.js';
import { spatialAverage, meanCoherence, SPATIAL_MODES } from './spatial.js';
import {
  MATCH_LETTERS,
  MATCH_DEFAULTS,
  relativeMatch,
  applyCorrection,
  combineCorrections,
  calibrationCurve,
  decimateCurve,
  curveFromPoints,
  loadMatchProfiles,
  persistMatchProfiles,
  newMatchProfile,
  loadMicCalibrations,
  persistMicCalibrations,
} from './micmatch.js';
import { parseCalibration } from './calibration.js';
import { createDiagnostics } from './diagnostics.js';
import { shareOrDownload } from './sharing.js';

/**
 * The four-channel, three-microphone workspace.
 *
 * One electrical reference on the fourth channel is compared against microphones
 * A, B and C at once. Each microphone keeps its own transfer function, delay and
 * coherence; the average is built from whichever ones the operator enables.
 *
 * The analysers run at their own pace (a few frames a second) and the chart is
 * painted on the animation frame, so drawing never slows the measurement down.
 */
export function createMultiView(options) {
  const opts = options || {};
  const engine = opts.engine;
  const setStatus = typeof opts.setStatus === 'function' ? opts.setStatus : () => {};
  const sourceOptions = typeof opts.sourceOptions === 'function' ? opts.sourceOptions : () => ({});
  const generator = typeof opts.generator === 'function'
    ? opts.generator
    : () => ({ signal: 'pink', level: 0.2, sineHz: 1000 });

  const state = {
    active: false,
    running: false,
    frozen: false,
    fftSize: 2048 * 8,
    updateMs: 350,
    mode: 'power',
    smoothing: 1 / 6,
    coherenceThreshold: 0.35,
    showPhase: true,
    showCoherence: true,
    phaseMode: 'wrapped',
    showAverage: true,
    showOnlyAverage: false,
    enabled: [true, true, true],
    visible: [true, true, true],
    phaseVisible: [true, true, true],
    offsets: [0, 0, 0],
    bypassCorrections: false,
    routing: { a: 0, b: 1, c: 2, ref: 3 },
    calibrations: {},
    profiles: [],
    snapshots: [],
    viewing: 'live',
    selectedCalibrationLetter: 'A',
  };

  let chart = null;
  let analyser = null;
  let windows = [];
  let refWindow = null;
  let results = [null, null, null];
  let average = null;
  let weights = [0, 0, 0];
  let lastAnalysis = 0;
  let lastUi = 0;
  let cursorFreq = null;
  let drag = null;
  let bound = false;
  let observerBound = false;
  let levels = [0, 0, 0];

  // Reads the engine and the analysers; it never starts or changes audio.
  const diagnostics = createDiagnostics({
    engine,
    getState: () => ({
      fftSize: analyser ? analyser.fftSize : state.fftSize,
      frames: analyser ? analyser.frames : 0,
      routing: state.routing,
      running: state.running,
    }),
  });

  const mics = MATCH_LETTERS.map((letter) => ({
    letter,
    channelWord: 'ch 1',
    deviceChannel: 0,
    available: false,
  }));

  const cards = {};

  /* ---------- DOM ---------- */

  const $ = (id) => document.getElementById(id);

  function element(id) {
    return $(id);
  }

  function buildChart() {
    const canvas = element('multiChart');
    if (!canvas) return;
    if (!chart) {
      chart = new MultiChart(canvas);
      bindChartPointer(canvas);
    } else {
      chart.canvas = canvas;
      chart.ctx = canvas.getContext('2d');
      chart.resize();
    }
    if (typeof ResizeObserver === 'function' && !observerBound) {
      // The workspace is hidden until it opens, so the canvas has no size then.
      observerBound = true;
      const observer = new ResizeObserver(() => {
        if (!chart) return;
        chart.resize();
        chart.draw(chartState());
      });
      observer.observe(canvas.parentElement || canvas);
    }
  }

  function buildCards() {
    const holder = element('multiMics');
    if (!holder) return;
    if (Object.keys(cards).length) return;
    holder.textContent = '';
    for (let i = 0; i < MATCH_LETTERS.length; i++) {
      const letter = MATCH_LETTERS[i];
      const card = document.createElement('div');
      card.className = 'multi-mic';
      card.dataset.letter = letter;
      card.style.setProperty('--mic', MULTI_COLORS[letter]);
      card.innerHTML = [
        '<div class="multi-mic-head">',
        '  <span class="multi-swatch"></span>',
        '  <b>Mic ' + letter + '</b>',
        '  <span class="multi-ch" data-role="channel">ch 1</span>',
        '  <button class="link-btn" type="button" data-act="visible" aria-pressed="true">hide</button>',
        '</div>',
        '<div class="multi-mic-row"><span>Level</span><b data-role="level">—</b></div>',
        '<div class="multi-mic-row"><span>Delay</span><b data-role="delay">—</b></div>',
        '<div class="multi-mic-row"><span>Coherence</span><b data-role="coherence">—</b></div>',
        '<div class="multi-mic-row"><span>Offset</span>',
        '  <input type="number" step="0.05" min="-20" max="20" value="0" data-act="offset" aria-label="Display phase offset for mic ' + letter + ' in milliseconds">',
        '  <span class="multi-unit">ms</span>',
        '</div>',
        '<div class="multi-mic-flags">',
        '  <label class="chk"><input type="checkbox" data-act="enabled" checked> average</label>',
        '  <label class="chk"><input type="checkbox" data-act="phase" checked> phase</label>',
        '</div>',
        '<p class="multi-mic-note" data-role="note"></p>',
        '<p class="multi-mic-warn" data-role="warn" hidden></p>',
      ].join('');
      holder.appendChild(card);
      cards[letter] = {
        root: card,
        channel: card.querySelector('[data-role="channel"]'),
        level: card.querySelector('[data-role="level"]'),
        delay: card.querySelector('[data-role="delay"]'),
        coherence: card.querySelector('[data-role="coherence"]'),
        note: card.querySelector('[data-role="note"]'),
        warn: card.querySelector('[data-role="warn"]'),
        offset: card.querySelector('[data-act="offset"]'),
        enabled: card.querySelector('[data-act="enabled"]'),
        phase: card.querySelector('[data-act="phase"]'),
        visible: card.querySelector('[data-act="visible"]'),
      };
    }

    holder.addEventListener('change', (event) => {
      const letter = event.target.closest('.multi-mic')?.dataset.letter;
      const index = MATCH_LETTERS.indexOf(letter);
      if (index < 0) return;
      const act = event.target.dataset.act;
      if (act === 'enabled') state.enabled[index] = event.target.checked;
      if (act === 'phase') state.phaseVisible[index] = event.target.checked;
      if (act === 'offset') {
        const value = Number(event.target.value);
        state.offsets[index] = Number.isFinite(value) ? Math.max(-20, Math.min(20, value)) : 0;
      }
      drawNow();
    });

    holder.addEventListener('click', (event) => {
      const button = event.target.closest('[data-act="visible"]');
      if (!button) return;
      const letter = button.closest('.multi-mic')?.dataset.letter;
      const index = MATCH_LETTERS.indexOf(letter);
      if (index < 0) return;
      state.visible[index] = !state.visible[index];
      button.textContent = state.visible[index] ? 'hide' : 'show';
      button.setAttribute('aria-pressed', state.visible[index] ? 'true' : 'false');
      drawNow();
    });
  }

  function bindChartPointer(canvas) {
    canvas.addEventListener('pointerdown', (event) => {
      if (!chart) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      drag = { pointerId: event.pointerId, startX: x, currentX: x, moved: false };
      cursorFreq = chart.freqAtX(x);
      chart.selection = null;
      updateReadout();
      drawNow();
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch (err) {
        /* not every browser needs it */
      }
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!chart) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      if (drag && event.pointerId === drag.pointerId) {
        drag.currentX = x;
        if (Math.abs(x - drag.startX) >= 10) drag.moved = true;
        if (drag.moved) chart.selection = { x0: drag.startX, x1: x };
        else cursorFreq = chart.freqAtX(x);
        updateReadout();
        drawNow();
        return;
      }
      cursorFreq = chart.freqAtX(x);
      updateReadout();
      drawNow();
    });

    const end = (event) => {
      if (!drag || event.pointerId !== drag.pointerId || !chart) return;
      const finished = drag;
      drag = null;
      chart.selection = null;
      if (finished.moved) {
        const lower = chart.freqAtX(Math.min(finished.startX, finished.currentX));
        const upper = chart.freqAtX(Math.max(finished.startX, finished.currentX));
        if (upper / lower >= 1.08) {
          chart.setRange(lower, upper);
          cursorFreq = null;
          if (element('btnMultiReset')) element('btnMultiReset').hidden = false;
        }
      }
      updateReadout();
      drawNow();
    };

    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', () => {
      if (drag) return;
      cursorFreq = null;
      updateReadout();
      drawNow();
    });
  }

  function bindControls() {
    if (bound) return;
    bound = true;

    element('btnMultiStart')?.addEventListener('click', () => {
      if (state.running) stopListening();
      else startListening();
    });

    element('btnMultiFreeze')?.addEventListener('click', () => {
      state.frozen = !state.frozen;
      const button = element('btnMultiFreeze');
      if (button) {
        button.textContent = state.frozen ? 'Resume' : 'Freeze';
        button.classList.toggle('on', state.frozen);
      }
      setStatus(state.frozen ? 'display held — the analysers are paused' : 'live again');
    });

    element('btnMultiSnapshot')?.addEventListener('click', takeSnapshot);
    element('btnMultiExport')?.addEventListener('click', exportCsv);

    element('btnMultiReset')?.addEventListener('click', () => {
      if (chart) chart.setRange(20, 20000);
      cursorFreq = null;
      const button = element('btnMultiReset');
      if (button) button.hidden = true;
      updateReadout();
      drawNow();
    });

    element('selMultiMode')?.addEventListener('change', (event) => {
      state.mode = event.target.value;
      updateUI(true);
      drawNow();
    });

    element('selMultiSmoothing')?.addEventListener('change', (event) => {
      state.smoothing = Number(event.target.value) || 0;
      analyser?.results({ smoothing: state.smoothing });
      updateUI(true);
      drawNow();
    });

    element('selMultiRate')?.addEventListener('change', (event) => {
      state.updateMs = Math.max(120, Number(event.target.value) || 350);
    });

    element('chkMultiShowAverage')?.addEventListener('change', (event) => {
      state.showAverage = event.target.checked;
      drawNow();
    });

    element('chkMultiPhase')?.addEventListener('change', (event) => {
      state.showPhase = event.target.checked;
      drawNow();
    });

    element('chkMultiCoh')?.addEventListener('change', (event) => {
      state.showCoherence = event.target.checked;
      drawNow();
    });

    for (const letter of MATCH_LETTERS) {
      const select = element('selMultiCh' + letter.toUpperCase());
      if (select) {
        select.addEventListener('change', () => applyRouting());
      }
    }
    element('selMultiChREF')?.addEventListener('change', () => applyRouting());

    element('btnMatchB')?.addEventListener('click', () => runMatch('B'));
    element('btnMatchC')?.addEventListener('click', () => runMatch('C'));

    element('chkMatchBypass')?.addEventListener('change', (event) => {
      state.bypassCorrections = event.target.checked;
      updateUI(true);
      drawNow();
    });

    for (const letter of MATCH_LETTERS) {
      element('btnMultiCal' + letter)?.addEventListener('click', () => {
        state.selectedCalibrationLetter = letter;
        const input = element('multiCalFile');
        if (!input) return;
        input.value = '';
        input.click();
      });
    }

    element('multiCalFile')?.addEventListener('change', handleCalibrationFile);
    element('btnMultiClearCal')?.addEventListener('click', () => {
      state.calibrations = {};
      persistMicCalibrations({});
      setCalNote('No manufacturer calibration is loaded for any microphone.');
      updateUI(true);
      drawNow();
    });
  }

  /* ---------- audio ---------- */

  function channelFor(letter) {
    return letter === 'REF'
      ? Number(state.routing.ref)
      : Number(state.routing[letter.toLowerCase()]);
  }

  function applyRouting() {
    const next = {
      a: Number(element('selMultiChA')?.value ?? 0),
      b: Number(element('selMultiChB')?.value ?? 1),
      c: Number(element('selMultiChC')?.value ?? 2),
      ref: Number(element('selMultiChREF')?.value ?? 3),
    };
    const used = [next.a, next.b, next.c, next.ref];
    if (new Set(used).size < used.length) {
      setStatus('each input can only carry one signal — two channels are routed to the same input', 'err');
      updateRoutingSelects();
      return;
    }
    state.routing = next;
    if (engine && engine.routing) engine.routing = next;
    analyser?.reset();
    analyser?.setSampleRate(engine.sampleRate);
    updateRoutingSelects();
    updateUI(true);
    setStatus('routing updated — the analysers were reset', 'ok');
  }

  function updateRoutingSelects() {
    for (const key of ['A', 'B', 'C', 'REF']) {
      const select = element('selMultiCh' + key);
      if (!select) continue;
      const value = key === 'REF' ? state.routing.ref : state.routing[key.toLowerCase()];
      select.value = String(value);
    }
  }

  async function startListening() {
    if (!engine) return;
    setStatus('opening four inputs…');
    try {
      const channels = await engine.start(Object.assign({}, sourceOptions(), { channels: 4 }));
      engine.routing = state.routing;
      const generated = generator();
      engine.setSignal(generated.signal || 'pink');
      engine.setLevel(Number(generated.level) || 0.2);
      engine.setSineHz(Number(generated.sineHz) || 1000);

      state.running = true;
      state.frozen = false;
      state.viewing = 'live';
      analyser = new MultiAnalyser(state.fftSize, engine.sampleRate, 3);
      analyser.setUpdateRate(rateForUpdate());
      windows = [0, 1, 2].map(() => new Float32Array(state.fftSize));
      refWindow = new Float32Array(state.fftSize);
      results = [null, null, null];
      average = null;
      lastAnalysis = 0;

      const button = element('btnMultiStart');
      if (button) {
        button.textContent = 'Stop listening';
        button.classList.add('on');
      }

      reportCapture(channels);
    } catch (err) {
      state.running = false;
      setStatus('multi-channel capture failed: ' + (err && err.message ? err.message : err), 'err');
      const button = element('btnMultiStart');
      if (button) button.textContent = 'Start listening';
    }
  }

  function stopListening() {
    state.running = false;
    state.frozen = false;
    if (engine) engine.stop();
    analyser = null;
    results = [null, null, null];
    average = null;
    const button = element('btnMultiStart');
    if (button) {
      button.textContent = 'Start listening';
      button.classList.remove('on');
    }
    const freeze = element('btnMultiFreeze');
    if (freeze) {
      freeze.textContent = 'Freeze';
      freeze.classList.remove('on');
    }
    setStatus('multi-channel measurement stopped');
    updateUI(true);
    drawNow();
  }

  function reportCapture(channels) {
    const rate = engine.sampleRate;
    const count = Number(channels) || engine.channels || 1;
    const parts = [
      engine.deviceLabel || 'audio input',
      count + (count === 1 ? ' channel' : ' channels'),
      (rate / 1000).toFixed(1) + ' kHz',
    ];
    let text = 'capturing ' + parts.join(' · ');
    let kind = 'ok';

    if (count < 4) {
      kind = 'err';
      text += ' — the browser opened only ' + count +
        ', so a four-input measurement is not possible. Channel 4 must be the electrical reference.';
    }
    if (engine.channelDuplicated && count > 1) {
      kind = 'err';
      text += ' — several inputs are carrying the same signal; check the interface and the routing.';
    }
    setStatus(text, kind);
  }

  function rateForUpdate() {
    // A 350 ms analysis interval with a 45 % follow rate settles like the single
    // measurement screen's averaging at the same speed.
    return Math.min(0.9, Math.max(0.05, 260 / Math.max(120, state.updateMs) * 0.45));
  }

  /* ---------- analysis ---------- */

  function analyseFrame() {
    if (!analyser || !engine.running) return;
    const n = state.fftSize;
    const written = engine.micWritten;
    const end = written - 512;
    const start = end - state.fftSize;
    if (start < 0) return;

    const refChannel = channelFor('REF');
    if (refChannel >= engine.channels) return;
    engine.readChannel(refWindow, start, refChannel);

    const micWindows = [null, null, null];
    const levelsNow = [0, 0, 0];
    for (let i = 0; i < MATCH_LETTERS.length; i++) {
      const channel = channelFor(MATCH_LETTERS[i]);
      if (channel >= engine.channels) {
        mics[i].available = false;
        continue;
      }
      mics[i].available = true;
      engine.readChannel(windows[i], start, channel);
      micWindows[i] = windows[i];
      levelsNow[i] = engine.channelLevel[channel] || 0;
    }
    levels = levelsNow;

    analyser.accumulate(micWindows, refWindow);
    results = analyser.results({
      compensate: false,
      smoothing: state.smoothing,
      normalize: false,
      phaseSmoothing: state.smoothing,
    });

    recomputeAverage();
    // Only a frame that actually reached the analysers counts towards the
    // analysis rate, so the figure is not the display's refresh rate.
    diagnostics.noteAnalysis(Date.now());
    lastUi = Date.now();
  }

  function correctionsFor(letterIndex) {
    if (state.bypassCorrections) return null;
    const letter = MATCH_LETTERS[letterIndex];
    const bins = analyser ? analyser.bins : 0;
    const df = analyser ? analyser.df : 0;
    if (!bins) return null;

    let curve = null;

    const calibration = state.calibrations[letter];
    if (calibration) {
      curve = calibrationCurve(calibration, bins, df);
    }

    const profile = state.profiles.find((item) => item.mic === letter);
    if (profile) {
      const matchCurve = curveFromPoints(profile.points, bins, df);
      curve = combineCorrections(curve, matchCurve);
    }

    return curve;
  }

  function displayedSeries() {
    const series = [];
    for (let i = 0; i < MATCH_LETTERS.length; i++) {
      const result = results[i];
      const letter = MATCH_LETTERS[i];
      if (!result) continue;
      const correction = correctionsFor(i);
      const magnitude = correction ? applyCorrection(result.magDb, correction) : result.magDb;
      series.push({
        letter,
        color: MULTI_COLORS[letter],
        visible: state.visible[i] && state.enabled[i] !== false,
        phaseVisible: state.phaseVisible[i],
        phaseOffsetMs: state.offsets[i],
        trace: {
          bins: result.bins,
          df: result.df,
          coh: result.coh,
          phaseDeg: result.phaseDeg,
          delayMs: result.delayMs,
          magDb: magnitude,
        },
      });
    }
    return series;
  }

  function recomputeAverage() {
    if (!analyser) {
      average = null;
      weights = [0, 0, 0];
      return;
    }
    const corrections = [];
    for (let i = 0; i < MATCH_LETTERS.length; i++) corrections.push(correctionsFor(i));
    const combined = spatialAverage(results, state.enabled, state.mode, corrections);
    weights = combined.contributions;
    const first = results.find((item) => item);
    average = first
      ? {
          bins: first.bins,
          df: first.df,
          coh: new Float32Array(first.bins),
          phaseDeg: new Float32Array(first.bins),
          delayMs: 0,
          magDb: combined.magDb,
        }
      : null;
    if (average && results[0]) {
      // The average has no phase of its own; the phase pane shows the microphones.
      average.comp =
        combined.contributions.reduce((sum, value) => sum + value, 0);
    }
  }

  /* ---------- chart ---------- */

  function activeSnapshot() {
    const found = state.snapshots.find((item) => item.id === state.viewing);
    return found || null;
  }

  function chartState() {
    const snapshot = activeSnapshot();
    if (snapshot) {
      return {
        series: snapshot.series,
        average: snapshot.average,
        showAverage: state.showAverage,
        showPhase: state.showPhase,
        showCoherence: state.showCoherence,
        phaseMode: state.phaseMode,
        phaseSpan: state.phaseMode === 'unwrapped' ? 360 : 180,
        coherenceThreshold: state.coherenceThreshold,
        cursorFreq,
      };
    }
    return {
      series: displayedSeries(),
      average,
      showAverage: state.showAverage,
      showPhase: state.showPhase,
      showCoherence: state.showCoherence,
      phaseMode: state.phaseMode,
      phaseSpan: state.phaseMode === 'unwrapped' ? 360 : 180,
      coherenceThreshold: state.coherenceThreshold,
      cursorFreq,
    };
  }

  function drawNow() {
    if (!chart) return;
    if (chart.w < 80 || chart.h < 80) chart.resize();
    chart.draw(chartState());
  }

  /* ---------- readout and cards ---------- */

  function updateReadout() {
    const readout = element('multiReadout');
    if (!readout) return;
    const snapshot = activeSnapshot();
    const series = snapshot ? snapshot.series : displayedSeries();
    if (!Number.isFinite(cursorFreq) || !series.length) {
      readout.textContent = 'move the cursor over the plot to read the three microphones there';
      return;
    }
    const first = series[0];
    const bins = first.trace.bins;
    const df = first.trace.df;
    const k = Math.min(bins - 1, Math.max(0, Math.round(cursorFreq / df)));
    const label = cursorFreq >= 1000
      ? (cursorFreq / 1000).toFixed(2) + ' kHz'
      : cursorFreq.toFixed(0) + ' Hz';

    const parts = [];
    for (const item of series) {
      const trace = item.trace;
      if (!trace || k >= trace.bins) continue;
      const magnitude = trace.magDb[k];
      const coherence = trace.coh[k];
      const phase = trace.phaseDeg[k];
      parts.push(item.letter + ' ' +
        (Number.isFinite(magnitude) ? magnitude.toFixed(1) : '—') + ' dB · ' +
        (Number.isFinite(phase) ? phase.toFixed(0) : '—') + '° · ' +
        (Number.isFinite(coherence) ? (coherence * 100).toFixed(0) : '—') + '%');
    }
    readout.textContent = label + ' · ' + parts.join('  |  ');
  }

  function updateUI(force) {
    const now = Date.now();
    if (!force && now - lastUi < 250) return;
    lastUi = now;

    for (let i = 0; i < MATCH_LETTERS.length; i++) {
      const letter = MATCH_LETTERS[i];
      const card = cards[letter];
      if (!card) continue;
      const result = results[i];
      card.deviceChannel = channelFor(letter) + 1;
      if (card.channel) card.channel.textContent = 'ch ' + card.deviceChannel;
      card.root.classList.toggle('multi-mic-missing', !mics[i].available && state.running);

      if (result) {
        if (card.level) {
          const level = levels[i] > 0 ? 20 * Math.log10(levels[i]) : -Infinity;
          card.level.textContent = Number.isFinite(level) ? level.toFixed(1) + ' dBFS' : '—';
        }
        if (card.delay) {
          const relative = result.delayMs - (results[0] ? results[0].delayMs : result.delayMs);
          card.delay.textContent = result.delayMs.toFixed(2) + ' ms' +
            (i === 0 ? '' : '  (' + (relative >= 0 ? '+' : '') + relative.toFixed(2) + ')');
        }
        if (card.coherence) {
          const coherence = meanCoherenceFor(result);
          card.coherence.textContent = (coherence * 100).toFixed(0) + '%';
        }
        const share = weights[i] || 0;
        const profile = state.profiles.find((item) => item.mic === letter);
        const calibration = state.calibrations[letter];
        const notes = [];
        if (calibration) notes.push('cal ' + calibration.name);
        if (profile) {
          notes.push('match ' + Math.round(profile.coverage * 100) + '% · ±' +
            (profile.residual || 0).toFixed(1) + ' dB residual');
        }
        if (state.mode === 'coherence' && state.enabled[i]) {
          notes.push('share ' + (share * 100).toFixed(0) + '%');
        }
        if (state.bypassCorrections && (calibration || profile)) notes.push('corrections bypassed');
        if (card.note) card.note.textContent = notes.join(' · ');
        if (result.silent) {
          if (card.warn) {
            card.warn.hidden = false;
            card.warn.textContent = 'no signal on this input — the curve is averaging down to nothing';
          }
        } else if (card.warn) {
          const clipped = engine && engine.channelClippedUntil
            && engine.channelClippedUntil[channelFor(letter)] > Date.now();
          const missing = state.running && !mics[i].available;
          card.warn.hidden = !(clipped || missing);
          card.warn.textContent = clipped
            ? 'clipping on this input — lower the interface gain'
            : missing ? 'input ' + card.deviceChannel + ' is not being delivered by this device' : '';
        }
      } else {
        if (card.level) card.level.textContent = '—';
        if (card.delay) card.delay.textContent = '—';
        if (card.coherence) card.coherence.textContent = '—';
        if (card.note) card.note.textContent = state.running ? '' : 'not measuring';
      }
    }

    const status = element('multiStatus');
    if (status) {
      const lines = [];
      if (!state.running) {
        lines.push('Four inputs on one interface: channels 1–3 are the microphones, channel 4 the electrical reference.');
      } else {
        const count = engine ? engine.channels : 0;
        lines.push((engine.deviceLabel || 'audio input') + ' · ' + engine.inputCount +
          ' of 4 inputs · ' + (engine.sampleRate / 1000).toFixed(1) + ' kHz');
        if (engine.droppedCallbacks > 0) {
          lines.push(engine.droppedCallbacks + ' late audio callbacks — the graph may have missed samples');
        }
      }
      lines.push('average: ' + (SPATIAL_MODES.find((mode) => mode.id === state.mode) || SPATIAL_MODES[0]).label +
        ' · ' + state.enabled.filter(Boolean).length + ' microphones · ' +
        (Math.round(1000 / state.updateMs * 10) / 10).toFixed(1) + ' updates/s');
      if (state.frozen) lines.push('display held');
      if (state.viewing !== 'live') {
        const snapshot = activeSnapshot();
        lines.push('showing snapshot ' + (snapshot ? snapshot.name : ''));
      }
      status.textContent = lines.join(' · ');
    }

    renderSnapshots();
    renderMatchList();
    renderCalibrationNote();
  }

  function meanCoherenceFor(result) {
    if (!result) return 0;
    const k0 = Math.max(1, Math.round(200 / result.df));
    const k1 = Math.min(result.bins - 1, Math.round(10000 / result.df));
    let sum = 0;
    let count = 0;
    for (let k = k0; k <= k1; k++) {
      sum += Number.isFinite(result.coh[k]) ? result.coh[k] : 0;
      count += 1;
    }
    return count ? sum / count : 0;
  }

  /* ---------- snapshots ---------- */

  function takeSnapshot() {
    if (!results.find((item) => item)) {
      setStatus('there is no measurement to snapshot yet', 'err');
      return;
    }
    const series = displayedSeries().map((item) => ({
      letter: item.letter,
      color: item.color,
      visible: item.visible,
      phaseVisible: item.phaseVisible,
      phaseOffsetMs: item.phaseOffsetMs,
      trace: {
        bins: item.trace.bins,
        df: item.trace.df,
        coh: Float32Array.from(item.trace.coh),
        phaseDeg: Float32Array.from(item.trace.phaseDeg),
        delayMs: item.trace.delayMs,
        magDb: Float32Array.from(item.trace.magDb),
      },
    }));
    const snapshot = {
      id: 's' + Date.now().toString(36),
      name: 'Snapshot ' + (state.snapshots.length + 1),
      time: new Date(),
      series,
      average: average
        ? {
            bins: average.bins,
            df: average.df,
            coh: new Float32Array(average.bins),
            phaseDeg: new Float32Array(average.bins),
            delayMs: 0,
            magDb: Float32Array.from(average.magDb),
          }
        : null,
    };
    state.snapshots = [snapshot, ...state.snapshots].slice(0, 4);
    setStatus('stored ' + snapshot.name + ' — compare it from the snapshot list', 'ok');
    renderSnapshots();
  }

  function renderSnapshots() {
    const holder = element('multiSnapshots');
    if (!holder) return;
    holder.textContent = '';
    const live = document.createElement('button');
    live.type = 'button';
    live.className = 'chip' + (state.viewing === 'live' ? ' on' : '');
    live.textContent = 'Live';
    live.addEventListener('click', () => {
      state.viewing = 'live';
      renderSnapshots();
      updateUI(true);
      drawNow();
    });
    holder.appendChild(live);

    for (const snapshot of state.snapshots) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip' + (state.viewing === snapshot.id ? ' on' : '');
      button.textContent = snapshot.name;
      button.addEventListener('click', () => {
        state.viewing = snapshot.id;
        renderSnapshots();
        updateUI(true);
        drawNow();
      });
      holder.appendChild(button);
    }
  }

  /* ---------- microphone matching ---------- */

  function runMatch(letter) {
    const index = MATCH_LETTERS.indexOf(letter);
    if (index < 0) return;
    if (!results[0] || !results[index]) {
      setStatus('both microphones need a live measurement before they can be matched', 'err');
      return;
    }

    const options = {
      smoothing: Number(element('selMatchSmooth')?.value) || MATCH_DEFAULTS.smoothing,
      coherence: Number(element('selMatchCoh')?.value) || MATCH_DEFAULTS.coherence,
      maxDb: Math.max(1, Number(element('numMatchLimit')?.value) || MATCH_DEFAULTS.maxDb),
      fMin: MATCH_DEFAULTS.fMin,
      fMax: MATCH_DEFAULTS.fMax,
    };

    const match = relativeMatch(results[0], results[index], options);
    const note = element('multiMatchNote');
    if (!match.accepted) {
      if (note) {
        note.textContent = 'Match ' + letter + ' refused: ' + match.reason + '.';
        note.classList.add('bad');
      }
      setStatus('relative matching refused — ' + match.reason, 'err');
      return;
    }

    const bins = analyser.bins;
    const df = analyser.df;
    const points = decimateCurve(match.correction, bins, df, 360);
    const profile = newMatchProfile(letter, points, match);
    state.profiles = [profile, ...state.profiles.filter((item) => item.mic !== letter)];
    const stored = persistMatchProfiles(state.profiles);

    if (note) {
      note.classList.remove('bad');
      note.textContent = 'Matched ' + letter + ' to A over ' +
        formatHz(match.firstHz) + ' – ' + formatHz(match.lastHz) +
        ' · ' + Math.round(match.coverage * 100) + '% of that band usable · ' +
        'residual ±' + match.residual.toFixed(2) + ' dB' +
        (stored ? '' : ' · could not be stored in this browser');
    }
    setStatus('mic ' + letter + ' matched to A · correction stored', 'ok');
    updateUI(true);
    drawNow();
  }

  function renderMatchList() {
    const holder = element('multiMatchList');
    if (!holder) return;
    holder.textContent = '';
    for (const letter of ['B', 'C']) {
      const profile = state.profiles.find((item) => item.mic === letter);
      const row = document.createElement('div');
      row.className = 'multi-match-row';
      if (!profile) {
        row.innerHTML = '<span>Mic ' + letter + '</span><span class="multi-match-empty">not matched</span>';
      } else {
        const label = document.createElement('span');
        label.textContent = 'Mic ' + letter + ' → A · ' +
          Math.round(profile.coverage * 100) + '% · ±' + (profile.residual || 0).toFixed(1) + ' dB';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'link-btn';
        remove.textContent = 'remove';
        remove.addEventListener('click', () => {
          state.profiles = state.profiles.filter((item) => item.mic !== letter);
          persistMatchProfiles(state.profiles);
          setStatus('mic ' + letter + ' match removed');
          updateUI(true);
          drawNow();
        });
        row.appendChild(label);
        row.appendChild(remove);
      }
      holder.appendChild(row);
    }
  }

  /* ---------- manufacturer calibration ---------- */

  function handleCalibrationFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const letter = state.selectedCalibrationLetter;
    file.text().then((text) => {
      const parsed = parseCalibration(text, file.name.replace(/\.[^.]+$/, ''));
      if (!parsed || !Array.isArray(parsed.points) || parsed.points.length < 2) {
        setCalNote('That file did not read as a frequency/dB calibration — nothing was loaded.', true);
        setStatus('calibration refused for mic ' + letter, 'err');
        return;
      }
      state.calibrations = Object.assign({}, state.calibrations, { [letter]: parsed });
      const stored = persistMicCalibrations(state.calibrations);
      setCalNote('Mic ' + letter + ': ' + parsed.points.length + ' points loaded' +
        (stored ? '' : ' (this browser could not store it)'));
      setStatus('calibration loaded for mic ' + letter, 'ok');
      updateUI(true);
      drawNow();
    }).catch(() => {
      setCalNote('That file could not be read.', true);
    });
  }

  function setCalNote(text, error) {
    const note = element('multiCalNote');
    if (!note) return;
    note.textContent = text;
    note.classList.toggle('bad', !!error);
  }

  function renderCalibrationNote() {
    const entries = MATCH_LETTERS
      .filter((letter) => state.calibrations[letter])
      .map((letter) => letter + ': ' + state.calibrations[letter].name);
    if (entries.length && element('multiCalNote') && !element('multiCalNote').textContent) {
      setCalNote(entries.join(' · '));
    }
  }

  /* ---------- export ---------- */

  function exportCsv() {
    const series = displayedSeries();
    if (!series.length) {
      setStatus('nothing to export yet — start the measurement first', 'err');
      return;
    }
    const bins = series[0].trace.bins;
    const df = series[0].trace.df;
    const header = [
      'frequency_hz',
      'mic_a_db', 'mic_a_phase_deg', 'mic_a_coherence',
      'mic_b_db', 'mic_b_phase_deg', 'mic_b_coherence',
      'mic_c_db', 'mic_c_phase_deg', 'mic_c_coherence',
      'average_db',
    ];
    const lines = [];
    lines.push('# Align multi-microphone measurement');
    lines.push('# ' + (engine ? engine.deviceLabel : 'audio input') + ' · ' +
      (engine ? engine.sampleRate : 0) + ' Hz · 3 microphones against channel ' +
      (Number(state.routing.ref) + 1));
    lines.push('# average: ' + state.mode + ' · smoothing ' + state.smoothing +
      ' · correction ' + (state.bypassCorrections ? 'bypassed' : 'applied'));
    lines.push(header.join(','));

    for (let k = 1; k < bins; k++) {
      const row = [(k * df).toFixed(2)];
      for (const letter of MATCH_LETTERS) {
        const item = series.find((entry) => entry.letter === letter);
        const trace = item ? item.trace : null;
        if (trace && k < trace.bins) {
          row.push(trace.magDb[k].toFixed(2));
          row.push(trace.phaseDeg[k].toFixed(1));
          row.push(trace.coh[k].toFixed(3));
        } else {
          row.push('', '', '');
        }
      }
      row.push(average && k < average.bins ? average.magDb[k].toFixed(2) : '');
      lines.push(row.join(','));
    }

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
    shareOrDownload(blob, 'Align multi-mic ' + stamp + '.csv', 'Align multi-mic measurement')
      .then((result) => {
        if (result === 'downloaded') setStatus('CSV downloaded', 'ok');
      })
      .catch(() => setStatus('the browser would not share or download the file', 'err'));
  }

  /* ---------- lifecycle ---------- */

  function open() {
    state.active = true;
    const section = element('multiWorkspace');
    if (section) section.hidden = false;
    buildChart();
    buildCards();
    bindControls();
    updateRoutingSelects();
    state.profiles = loadMatchProfiles();
    state.calibrations = loadMicCalibrations();
    renderSnapshots();
    renderMatchList();
    setCalNote('No manufacturer calibration is loaded for any microphone.');
    if (element('selMultiMode')) element('selMultiMode').value = state.mode;
    if (element('selMatchSmooth')) element('selMatchSmooth').value = String(MATCH_DEFAULTS.smoothing);
    requestAnimationFrame(() => {
      if (chart) chart.resize();
      updateUI(true);
      diagnostics.render();
      drawNow();
    });
    setStatus('multi-microphone workspace ready — start listening', 'ok');
    if (typeof opts.onOpen === 'function') opts.onOpen();
  }

  function close() {
    if (state.running) stopListening();
    state.active = false;
    const section = element('multiWorkspace');
    if (section) section.hidden = true;
    setStatus('idle');
    if (typeof opts.onClose === 'function') opts.onClose();
  }

  function tick(now) {
    if (!state.active) return;
    if (state.running && !state.frozen && analyser) {
      if (now - lastAnalysis >= state.updateMs) {
        lastAnalysis = now;
        analyseFrame();
        recomputeAverage();
      }
    }
    updateUI(false);
    diagnostics.render();
    drawNow();
  }

  function formatHz(frequency) {
    if (!Number.isFinite(frequency)) return '—';
    return frequency >= 1000
      ? (frequency / 1000).toFixed(2) + ' kHz'
      : frequency.toFixed(0) + ' Hz';
  }

  return {
    open,
    close,
    tick,
    get active() {
      return state.active;
    },
    get running() {
      return state.running;
    },
    state,
  };
}
