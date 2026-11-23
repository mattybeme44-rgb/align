/*
 * The session log: what happened during a tuning day, in order.
 *
 * It records only what the app already did — a capture taken, a preset or an
 * EQ set applied, a delay applied, a calibration loaded, a report exported. It
 * never measures, changes or re-applies anything, and it says so where it is
 * shown. The store is plain data, so the tests can run it without a browser.
 */

export const SESSION_LOG_KEY = 'align.sessionLog.v1';
export const SESSION_LOG_LIMIT = 200;

const KINDS = {
  capture: 'Capture',
  preset: 'Preset applied',
  eqset: 'EQ set applied',
  delay: 'Delay applied',
  calibration: 'Calibration',
  target: 'Target',
  export: 'Report exported',
};

function text(value, fallback, limit) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, limit || 120);
}

/** One entry, normalised, or null when there is nothing worth keeping. */
export function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = typeof raw.kind === 'string' && KINDS[raw.kind] ? raw.kind : 'capture';
  const at = Number.isFinite(Number(raw.at)) ? Number(raw.at) : Date.now();
  return {
    at,
    kind,
    kindLabel: KINDS[kind],
    label: text(raw.label, KINDS[kind], 90),
    detail: text(raw.detail, '', 160),
  };
}

export function normalizeEntries(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeEntry).filter(Boolean)
    .sort((a, b) => b.at - a.at)
    .slice(0, SESSION_LOG_LIMIT);
}

/** Newest first, trimmed to the limit. */
export function appendEntry(list, entry) {
  const next = normalizeEntry(entry);
  const current = Array.isArray(list) ? list : [];
  if (!next) return current.slice(0, SESSION_LOG_LIMIT);
  return [next, ...current].slice(0, SESSION_LOG_LIMIT);
}

export function filterEntries(list, query) {
  const entries = Array.isArray(list) ? list : [];
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) =>
    (entry.label + ' ' + entry.detail + ' ' + entry.kindLabel).toLowerCase().includes(needle));
}

function clock(at) {
  const date = new Date(at);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return hours + ':' + minutes;
}

export function dayLabel(at) {
  const date = new Date(at);
  const now = new Date();
  const same = (a, b) => a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(date, now)) return 'Today';
  const yesterday = new Date(now.getTime() - 86400000);
  if (same(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function entriesToCsv(list) {
  const lines = ['time,type,what,figures'];
  for (const entry of Array.isArray(list) ? list : []) {
    const stamp = new Date(entry.at).toISOString();
    const clean = (value) => '"' + String(value || '').replace(/"/g, '""') + '"';
    lines.push([stamp, clean(entry.kindLabel), clean(entry.label), clean(entry.detail)].join(','));
  }
  return lines.join('\n');
}

export function loadEntries(storage) {
  const target = storage || (typeof window !== 'undefined' ? window.localStorage : null);
  if (!target) return [];
  try {
    const raw = target.getItem(SESSION_LOG_KEY);
    return normalizeEntries(raw ? JSON.parse(raw) : []);
  } catch (error) {
    return [];
  }
}

export function persistEntries(list, storage) {
  const target = storage || (typeof window !== 'undefined' ? window.localStorage : null);
  if (!target) return false;
  try {
    target.setItem(SESSION_LOG_KEY, JSON.stringify(normalizeEntries(list)));
    return true;
  } catch (error) {
    return false;
  }
}

/* ---------- the screen ---------- */

/**
 * The Session log sheet.
 *
 * `share` is the app's share helper: (blob, filename, title) => Promise. The
 * view only reads and stores; the entries are written by the app as it works.
 */
export function createSessionLog(options = {}) {
  const opts = options || {};
  const share = typeof opts.share === 'function' ? opts.share : null;
  const setStatus = typeof opts.setStatus === 'function' ? opts.setStatus : () => {};
  const $ = (id) => document.getElementById(id);

  let entries = loadEntries();
  let query = '';

  function render() {
    const list = $('sessionLogList');
    const count = $('sessionLogCount');
    if (!list) return;

    const shown = filterEntries(entries, query);
    if (count) {
      count.textContent = shown.length
        ? shown.length + (shown.length === 1 ? ' entry' : ' entries')
        : 'nothing logged yet';
    }

    list.replaceChildren();
    if (!shown.length) {
      const empty = document.createElement('p');
      empty.className = 'source-hint';
      empty.textContent = entries.length
        ? 'No entry matches that search.'
        : 'Nothing logged yet. Captures, presets and exports appear here as you work.';
      list.appendChild(empty);
      return;
    }

    let day = '';
    for (const entry of shown) {
      const label = dayLabel(entry.at);
      if (label !== day) {
        day = label;
        const heading = document.createElement('p');
        heading.className = 'sl-day';
        heading.textContent = label;
        list.appendChild(heading);
      }

      const row = document.createElement('div');
      row.className = 'sl-row' + (entry.kind === 'capture' ? '' : ' sl-changed');

      const time = document.createElement('span');
      time.className = 'sl-time';
      time.textContent = clock(entry.at);

      const body = document.createElement('span');
      body.className = 'sl-body';
      const head = document.createElement('span');
      head.className = 'sl-head';
      head.textContent = entry.kindLabel + ' · ' + entry.label;
      body.appendChild(head);
      if (entry.detail) {
        const detail = document.createElement('span');
        detail.className = 'sl-detail';
        detail.textContent = entry.detail;
        body.appendChild(detail);
      }

      row.append(time, body);
      list.appendChild(row);
    }
  }

  function log(kind, label, detail) {
    entries = appendEntry(entries, { at: Date.now(), kind, label, detail });
    persistEntries(entries);
    if (!$('sessionLogSheet') || !$('sessionLogSheet').hidden) render();
  }

  function setQuery(value) {
    query = String(value || '');
    render();
  }

  function open() {
    const sheet = $('sessionLogSheet');
    if (!sheet) return;
    render();
    sheet.hidden = false;
    if (typeof opts.onOpen === 'function') opts.onOpen();
  }

  function close() {
    const sheet = $('sessionLogSheet');
    if (sheet) sheet.hidden = true;
    if (typeof opts.onClose === 'function') opts.onClose();
  }

  async function exportCsv() {
    if (!entries.length) {
      setStatus('nothing logged yet — there is nothing to export', 'err');
      return;
    }
    const csv = entriesToCsv(entries);
    const blob = new Blob([csv], { type: 'text/csv' });
    try {
      if (share) {
        await share(blob, 'align-session-log.csv', 'Align session log');
        setStatus('session log exported', 'ok');
        return;
      }
    } catch (error) {
      /* fall through to the message below */
    }
    setStatus('this browser would not export the log', 'err');
  }

  function clear() {
    if (!entries.length) {
      setStatus('the session log is already empty', 'ok');
      return;
    }
    entries = [];
    persistEntries(entries);
    render();
    setStatus('session log cleared', 'ok');
  }

  return { log, render, open, close, exportCsv, clear, setQuery, entries: () => entries.slice() };
}
