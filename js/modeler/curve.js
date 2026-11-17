/*
 * Response curves for the System Data Modeler.
 *
 * Everything here is pure arithmetic on plain numbers: a loudspeaker response
 * resampled onto one log frequency grid, phase unwrapped before it is ever
 * interpolated, fractional-octave smoothing, and a tolerant reader for the
 * frequency-response files sound engineers actually have on disk.
 *
 * The grid is the same 400-point, 20 Hz – 20 kHz log grid the capture library
 * already samples a saved measurement onto, so a saved capture can be used here
 * without touching the audio path at all.
 *
 * The rule the whole module rests on: a magnitude curve with no measured phase
 * stays magnitude-only. Nothing here invents phase for it.
 */

export const GRID_POINTS = 400;
export const CURVE_FMIN = 20;
export const CURVE_FMAX = 20000;
/** Speed of sound in air at 20 °C, m/s. */
export const SPEED_OF_SOUND = 343;

/** The grid frequency of one index, log-spaced from 20 Hz to 20 kHz. */
export function gridFrequency(index, count = GRID_POINTS) {
  const n = Math.max(2, Math.floor(Number(count) || GRID_POINTS));
  const t = Math.min(1, Math.max(0, Number(index) / (n - 1)));
  return CURVE_FMIN * Math.exp(t * Math.log(CURVE_FMAX / CURVE_FMIN));
}

export function gridFrequencies(count = GRID_POINTS) {
  const n = Math.max(2, Math.floor(Number(count) || GRID_POINTS));
  const values = new Float64Array(n);
  for (let i = 0; i < n; i += 1) values[i] = gridFrequency(i, n);
  return values;
}

/** Wrap an angle into ±180°. */
export function wrapDegrees(deg) {
  let value = Number(deg);
  if (!Number.isFinite(value)) return 0;
  value %= 360;
  if (value > 180) value -= 360;
  if (value < -180) value += 360;
  return value;
}

/**
 * Unwrap a phase curve, in degrees, so it can be interpolated and rotated by a
 * delay. Angles arrive wrapped from the analyser and from most files; the
 * forward difference is kept inside ±180° so the curve becomes continuous.
 */
export function unwrapDegrees(values) {
  const out = new Float64Array(values.length);
  let previous = 0;
  let first = true;
  for (let i = 0; i < values.length; i += 1) {
    const value = Number(values[i]);
    if (!Number.isFinite(value)) {
      out[i] = first ? 0 : previous;
      continue;
    }
    if (first) {
      previous = value;
      first = false;
      out[i] = value;
      continue;
    }
    let delta = value - previous;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    previous += delta;
    out[i] = previous;
  }
  return out;
}

export function dbToLinear(db) {
  return Math.pow(10, Number(db) / 20);
}

export function linearToDb(value) {
  const v = Number(value);
  if (!(v > 0)) return -120;
  return 20 * Math.log10(v);
}

/**
 * Linear interpolation of a series (linear in frequency), with the end values
 * held beyond the series. Returns NaN when the series carries no usable value.
 */
export function interpolateAt(frequencies, values, frequency) {
  const n = frequencies.length;
  if (!n || !values || values.length !== n) return NaN;
  const f = Number(frequency);
  if (!Number.isFinite(f)) return NaN;
  if (f <= frequencies[0]) return Number(values[0]);
  if (f >= frequencies[n - 1]) return Number(values[n - 1]);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frequencies[mid] <= f) lo = mid;
    else hi = mid;
  }
  const f0 = frequencies[lo];
  const f1 = frequencies[hi];
  const v0 = Number(values[lo]);
  const v1 = Number(values[hi]);
  if (!Number.isFinite(v0)) return v1;
  if (!Number.isFinite(v1)) return v0;
  const span = f1 - f0;
  if (!(span > 0)) return v0;
  const t = (f - f0) / span;
  return v0 + (v1 - v0) * t;
}

/**
 * Interpolate a magnitude curve (dB) onto the grid. Magnitude is read linearly
 * in the logarithm of frequency, which is how a response is drawn.
 */
function resampleMagnitude(frequencies, values, grid) {
  const out = new Float64Array(grid.length);
  const logs = new Float64Array(frequencies.length);
  for (let i = 0; i < frequencies.length; i += 1) logs[i] = Math.log(frequencies[i]);
  for (let i = 0; i < grid.length; i += 1) {
    out[i] = interpolateAt(logs, values, Math.log(grid[i]));
  }
  return out;
}

/**
 * Interpolate a phase curve (degrees, already unwrapped) onto the grid. Phase is
 * read linearly in frequency, because a delay is a straight line against f — not
 * against the logarithm of f.
 */
function resamplePhase(frequencies, values, grid) {
  const out = new Float64Array(grid.length);
  for (let i = 0; i < grid.length; i += 1) {
    out[i] = interpolateAt(frequencies, values, grid[i]);
  }
  return out;
}

/**
 * Resample an imported response onto the model grid.
 *
 * `response` carries ascending `frequencies`, `magDb` and, when it was really
 * measured, `phaseDeg` and `coherence`. The phase is unwrapped first and only
 * then interpolated; the coherence is carried across so the chart can be read
 * with the same honesty as the measurement screen.
 */
export function resampleResponse(response, count = GRID_POINTS) {
  const n = Math.max(2, Math.floor(Number(count) || GRID_POINTS));
  const grid = gridFrequencies(n);
  const source = response && typeof response === 'object' ? response : {};
  const frequencies = Array.from(source.frequencies || []);
  const magnitude = Array.from(source.magDb || []);
  const count0 = Math.min(frequencies.length, magnitude.length);

  if (count0 < 2) {
    return { ok: false, message: 'A response needs at least two points to be modelled.', grid };
  }

  const freqs = [];
  const mags = [];
  const phases = [];
  const coherences = [];
  let phaseComplete = Array.isArray(source.phaseDeg) || ArrayBuffer.isView(source.phaseDeg);
  let coherenceComplete = Array.isArray(source.coherence) || ArrayBuffer.isView(source.coherence);

  for (let i = 0; i < count0; i += 1) {
    const f = Number(frequencies[i]);
    const m = Number(magnitude[i]);
    if (!(f > 0) || !Number.isFinite(m)) continue;
    freqs.push(f);
    mags.push(m);

    if (phaseComplete) {
      const value = Number(source.phaseDeg[i]);
      if (Number.isFinite(value)) phases.push(value);
      else phaseComplete = false;
    }
    if (coherenceComplete) {
      const value = Number(source.coherence[i]);
      if (Number.isFinite(value)) coherences.push(Math.max(0, Math.min(1, value)));
      else coherenceComplete = false;
    }
  }
  if (freqs.length < 2) {
    return { ok: false, message: 'That response has no usable frequency and level pairs.', grid };
  }

  const magDb = resampleMagnitude(freqs, mags, grid);

  let phaseDeg = null;
  let phaseNote = '';
  if (phaseComplete && phases.length === freqs.length) {
    const unwrapped = unwrapDegrees(phases);
    phaseDeg = resamplePhase(freqs, Array.from(unwrapped), grid);
  } else if (source.phaseDeg) {
    phaseNote = 'the phase column was incomplete, so the curve stays magnitude-only';
  }

  const coherence = coherenceComplete && coherences.length === freqs.length
    ? resamplePhase(freqs, coherences, grid)
    : null;

  return {
    ok: true,
    message: phaseNote,
    grid,
    magDb,
    phaseDeg,
    coherence,
    sourceRange: { min: freqs[0], max: freqs[freqs.length - 1] },
    phaseValid: !!phaseDeg,
  };
}

/**
 * Fractional-octave smoothing of a magnitude curve, in dB.
 *
 * A triangular window half a width wide per side, applied on the log axis and
 * normalized, so a flat curve stays exactly flat and a ripple settles without
 * the level moving.
 */
export function fractionalOctaveSmooth(values, octaves, count = values.length) {
  const n = values.length;
  const width = Number(octaves);
  if (!(width > 0) || n < 3) return Float64Array.from(values);
  const frequencies = gridFrequencies(count);
  const out = new Float64Array(n);
  const step = Math.log(CURVE_FMAX / CURVE_FMIN) / Math.log(2) / (n - 1);
  const half = Math.max(1, Math.round(width / 2 / step));

  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    let weight = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(n - 1, i + half); k += 1) {
      const distance = Math.abs(Math.log2(frequencies[k] / frequencies[i]));
      const w = Math.max(0, 1 - distance / (width / 2));
      if (!(w > 0)) continue;
      const value = Number(values[k]);
      if (!Number.isFinite(value)) continue;
      sum += value * w;
      weight += w;
    }
    out[i] = weight > 0 ? sum / weight : values[i];
  }
  return out;
}

/** The mean of a curve across a frequency band, or NaN when the band is empty. */
export function bandMean(frequencies, values, min, max) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < frequencies.length; i += 1) {
    if (frequencies[i] < min || frequencies[i] > max) continue;
    const value = Number(values[i]);
    if (!Number.isFinite(value)) continue;
    sum += value;
    count += 1;
  }
  return count ? sum / count : NaN;
}

/** Statistics of one curve across a band: mean, worst peak and worst dip. */
export function curveStatistics(frequencies, values, band) {
  const min = band && band.min ? band.min : CURVE_FMIN;
  const max = band && band.max ? band.max : CURVE_FMAX;
  let sum = 0;
  let count = 0;
  let peak = -Infinity;
  let peakF = NaN;
  let dip = Infinity;
  let dipF = NaN;
  for (let i = 0; i < frequencies.length; i += 1) {
    const f = frequencies[i];
    if (f < min || f > max) continue;
    const value = Number(values[i]);
    if (!Number.isFinite(value)) continue;
    sum += value;
    count += 1;
    if (value > peak) { peak = value; peakF = f; }
    if (value < dip) { dip = value; dipF = f; }
  }
  return {
    meanDb: count ? sum / count : NaN,
    peakDb: count ? peak : NaN,
    peakHz: peakF,
    dipDb: count ? dip : NaN,
    dipHz: dipF,
    count,
  };
}

/**
 * Compare a predicted curve with a measured one across a band. The magnitude
 * error is measured against the predicted curve; the phase error only exists
 * where both curves carry phase and the measured coherence is usable.
 */
export function compareCurves(predicted, measured, band, options = {}) {
  const frequencies = predicted.frequencies;
  const threshold = Number.isFinite(Number(options.coherenceThreshold))
    ? Number(options.coherenceThreshold)
    : 0.35;
  const min = band && band.min ? band.min : CURVE_FMIN;
  const max = band && band.max ? band.max : CURVE_FMAX;

  const errors = [];
  const frequenciesUsed = [];
  const predictedDb = [];
  const measuredDb = [];
  const predictedPhase = [];
  const measuredPhase = [];
  let sumSquares = 0;
  let count = 0;
  let worst = -Infinity;
  let worstF = NaN;

  for (let i = 0; i < frequencies.length; i += 1) {
    const f = frequencies[i];
    if (f < min || f > max) continue;
    const a = Number(predicted.magDb[i]);
    const b = Number(measured.magDb[i]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const error = b - a;
    errors.push(error);
    frequenciesUsed.push(f);
    predictedDb.push(a);
    measuredDb.push(b);
    predictedPhase.push(predicted.phaseDeg ? Number(predicted.phaseDeg[i]) : NaN);
    measuredPhase.push(measured.phaseDeg ? Number(measured.phaseDeg[i]) : NaN);
    sumSquares += error * error;
    count += 1;
    if (!Number.isFinite(worst) || Math.abs(error) > Math.abs(worst)) { worst = error; worstF = f; }
  }

  let phase = null;
  if (predicted.phaseDeg && measured.phaseDeg) {
    let sum = 0;
    let used = 0;
    let worstPhase = 0;
    let worstPhaseF = NaN;
    for (let i = 0; i < frequencies.length; i += 1) {
      const f = frequencies[i];
      if (f < min || f > max) continue;
      const a = Number(predicted.phaseDeg[i]);
      const b = Number(measured.phaseDeg[i]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      if (measured.coherence && Number(measured.coherence[i]) < threshold) continue;
      const error = wrapDegrees(b - a);
      sum += Math.abs(error);
      used += 1;
      if (Math.abs(error) > Math.abs(worstPhase)) { worstPhase = error; worstPhaseF = f; }
    }
    if (used >= 3) {
      phase = {
        meanDeg: sum / used,
        worstDeg: worstPhase,
        worstHz: worstPhaseF,
        count: used,
      };
    }
  }

  return {
    count,
    frequencies: Float64Array.from(frequenciesUsed),
    errors: Float64Array.from(errors),
    predictedDb: Float64Array.from(predictedDb),
    measuredDb: Float64Array.from(measuredDb),
    predictedPhase: Float64Array.from(predictedPhase),
    measuredPhase: Float64Array.from(measuredPhase),
    meanDb: count ? errors.reduce((a, b) => a + b, 0) / count : NaN,
    rmsDb: count ? Math.sqrt(sumSquares / count) : NaN,
    worstDb: count ? worst : NaN,
    worstHz: worstF,
    phase,
    band: { min, max },
  };
}

/* ---------- reading a frequency-response file ---------- */

const COMMENT_LINE = /^\s*(#|\/\/|\*|;|')/;
const NUMBER_TOKEN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function isNumberToken(token) {
  return NUMBER_TOKEN.test(String(token).trim());
}

function numberOf(token) {
  return Number(String(token).trim());
}

function splitTokens(line, delimiter) {
  if (delimiter === 'ws') return line.trim().split(/\s+/);
  return line.split(delimiter);
}

/**
 * Guess the separator the numeric lines are written with. A comma or a tab only
 * counts when splitting on it actually yields numeric columns, so a file whose
 * numbers carry no separator falls through to whitespace.
 */
function guessDelimiter(lines) {
  const candidates = ['\t', ';', ','];
  let best = 'ws';
  let top = 0;
  for (const delimiter of candidates) {
    let count = 0;
    for (const line of lines) {
      if (!line || COMMENT_LINE.test(line)) continue;
      const tokens = line.split(delimiter).map((token) => token.trim());
      if (tokens.filter(isNumberToken).length >= 2) count += 1;
    }
    if (count > top) { top = count; best = delimiter; }
  }
  return best;
}

function normaliseLabel(label) {
  return String(label || '').trim().replace(/^["']|["']$/g, '');
}

/**
 * Read a table of numbers once, so the importer can show the columns it found
 * and let the operator map them before anything is stored.
 */
export function describeResponseText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, message: 'That file is empty.', rows: [], labels: [], mapping: null };
  }

  const lines = text.split(/\r?\n/);
  const delimiter = guessDelimiter(lines);

  let labels = [];
  let headerIndex = -1;
  const rows = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || !line.trim()) continue;

    if (COMMENT_LINE.test(line)) {
      // A comment line that reads like a header names the columns, so a file
      // exported with "# frequency magnitude phase" keeps its phase.
      if (headerIndex < 0 && rows.length === 0) {
        const stripped = line.replace(/^\s*(#|\/\/|\*|;|')\s*/, '').trim();
        if (stripped) {
          let tokens = splitTokens(stripped, delimiter).map(normaliseLabel);
          if (tokens.length < 2) tokens = stripped.split(/\s+/).map(normaliseLabel);
          const words = tokens.filter((token) => token && /^[A-Za-z]/.test(token));
          const digits = tokens.some((token) => /\d/.test(token));
          if (words.length >= 2 && !digits && tokens.length <= 12) {
            labels = tokens;
            headerIndex = index;
          }
        }
      }
      continue;
    }

    const tokens = splitTokens(line, delimiter).map(normaliseLabel);
    const numeric = tokens.filter(isNumberToken).length;
    if (numeric < 2) {
      // The first text line that is not a comment names the columns.
      if (headerIndex < 0 && rows.length === 0) {
        labels = tokens;
        headerIndex = index;
      }
      continue;
    }
    rows.push(tokens);
  }

  if (!rows.length) {
    return { ok: false, message: 'That file holds no numeric rows.', rows: [], labels, mapping: null };
  }

  const rowsWidth = rows.reduce((most, row) => Math.max(most, row.length), 0);
  const columnCount = Math.max(rowsWidth, labels.length);
  const padding = Array.from(rows, (row) =>
    row.concat(new Array(Math.max(0, columnCount - row.length)).fill('')));

  if (labels.length < columnCount) {
    labels = labels.concat(Array.from({ length: columnCount - labels.length }, (_, i) =>
      'Column ' + (labels.length + i + 1)));
  }

  const mapping = autoMapping(labels, padding[0] || []);
  const headerRow = headerIndex >= 0 ? lines[headerIndex].trim() : '';

  return {
    ok: true,
    message: '',
    delimiter,
    labels: labels.slice(0, columnCount),
    headerRow,
    rowCount: padding.length,
    preview: padding.slice(0, 4),
    rows: padding,
    mapping,
  };
}

/** Choose the frequency, magnitude, phase and coherence columns from a header. */
function autoMapping(labels, sampleRow) {
  const lower = labels.map((label) => String(label).toLowerCase());
  const find = (regex, fallback) => {
    const index = lower.findIndex((label) => regex.test(label));
    return index >= 0 ? index : fallback;
  };

  let frequency = find(/freq|hertz|\bhz\b/, -1);
  let magnitude = find(/mag|spl|level|amplitude|\bdb\b/, -1);
  const phase = find(/phase|angle/, -1);
  const coherence = find(/coh/, -1);

  // With no header, the first two numeric columns are frequency and level.
  if (frequency < 0) frequency = 0;
  if (magnitude < 0) magnitude = labels.length > 1 ? 1 : -1;
  if (magnitude === frequency) {
    const other = labels.findIndex((label, index) => index !== frequency && isNumberToken(sampleRow[index]));
    magnitude = other >= 0 ? other : -1;
  }

  const frequencyUnit = lower[frequency] && /khz/.test(lower[frequency]) ? 'kHz' : 'Hz';
  const magnitudeUnit = lower[magnitude] && /linear|ratio/.test(lower[magnitude]) ? 'linear' : 'dB';
  const phaseUnit = lower[phase] && /\brad/.test(lower[phase]) ? 'rad' : 'deg';

  return {
    frequency,
    magnitude,
    phase,
    coherence,
    frequencyUnit,
    magnitudeUnit,
    phaseUnit,
    delimiter: null,
  };
}

export const DEFAULT_MAPPING = {
  frequency: 0,
  magnitude: 1,
  phase: -1,
  coherence: -1,
  frequencyUnit: 'Hz',
  magnitudeUnit: 'dB',
  phaseUnit: 'deg',
};

/**
 * Read a frequency-response file into band data.
 *
 * The mapping can be overridden for a file whose columns are laid out
 * differently. A file is refused as a whole — with a message saying why — when
 * it is not a response at all, and missing phase is never invented: with no
 * phase column the response stays magnitude-only.
 */
export function parseResponseText(text, options = {}) {
  const described = describeResponseText(text);
  if (!described.ok) return described;

  const mapping = {
    ...DEFAULT_MAPPING,
    ...(described.mapping || {}),
    ...(options.mapping || {}),
  };
  if (options.delimiter) mapping.delimiter = options.delimiter;

  const delimiter = mapping.delimiter || described.delimiter;
  const labels = described.labels;
  const columnCount = labels.length;

  const frequencyColumn = Number(mapping.frequency);
  const magnitudeColumn = Number(mapping.magnitude);
  const phaseColumn = Number(mapping.phase);
  const coherenceColumn = Number(mapping.coherence);

  for (const [name, column] of [
    ['frequency', frequencyColumn],
    ['magnitude', magnitudeColumn],
    ['phase', phaseColumn],
    ['coherence', coherenceColumn],
  ]) {
    if (!Number.isInteger(column) || column < -1 || column >= columnCount) {
      return { ok: false, message: 'The ' + name + ' column is not one of the columns in that file.' };
    }
  }
  if (frequencyColumn < 0 || magnitudeColumn < 0 || frequencyColumn === magnitudeColumn) {
    return { ok: false, message: 'A response needs one frequency column and one level column.' };
  }

  const rows = delimiter && delimiter !== described.delimiter
    ? Array.from(text.split(/\r?\n/), (line) => {
        if (!line || !line.trim() || COMMENT_LINE.test(line)) return null;
        const tokens = splitTokens(line, delimiter).map(normaliseLabel);
        return tokens.filter(isNumberToken).length >= 2 ? tokens : null;
      }).filter(Boolean)
    : described.rows;

  const frequencyScale = mapping.frequencyUnit === 'kHz' ? 1000 : 1;
  const magnitudeLog = mapping.magnitudeUnit === 'linear';
  const phaseRadians = mapping.phaseUnit === 'rad';

  const entries = [];
  let refusedRows = 0;
  let withPhase = 0;
  let withCoherence = 0;

  for (const row of rows) {
    const f = numberOf(row[frequencyColumn]) * frequencyScale;
    const rawMagnitude = numberOf(row[magnitudeColumn]);
    if (!(f > 0) || !Number.isFinite(rawMagnitude)) { refusedRows += 1; continue; }
    const magnitude = magnitudeLog ? (rawMagnitude > 0 ? 20 * Math.log10(rawMagnitude) : -120) : rawMagnitude;

    let phase = null;
    if (phaseColumn >= 0) {
      const value = numberOf(row[phaseColumn]);
      if (Number.isFinite(value)) {
        phase = phaseRadians ? (value * 180) / Math.PI : value;
        withPhase += 1;
      }
    }

    let coherence = null;
    if (coherenceColumn >= 0) {
      const value = numberOf(row[coherenceColumn]);
      if (Number.isFinite(value)) {
        coherence = Math.max(0, Math.min(1, value > 1 ? value / 100 : value));
        withCoherence += 1;
      }
    }

    entries.push({ f, magnitude, phase, coherence });
  }

  if (entries.length < 8) {
    return {
      ok: false,
      message: 'That file holds ' + entries.length + ' usable rows — a response needs at least eight.',
    };
  }

  // Sorted ascending, duplicates dropped, so interpolation is well defined.
  entries.sort((a, b) => a.f - b.f);
  const unique = [];
  let duplicates = 0;
  for (const entry of entries) {
    const previous = unique[unique.length - 1];
    if (previous && Math.abs(previous.f - entry.f) <= Math.abs(entry.f) * 1e-9) {
      duplicates += 1;
      continue;
    }
    unique.push(entry);
  }

  const phaseCapable = phaseColumn >= 0 && withPhase === entries.length;
  const coherenceCapable = coherenceColumn >= 0 && withCoherence >= entries.length * 0.8;

  const response = {
    frequencies: unique.map((entry) => entry.f),
    magDb: unique.map((entry) => entry.magnitude),
    phaseDeg: phaseCapable ? unique.map((entry) => entry.phase) : null,
    coherence: coherenceCapable ? unique.map((entry) => entry.coherence) : null,
    fMin: unique[0].f,
    fMax: unique[unique.length - 1].f,
    points: unique.length,
    labels,
  };

  const notes = [];
  if (duplicates) notes.push(duplicates + ' duplicate frequency rows were dropped');
  if (refusedRows) notes.push(refusedRows + ' rows could not be read');
  if (phaseColumn >= 0 && !phaseCapable) {
    notes.push('the phase column was incomplete, so no phase was taken');
  }

  return {
    ok: true,
    message: notes.join(' · '),
    response,
    mapping,
    labels,
    delimiter,
    points: unique.length,
    rangeText: formatRangeText(response.fMin, response.fMax),
  };
}

/** One frequency, short: 63 Hz, 1.6 kHz, 20 kHz. */
export function formatFrequency(frequency) {
  const f = Number(frequency);
  if (!Number.isFinite(f)) return '—';
  if (f >= 1000) {
    const k = f / 1000;
    return (k >= 10 ? k.toFixed(1) : k.toFixed(k >= 2 ? 1 : 2)).replace(/\.0+$/, '') + ' kHz';
  }
  return (f >= 100 ? f.toFixed(0) : f.toFixed(f >= 20 ? 0 : 1)) + ' Hz';
}

export function formatRangeText(min, max) {
  return formatFrequency(min) + ' – ' + formatFrequency(max);
}

/** One delay, in milliseconds or microseconds, with the path length it means. */
export function formatDelay(ms) {
  const value = Number(ms) || 0;
  if (Math.abs(value) < 0.1) return (value * 1000).toFixed(1) + ' µs';
  if (Math.abs(value) < 10) return value.toFixed(2) + ' ms';
  return value.toFixed(1) + ' ms';
}

export function pathLengthMm(ms) {
  return (Number(ms) || 0) * SPEED_OF_SOUND;
}
