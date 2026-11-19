/*
 * Multichannel — up to four live transfer functions from the inputs the
 * interface actually offers, side by side on one logarithmic axis.
 *
 * Each channel has its own input, its own window, smoothing and averaging, its
 * own delay and coherence, and its own held capture. One button starts and stops
 * them together, one channel can fill the window, and the screen says plainly
 * which inputs the browser delivered. It reads the capture and never touches the
 * single measurement's settings, gate or captures.
 */

import { Analyser } from './analyser.js';

const NAMES = ['Channel 1', 'Channel 2', 'Channel 3', 'Channel 4'];
const COLORS = ['#a6f14d', '#3ddcff', '#ffb054', '#ffe066'];
const FFT_CHOICES = [4096, 8192, 16384, 32768];
const SMOOTHING = [[0, 'None'], [0.125, '1/8 oct'], [1 / 6, '1/6 oct'], [1 / 3, '1/3 oct']];
const AVERAGING = [[0.05, 'Slow'], [0.12, 'Medium'], [0.3, 'Quick']];
const UPDATE_MS = 300;

const F_MIN = 20;
const F_MAX = 20000;
const DB_TOP = 20;
const DB_BOTTOM = -60;
const TICKS = [20, 100, 1000, 10000, 20000];

const ICON_PIN = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M9.5 1.5 14.5 6.5 12 7.5 9.5 10 8.5 14 2 7.5 6 6.5 8.5 4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
const ICON_PIN_OFF = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M9.5 1.5 14.5 6.5 12 7.5 9.5 10 8.5 14 2 7.5 6 6.5 8.5 4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M2 14 14 2" stroke="currentColor" stroke-width="1.4"/></svg>';
const ICON_EXPAND = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M9 2h5v5M7 14H2V9M14 2 9.5 6.5M2 14l4.5-4.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const ICON_COLLAPSE = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M14 9H9v5M2 7h5V2M14 9 9.5 4.5M2 7l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const ICON_SLIDERS = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.2"/><circle cx="6" cy="4" r="1.7" fill="currentColor"/><circle cx="10" cy="8" r="1.7" fill="currentColor"/><circle cx="5" cy="12" r="1.7" fill="currentColor"/></svg>';

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function frequencyLabel(hz) {
  if (hz >= 1000) {
    const k = hz / 1000;
    return (k === Math.round(k) ? String(k) : k.toFixed(1)) + 'k';
  }
  return String(Math.round(hz));
}

function dbLabel(db) {
  return String(Math.round(db)).replace('-', '−');
}

function meanCoherence(result) {
  if (!result || !result.coh || !result.df || !result.bins) return 0;
  const k0 = Math.max(1, Math.round(200 / result.df));
  const k1 = Math.min(result.bins - 1, Math.round(10000 / result.df));
  if (k1 < k0) return 0;
  let sum = 0;
  let count = 0;
  for (let k = k0; k <= k1; k += 1) {
    sum += result.coh[k];
    count += 1;
  }
  return count ? sum / count : 0;
}

export function createChannels(options) {
  const opts = options || {};
  const engine = opts.engine || null;
  const setStatus = typeof opts.setStatus === 'function' ? opts.setStatus : () => {};
  const sourceOptions = typeof opts.sourceOptions === 'function' ? opts.sourceOptions : () => ({});
  const generator = typeof opts.generator === 'function'
    ? opts.generator
    : () => ({ signal: 'pink', level: 0.2, sineHz: 1000 });
  const onOpenHook = typeof opts.onOpen === 'function' ? opts.onOpen : null;
  const onCloseHook = typeof opts.onClose === 'function' ? opts.onClose : null;

  const state = {
    active: false,
    running: false,
    startedEngine: false,
    expanded: null,
    editing: null,
    delivered: 0,
    channels: [0, 1, 2, 3].map(() => ({
      input: null,
      fftSize: 16384,
      smoothing: 1 / 6,
      averaging: 0.12,
      result: null,
      held: null,
      coherence: null,
      delayMs: null,
    })),
  };

  let analysers = [null, null, null, null];
  let windows = [null, null, null, null];
  let refWindow = null;
  let cards = [];
  let raf = 0;
  let lastAnalysis = 0;
  let bound = false;

  /* ---------- DOM ---------- */

  const $ = (id) => document.getElementById(id);

  function buildCards() {
    const grid = $('mcGrid');
    if (!grid) return;
    grid.textContent = '';
    cards = [];

    state.channels.forEach((channel, index) => {
      const card = document.createElement('div');
      card.className = 'mc-card';
      card.dataset.index = String(index);

      const head = document.createElement('div');
      head.className = 'mc-card-head';
      head.innerHTML =
        '<span class="mc-dot" style="background:' + COLORS[index] + '"></span>' +
        '<span class="mc-name">' + NAMES[index] + '</span>' +
        '<button class="mc-icon" type="button" data-act="settings" title="Channel analysis" aria-label="Channel ' + (index + 1) + ' analysis">' + ICON_SLIDERS + '</button>' +
        '<button class="mc-icon" type="button" data-act="hold" title="Hold this curve" aria-label="Hold channel ' + (index + 1) + '">' + ICON_PIN + '</button>' +
        '<button class="mc-icon" type="button" data-act="expand" title="Fill the window with this channel" aria-label="Expand channel ' + (index + 1) + '">' + ICON_EXPAND + '</button>';

      const row = document.createElement('div');
      row.className = 'mc-row';

      const select = document.createElement('select');
      select.className = 'mc-input';
      select.setAttribute('aria-label', 'Input for channel ' + (index + 1));
      select.addEventListener('change', () => {
        const value = select.value;
        setInput(index, value === '' ? null : Number(value));
      });

      const delay = document.createElement('div');
      delay.className = 'mc-fig';
      delay.innerHTML = '<span>Delay</span><strong data-role="delay">—</strong>';

      const coherence = document.createElement('div');
      coherence.className = 'mc-fig';
      coherence.innerHTML = '<span>Coherence</span><strong data-role="coherence">—</strong>';

      const held = document.createElement('span');
      held.className = 'mc-held';
      held.textContent = 'HELD';
      held.hidden = true;

      row.appendChild(select);
      row.appendChild(delay);
      row.appendChild(coherence);
      row.appendChild(held);

      const wrap = document.createElement('div');
      wrap.className = 'mc-chart-wrap';
      const canvas = document.createElement('canvas');
      canvas.className = 'mc-chart';
      const empty = document.createElement('p');
      empty.className = 'mc-empty';
      empty.hidden = true;
      wrap.appendChild(canvas);
      wrap.appendChild(empty);

      card.appendChild(head);
      card.appendChild(row);
      card.appendChild(wrap);
      grid.appendChild(card);

      head.addEventListener('click', (event) => {
        const button = event.target.closest('[data-act]');
        if (!button) return;
        const act = button.dataset.act;
        if (act === 'hold') toggleHold(index);
        if (act === 'expand') toggleExpand(index);
        if (act === 'settings') showSettings(index);
      });

      cards[index] = { card, select, delay, coherence, held, canvas, empty };
    });

    renderInputs();
    renderExpansion();
  }

  function renderInputs() {
    const count = state.delivered;
    state.channels.forEach((channel, index) => {
      const entry = cards[index];
      if (!entry) return;
      const select = entry.select;
      select.textContent = '';
      const none = document.createElement('option');
      none.value = '';
      none.textContent = 'IN —';
      select.appendChild(none);
      for (let input = 0; input < count; input += 1) {
        const option = document.createElement('option');
        option.value = String(input);
        option.textContent = 'IN ' + (input + 1);
        select.appendChild(option);
      }
      select.value = channel.input === null ? '' : String(channel.input);
      select.disabled = count === 0;

      const empty = entry.empty;
      if (channel.input === null) {
        empty.hidden = false;
        empty.textContent = count === 0
          ? 'No input yet — Start all opens the inputs this interface offers.'
          : 'No input assigned — this device offers ' + count + ' input' + (count === 1 ? '' : 's') + '.';
      } else {
        empty.hidden = true;
      }
    });
  }

  function renderExpansion() {
    state.channels.forEach((channel, index) => {
      const entry = cards[index];
      if (!entry) return;
      const expanded = state.expanded === index;
      entry.card.classList.toggle('mc-expanded', expanded);
      entry.card.hidden = state.expanded !== null && !expanded;
      const button = entry.card.querySelector('[data-act="expand"]');
      if (button) button.innerHTML = expanded ? ICON_COLLAPSE : ICON_EXPAND;
    });
  }

  function updateFigures() {
    state.channels.forEach((channel, index) => {
      const entry = cards[index];
      if (!entry) return;
      const delay = channel.delayMs !== null && Number.isFinite(channel.delayMs)
        ? channel.delayMs.toFixed(2) + ' ms'
        : '—';
      const coherence = channel.coherence !== null && Number.isFinite(channel.coherence)
        ? Math.round(channel.coherence * 100) + '%'
        : '—';
      const delayNode = entry.delay.querySelector('[data-role="delay"]');
      const coherenceNode = entry.coherence.querySelector('[data-role="coherence"]');
      if (delayNode.textContent !== delay) delayNode.textContent = delay;
      if (coherenceNode.textContent !== coherence) coherenceNode.textContent = coherence;
      entry.held.hidden = !channel.held;
      entry.select.value = channel.input === null ? '' : String(channel.input);
    });
  }

  function updateNote() {
    const note = $('mcNote');
    if (!note) return;
    if (!state.delivered) {
      note.textContent = 'Start all opens the inputs this interface offers. Nothing here changes the measurement, its gate or its captures.';
      return;
    }
    const captured = state.delivered;
    let text = 'Input' + (captured === 1 ? '' : 's') + ' 1' +
      (captured > 1 ? '–' + captured : '') + ' ' + (captured === 1 ? 'is' : 'are') +
      ' being captured; the reference is the generated signal.';
    if (captured < 4) {
      text += ' Channel ' + (captured + 1) + ' has no input — this device offers ' + captured + '.';
    }
    note.textContent = text;
  }

  function updateStartButton() {
    const button = $('btnMcStart');
    if (!button) return;
    button.textContent = state.running ? 'Stop all' : 'Start all';
    button.classList.toggle('on', state.running);
  }

  /* ---------- control ---------- */

  function open() {
    if (state.active) return;
    const section = $('channelsWorkspace');
    if (!section) return;
    if (onOpenHook) onOpenHook();
    section.hidden = false;
    state.active = true;
    if (!bound) {
      bind();
      bound = true;
    }
    buildCards();
    updateNote();
    updateStartButton();
    setStatus('multichannel screen open — Start all reads the inputs the interface offers');
    window.addEventListener('resize', resizeAll);
    requestAnimationFrame(() => { resizeAll(); drawAll(); });
  }

  function close() {
    if (!state.active) return;
    stopAll();
    const section = $('channelsWorkspace');
    if (section) section.hidden = true;
    state.active = false;
    window.removeEventListener('resize', resizeAll);
    if (onCloseHook) onCloseHook();
  }

  async function startAll() {
    if (!engine) return;
    if (state.running) {
      stopAll();
      return;
    }

    try {
      let delivered;
      if (!engine.running) {
        // The single measurement is not capturing, so this screen opens the
        // inputs itself — and stops them again when it is done.
        delivered = await engine.start(Object.assign({}, sourceOptions(), { channels: 4 }));
        state.startedEngine = true;
      } else {
        // It is capturing; this screen reads the inputs that are already open
        // rather than restarting the stream underneath the measurement.
        delivered = engine.channels;
        state.startedEngine = false;
      }

      state.delivered = Math.max(0, Number(delivered) || 0);
      const generated = generator();
      engine.setSignal(generated.signal || 'pink');
      engine.setLevel(Number(generated.level) || 0.2);
      engine.setSineHz(Number(generated.sineHz) || 1000);

      state.running = true;
      analysers = [null, null, null, null];
      windows = [null, null, null, null];
      refWindow = null;
      lastAnalysis = 0;

      state.channels.forEach((channel, index) => {
        channel.input = index < state.delivered ? index : null;
        channel.result = null;
        channel.held = null;
        channel.coherence = null;
        channel.delayMs = null;
      });

      renderInputs();
      updateNote();
      updateStartButton();

      setStatus(state.delivered + ' input' + (state.delivered === 1 ? '' : 's') +
        ' open — the reference is the generated signal', 'ok');

      if (!raf) raf = requestAnimationFrame(tick);
    } catch (err) {
      state.running = false;
      state.startedEngine = false;
      updateStartButton();
      setStatus('the inputs could not be opened: ' + (err && err.message ? err.message : err), 'err');
    }
  }

  function stopAll() {
    state.running = false;
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (state.startedEngine && engine) engine.stop();
    state.startedEngine = false;
    updateStartButton();
    updateNote();
    setStatus('the channels are stopped');
  }

  function setInput(index, input) {
    const channel = state.channels[index];
    if (!channel) return;
    channel.input = input !== null && input >= 0 && input < state.delivered ? input : null;
    channel.result = null;
    channel.held = null;
    channel.coherence = null;
    channel.delayMs = null;
    analysers[index] = null;
    windows[index] = null;
    renderInputs();
    updateFigures();
    drawAll();
  }

  function setFFT(index, size) {
    const channel = state.channels[index];
    if (!channel) return;
    channel.fftSize = clamp(Number(size) || channel.fftSize, 2048, 32768);
    channel.result = null;
    analysers[index] = null;
    windows[index] = null;
    drawAll();
  }

  function setSmoothing(index, value) {
    const channel = state.channels[index];
    if (!channel) return;
    channel.smoothing = Number(value) || 0;
    channel.result = null;
    analysers[index] = null;
    drawAll();
  }

  function setAveraging(index, value) {
    const channel = state.channels[index];
    if (!channel) return;
    channel.averaging = clamp(Number(value) || 0.12, 0.01, 1);
    if (analysers[index]) analysers[index].setUpdateRate(channel.averaging);
  }

  function toggleHold(index) {
    const channel = state.channels[index];
    if (!channel) return;
    if (channel.held) {
      channel.held = null;
    } else if (channel.result) {
      channel.held = { magDb: Float32Array.from(channel.result.magDb), df: channel.result.df };
    } else {
      setStatus('channel ' + (index + 1) + ' has no curve to hold yet', 'err');
      return;
    }
    updateFigures();
    drawAll();
  }

  function toggleExpand(index) {
    state.expanded = state.expanded === index ? null : index;
    renderExpansion();
    requestAnimationFrame(() => { resizeAll(); drawAll(); });
  }

  function showSettings(index) {
    state.editing = index;
    const panel = $('mcSettings');
    const title = $('mcSettingsTitle');
    const fft = $('mcFFT');
    const smoothing = $('mcSmoothing');
    const averaging = $('mcAveraging');
    if (!panel || !title || !fft || !smoothing || !averaging) return;

    const nearest = (list, value) => list.reduce(
      (best, item) => (Math.abs(item - value) < Math.abs(best - value) ? item : best),
      list[0],
    );

    const channel = state.channels[index];
    title.textContent = NAMES[index] + ' analysis';
    fft.value = String(nearest(FFT_CHOICES, channel.fftSize));
    smoothing.value = String(nearest([0, 0.125, 1 / 6, 1 / 3], channel.smoothing));
    averaging.value = String(nearest([0.05, 0.12, 0.3], channel.averaging));
    panel.hidden = false;
  }

  function hideSettings() {
    const panel = $('mcSettings');
    if (panel) panel.hidden = true;
    state.editing = null;
  }

  function bindSettings() {
    const close = $('btnMcSettingsDone');
    if (close) close.addEventListener('click', hideSettings);
    const fft = $('mcFFT');
    if (fft) fft.addEventListener('change', () => { if (state.editing !== null) setFFT(state.editing, fft.value); });
    const smoothing = $('mcSmoothing');
    if (smoothing) smoothing.addEventListener('change', () => { if (state.editing !== null) setSmoothing(state.editing, smoothing.value); });
    const averaging = $('mcAveraging');
    if (averaging) averaging.addEventListener('change', () => { if (state.editing !== null) setAveraging(state.editing, averaging.value); });
  }

  /* ---------- analysis ---------- */

  function tick(now) {
    if (!state.active) { raf = 0; return; }
    raf = requestAnimationFrame(tick);
    if (!state.running || !engine || !engine.running) return;
    if (now - lastAnalysis < UPDATE_MS) return;
    lastAnalysis = now;
    analyseFrame();
    updateFigures();
    drawAll();
  }

  function analyseFrame() {
    if (!engine || !engine.running) return;

    if (engine.interrupted || engine.trackIssue) {
      stopAll();
      setStatus(engine.interrupted
        ? 'the audio was suspended (' + engine.interrupted + ') — the channels stopped'
        : (engine.trackIssue || 'the input stopped') + ' — the channels stopped', 'err');
      return;
    }

    const written = engine.micWritten;
    const end = written - 512;

    state.channels.forEach((channel, index) => {
      if (channel.input === null || channel.input >= state.delivered) return;
      const n = channel.fftSize;
      const start = end - n;
      if (start < 0) return;

      if (!refWindow || refWindow.length !== n) refWindow = new Float32Array(n);
      engine.readGeneratedRef(refWindow, start);

      let window = windows[index];
      if (!window || window.length !== n) window = new Float32Array(n);
      engine.readChannel(window, start, channel.input);
      windows[index] = window;

      let analyser = analysers[index];
      if (!analyser || analyser.fftSize !== n || analyser.sampleRate !== engine.sampleRate) {
        analyser = new Analyser(n, engine.sampleRate);
        analyser.setUpdateRate(channel.averaging);
        analyser.searchRadius = 0;
        analysers[index] = analyser;
        channel.result = null;
      }

      analyser.accumulate(window, refWindow);
      const result = analyser.results({
        compensate: true,
        smoothing: channel.smoothing,
        normalize: true,
      });

      if (result && result.frames >= 2) {
        channel.result = result;
        channel.coherence = meanCoherence(result);
        channel.delayMs = result.delayMs;
      }
    });
  }

  /* ---------- drawing ---------- */

  function resizeAll() {
    state.channels.forEach((channel, index) => {
      const entry = cards[index];
      if (!entry) return;
      const rect = entry.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (entry.canvas.width !== width || entry.canvas.height !== height) {
        entry.canvas.width = width;
        entry.canvas.height = height;
      }
    });
    drawAll();
  }

  function drawAll() {
    state.channels.forEach((channel, index) => {
      const entry = cards[index];
      if (!entry || entry.card.hidden) return;
      drawCard(channel, index, entry.canvas);
    });
  }

  function drawCard(channel, index, canvas) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    if (width < 40 || height < 40) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const left = 34;
    const right = 8;
    const top = 10;
    const bottom = 24;
    const pane = {
      x: left,
      y: top,
      w: Math.max(1, width - left - right),
      h: Math.max(1, height - top - bottom),
    };

    const logSpan = Math.log(F_MAX / F_MIN);
    const xFor = (hz) => pane.x + pane.w * clamp(Math.log(clamp(hz, F_MIN, F_MAX) / F_MIN) / logSpan, 0, 1);
    const yFor = (db) => pane.y + pane.h * (DB_TOP - clamp(db, DB_BOTTOM, DB_TOP)) / (DB_TOP - DB_BOTTOM);

    // Grid and axes.
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';

    for (let db = DB_TOP; db >= DB_BOTTOM; db -= 20) {
      const y = yFor(db);
      ctx.strokeStyle = db === 0 ? 'rgba(140, 220, 160, 0.45)' : 'rgba(120, 190, 140, 0.16)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pane.x, y);
      ctx.lineTo(pane.x + pane.w, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(159, 184, 164, 0.9)';
      ctx.textAlign = 'right';
      ctx.fillText(dbLabel(db), pane.x - 6, y);
    }

    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(159, 184, 164, 0.9)';
    ctx.fillText('dB', 2, pane.y - 3);

    for (const hz of TICKS) {
      const x = xFor(hz);
      ctx.strokeStyle = 'rgba(120, 190, 140, 0.14)';
      ctx.beginPath();
      ctx.moveTo(x, pane.y);
      ctx.lineTo(x, pane.y + pane.h);
      ctx.stroke();
      ctx.fillStyle = 'rgba(159, 184, 164, 0.9)';
      ctx.textAlign = 'center';
      ctx.fillText(frequencyLabel(hz), x, pane.y + pane.h + 9);
    }

    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(159, 184, 164, 0.8)';
    ctx.fillText('Frequency (Hz)', pane.x + pane.w / 2, pane.y + pane.h + 19);

    // Curves: the held capture dim behind the live one.
    const plot = (values, df, stroke, widthPx, alpha) => {
      if (!values || !df) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = widthPx;
      ctx.beginPath();
      let started = false;
      const columns = Math.max(2, Math.round(pane.w));
      for (let i = 0; i < columns; i += 1) {
        const hz = F_MIN * Math.exp((i / (columns - 1)) * logSpan);
        const bin = clamp(Math.round(hz / df), 0, values.length - 1);
        const db = values[bin];
        if (!Number.isFinite(db)) { started = false; continue; }
        const x = pane.x + (i / (columns - 1)) * pane.w;
        const y = yFor(db);
        if (started) ctx.lineTo(x, y);
        else { ctx.moveTo(x, y); started = true; }
      }
      ctx.stroke();
      ctx.restore();
    };

    if (channel.held) plot(channel.held.magDb, channel.held.df, COLORS[index], 1.3, 0.4);
    if (channel.result) plot(channel.result.magDb, channel.result.df, COLORS[index], 1.8, 1);
  }

  /* ---------- boot ---------- */

  return {
    open,
    close,
    startAll,
    stopAll,
    get active() { return state.active; },
    get running() { return state.running; },
    /** Called once after the page's DOM exists. */
    bind() {
      const start = $('btnMcStart');
      if (start) start.addEventListener('click', startAll);
      const closeButton = $('btnMcClose');
      if (closeButton) closeButton.addEventListener('click', close);
      bindSettings();
    },
  };
}
