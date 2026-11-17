/*
 * Input diagnostics for the four-channel workspace.
 *
 * Two kinds of figure are shown and they are labelled as such: what the browser
 * REPORTS (the device's label, its channel count, its sample rate) and what can
 * be VERIFIED from the samples that actually arrived (how many windows have been
 * analysed, each input's level, whether two inputs carry the same signal,
 * whether callbacks arrived late). A browser can report four channels and then
 * deliver two; only the second column can tell you that.
 *
 * Nothing here changes the measurement. It only reads the engine and the
 * analyser.
 */

const INPUT_LABELS = ['Input 1', 'Input 2', 'Input 3', 'Input 4'];

function dbText(level) {
  if (!(level > 0)) return 'silent';
  const db = 20 * Math.log10(level);
  return (db < -120 ? -120 : db).toFixed(1) + ' dBFS';
}

export function createDiagnostics(options) {
  const opts = options || {};
  const engine = opts.engine;
  const getState = typeof opts.getState === 'function' ? opts.getState : () => ({});

  let root = null;
  let analysisStamps = [];
  let lastRender = 0;

  function ensure() {
    if (root) return root;
    root = document.getElementById('multiDiag');
    return root;
  }

  function build(container) {
    container.textContent = '';
    const table = document.createElement('table');
    table.className = 'diag-table';
    const body = document.createElement('tbody');
    // Every row is a [label, value, kind] triple. kind is 'report' for a figure
    // the browser supplied, 'verified' for one the app measured, and 'app' for
    // a setting this app chose.
    const rows = [
      'device', 'channelsRequested', 'channelsDelivered', 'rate', 'rateRequested',
      'fft', 'resolution', 'frames', 'lateCallbacks', 'analysisRate', 'status',
    ];
    for (const key of rows) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.textContent = '';
      const td = document.createElement('td');
      td.dataset.diag = key;
      td.textContent = '—';
      const kind = document.createElement('td');
      kind.className = 'diag-kind';
      kind.dataset.diagKind = key;
      tr.appendChild(th);
      tr.appendChild(td);
      tr.appendChild(kind);
      body.appendChild(tr);
    }
    table.appendChild(body);
    container.appendChild(table);

    const meters = document.createElement('div');
    meters.className = 'diag-meters';
    meters.id = 'multiDiagMeters';
    for (let i = 0; i < INPUT_LABELS.length; i++) {
      const row = document.createElement('div');
      row.className = 'diag-meter';
      row.innerHTML = [
        '<b>' + INPUT_LABELS[i] + '</b>',
        '<span class="diag-bar"><i data-meter="' + i + '"></i></span>',
        '<span data-meterText="' + i + '">—</span>',
      ].join('');
      meters.appendChild(row);
    }
    container.appendChild(meters);

    const note = document.createElement('p');
    note.className = 'source-hint';
    note.id = 'multiDiagNote';
    note.textContent = '';
    container.appendChild(note);
  }

  function set(key, label, value, kind, warn) {
    const cell = root.querySelector('[data-diag="' + key + '"]');
    if (!cell) return;
    const th = cell.previousElementSibling;
    if (th) th.textContent = label;
    cell.textContent = value;
    cell.classList.toggle('diag-warn', !!warn);
    const kindCell = root.querySelector('[data-diagKind="' + key + '"]');
    if (kindCell) kindCell.textContent = kind || '';
  }

  /** Called by the workspace after each analysis frame. */
  function noteAnalysis(now) {
    analysisStamps.push(now);
    if (analysisStamps.length > 12) analysisStamps.shift();
  }

  function analysisRate() {
    if (analysisStamps.length < 2) return 0;
    const span = analysisStamps[analysisStamps.length - 1] - analysisStamps[0];
    if (!(span > 0)) return 0;
    return ((analysisStamps.length - 1) * 1000) / span;
  }

  function render() {
    const now = Date.now();
    if (now - lastRender < 400) return;
    lastRender = now;

    const container = ensure();
    if (!container) return;
    if (!container.firstChild) build(container);

    const state = getState() || {};
    const live = !!(engine && engine.running);

    if (!engine) {
      set('device', 'Input device', 'no audio engine', 'app');
      return;
    }

    set('device', 'Input device', engine.deviceLabel || 'not opened yet', 'report');
    set('channelsRequested', 'Channels requested', String(engine.requestedChannels || 1), 'app');
    set('channelsDelivered', 'Channels delivered', String(engine.channels || 0), 'report',
      (engine.channels || 0) < (engine.requestedChannels || 1));
    set('rate', 'Sample rate', engine.ctx ? (engine.sampleRate / 1000).toFixed(1) + ' kHz' : '—', 'report');
    set('rateRequested', 'Rate constraint', 'none set — the device picks', 'app');

    const fftSize = state.fftSize || 0;
    const rate = engine.ctx ? engine.sampleRate : 0;
    set('fft', 'FFT size', fftSize ? String(fftSize) : '—', 'app');
    set('resolution', 'Resolution',
      fftSize && rate ? (rate / fftSize).toFixed(2) + ' Hz · ' +
        ((fftSize / rate) * 1000).toFixed(0) + ' ms window' : '—', 'verified');
    set('frames', 'Windows analysed', state.frames ? String(state.frames) : (live ? '0' : '—'), 'verified');
    set('lateCallbacks', 'Late callbacks', live ? String(engine.droppedCallbacks || 0) : '—', 'verified',
      (engine.droppedCallbacks || 0) > 0);
    set('analysisRate', 'Analysis rate', live ? analysisRate().toFixed(1) + ' / s' : '—', 'verified');

    const status = [];
    if (!live) status.push('not listening');
    if (engine.interrupted) status.push('audio ' + engine.interrupted);
    if (engine.trackIssue) status.push(engine.trackIssue);
    if (engine.channelDuplicated) status.push('inputs carry the same signal');
    set('status', 'Status', status.length ? status.join(' · ') : 'listening', 'verified',
      status.length > 0);

    // Level meters: one per device input, from the samples themselves.
    for (let i = 0; i < INPUT_LABELS.length; i++) {
      const bar = container.querySelector('[data-meter="' + i + '"]');
      const text = container.querySelector('[data-meterText="' + i + '"]');
      if (!bar || !text) continue;
      const delivered = live && i < (engine.channels || 0);
      const level = delivered ? (engine.channelLevel[i] || 0) : 0;
      const clipped = delivered && engine.channelClippedUntil
        && engine.channelClippedUntil[i] > now;
      const ratio = level > 0 ? Math.min(1, Math.max(0, (20 * Math.log10(level) + 60) / 60)) : 0;
      bar.style.width = Math.round(ratio * 100) + '%';
      bar.classList.toggle('clip', !!clipped);
      text.textContent = delivered ? (clipped ? 'CLIP' : dbText(level)) : 'not delivered';
    }

    const note = document.getElementById('multiDiagNote');
    if (!note) return;
    const refChannel = Number(state.routing ? state.routing.ref : 3);
    const refLevel = live && engine.channelLevel ? engine.channelLevel[refChannel] || 0 : 0;
    if (!live) {
      note.textContent = 'Start listening to read the four inputs.';
    } else if (!(engine.channels >= 4)) {
      note.textContent = 'This device delivered ' + (engine.channels || 0) +
        ' of the 4 inputs asked for, so a four-channel measurement is not possible here. ' +
        'The inputs it did deliver are shown above.';
    } else if (!(refLevel > 1e-5)) {
      note.textContent = 'Input ' + (refChannel + 1) + ' is the reference and is silent. ' +
        'The transfer function needs a signal there before anything can be measured.';
    } else if (engine.channelDuplicated) {
      note.textContent = 'Two or more inputs carry the same signal. That is not four independent ' +
        'channels: check the interface, the hub and the browser’s channel handling.';
    } else {
      note.textContent = 'Four inputs, each with its own signal. Levels, clipping and the reference ' +
        'are measured from the samples that arrived, not taken from the browser’s report.';
    }
  }

  return { render, noteAnalysis };
}
