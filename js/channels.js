/*
 * Multichannel — up to four live transfer functions from the inputs the
 * interface actually offers, side by side on one logarithmic axis.
 *
 * Each channel has its own input, its own window, smoothing and averaging, its
 * own delay, coherence, held capture and impulse pane. One button starts and
 * stops them together, one channel can fill the window, and the screen says
 * plainly which inputs the browser delivered.
 *
 * Three tabs keep it uncluttered: the channels themselves, a band-by-band
 * comparison of two of them, and the report. It reads the capture and never
 * touches the single measurement's settings, gate or captures.
 */

import { Analyser } from './analyser.js';
import { reportPdfBlob, shareOrDownload } from './sharing.js';

const NAMES = ['Channel 1', 'Channel 2', 'Channel 3', 'Channel 4'];
const COLORS = ['#a6f14d', '#3ddcff', '#ffb054', '#ffe066'];
const FFT_CHOICES = [4096, 8192, 16384, 32768];
const UPDATE_MS = 300;

const F_MIN = 20;
const F_MAX = 20000;
const DB_TOP = 20;
const DB_BOTTOM = -60;
const TICKS = [20, 100, 1000, 10000, 20000];
const COHERENCE_GATE = 0.35;

const SMOOTHING_LABELS = [[0, 'None'], [0.125, '1/8 oct'], [1 / 6, '1/6 oct'], [1 / 3, '1/3 oct']];

const ICON_PIN = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M9.5 1.5 14.5 6.5 12 7.5 9.5 10 8.5 14 2 7.5 6 6.5 8.5 4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
const ICON_EXPAND = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M9 2h5v5M7 14H2V9M14 2 9.5 6.5M2 14l4.5-4.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const ICON_COLLAPSE = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M14 9H9v5M2 7h5V2M14 9 9.5 4.5M2 7l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const ICON_SLIDERS = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.2"/><circle cx="6" cy="4" r="1.7" fill="currentColor"/><circle cx="10" cy="8" r="1.7" fill="currentColor"/><circle cx="5" cy="12" r="1.7" fill="currentColor"/></svg>';
const ICON_IMPULSE = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1 12h5l1-8 1 10 1-5 1 3h6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';

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

function smoothingText(value) {
  let best = SMOOTHING_LABELS[0];
  for (const entry of SMOOTHING_LABELS) {
    if (Math.abs(entry[0] - value) < Math.abs(best[0] - value)) best = entry;
  }
  return best[1];
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

/** One third-octave band's power level and mean coherence. */
function bandLevel(result, centre) {
  if (!result || !result.magDb || !result.df || !result.bins) return null;
  const ratio = Math.pow(2, 1 / 6);
  const k0 = Math.max(1, Math.round(centre / ratio / result.df));
  const k1 = Math.min(result.bins - 1, Math.round(centre * ratio / result.df));
  if (k1 < k0) return null;
  let power = 0;
  let coherence = 0;
  let count = 0;
  for (let k = k0; k <= k1; k += 1) {
    const db = result.magDb[k];
    if (!Number.isFinite(db)) continue;
    power += Math.pow(10, db / 10);
    coherence += result.coh[k];
    count += 1;
  }
  if (!count || !(power > 0)) return null;
  return { db: 10 * Math.log10(power / count), coherence: coherence / count };
}

function thirdOctaves() {
  const centres = [];
  let centre = 25;
  while (centre <= 16000) {
    centres.push(Math.round(centre * 100) / 100);
    centre *= Math.pow(2, 1 / 3);
  }
  return centres;
}

const CENTRES = thirdOctaves();

export function createChannels(options) {
  const opts = options || {};
  const engine = opts.engine || null;
  const setStatus = typeof opts.setStatus === 'function' ? opts.setStatus : () => {};
  const sourceOptions = typeof opts.sourceOptions === 'function' ? opts.sourceOptions : () => ({});
  const generator = typeof opts.generator === 'function'
    ? opts.generator
    : () => ({ signal: 'pink', level: 0.2, sineHz: 1000 });
  const saveChannels = typeof opts.saveChannels === 'function' ? opts.saveChannels : null;
  const onOpenHook = typeof opts.onOpen === 'function' ? opts.onOpen : null;
  const onCloseHook = typeof opts.onClose === 'function' ? opts.onClose : null;

  const state = {
    active: false,
    running: false,
    startedEngine: false,
    expanded: null,
    editing: null,
    tab: 'channels',
    compareA: null,
    compareB: null,
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
      impulse: false,
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
        '<button class="mc-icon" type="button" data-act="impulse" title="Impulse response" aria-label="Channel ' + (index + 1) + ' impulse response">' + ICON_IMPULSE + '</button>' +
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
      const impulse = document.createElement('canvas');
      impulse.className = 'mc-chart mc-chart-impulse';
      impulse.hidden = true;
      const empty = document.createElement('p');
      empty.className = 'mc-empty';
      empty.hidden = true;
      wrap.appendChild(canvas);
      wrap.appendChild(impulse);
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
        if (act === 'impulse') toggleImpulse(index);
      });

      cards[index] = { card, select, delay, coherence, held, canvas, impulse, empty };
    });

    renderInputs();
    renderExpansion();
    renderImpulse();
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
    applyVisibility();
  }

  /** A channel whose input the interface did not deliver is not shown at all. */
  function isUnused(index) {
    return state.delivered > 0 && index >= state.delivered;
  }

  function applyVisibility() {
    state.channels.forEach((channel, index) => {
      const entry = cards[index];
      if (!entry) return;
      entry.card.hidden = isUnused(index) ||
        (state.expanded !== null && state.expanded !== index);
    });
    const grid = $('mcGrid');
    if (grid) {
      const shown = state.delivered > 0 ? Math.min(state.delivered, 4) : 4;
      grid.classList.toggle('mc-single', shown === 1);
    }
  }

  function renderExpansion() {
    state.channels.forEach((channel, index) => {
      const entry = cards[index];
      if (!entry) return;
      const expanded = state.expanded === index;
      entry.card.classList.toggle('mc-expanded', expanded);
      const button = entry.card.querySelector('[data-act="expand"]');
      if (button) button.innerHTML = expanded ? ICON_COLLAPSE : ICON_EXPAND;
    });
    applyVisibility();
  }

  function renderImpulse() {
    state.channels.forEach((channel, index) => {
      const entry = cards[index];
      if (!entry) return;
      entry.impulse.hidden = !channel.impulse || channel.input === null;
      entry.card.classList.toggle('mc-with-impulse', channel.impulse && channel.input !== null);
      const button = entry.card.querySelector('[data-act="impulse"]');
      if (button) button.classList.toggle('on', channel.impulse);
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
      text += ' This interface offers ' + captured +
        ' input' + (captured === 1 ? '' : 's') + ', so ' + captured +
        ' channel' + (captured === 1 ? ' is' : 's are') + ' shown.';
    }
    note.textContent = text;
  }

  function updateStartButton() {
    const button = $('btnMcStart');
    if (!button) return;
    button.textContent = state.running ? 'Stop all' : 'Start all';
    button.classList.toggle('on', state.running);
  }

  /* ---------- tabs ---------- */

  function showTab(tab) {
    state.tab = tab;
    const panels = { channels: 'mcPanelChannels', compare: 'mcPanelCompare', report: 'mcPanelReport' };
    Object.keys(panels).forEach((key) => {
      const panel = $(panels[key]);
      if (panel) panel.hidden = key !== tab;
    });
    document.querySelectorAll('.mc-tab').forEach((button) => {
      const on = button.dataset.tab === tab;
      button.classList.toggle('on', on);
      button.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    requestAnimationFrame(() => {
      resizeAll();
      drawAll();
    });
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
    showTab(state.tab || 'channels');
    updateNote();
    updateStartButton();
    updateCompareChoices();
    renderReport();
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
      renderImpulse();
      updateNote();
      updateStartButton();
      updateCompareChoices();
      renderReport();

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
    renderImpulse();
    updateFigures();
    updateCompareChoices();
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
      channel.held = {
        magDb: Float32Array.from(channel.result.magDb),
        df: channel.result.df,
      };
    } else {
      setStatus('channel ' + (index + 1) + ' has no curve to hold yet', 'err');
      return;
    }
    updateFigures();
    drawAll();
  }

  function toggleImpulse(index) {
    const channel = state.channels[index];
    if (!channel) return;
    channel.impulse = !channel.impulse;
    renderImpulse();
    requestAnimationFrame(() => { resizeAll(); drawAll(); });
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

  /* ---------- saving and reporting ---------- */

  function assignedChannels() {
    return state.channels.filter((channel) => channel.input !== null);
  }

  function saveAll() {
    if (!saveChannels) return;
    const ready = assignedChannels().filter((channel) => channel.result);
    if (!ready.length) {
      setStatus(assignedChannels().length
        ? 'no channel has a curve yet — Start the channels, then save'
        : 'no channel has an input, so there is nothing to save', 'err');
      return;
    }

    const payload = ready.map((channel) => ({
      input: channel.input,
      smoothing: channel.smoothing,
      coherence: channel.coherence,
      delayMs: channel.delayMs,
      result: channel.result,
    }));

    const outcome = saveChannels(payload) || { ok: false, message: 'nothing was saved' };
    if (outcome.ok) {
      const left = assignedChannels().length - ready.length;
      setStatus('saved ' + outcome.count + ' channel' + (outcome.count === 1 ? '' : 's') +
        ' to the capture library' + (left > 0 ? ' · ' + left + ' left out — no curve yet' : ''), 'ok');
    } else {
      setStatus(outcome.message || 'the channels could not be saved', 'err');
    }
  }

  async function shareReport() {
    const withCurves = state.channels.filter((channel) => channel.result);
    if (!withCurves.length) {
      setStatus('there is nothing to report until a channel has a curve', 'err');
      return;
    }

    try {
      const chart = buildReportChart();
      const facts = state.channels.map((channel, index) => {
        if (!channel.result) return [NAMES[index], 'no curve'];
        const delay = Number.isFinite(channel.delayMs) ? channel.delayMs.toFixed(2) + ' ms' : '—';
        const coherence = Number.isFinite(channel.coherence) ? Math.round(channel.coherence * 100) + '%' : '—';
        return [NAMES[index], delay + ' · ' + coherence];
      });
      const settings = [
        ['Inputs captured', String(state.delivered)],
        ['Reference', 'generated signal'],
        ...state.channels.map((channel, index) => [
          NAMES[index],
          channel.input === null
            ? 'no input'
            : 'IN ' + (channel.input + 1) + ' · FFT ' + channel.fftSize + ' · ' + smoothingText(channel.smoothing),
        ]),
      ];

      const blob = await reportPdfBlob({
        dateText: new Date().toLocaleString(),
        chartCanvas: chart,
        facts,
        eqLines: ['Multichannel capture in the browser — every curve is measured from the captured audio.'],
        settings,
      });

      const outcome = await shareOrDownload(blob, 'align-multichannel.pdf', 'Align multichannel report');
      setStatus(outcome === 'cancelled'
        ? 'the report was cancelled'
        : 'the multichannel report is ready', outcome === 'cancelled' ? 'err' : 'ok');
    } catch (err) {
      setStatus('the report could not be made: ' + (err && err.message ? err.message : err), 'err');
    }
  }

  /* ---------- comparison ---------- */

  function updateCompareChoices() {
    const options = state.channels
      .filter((channel) => channel.input !== null)
      .map((channel) => ({ value: String(state.channels.indexOf(channel)), label: NAMES[state.channels.indexOf(channel)] }));

    const apply = (select, current) => {
      if (!select) return null;
      select.textContent = '';
      if (!options.length) {
        const none = document.createElement('option');
        none.value = '';
        none.textContent = 'no channel';
        select.appendChild(none);
        select.disabled = true;
        return null;
      }
      select.disabled = false;
      options.forEach((option) => {
        const node = document.createElement('option');
        node.value = option.value;
        node.textContent = option.label;
        select.appendChild(node);
      });
      const wanted = options.some((option) => option.value === String(current))
        ? String(current)
        : options[0].value;
      select.value = wanted;
      return Number(wanted);
    };

    state.compareA = apply($('mcCompareA'), state.compareA);
    const second = options.find((option) => Number(option.value) !== state.compareA);
    const wantedB = options.some((option) => option.value === String(state.compareB)) &&
      Number(state.compareB) !== state.compareA
      ? String(state.compareB)
      : (second ? second.value : null);
    state.compareB = wantedB === null ? null : apply($('mcCompareB'), Number(wantedB));
  }

  function comparison() {
    const a = state.channels[state.compareA ?? -1];
    const b = state.channels[state.compareB ?? -1];
    if (!a || !b || !a.result || !b.result) return null;

    const bands = CENTRES.map((centre) => {
      const left = bandLevel(a.result, centre);
      const right = bandLevel(b.result, centre);
      if (!left || !right || left.coherence < COHERENCE_GATE || right.coherence < COHERENCE_GATE) {
        return { centre, delta: null };
      }
      return { centre, delta: left.db - right.db };
    });

    const measured = bands.filter((band) => band.delta !== null);
    const largest = measured.reduce(
      (best, band) => (!best || Math.abs(band.delta) > Math.abs(best.delta) ? band : best),
      null,
    );
    const range = measured.filter((band) => band.centre >= 250 && band.centre <= 4000);
    const withinTwo = range.length
      ? range.filter((band) => Math.abs(band.delta) <= 2).length / range.length
      : null;

    return { a, b, bands, largest, withinTwo };
  }

  function comparisonText(result) {
    if (!result) {
      return 'Two channels with a live curve are needed: Start the channels, then choose one for A and one for B.';
    }
    if (!result.largest) {
      return 'No band is clear of the coherence gate (35%) yet — the two curves do not agree enough to compare.';
    }
    const aIndex = state.channels.indexOf(result.a);
    const bIndex = state.channels.indexOf(result.b);
    const louder = result.largest.delta >= 0 ? NAMES[aIndex] : NAMES[bIndex];
    const amount = Math.abs(result.largest.delta);
    let text = NAMES[aIndex] + ' − ' + NAMES[bIndex] + ': ' + louder + ' is ' + amount.toFixed(1) +
      ' dB louder at ' + result.largest.centre + ' Hz';
    if (result.largest.centre >= 1000) {
      text = NAMES[aIndex] + ' − ' + NAMES[bIndex] + ': ' + louder + ' is ' + amount.toFixed(1) +
        ' dB louder at ' + (result.largest.centre / 1000).toFixed(2) + ' kHz';
    }
    if (result.withinTwo !== null) {
      text += ' · ' + Math.round(result.withinTwo * 100) + '% of 250 Hz – 4 kHz within 2 dB';
    }
    return text + ' · bands below 35% coherence are left out';
  }

  /* ---------- report ---------- */

  function renderReport() {
    const list = $('mcReportList');
    if (!list) return;
    list.textContent = '';
    state.channels.forEach((channel, index) => {
      const item = document.createElement('li');
      const delay = channel.result && Number.isFinite(channel.delayMs)
        ? channel.delayMs.toFixed(2) + ' ms'
        : '—';
      const coherence = channel.result && Number.isFinite(channel.coherence)
        ? Math.round(channel.coherence * 100) + '%'
        : '—';
      item.innerHTML =
        '<span class="mc-dot" style="background:' + COLORS[index] + '"></span>' +
        '<strong>' + NAMES[index] + '</strong>' +
        '<span>' + (channel.input === null ? 'no input' : 'IN ' + (channel.input + 1)) + '</span>' +
        '<span>' + delay + '</span>' +
        '<span>' + coherence + '</span>' +
        '<span>FFT ' + channel.fftSize + ' · ' + smoothingText(channel.smoothing) + '</span>';
      list.appendChild(item);
    });

    const button = $('btnMcReport');
    if (button) button.disabled = !state.channels.some((channel) => channel.result);
    drawReport();
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

  function resizeCanvas(canvas) {
    if (!canvas || canvas.hidden) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  function resizeAll() {
    state.channels.forEach((channel, index) => {
      const entry = cards[index];
      if (!entry) return;
      resizeCanvas(entry.canvas);
      resizeCanvas(entry.impulse);
    });
    resizeCanvas($('mcCompareChart'));
    resizeCanvas($('mcReportChart'));
  }

  function drawAll() {
    if (!state.active) return;
    state.channels.forEach((channel, index) => {
      const entry = cards[index];
      if (!entry || entry.card.hidden) return;
      drawCard(channel, index, entry.canvas);
      if (channel.impulse) drawImpulse(channel, index, entry.impulse);
    });

    if (state.tab === 'compare') drawCompare();
    if (state.tab === 'report') { drawReport(); renderReport(); }
  }

  function paneFor(width, height, left, right, top, bottom) {
    return {
      x: left,
      y: top,
      w: Math.max(1, width - left - right),
      h: Math.max(1, height - top - bottom),
    };
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

    const pane = paneFor(width, height, 34, 8, 10, 24);
    const logSpan = Math.log(F_MAX / F_MIN);
    const xFor = (hz) => pane.x + pane.w * clamp(Math.log(clamp(hz, F_MIN, F_MAX) / F_MIN) / logSpan, 0, 1);
    const yFor = (db) => pane.y + pane.h * (DB_TOP - clamp(db, DB_BOTTOM, DB_TOP)) / (DB_TOP - DB_BOTTOM);

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

    plotMagnitude(ctx, channel, pane, xFor, yFor, logSpan, COLORS[index]);
  }

  function plotMagnitude(ctx, channel, pane, xFor, yFor, logSpan, colour, strong) {
    const plot = (values, df, widthPx, alpha) => {
      if (!values || !df) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = colour;
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

    if (channel.held) plot(channel.held.magDb, channel.held.df, 1.3, 0.4);
    if (channel.result) plot(channel.result.magDb, channel.result.df, strong ? 2 : 1.8, 1);
  }

  function drawImpulse(channel, index, canvas) {
    const ctx = canvas.getContext('2d');
    if (!ctx || !channel.result || !channel.result.irDb) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    if (width < 40 || height < 20) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const values = channel.result.irDb;
    const n = values.length;
    const rate = channel.result.sampleRate || engine?.sampleRate || 48000;
    const peakRaw = Math.round(channel.result.delaySamples || 0);
    const peak = peakRaw < 0 ? n + peakRaw : peakRaw;
    const before = Math.round(rate * 0.002);
    const after = Math.round(rate * 0.010);
    const span = before + after;

    const left = 30;
    const pane = paneFor(width, height, left, 8, 6, 14);
    const top = 0;
    const bottom = -70;

    ctx.strokeStyle = 'rgba(120, 190, 140, 0.16)';
    ctx.lineWidth = 1;
    for (const db of [0, -35, -70]) {
      const y = pane.y + pane.h * (top - db) / (top - bottom);
      ctx.beginPath();
      ctx.moveTo(pane.x, y);
      ctx.lineTo(pane.x + pane.w, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(159, 184, 164, 0.8)';
      ctx.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(dbLabel(db), pane.x - 5, y);
    }

    ctx.strokeStyle = COLORS[index];
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i <= span; i += 1) {
      let sample = peak - before + i;
      sample = ((sample % n) + n) % n;
      const db = clamp(values[sample], bottom, top);
      const x = pane.x + pane.w * (i / span);
      const y = pane.y + pane.h * (top - db) / (top - bottom);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Mark the peak and name the time window.
    const peakX = pane.x + pane.w * (before / span);
    ctx.strokeStyle = 'rgba(159, 232, 138, 0.5)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(peakX, pane.y);
    ctx.lineTo(peakX, pane.y + pane.h);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(159, 184, 164, 0.8)';
    ctx.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('impulse · −2 to +10 ms', pane.x + 4, pane.y + pane.h + 7);
  }

  function drawCompare() {
    const canvas = $('mcCompareChart');
    const readout = $('mcCompareReadout');
    if (!canvas || !readout) return;

    const result = comparison();
    readout.textContent = comparisonText(result);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    if (width < 40 || height < 30) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const span = 12;
    const pane = paneFor(width, height, 34, 8, 10, 24);
    const logSpan = Math.log(F_MAX / F_MIN);
    const xFor = (hz) => pane.x + pane.w * clamp(Math.log(clamp(hz, F_MIN, F_MAX) / F_MIN) / logSpan, 0, 1);
    const yFor = (db) => pane.y + pane.h / 2 - (pane.h / 2) * clamp(db, -span, span) / span;

    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';

    for (const db of [-12, -6, 0, 6, 12]) {
      const y = yFor(db);
      ctx.strokeStyle = db === 0 ? 'rgba(140, 220, 160, 0.5)' : 'rgba(120, 190, 140, 0.16)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pane.x, y);
      ctx.lineTo(pane.x + pane.w, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(159, 184, 164, 0.9)';
      ctx.textAlign = 'right';
      ctx.fillText(db === 0 ? '0' : (db > 0 ? '+' : '') + db, pane.x - 6, y);
    }

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

    if (!result) return;

    ctx.strokeStyle = '#ffb054';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    let started = false;
    for (const band of result.bands) {
      if (band.delta === null) { started = false; continue; }
      const x = xFor(band.centre);
      const y = yFor(band.delta);
      if (started) ctx.lineTo(x, y);
      else { ctx.moveTo(x, y); started = true; }
      ctx.fillStyle = '#ffb054';
      ctx.fillRect(x - 1.4, y - 1.4, 2.8, 2.8);
    }
    ctx.stroke();
  }

  function buildReportChart() {
    const canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 420;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0b0f0c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const pane = { x: 56, y: 22, w: canvas.width - 78, h: canvas.height - 66 };
    const logSpan = Math.log(F_MAX / F_MIN);
    const xFor = (hz) => pane.x + pane.w * clamp(Math.log(clamp(hz, F_MIN, F_MAX) / F_MIN) / logSpan, 0, 1);
    const yFor = (db) => pane.y + pane.h * (DB_TOP - clamp(db, DB_BOTTOM, DB_TOP)) / (DB_TOP - DB_BOTTOM);

    ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
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
      ctx.fillText(dbLabel(db), pane.x - 8, y);
    }

    for (const hz of TICKS) {
      const x = xFor(hz);
      ctx.strokeStyle = 'rgba(120, 190, 140, 0.14)';
      ctx.beginPath();
      ctx.moveTo(x, pane.y);
      ctx.lineTo(x, pane.y + pane.h);
      ctx.stroke();
      ctx.fillStyle = 'rgba(159, 184, 164, 0.9)';
      ctx.textAlign = 'center';
      ctx.fillText(frequencyLabel(hz) + ' Hz', x, pane.y + pane.h + 18);
    }

    // A legend along the top.
    let legendX = pane.x;
    state.channels.forEach((channel, index) => {
      if (!channel.result) return;
      ctx.fillStyle = COLORS[index];
      ctx.fillRect(legendX, 8, 14, 3);
      ctx.fillStyle = 'rgba(233, 245, 232, 0.9)';
      ctx.textAlign = 'left';
      ctx.font = '12px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.fillText(NAMES[index], legendX + 20, 10);
      legendX += 34 + ctx.measureText(NAMES[index]).width;
      ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
    });

    state.channels.forEach((channel, index) => {
      if (!channel.result) return;
      const values = channel.result.magDb;
      const df = channel.result.df;
      ctx.strokeStyle = COLORS[index];
      ctx.lineWidth = 1.6;
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
    });

    return canvas;
  }

  function drawReport() {
    const canvas = $('mcReportChart');
    if (!canvas || state.tab !== 'report') return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    if (width < 40 || height < 30) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const pane = paneFor(width, height, 34, 8, 10, 24);
    const logSpan = Math.log(F_MAX / F_MIN);
    const xFor = (hz) => pane.x + pane.w * clamp(Math.log(clamp(hz, F_MIN, F_MAX) / F_MIN) / logSpan, 0, 1);
    const yFor = (db) => pane.y + pane.h * (DB_TOP - clamp(db, DB_BOTTOM, DB_TOP)) / (DB_TOP - DB_BOTTOM);

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

    state.channels.forEach((channel, index) => {
      if (!channel.result) return;
      plotMagnitude(ctx, channel, pane, xFor, yFor, logSpan, COLORS[index], false);
    });
  }

  /* ---------- boot ---------- */

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

  function bind() {
    const start = $('btnMcStart');
    if (start) start.addEventListener('click', startAll);
    const closeButton = $('btnMcClose');
    if (closeButton) closeButton.addEventListener('click', close);
    const saveButton = $('btnMcSave');
    if (saveButton) saveButton.addEventListener('click', saveAll);
    const reportButton = $('btnMcReport');
    if (reportButton) reportButton.addEventListener('click', shareReport);

    document.querySelectorAll('.mc-tab').forEach((button) => {
      button.addEventListener('click', () => showTab(button.dataset.tab));
    });

    const compareA = $('mcCompareA');
    if (compareA) compareA.addEventListener('change', () => {
      state.compareA = Number(compareA.value);
      if (state.compareB === state.compareA) updateCompareChoices();
      drawAll();
    });
    const compareB = $('mcCompareB');
    if (compareB) compareB.addEventListener('change', () => {
      state.compareB = Number(compareB.value);
      drawAll();
    });

    bindSettings();
  }

  return {
    open,
    close,
    startAll,
    stopAll,
    get active() { return state.active; },
    get running() { return state.running; },
    /** Bind once the page's DOM exists. */
    bind,
  };
}
