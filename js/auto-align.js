/*
 * Automatic loudspeaker alignment from measured complex transfer functions.
 *
 * Everything here works on what was actually measured: each curve's magnitude,
 * its phase, its coherence and its impulse arrival. The two curves are summed as
 * complex numbers — never as decibels — so a delay rotates one curve's phase at
 * every frequency and the sum shows the interference that rotation produces.
 *
 * The curves keep the timing reference they were captured with. The engine never
 * removes each measurement's propagation delay on its own: if that were done
 * twice, the relative arrival the alignment is computed from would be destroyed.
 *
 * The engine optimises across the pair's acoustic overlap band rather than at
 * one frequency, weights every bin by its coherence so an unreliable bin cannot
 * decide the answer, and refuses to report an alignment when the data cannot
 * support one.
 *
 * It is pure: no DOM, no audio, no storage. Nothing here touches the running
 * measurement, the gate, the captures or a processor.
 */

import { biquadResponse } from './modeler/filters.js';

export const COHERENCE_FLOOR = 0.35;
export const ALIGN_POINTS = 512;
export const LOWEST_HZ = 20;
export const HIGHEST_HZ = 20000;

export const ALIGN_MODES = [
  { id: 'mainSub', label: 'Main to subwoofer', hint: 'aligns a main into the subwoofer’s overlap' },
  { id: 'subSub', label: 'Subwoofer to subwoofer', hint: 'aligns two cabinets in the same pass band' },
  { id: 'mainMain', label: 'Main to main', hint: 'aligns two mains across their overlap' },
  { id: 'mainDelay', label: 'Main to delay speaker', hint: 'allows a deliberate arrival offset' },
  { id: 'mainFill', label: 'Main to fill speaker', hint: 'aligns a fill into the main’s coverage' },
  { id: 'multiple', label: 'Multiple loudspeakers', hint: 'aligns each target to one reference in turn' },
  { id: 'multiMic', label: 'Multi-microphone', hint: 'one alignment that serves every position' },
];

export const ALIGN_LEVELS = [
  { id: 'quick', label: 'Quick align', hint: 'delay and polarity only' },
  { id: 'advanced', label: 'Advanced align', hint: 'delay, polarity and all-pass filters' },
  { id: 'custom', label: 'Custom align', hint: 'your own limits and priorities' },
];

/** Delay resolutions offered, in milliseconds, from finest to coarsest. */
export const RESOLUTIONS = [0.01, 0.02, 0.05, 0.1, 0.125, 0.25, 0.5, 1];

const USABLE_COHERENCE = 0.8;
const NULL_CLAMP_DB = 60;
const RIPPLE_WEIGHT = 0.25;
const SPEED_OF_SOUND = 343;

function clamp(value, low, high, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(high, Math.max(low, number));
}

function wrapDegrees(value) {
  let degrees = value % 360;
  if (degrees > 180) degrees -= 360;
  if (degrees <= -180) degrees += 360;
  return degrees;
}

function fail(message) {
  return { ok: false, message, warnings: [] };
}

/** The frequency of one point on a logarithmic grid. */
export function gridFrequencies(count, low = LOWEST_HZ, high = HIGHEST_HZ) {
  const n = Math.max(2, Math.floor(Number(count) || 2));
  const a = Math.log(clamp(low, 0.1, 100000, LOWEST_HZ));
  const b = Math.log(clamp(high, 0.2, 100000, HIGHEST_HZ));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    out[i] = Math.exp(a + (b - a) * t);
  }
  return out;
}

 /**
 * A measured curve, normalised for the engine. Accepts three shapes:
 *
 *   { frequencies, magDb, phaseDeg, coherence }   a curve with its own axis
 *   { magDb, fftSize, sampleRate, phaseDeg, coh } an analyser result
 *   { curve, phase, phaseCoherence }              a saved library entry
 *
 * A curve without finite phase is returned with `phaseValid: false`: its phase
 * is never invented as zero, because a made-up phase would produce an alignment
 * answer that no measurement supports.
 */
export function alignTrace(raw) {
  const source = raw && typeof raw === 'object' ? raw : null;
  if (!source) return null;

  let frequencies = null;
  let magDb = null;
  let phaseDeg = null;
  let coherence = null;
  let sampleRate = Number(source.sampleRate) > 0 ? Number(source.sampleRate) : 0;

  if (Array.isArray(source.frequencies) || ArrayBuffer.isView(source.frequencies)) {
    if (!Array.isArray(source.magDb) && !ArrayBuffer.isView(source.magDb)) return null;
    const count = Math.min(source.frequencies.length, source.magDb.length);
    if (count < 8) return null;
    frequencies = new Float64Array(count);
    magDb = new Float64Array(count);
    for (let i = 0; i < count; i += 1) {
      frequencies[i] = Number(source.frequencies[i]);
      magDb[i] = Number(source.magDb[i]);
    }
    if (Array.isArray(source.phaseDeg) || ArrayBuffer.isView(source.phaseDeg)) {
      if (source.phaseDeg.length >= count) {
        phaseDeg = new Float64Array(count);
        for (let i = 0; i < count; i += 1) phaseDeg[i] = Number(source.phaseDeg[i]);
      }
    }
    if (Array.isArray(source.coherence) || ArrayBuffer.isView(source.coherence)) {
      if (source.coherence.length >= count) {
        coherence = new Float64Array(count);
        for (let i = 0; i < count; i += 1) coherence[i] = Number(source.coherence[i]);
      }
    }
  } else if (Array.isArray(source.magDb) || ArrayBuffer.isView(source.magDb)) {
    const fftSize = Number(source.fftSize);
    const rate = Number(source.sampleRate);
    if (!(fftSize > 0) || !(rate > 0)) return null;
    const df = rate / fftSize;
    const bins = source.magDb.length;
    const kept = [];
    for (let k = 1; k < bins; k += 1) {
      const frequency = k * df;
      if (frequency > Math.min(HIGHEST_HZ * 1.5, rate / 2)) continue;
      kept.push(k);
    }
    if (kept.length < 8) return null;
    frequencies = new Float64Array(kept.length);
    magDb = new Float64Array(kept.length);
    const phaseSource = Array.isArray(source.phaseDeg) || ArrayBuffer.isView(source.phaseDeg)
      ? source.phaseDeg
      : null;
    const coherenceSource = Array.isArray(source.coh) || ArrayBuffer.isView(source.coh)
      ? source.coh
      : Array.isArray(source.phaseCoherence) && source.phaseCoherence.length >= bins
        ? source.phaseCoherence
        : null;
    if (phaseSource) phaseDeg = new Float64Array(kept.length);
    if (coherenceSource) coherence = new Float64Array(kept.length);
    for (let i = 0; i < kept.length; i += 1) {
      const k = kept[i];
      frequencies[i] = k * df;
      magDb[i] = Number(source.magDb[k]);
      if (phaseDeg) phaseDeg[i] = Number(phaseSource[k]);
      if (coherence) coherence[i] = Number(coherenceSource[k]);
    }
  } else if (Array.isArray(source.curve) || ArrayBuffer.isView(source.curve)) {
    const count = source.curve.length;
    if (count < 8) return null;
    frequencies = gridFrequencies(count);
    magDb = new Float64Array(count);
    for (let i = 0; i < count; i += 1) magDb[i] = Number(source.curve[i]);
    if (Array.isArray(source.phase) && source.phase.length === count) {
      phaseDeg = new Float64Array(count);
      for (let i = 0; i < count; i += 1) phaseDeg[i] = Number(source.phase[i]);
    }
    if (Array.isArray(source.phaseCoherence) && source.phaseCoherence.length === count) {
      coherence = new Float64Array(count);
      for (let i = 0; i < count; i += 1) coherence[i] = Number(source.phaseCoherence[i]);
    }
    if (!sampleRate) sampleRate = Number(source.sampleRate) > 0 ? Number(source.sampleRate) : 0;
  } else {
    return null;
  }

  // Ascending, finite, and inside the audible range.
  const rows = [];
  for (let i = 0; i < frequencies.length; i += 1) {
    const f = frequencies[i];
    const m = magDb[i];
    if (!(f > 0) || !Number.isFinite(f) || !Number.isFinite(m)) continue;
    rows.push({
      f,
      m,
      p: phaseDeg ? phaseDeg[i] : null,
      c: coherence ? coherence[i] : null,
    });
  }
  if (rows.length < 8) return null;
  rows.sort((left, right) => left.f - right.f);
  const unique = [];
  for (const row of rows) {
    if (unique.length && Math.abs(row.f - unique[unique.length - 1].f) < row.f * 1e-9) continue;
    unique.push(row);
  }
  if (unique.length < 8) return null;

  const fMin = Math.max(LOWEST_HZ, unique[0].f);
  const fMax = Math.min(HIGHEST_HZ, unique[unique.length - 1].f);
  if (!(fMax > fMin * 1.05)) return null;

  const out = {
    label: typeof source.label === 'string' && source.label ? source.label.slice(0, 80) : 'Curve',
    frequencies: new Float64Array(unique.length),
    magDb: new Float64Array(unique.length),
    phaseDeg: null,
    coherence: null,
    fMin,
    fMax,
    points: unique.length,
    sampleRate,
    delayMs: Number(source.delayMs) || 0,
    phaseCompensated: source.phaseCompensated === true,
  };

  let hasPhase = !!phaseDeg;
  let hasCoherence = !!coherence;
  if (hasPhase) out.phaseDeg = new Float64Array(unique.length);
  if (hasCoherence) out.coherence = new Float64Array(unique.length);

  for (let i = 0; i < unique.length; i += 1) {
    const row = unique[i];
    out.frequencies[i] = row.f;
    out.magDb[i] = row.m;
    if (hasPhase) {
      if (row.p === null || !Number.isFinite(row.p)) hasPhase = false;
      else out.phaseDeg[i] = row.p;
    }
    if (hasCoherence) {
      if (row.c === null || !Number.isFinite(row.c)) hasCoherence = false;
      else out.coherence[i] = Math.max(0, Math.min(1, row.c));
    }
  }

  if (!hasPhase) out.phaseDeg = null;
  if (!hasCoherence) out.coherence = null;
  out.phaseValid = hasPhase;
  out.coherenceValid = hasCoherence;
  return out;
}

/** A curve read back from one of the analyser's own results. */
export function traceFromAnalyser(results, label) {
  if (!results || !results.magDb) return null;
  return alignTrace({
    magDb: results.magDb,
    phaseDeg: results.phaseDeg,
    coh: results.coh,
    fftSize: results.fftSize,
    sampleRate: results.sampleRate,
    label: label || 'Measurement',
  });
}

/** The two curves on one logarithmic axis, the span both of them cover. */
export function commonAxis(a, b) {
  if (!a || !b) return null;
  const low = Math.max(LOWEST_HZ, a.fMin, b.fMin);
  const high = Math.min(HIGHEST_HZ, a.fMax, b.fMax);
  if (!(high > low * 1.05)) return null;
  return { low, high, frequencies: gridFrequencies(ALIGN_POINTS, low, high) };
}

/**
 * One point off a curve's own grid, interpolated in the complex domain so a
 * phase that wraps between two stored bins is not read as a 350° step.
 */
function sampleCurve(trace, frequency) {
  const grid = trace.frequencies;
  const last = grid.length - 1;
  const edge = edgeTolerance(grid[last]);
  if (frequency < grid[0] - edge || frequency > grid[last] + edge) return null;

  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (grid[mid] <= frequency) lo = mid;
    else hi = mid;
  }
  const f0 = grid[lo];
  const f1 = grid[hi];
  const t = f1 > f0 ? Math.min(1, Math.max(0, (frequency - f0) / (f1 - f0))) : 0;

  const m0 = Math.pow(10, trace.magDb[lo] / 20);
  const m1 = Math.pow(10, trace.magDb[hi] / 20);
  const p0 = trace.phaseDeg ? (trace.phaseDeg[lo] * Math.PI) / 180 : 0;
  const p1 = trace.phaseDeg ? (trace.phaseDeg[hi] * Math.PI) / 180 : 0;

  const re = m0 * Math.cos(p0) * (1 - t) + m1 * Math.cos(p1) * t;
  const im = m0 * Math.sin(p0) * (1 - t) + m1 * Math.sin(p1) * t;
  const magnitude = Math.hypot(re, im);

  let coherence = null;
  if (trace.coherence) coherence = trace.coherence[lo] * (1 - t) + trace.coherence[hi] * t;

  return {
    magDb: magnitude > 0 ? 20 * Math.log10(magnitude) : -240,
    phaseRad: Math.atan2(im, re),
    magnitude,
    coherence,
  };
}

function edgeTolerance(frequency) {
  return Math.max(1e-9, Math.abs(frequency) * 1e-6);
}

/** Both curves as complex spectra on the shared axis, with a combined weight. */
function buildContext(reference, target, axis) {
  const count = axis.frequencies.length;
  const aRe = new Float64Array(count);
  const aIm = new Float64Array(count);
  const bRe = new Float64Array(count);
  const bIm = new Float64Array(count);
  const aPower = new Float64Array(count);
  const bPower = new Float64Array(count);
  const weights = new Float64Array(count);
  const coherence = new Float64Array(count);
  const aDb = new Float64Array(count);
  const bDb = new Float64Array(count);

  for (let i = 0; i < count; i += 1) {
    const frequency = axis.frequencies[i];
    const a = sampleCurve(reference, frequency);
    const b = sampleCurve(target, frequency);
    aDb[i] = NaN;
    bDb[i] = NaN;
    coherence[i] = NaN;
    if (!a || !b) continue;

    aDb[i] = a.magDb;
    bDb[i] = b.magDb;
    aRe[i] = a.magnitude * Math.cos(a.phaseRad);
    aIm[i] = a.magnitude * Math.sin(a.phaseRad);
    bRe[i] = b.magnitude * Math.cos(b.phaseRad);
    bIm[i] = b.magnitude * Math.sin(b.phaseRad);

    aPower[i] = a.magnitude * a.magnitude;
    bPower[i] = b.magnitude * b.magnitude;

    // Coherence decides how much a bin may weigh: below the floor the bin is
    // left out entirely rather than trusted a little.
    const c = a.coherence === null || b.coherence === null
      ? null
      : Math.min(a.coherence, b.coherence);
    if (c !== null) coherence[i] = c;
    if (c === null) {
      weights[i] = 1;
    } else if (c <= COHERENCE_FLOOR) {
      weights[i] = 0;
    } else {
      weights[i] = Math.min(1, (c - COHERENCE_FLOOR) / (USABLE_COHERENCE - COHERENCE_FLOOR));
    }
    if (!(aPower[i] + bPower[i] > 1e-22)) weights[i] = 0;
  }

  return { frequencies: axis.frequencies, aRe, aIm, bRe, bIm, aPower, bPower, weights, coherence, aDb, bDb };
}

/**
 * The band the pair is aligned over.
 *
 * Automatic detection looks for the acoustic crossover — the place the two
 * measured magnitude curves are level while both are still strong — and takes
 * the overlap around it, so a main crossed over at 80 Hz is aligned across the
 * octave around 80 Hz rather than at 80 Hz exactly. A pair that never crosses
 * inside its usable range is aligned over the whole range both of them cover.
 */
export function detectBand(context, options = {}) {
  const opts = options || {};
  const frequencies = context.frequencies;
  const count = frequencies.length;
  if (!count) return null;

  let loudest = -Infinity;
  for (let i = 0; i < count; i += 1) {
    if (!(context.weights[i] > 0)) continue;
    loudest = Math.max(loudest, context.aDb[i], context.bDb[i]);
  }
  if (!Number.isFinite(loudest)) return null;

  let usableLow = Infinity;
  let usableHigh = -Infinity;
  for (let i = 0; i < count; i += 1) {
    if (!(context.weights[i] > 0)) continue;
    usableLow = Math.min(usableLow, frequencies[i]);
    usableHigh = Math.max(usableHigh, frequencies[i]);
  }
  if (!(usableHigh > usableLow * 1.05)) return null;

  const window = clamp(opts.detectWindowDb, 6, 40, 18);

  // Crossings of the two magnitude curves, where both are within the window of
  // the loudest point either curve reaches in the pair.
  let bestCrossing = null;
  let bestLevel = -Infinity;
  for (let i = 1; i < count; i += 1) {
    if (!(context.weights[i] > 0) || !(context.weights[i - 1] > 0)) continue;
    const d0 = context.aDb[i - 1] - context.bDb[i - 1];
    const d1 = context.aDb[i] - context.bDb[i];
    // A real crossover changes sign sharply; two curves a float apart must not
    // be read as a crossover at the first bin.
    if (!(Math.abs(d0) > 0.05) || !(Math.abs(d1) > 0.05)) continue;
    if (!(d0 * d1 < 0)) continue;
    const t = d0 === d1 ? 0 : d0 / (d0 - d1);
    const f0 = Math.log(frequencies[i - 1]);
    const f1 = Math.log(frequencies[i]);
    const frequency = Math.exp(f0 + (f1 - f0) * Math.min(1, Math.max(0, t)));
    const level = Math.min(context.aDb[i - 1], context.bDb[i - 1]);
    if (level < loudest - window) continue;
    if (level > bestLevel) {
      bestLevel = level;
      bestCrossing = frequency;
    }
  }

  const span = clamp(opts.spanOctaves, 0.25, 4, 1);
  let focus;
  let detected;
  let minHz;
  let maxHz;

  if (bestCrossing && bestCrossing > usableLow && bestCrossing < usableHigh) {
    focus = bestCrossing;
    detected = 'crossing';
    minHz = Math.max(usableLow, focus / Math.pow(2, span / 2));
    maxHz = Math.min(usableHigh, focus * Math.pow(2, span / 2));
  } else {
    // No crossing: the pair is strong together over a range, and that range is
    // the overlap. A flat pair offers the whole span both curves cover.
    let bestTogether = -Infinity;
    for (let i = 0; i < count; i += 1) {
      if (!(context.weights[i] > 0)) continue;
      const together = Math.min(context.aDb[i], context.bDb[i]);
      if (together > bestTogether) {
        bestTogether = together;
        focus = frequencies[i];
      }
    }
    if (!Number.isFinite(focus)) return null;
    detected = 'overlap';
    minHz = usableLow;
    maxHz = usableHigh;
  }

  if (opts.manual === true) {
    const low = clamp(opts.minHz, LOWEST_HZ, HIGHEST_HZ, minHz);
    const high = clamp(opts.maxHz, LOWEST_HZ, HIGHEST_HZ, maxHz);
    if (!(high > low * 1.02)) {
      return {
        ok: false,
        message: 'The chosen range needs a low frequency below the high one, at least a quarter of an octave apart.',
      };
    }
    minHz = low;
    maxHz = high;
    detected = 'manual';
    // A range given by hand is centred on its own geometric middle, not on a
    // crossing the operator has just overridden.
    focus = Math.sqrt(low * high);
  } else if (!(maxHz > minHz * 1.02)) {
    // A quarter of an octave either way, so the answer is never a single bin.
    const mid = Math.sqrt(Math.max(1, minHz) * Math.max(2, maxHz));
    minHz = Math.max(usableLow, mid / Math.pow(2, 1 / 8));
    maxHz = Math.min(usableHigh, mid * Math.pow(2, 1 / 8));
  }

  return {
    ok: true,
    message: '',
    detected,
    minHz,
    maxHz,
    focusHz: Number.isFinite(focus) ? focus : Math.sqrt(minHz * maxHz),
    crossingHz: bestCrossing,
    octaves: Math.log2(maxHz / minHz),
    spanOctaves: span,
  };
}

/** The complex multiplier of an all-pass chain, one unit amount per bin. */
function allPassMultiplier(allPass, frequencies, sampleRate) {
  const chain = (allPass || []).filter((entry) => entry && entry.frequency > 0);
  if (!chain.length) return null;
  const count = frequencies.length;
  const re = new Float64Array(count);
  const im = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    re[i] = 1;
    im[i] = 0;
  }
  for (const entry of chain) {
    const filter = {
      kind: entry.order === 1 ? 'allPass1' : 'allPass2',
      frequency: entry.frequency,
      q: entry.order === 1 ? 0.7071 : clamp(entry.q, 0.3, 10, 0.7071),
      gainDb: 0,
    };
    for (let i = 0; i < count; i += 1) {
      const response = biquadResponse(filter, frequencies[i], sampleRate);
      const cosine = Math.cos(response.phaseRad);
      const sine = Math.sin(response.phaseRad);
      const nextRe = re[i] * cosine - im[i] * sine;
      const nextIm = re[i] * sine + im[i] * cosine;
      re[i] = nextRe;
      im[i] = nextIm;
    }
  }
  return { re, im };
}

/** The indices of the shared axis inside the band that carry enough trust. */
function bandIndices(context, band) {
  const indices = [];
  for (let i = 0; i < context.frequencies.length; i += 1) {
    const frequency = context.frequencies[i];
    if (frequency < band.minHz || frequency > band.maxHz) continue;
    if (!(context.weights[i] > 0)) continue;
    if (!Number.isFinite(context.aRe[i]) || !Number.isFinite(context.bRe[i])) continue;
    indices.push(i);
  }
  return indices;
}

/**
 * How one arrangement would sum, over the band only.
 *
 * `delayMs` delays the target; `inverted` flips its polarity; `gainDb` moves
 * its level; `allPass` is the chain in front of it. The every-bin figure is the
 * level the pair would reach against the louder of the two alone, so a gain
 * change cannot pass itself off as alignment.
 */
function evaluate(context, settings, prepared) {
  const indices = prepared.indices;
  const scale = Math.pow(10, (Number(settings.gainDb) || 0) / 20) *
    (settings.inverted ? -1 : 1);
  const delaySeconds = (Number(settings.delayMs) || 0) / 1000;
  const ap = prepared.ap;

  let weight = 0;
  let sum = 0;
  let sumSquared = 0;
  let worst = Infinity;
  let phaseSum = 0;
  let phaseWeight = 0;
  let best = -1;
  let bestGain = -Infinity;

  for (let k = 0; k < indices.length; k += 1) {
    const index = indices[k];
    const frequency = context.frequencies[index];
    const angle = -2 * Math.PI * frequency * delaySeconds;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    let bRe = context.bRe[index] * scale;
    let bIm = context.bIm[index] * scale;
    if (ap) {
      const apRe = ap.re[index];
      const apIm = ap.im[index];
      const rotatedRe = bRe * apRe - bIm * apIm;
      const rotatedIm = bRe * apIm + bIm * apRe;
      bRe = rotatedRe;
      bIm = rotatedIm;
    }
    const delayedRe = bRe * cos - bIm * sin;
    const delayedIm = bRe * sin + bIm * cos;

    const sumRe = context.aRe[index] + delayedRe;
    const sumIm = context.aIm[index] + delayedIm;
    const power = sumRe * sumRe + sumIm * sumIm;
    // What the same two signals would give with no correlation at all: their
    // powers added. The figure is how much more the pair sums than that, so a
    // gain change cannot pass itself off as alignment, and 0 dB means the pair
    // adds no more than two unrelated loudspeakers would.
    const incoherent = context.aPower[index] + context.bPower[index] * scale * scale;
    if (!(incoherent > 1e-22) || !(power >= 0)) continue;

    const gain = Math.max(-NULL_CLAMP_DB, Math.min(20, 10 * Math.log10(Math.max(power, 1e-24) / incoherent)));
    const w = context.weights[index];

    weight += w;
    sum += gain * w;
    sumSquared += gain * gain * w;
    if (gain < worst) worst = gain;
    if (gain > bestGain) {
      bestGain = gain;
      best = frequency;
    }

    // The phase disagreement the arrangement leaves behind, from the same
    // coherence-gated bins the summation figure uses.
    const aPhase = Math.atan2(context.aIm[index], context.aRe[index]);
    const bPhase = Math.atan2(delayedIm, delayedRe);
    phaseSum += Math.abs(wrapDegrees(((aPhase - bPhase) * 180) / Math.PI)) * w;
    phaseWeight += w;
  }

  if (!(weight > 0)) return null;

  const meanDb = sum / weight;
  const variance = Math.max(0, sumSquared / weight - meanDb * meanDb);
  const rippleDb = Math.sqrt(variance);
  return {
    delayMs: Number(settings.delayMs) || 0,
    inverted: !!settings.inverted,
    polarity: settings.inverted ? 'inverted' : 'normal',
    gainDb: Number(settings.gainDb) || 0,
    allPass: (settings.allPass || []).slice(),
    meanDb,
    rippleDb,
    worstDb: worst,
    bestDb: bestGain,
    bestHz: best,
    objective: meanDb - RIPPLE_WEIGHT * rippleDb,
    phaseErrorDeg: phaseWeight > 0 ? phaseSum / phaseWeight : NaN,
  };
}

/** Snap a delay onto the resolution the operator's processor works at. */
export function snapDelay(delayMs, resolutionMs) {
  const resolution = clamp(resolutionMs, 0.001, 1, 0.01);
  const value = Number(delayMs) || 0;
  const steps = Math.round(value / resolution);
  const snapped = steps * resolution;
  return {
    resolution,
    requestedMs: value,
    delayMs: Math.abs(snapped) < resolution / 2 ? 0 : snapped,
    lostMs: snapped - value,
  };
}

/**
 * The delay the two curves are apart, from the slope of their phase difference
 * against frequency. This is the relative arrival time the measurements carry,
 * and it is read from the whole overlap instead of one frequency: a broadband
 * pair's sum peak is far narrower than any delay grid, while its phase slope
 * gives the arrival in one step.
 *
 * A constant phase offset — a polarity inversion — does not change the slope,
 * so polarity is decided afterwards by the complex sum.
 */
function estimateDelayMs(context, indices) {
  let count = 0;
  let sumW = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  let previous = NaN;

  for (const index of indices) {
    const w = context.weights[index];
    if (!(w > 0)) continue;
    const aPhase = Math.atan2(context.aIm[index], context.aRe[index]);
    const bPhase = Math.atan2(context.bIm[index], context.bRe[index]);
    let delta = wrapAngle(bPhase - aPhase);
    if (Number.isFinite(previous)) {
      // Unwrap along the band: the difference is smooth, so the branch next to
      // its neighbour is the one that continues it.
      delta += 2 * Math.PI * Math.round((previous - delta) / (2 * Math.PI));
    }
    previous = delta;

    const x = context.frequencies[index];
    sumW += w;
    sumX += x * w;
    sumY += delta * w;
    sumXX += x * x * w;
    sumXY += x * delta * w;
    count += 1;
  }

  if (count < 8) return NaN;
  const denominator = sumW * sumXX - sumX * sumX;
  if (!(Math.abs(denominator) > 1e-9)) return NaN;
  const slope = (sumW * sumXY - sumX * sumY) / denominator;
  // The phase difference is -360° per frequency-second of arrival difference,
  // so the delay to add to the target is the slope against 2π.
  const delayMs = (slope / (2 * Math.PI)) * 1000;
  return Number.isFinite(delayMs) ? delayMs : NaN;
}

/** One coarse pass, then one fine pass around the arrival it estimates. */
function searchDelay(context, prepared, options, polarities, gainDb) {
  const low = Math.min(options.delayMin, options.delayMax);
  const high = Math.max(options.delayMin, options.delayMax);
  const coarse = clamp(options.coarseMs, 0.05, 2, 0.2);
  const fine = clamp(options.resolution, 0.01, 1, 0.01);
  const sweep = [];

  let best = null;
  let bestSettings = null;
  const consider = (settings) => {
    const evaluation = evaluate(context, settings, prepared);
    if (!evaluation) return;
    if (!best || evaluation.objective > best.objective) {
      best = evaluation;
      bestSettings = settings;
    }
  };

  const allPass = options.allPass || [];
  for (const inverted of polarities) {
    for (let delay = low; delay <= high + coarse / 2; delay += coarse) {
      const settings = { delayMs: delay, inverted, gainDb, allPass };
      const evaluation = evaluate(context, settings, prepared);
      if (!evaluation) continue;
      sweep.push({ delayMs: delay, polarity: evaluation.polarity, objective: evaluation.objective });
      if (!best || evaluation.objective > best.objective) {
        best = evaluation;
        bestSettings = settings;
      }
    }
  }

  // The centres the fine pass looks around: the arrival the phase slope gives
  // and the coarse winner, which is what a narrow band needs. The window is at
  // least half a millisecond wide, because a crossover pair's own phase varies
  // across the band and biases the slope a little.
  const centres = [];
  const estimated = estimateDelayMs(context, prepared.indices);
  if (Number.isFinite(estimated)) centres.push(clamp(estimated, low, high, 0));
  if (best) centres.push(best.delayMs);
  const span = Math.max(coarse, 0.5);
  for (const centre of centres) {
    const from = Math.max(low, centre - span);
    const to = Math.min(high, centre + span);
    for (const inverted of polarities) {
      for (let delay = from; delay <= to + fine / 2; delay += fine) {
        consider({ delayMs: delay, inverted, gainDb, allPass });
      }
    }
  }

  return best ? { best, settings: bestSettings, sweep, estimatedMs: estimated } : null;
}

/**
 * The best all-pass chain the pair can use.
 *
 * All-pass filters are only introduced when they gain something delay and
 * polarity cannot: each section must improve the summation by the margin, and
 * the chain stops at the count the operator allows. Every section costs latency
 * below its frequency, which is reported rather than hidden.
 */
function stageAllPass(context, prepared, options, seed) {
  const limit = clamp(options.maxAllPass, 0, 4, 2);
  const margin = clamp(options.allPassMarginDb, 0.1, 3, 0.35);
  if (!limit) return { settings: seed, added: 0 };

  let settings = { ...seed, allPass: (seed.allPass || []).slice() };
  let best = evaluate(context, settings, prepared);
  if (!best) return { settings: seed, added: 0 };

  const bandLow = Math.max(LOWEST_HZ, options.band.minHz / 2);
  const bandHigh = Math.min(HIGHEST_HZ, options.band.maxHz * 4);
  const sampleRate = options.sampleRate;

  let added = 0;
  for (let pass = 0; pass < limit; pass += 1) {
    const candidates = [];
    const firstSteps = 20;
    for (let k = 0; k <= firstSteps; k += 1) {
      const t = k / firstSteps;
      const frequency = Math.exp(Math.log(bandLow) + (Math.log(bandHigh) - Math.log(bandLow)) * t);
      candidates.push({ order: 1, frequency, q: 0.7071 });
    }
    const secondSteps = 16;
    const quality = [0.5, 0.7071, 1, 1.5, 2, 3, 4];
    for (let k = 0; k <= secondSteps; k += 1) {
      const t = k / secondSteps;
      const frequency = Math.exp(Math.log(bandLow) + (Math.log(bandHigh) - Math.log(bandLow)) * t);
      for (const q of quality) candidates.push({ order: 2, frequency, q });
    }

    let winner = null;
    for (const candidate of candidates) {
      const allPass = settings.allPass.concat([candidate]);
      const ap = allPassMultiplier(allPass, context.frequencies, sampleRate);
      const local = { ...prepared, ap };
      let localBest = null;
      for (let step = -8; step <= 8; step += 1) {
        const delay = settings.delayMs + step * 0.05;
        const trial = evaluate(context, { ...settings, delayMs: delay, allPass }, local);
        if (trial && (!localBest || trial.objective > localBest.objective)) localBest = trial;
      }
      if (localBest && (!winner || localBest.objective > winner.evaluation.objective)) {
        winner = { candidate, evaluation: localBest };
      }
    }

    if (!winner) break;

    // The coarse frequency grid can sit up to half a step off the frequency the
    // phase asks for, so the section is trimmed around the grid's own winner.
    const centreLog = Math.log(winner.candidate.frequency);
    const spread = winner.candidate.order === 1 ? 0.8 : 0.7;
    const trimmed = [];
    for (let k = 0; k <= 14; k += 1) {
      const frequency = Math.exp(centreLog + (k / 14 - 0.5) * 2 * spread * Math.LN2);
      if (!(frequency > LOWEST_HZ / 4) || !(frequency < HIGHEST_HZ * 2)) continue;
      const widths = winner.candidate.order === 1
        ? [0.7071]
        : [0.6, 0.8, 1, 1.25, 1.6].map((scale) => clamp(winner.candidate.q * scale, 0.3, 10, 0.7071));
      for (const q of widths) {
        trimmed.push({ order: winner.candidate.order, frequency, q });
      }
    }
    for (const candidate of trimmed) {
      const allPass = settings.allPass.concat([candidate]);
      const ap = allPassMultiplier(allPass, context.frequencies, sampleRate);
      const local = { ...prepared, ap };
      let localBest = null;
      for (let step = -8; step <= 8; step += 1) {
        const delay = settings.delayMs + step * 0.05;
        const trial = evaluate(context, { ...settings, delayMs: delay, allPass }, local);
        if (trial && (!localBest || trial.objective > localBest.objective)) localBest = trial;
      }
      if (localBest && localBest.objective > winner.evaluation.objective) {
        winner = { candidate, evaluation: localBest };
      }
    }

    if (!(winner.evaluation.objective >= best.objective + margin)) break;

    settings = {
      delayMs: winner.evaluation.delayMs,
      inverted: winner.evaluation.inverted,
      gainDb: winner.evaluation.gainDb,
      allPass: settings.allPass.concat([winner.candidate]),
    };
    const ap = allPassMultiplier(settings.allPass, context.frequencies, sampleRate);
    const refined = { ...prepared, ap };
    let fallback = winner.evaluation;
    for (let step = -12; step <= 12; step += 1) {
      const delay = winner.evaluation.delayMs + step * options.resolution;
      const trial = evaluate(context, { ...settings, delayMs: delay }, refined);
      if (trial && trial.objective > fallback.objective) {
        fallback = trial;
        settings.delayMs = delay;
      }
    }
    best = fallback;
    added += 1;
  }

  return { settings, best, added };
}

/** The extra group delay the all-pass chain costs, measured on the band. */
export function allPassLatencyMs(allPass, band, sampleRate) {
  const chain = (allPass || []).filter((entry) => entry && entry.frequency > 0);
  if (!chain.length) return 0;
  const rate = clamp(sampleRate, 8000, 384000, 48000);
  const from = Math.max(1, band ? band.minHz : LOWEST_HZ);
  const to = Math.max(from * 1.01, Math.min(HIGHEST_HZ, band && band.maxHz ? band.maxHz : HIGHEST_HZ));

  let worst = 0;
  for (const entry of chain) {
    const filter = {
      kind: entry.order === 1 ? 'allPass1' : 'allPass2',
      frequency: entry.frequency,
      q: entry.order === 1 ? 0.7071 : clamp(entry.q, 0.3, 10, 0.7071),
      gainDb: 0,
    };
    let most = 0;
    const steps = 48;
    for (let k = 0; k <= steps; k += 1) {
      const t = k / steps;
      const frequency = from * Math.pow(to / from, t);
      const at = biquadResponse(filter, frequency, rate).phaseRad;
      const next = frequency * Math.pow(to / from, 1 / (steps * 40));
      const after = biquadResponse(filter, next, rate).phaseRad;
      const omega = 2 * Math.PI * frequency / rate;
      const deltaOmega = 2 * Math.PI * next / rate - omega;
      if (!(Math.abs(deltaOmega) > 1e-12)) continue;
      const group = -wrapAngle(after - at) / deltaOmega / rate * 1000;
      if (group > most) most = group;
    }
    worst += most;
  }
  return worst;
}

function wrapAngle(value) {
  let angle = value % (2 * Math.PI);
  if (angle > Math.PI) angle -= 2 * Math.PI;
  if (angle <= -Math.PI) angle += 2 * Math.PI;
  return angle;
}

/** The predicted curves, one row per point of the shared axis. */
function buildPoints(context, previous, settings, prepared) {
  const ap = prepared.ap;
  const scale = Math.pow(10, (Number(settings.gainDb) || 0) / 20) * (settings.inverted ? -1 : 1);
  const previousScale = Math.pow(10, (Number(previous.gainDb) || 0) / 20) *
    (previous.inverted ? -1 : 1);
  const delaySeconds = (Number(settings.delayMs) || 0) / 1000;
  const previousSeconds = (Number(previous.delayMs) || 0) / 1000;

  const points = [];
  for (let i = 0; i < context.frequencies.length; i += 1) {
    const frequency = context.frequencies[i];
    if (!Number.isFinite(context.aRe[i]) || !Number.isFinite(context.bRe[i])) continue;

    const angle = -2 * Math.PI * frequency * delaySeconds;
    const previousAngle = -2 * Math.PI * frequency * previousSeconds;

    const shape = (sourceRe, sourceIm, gain, rotation) => {
      let re = sourceRe * gain;
      let im = sourceIm * gain;
      if (ap) {
        const rotatedRe = re * ap.re[i] - im * ap.im[i];
        const rotatedIm = re * ap.im[i] + im * ap.re[i];
        re = rotatedRe;
        im = rotatedIm;
      }
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      return { re: re * cos - im * sin, im: re * sin + im * cos };
    };

    const afterB = shape(context.bRe[i], context.bIm[i], scale, angle);
    const beforeB = shape(context.bRe[i], context.bIm[i], previousScale, previousAngle);

    const sumRe = context.aRe[i] + afterB.re;
    const sumIm = context.aIm[i] + afterB.im;
    const previousSumRe = context.aRe[i] + beforeB.re;
    const previousSumIm = context.aIm[i] + beforeB.im;
    const aPhase = (Math.atan2(context.aIm[i], context.aRe[i]) * 180) / Math.PI;

    points.push({
      frequency,
      aDb: context.aDb[i],
      bDb: context.bDb[i],
      aPhaseDeg: aPhase,
      bPhaseBeforeDeg: (Math.atan2(beforeB.im, beforeB.re) * 180) / Math.PI,
      bPhaseAfterDeg: (Math.atan2(afterB.im, afterB.re) * 180) / Math.PI,
      sumBeforeDb: 20 * Math.log10(Math.max(1e-12, Math.hypot(previousSumRe, previousSumIm))),
      sumAfterDb: 20 * Math.log10(Math.max(1e-12, Math.hypot(sumRe, sumIm))),
      sumBeforePhaseDeg: (Math.atan2(previousSumIm, previousSumRe) * 180) / Math.PI,
      sumAfterPhaseDeg: (Math.atan2(sumIm, sumRe) * 180) / Math.PI,
      coherence: Number.isFinite(context.coherence[i]) ? context.coherence[i] : null,
      weight: context.weights[i],
    });
  }
  return points;
}

/** The chain the engine finally chose, as settings a processor can read. */
function settingsOf(evaluation) {
  return {
    delayMs: evaluation.delayMs,
    inverted: evaluation.inverted,
    polarity: evaluation.polarity,
    gainDb: evaluation.gainDb,
    allPass: (evaluation.allPass || []).map((entry) => ({
      order: entry.order === 1 ? 1 : 2,
      frequency: entry.frequency,
      q: entry.order === 1 ? 0.7071 : clamp(entry.q, 0.3, 10, 0.7071),
    })),
  };
}

/**
 * The whole answer for one pair: the recommendation, the predicted result, the
 * figures before and after, the confidence and the sweep the chart draws.
 */
function finishPair(input) {
  const {
    reference, target, context, band, axes, search, previous, latency, level, mode,
    options, warnings, quality,
  } = input;

  const chosen = {
    ...search.settings,
    allPass: (search.settings.allPass || []).slice(),
  };
  const best = search.best;
  const after = evaluate(context, chosen, axes);

  // A negative delay would mean advancing the target, which no processor can
  // do. The same rotation is a positive delay on the other loudspeaker, because
  // delaying both curves by the same amount leaves their sum unchanged.
  const snapped = snapDelay(chosen.delayMs, options.resolutionMs);
  const requestedPositive = snapped.delayMs;
  const applyTo = requestedPositive >= 0 ? 'target' : 'reference';
  const delayMs = Math.abs(requestedPositive);

  const arrivalOffsetMs = clamp(options.arrivalOffsetMs, -20, 50, 0);
  const totalReferenceMs = applyTo === 'reference' ? delayMs : 0;
  const totalTargetMs = applyTo === 'target' ? delayMs + arrivalOffsetMs : arrivalOffsetMs;

  const finalSettings = {
    delayMs: applyTo === 'target' ? delayMs : -delayMs,
    inverted: chosen.inverted,
    gainDb: chosen.gainDb,
    allPass: chosen.allPass,
  };
  const finalEvaluation = evaluate(context, finalSettings, axes) || after || best;
  const points = buildPoints(context, previous, finalSettings, axes);

  const improvement = {
    summationDb: finalEvaluation.meanDb - previous.meanDb,
    objective: finalEvaluation.objective - previous.objective,
    worstDb: finalEvaluation.worstDb - previous.worstDb,
    phaseErrorDeg: Number.isFinite(previous.phaseErrorDeg) && Number.isFinite(finalEvaluation.phaseErrorDeg)
      ? previous.phaseErrorDeg - finalEvaluation.phaseErrorDeg
      : NaN,
  };

  const notes = warnings.slice();
  if (band.detected === 'overlap') {
    notes.push('No acoustic crossover was found inside the usable range, so the whole overlap both curves ' +
      'cover is used.');
  }
  if (Math.abs(snapped.lostMs) > 0) {
    notes.push('The delay is snapped to ' + snapped.resolution.toFixed(2) + ' ms, which moves it by ' +
      snapped.lostMs.toFixed(2) + ' ms.');
  }
  if (applyTo === 'reference') {
    notes.push('The target arrives later, so the delay belongs on the reference: ' + delayMs.toFixed(2) +
      ' ms on ' + reference.label + ', not a negative delay on ' + target.label + '.');
  }
  if (finalSettings.allPass.length && Number.isFinite(latency.maxAddedMs)) {
    notes.push('The all-pass chain adds up to ' + latency.maxAddedMs.toFixed(2) +
      ' ms of latency below ' + band.minHz.toFixed(0) + ' Hz; no delay or polarity alone gains the same.');
  }
  if (improvement.summationDb < 0.2) {
    notes.push('Delay and polarity already sum as well as they can here: the change is within a fifth of a dB.');
  }

  let confidence = quality.level;
  let confidenceNote = quality.note;
  if (confidence === 'good' && (improvement.summationDb < 0.2 || band.octaves < 0.4)) {
    confidence = 'limited';
    confidenceNote = band.octaves < 0.4
      ? 'The overlap is narrower than half an octave, so the answer rests on few bins.'
      : 'There is little to gain, so the answer mostly confirms what is already there.';
  }

  return {
    ok: true,
    message: '',
    level,
    mode,
    reference: { label: reference.label, points: reference.points, delayMs: reference.delayMs },
    target: { label: target.label, points: target.points, delayMs: target.delayMs },
    band,
    applyTo,
    delay: {
      ms: delayMs,
      resolutionMs: snapped.resolution,
      requestedMs: snapped.requestedMs,
      snappedMs: snapped.delayMs,
      lostMs: snapped.lostMs,
      pathMm: (delayMs / 1000) * SPEED_OF_SOUND * 1000,
      referenceMs: totalReferenceMs,
      targetMs: totalTargetMs,
      arrivalOffsetMs,
    },
    polarity: chosen.inverted ? 'inverted' : 'normal',
    gainDb: chosen.gainDb,
    allPass: settingsOf(finalEvaluation).allPass,
    latency: {
      maxAddedMs: latency.maxAddedMs,
      note: latency.maxAddedMs > 0
        ? 'The all-pass chain costs up to ' + latency.maxAddedMs.toFixed(2) +
          ' ms of group delay in the overlap; a section placed below the band costs more.'
        : 'No all-pass filter is used, so no latency is added.',
    },
    before: previous,
    after: finalEvaluation,
    improvement,
    confidence: { level: confidence, note: confidenceNote, ...quality },
    warnings: notes,
    points,
    sweep: search.sweep,
    complex: {
      frequencies: context.frequencies,
      aRe: context.aRe,
      aIm: context.aIm,
      bRe: context.bRe,
      bIm: context.bIm,
      weights: context.weights,
      coherence: context.coherence,
      band: { minHz: band.minHz, maxHz: band.maxHz },
      level,
      mode,
      sampleRate: options.sampleRate,
    },
  };
}

/** Settings a pair has as it stands, so the prediction can show it. */
function arrangementOf(options) {
  const delayMs = Number(options.currentDelayMs) || 0;
  const inverted = options.currentPolarity === 'inverted';
  return { delayMs, inverted, gainDb: 0, allPass: [] };
}

function optionsFor(options, band, sampleRate) {
  const maxDelayMs = clamp(options.maxDelayMs, 0.2, 40, 10);
  const resolution = clamp(options.resolutionMs, 0.01, 1, 0.01);
  return {
    delayMin: -maxDelayMs,
    delayMax: maxDelayMs,
    coarseMs: clamp(options.coarseMs, 0.05, 2, Math.max(0.1, Math.min(0.5, (2 * maxDelayMs) / 160))),
    resolution,
    maxAllPass: options.maxAllPass,
    allPassMarginDb: options.allPassMarginDb,
    band,
    sampleRate,
  };
}

function confidenceFor(context, indices, extra) {
  let coherenceSum = 0;
  let coherenceWeight = 0;
  for (const index of indices) {
    const value = context.coherence[index];
    if (!Number.isFinite(value)) continue;
    coherenceSum += value;
    coherenceWeight += 1;
  }
  const coherence = coherenceWeight > 0 ? coherenceSum / coherenceWeight : NaN;
  const coverage = indices.length / Math.max(1, context.frequencies.length);

  let level = 'good';
  let note = 'Both curves carry measured phase and usable coherence across the overlap.';
  if (!Number.isFinite(coherence)) {
    level = 'limited';
    note = 'One curve carries no coherence, so every bin weighs the same.';
  } else if (coherence < 0.6) {
    level = 'limited';
    note = 'The coherence in the overlap averages ' + Math.round(coherence * 100) +
      '%, so the answer rests on average data.';
  }
  if (coverage < 0.2) {
    level = 'limited';
    note = 'The overlap covers a small part of the measured range, so few bins decide the answer.';
  }
  return { level, note, coherence, coverage, ...extra };
}

/**
 * Align one target to one reference, or one arrangement to several measured
 * positions at once.
 *
 * `positions` (multi-microphone) takes several measured pairs and finds one
 * delay and one polarity that serve all of them, weighted, rather than a result
 * that is perfect at one seat and wrong at the others.
 */
export function autoAlign(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const level = ALIGN_LEVELS.some((entry) => entry.id === opts.level) ? opts.level : 'quick';
  const mode = ALIGN_MODES.some((entry) => entry.id === opts.mode) ? opts.mode : 'mainSub';
  const sampleRate = clamp(opts.sampleRate, 8000, 384000, 48000);
  const resolutionMs = clamp(opts.resolutionMs, 0.01, 1, 0.01);
  const allowGain = level === 'custom' && opts.allowGain === true;
  const allowAllPass = level !== 'quick' && opts.allowAllPass !== false;

  if (opts.clipped === true) {
    return fail('The input reached full scale, so this measurement cannot be aligned. Lower the source or ' +
      'the interface gain and capture both loudspeakers again.');
  }
  const snrDb = Number(opts.snrDb);
  if (Number.isFinite(snrDb) && snrDb < 10) {
    return fail('The measurement sits ' + snrDb.toFixed(0) + ' dB above the noise floor, which is too little ' +
      'to align from. Raise the level and capture again.');
  }

  const warnings = [];
  if (Number.isFinite(snrDb) && snrDb < 25) {
    warnings.push('The measurement is only ' + snrDb.toFixed(0) + ' dB above the noise floor.');
  }
  if (opts.phaseCompensated === true) {
    warnings.push('A curve was captured with phase compensation on: the relative arrival it carries is the ' +
      'compensated one, so recapture with it off for an arrival comparison.');
  }

  const positions = Array.isArray(opts.positions) ? opts.positions : null;
  if (positions && positions.length) {
    return autoAlignPositions(opts, positions, { level, mode, sampleRate, resolutionMs, warnings });
  }

  const reference = alignTrace(opts.reference);
  const target = alignTrace(opts.target);
  if (!reference || !target) {
    return fail('Auto align needs two measured curves with at least eight points each.');
  }
  if (opts.reference === opts.target) {
    return fail('Auto align needs two different loudspeakers, not one curve twice.');
  }
  if (!reference.phaseValid || !target.phaseValid) {
    return fail('Auto align needs measured phase on both curves: a magnitude-only capture cannot be ' +
      'aligned in time. Capture both loudspeakers with phase on.');
  }

  const axis = commonAxis(reference, target);
  if (!axis) return fail('The two curves share too little of the 20 Hz – 20 kHz range to be aligned.');
  const context = buildContext(reference, target, axis);

  const detected = detectBand(context, {
    manual: opts.range === 'manual',
    minHz: opts.minHz,
    maxHz: opts.maxHz,
    spanOctaves: opts.spanOctaves,
    detectWindowDb: opts.detectWindowDb,
  });
  if (!detected || detected.ok === false) {
    return fail((detected && detected.message) ||
      'No usable overlap was found: both curves are below the coherence floor where they meet.');
  }

  const indices = bandIndices(context, detected);
  if (indices.length < 12) {
    return fail('Only ' + indices.length + ' bins in the overlap carry usable coherence, which is too few to ' +
      'align from. Capture again with a cleaner measurement, or choose the range yourself.');
  }

  const quality = confidenceFor(context, indices, {});
  if (Number.isFinite(quality.coherence) && quality.coherence <= COHERENCE_FLOOR) {
    return fail('The coherence in the overlap averages ' + Math.round(quality.coherence * 100) +
      '%, below the ' + Math.round(COHERENCE_FLOOR * 100) + '% this engine trusts. Nothing is recommended.');
  }

  const searchOptions = optionsFor({ ...opts, resolutionMs }, detected, sampleRate);
  const polarities = opts.polarity === 'normal'
    ? [false]
    : opts.polarity === 'inverted'
      ? [true]
      : [false, true];

  const prepared = { indices, ap: null };
  const previous = evaluate(context, arrangementOf(opts), prepared);
  if (!previous) return fail('The overlap holds no level to sum, so nothing can be predicted.');

  const quickest = searchDelay(context, prepared, searchOptions, polarities, 0);
  if (!quickest) return fail('No arrangement inside the delay limits sums the pair at all.');

  let settings = quickest.settings;
  let best = quickest.best;

  if (allowAllPass) {
    const staged = stageAllPass(context, prepared, searchOptions, settings);
    settings = staged.settings;
    if (staged.best) best = staged.best;
  }

  if (allowGain) {
    const maxGainDb = clamp(opts.maxGainDb, 0.5, 12, 3);
    const ap = allPassMultiplier(settings.allPass, context.frequencies, sampleRate);
    const withAp = { ...prepared, ap };
    // Every gain is weighed and the best of them decides, so the first gain
    // that happens to clear the margin cannot win just by being scanned first.
    let winner = null;
    for (let gain = -maxGainDb; gain <= maxGainDb + 0.25; gain += 0.5) {
      if (Math.abs(gain) < 0.5) continue;
      for (let step = -6; step <= 6; step += 1) {
        const trialSettings = { ...settings, gainDb: gain, delayMs: settings.delayMs + step * resolutionMs };
        const trial = evaluate(context, trialSettings, withAp);
        if (!trial) continue;
        if (!winner || trial.objective > winner.evaluation.objective) {
          winner = { evaluation: trial, settings: trialSettings };
        }
      }
    }
    if (winner && winner.evaluation.objective >= best.objective + 0.25) {
      settings = winner.settings;
      best = winner.evaluation;
      warnings.push('A gain change of ' + settings.gainDb.toFixed(1) + ' dB on ' + target.label +
        ' sums better than delay and polarity alone; check the level was not the fault to begin with.');
    }
  }

  const ap = allPassMultiplier(settings.allPass, context.frequencies, sampleRate);
  const finalAxes = { ...prepared, ap };
  const latency = { maxAddedMs: allPassLatencyMs(settings.allPass, detected, sampleRate) };

  return finishPair({
    reference,
    target,
    context,
    band: detected,
    axes: finalAxes,
    search: { settings, best, sweep: quickest.sweep },
    previous,
    latency,
    level,
    mode,
    options: { ...searchOptions, resolutionMs, arrivalOffsetMs: opts.arrivalOffsetMs, sampleRate },
    warnings,
    quality,
  });
}

/**
 * One delay and one polarity that serve every measured position, weighted by
 * how much each position matters. It is a compromise across the seats, and the
 * result says so rather than reporting one seat as the room.
 */
function autoAlignPositions(options, positions, shared) {
  const pairs = [];
  positions.forEach((entry, index) => {
    if (!entry) return;
    const reference = alignTrace(entry.reference);
    const target = alignTrace(entry.target);
    if (!reference || !target) return;
    if (!reference.phaseValid || !target.phaseValid) return;
    const axis = commonAxis(reference, target);
    if (!axis) return;
    const context = buildContext(reference, target, axis);
    pairs.push({
      index,
      label: entry.label || 'Position ' + (index + 1),
      weight: Number(entry.weight) > 0 ? Number(entry.weight) : 1,
      reference,
      target,
      context,
    });
  });

  if (pairs.length < 2) {
    return fail('Multi-microphone alignment needs at least two positions where both loudspeakers carry ' +
      'measured phase.');
  }

  const first = pairs[0];
  const detected = detectBand(first.context, {
    manual: options.range === 'manual',
    minHz: options.minHz,
    maxHz: options.maxHz,
    spanOctaves: options.spanOctaves,
    detectWindowDb: options.detectWindowDb,
  });
  if (!detected || detected.ok === false) {
    return fail((detected && detected.message) || 'No usable overlap was found across the positions.');
  }

  const prepared = pairs.map((pair) => {
    const indices = bandIndices(pair.context, detected);
    const ap = allPassMultiplier([], pair.context.frequencies, shared.sampleRate);
    return { pair, indices, ap };
  });
  const usable = prepared.filter((entry) => entry.indices.length >= 12);
  if (usable.length < 2) {
    return fail('Fewer than two positions carry usable coherence in the overlap.');
  }

  const maxDelayMs = clamp(options.maxDelayMs, 0.2, 40, 10);
  const searchOptions = optionsFor(options, detected, shared.sampleRate);
  const polarities = options.polarity === 'normal'
    ? [false]
    : options.polarity === 'inverted'
      ? [true]
      : [false, true];

  const combined = (delayMs, inverted) => {
    let weight = 0;
    let objective = 0;
    let summation = 0;
    let phase = 0;
    let phaseWeight = 0;
    for (const entry of usable) {
      const evaluation = evaluate(entry.pair.context, {
        delayMs, inverted, gainDb: 0, allPass: [],
      }, { indices: entry.indices, ap: null });
      if (!evaluation) continue;
      objective += evaluation.objective * entry.pair.weight;
      summation += evaluation.meanDb * entry.pair.weight;
      if (Number.isFinite(evaluation.phaseErrorDeg)) {
        phase += evaluation.phaseErrorDeg * entry.pair.weight;
        phaseWeight += entry.pair.weight;
      }
      weight += entry.pair.weight;
    }
    if (!(weight > 0)) return null;
    return {
      objective: objective / weight,
      summationDb: summation / weight,
      phaseErrorDeg: phaseWeight > 0 ? phase / phaseWeight : NaN,
    };
  };

  const coarse = clamp(searchOptions.coarseMs, 0.05, 2, 0.2);
  let best = null;
  let bestDelay = 0;
  let bestInverted = false;
  const sweep = [];
  for (const inverted of polarities) {
    for (let delay = -maxDelayMs; delay <= maxDelayMs + coarse / 2; delay += coarse) {
      const value = combined(delay, inverted);
      if (!value) continue;
      sweep.push({ delayMs: delay, polarity: inverted ? 'inverted' : 'normal', objective: value.objective });
      if (!best || value.objective > best.objective) {
        best = value;
        bestDelay = delay;
        bestInverted = inverted;
      }
    }
  }
  if (!best) return fail('No arrangement inside the delay limits serves the positions at all.');

  const from = Math.max(-maxDelayMs, bestDelay - coarse);
  const to = Math.min(maxDelayMs, bestDelay + coarse);
  for (const inverted of [bestInverted]) {
    for (let delay = from; delay <= to + shared.resolutionMs / 2; delay += shared.resolutionMs) {
      const value = combined(delay, inverted);
      if (!value) continue;
      if (value.objective > best.objective) {
        best = value;
        bestDelay = delay;
      }
    }
  }

  const snapped = snapDelay(bestDelay, shared.resolutionMs);
  const applyTo = snapped.delayMs >= 0 ? 'target' : 'reference';
  const delayMs = Math.abs(snapped.delayMs);

  const perPosition = [];
  const points = [];
  let beforeSum = 0;
  let beforeWeight = 0;
  for (const entry of usable) {
    const before = evaluate(entry.pair.context, { delayMs: 0, inverted: false, gainDb: 0, allPass: [] },
      { indices: entry.indices, ap: null });
    const after = evaluate(entry.pair.context,
      { delayMs: snapped.delayMs, inverted: bestInverted, gainDb: 0, allPass: [] },
      { indices: entry.indices, ap: null });
    if (before && after) {
      beforeSum += before.meanDb * entry.pair.weight;
      beforeWeight += entry.pair.weight;
    }
    perPosition.push({
      label: entry.pair.label,
      weight: entry.pair.weight,
      summationDb: after ? after.meanDb : NaN,
      phaseErrorDeg: after ? after.phaseErrorDeg : NaN,
    });
  }

  const referenceContext = usable[0].pair.context;
  const settings = { delayMs: snapped.delayMs, inverted: bestInverted, gainDb: 0, allPass: [] };
  const entryPoints = buildPoints(referenceContext, { delayMs: 0, inverted: false, gainDb: 0, allPass: [] },
    settings, { indices: usable[0].indices, ap: null });
  points.push(...entryPoints);

  const beforeMean = beforeWeight > 0 ? beforeSum / beforeWeight : NaN;

  return {
    ok: true,
    message: '',
    level: shared.level,
    mode: 'multiMic',
    multiPosition: true,
    positions: perPosition,
    band: detected,
    applyTo,
    delay: {
      ms: delayMs,
      resolutionMs: snapped.resolution,
      requestedMs: snapped.requestedMs,
      snappedMs: snapped.delayMs,
      lostMs: snapped.lostMs,
      pathMm: (delayMs / 1000) * SPEED_OF_SOUND * 1000,
      referenceMs: applyTo === 'reference' ? delayMs : 0,
      targetMs: applyTo === 'target' ? delayMs : 0,
      arrivalOffsetMs: 0,
    },
    polarity: bestInverted ? 'inverted' : 'normal',
    gainDb: 0,
    allPass: [],
    latency: { maxAddedMs: 0, note: 'No all-pass filter is used across several positions.' },
    before: { meanDb: beforeMean, objective: beforeMean, phaseErrorDeg: NaN, worstDb: NaN },
    after: { meanDb: best.summationDb, objective: best.objective, phaseErrorDeg: best.phaseErrorDeg, worstDb: NaN },
    improvement: {
      summationDb: best.summationDb - beforeMean,
      objective: best.objective - beforeMean,
      worstDb: NaN,
      phaseErrorDeg: NaN,
    },
    confidence: {
      level: 'limited',
      note: 'One arrangement serves ' + perPosition.length + ' positions: it is the best compromise across ' +
        'the seats, not a perfect result at any one of them.',
      coherence: NaN,
      coverage: NaN,
      phaseKnown: true,
    },
    warnings: shared.warnings.concat([
      'Multi-microphone alignment finds one delay and one polarity for every position, weighted by each ' +
      'position’s importance. A single seat can be aligned better on its own.',
    ]),
    points,
    sweep,
    complex: {
      frequencies: referenceContext.frequencies,
      aRe: referenceContext.aRe,
      aIm: referenceContext.aIm,
      bRe: referenceContext.bRe,
      bIm: referenceContext.bIm,
      weights: referenceContext.weights,
      coherence: referenceContext.coherence,
      band: { minHz: detected.minHz, maxHz: detected.maxHz },
      level: shared.level,
      mode: 'multiMic',
      sampleRate: shared.sampleRate,
    },
  };
}

/** The predicted curves for an arrangement of a result, without re-searching. */
export function alignPoints(result, settings) {
  if (!result || !result.ok || !result.complex) return null;
  const next = settings || {
    delayMs: result.applyTo === 'target' ? result.delay.ms : -result.delay.ms,
    inverted: result.polarity === 'inverted',
    gainDb: result.gainDb,
    allPass: result.allPass,
  };
  const complex = result.complex;
  const indices = [];
  for (let i = 0; i < complex.frequencies.length; i += 1) {
    if (!Number.isFinite(complex.aRe[i]) || !Number.isFinite(complex.bRe[i])) continue;
    indices.push(i);
  }
  const context = {
    frequencies: complex.frequencies,
    aRe: complex.aRe,
    aIm: complex.aIm,
    bRe: complex.bRe,
    bIm: complex.bIm,
    base: new Float64Array(complex.frequencies.length),
    aPower: new Float64Array(complex.frequencies.length),
    bPower: new Float64Array(complex.frequencies.length),
    weights: complex.weights,
    coherence: complex.coherence,
    aDb: new Float64Array(complex.frequencies.length),
    bDb: new Float64Array(complex.frequencies.length),
  };
  for (let i = 0; i < context.frequencies.length; i += 1) {
    const aPower = complex.aRe[i] * complex.aRe[i] + complex.aIm[i] * complex.aIm[i];
    const bPower = complex.bRe[i] * complex.bRe[i] + complex.bIm[i] * complex.bIm[i];
    context.base[i] = Math.max(aPower, bPower);
    context.aPower[i] = aPower;
    context.bPower[i] = bPower;
    context.aDb[i] = 10 * Math.log10(Math.max(aPower, 1e-24));
    context.bDb[i] = 10 * Math.log10(Math.max(bPower, 1e-24));
  }
  const ap = allPassMultiplier(next.allPass, complex.frequencies, complex.sampleRate);
  const previous = { delayMs: 0, inverted: false, gainDb: 0, allPass: [] };
  const points = buildPoints(context, previous, next, { indices, ap });
  const evaluation = evaluate(context, next, { indices, ap });
  return { settings: next, points, evaluation };
}

/**
 * Compare what was measured with both loudspeakers running against what the
 * alignment predicted. The residual delay is where the measurement sits later
 * than the prediction, so the correction is a smaller delay, never a larger one
 * invented from a guess.
 */
export function verifyAlignment(result, measured, options = {}) {
  if (!result || !result.ok) return fail('Run the automatic alignment before verifying it.');
  if (!result.complex) return fail('That alignment carries no prediction to compare.');
  const trace = alignTrace(measured);
  if (!trace) return fail('The verification needs a measurement with at least eight usable points.');
  if (!trace.phaseValid) {
    return fail('The verification needs a measurement with phase, so the arrival can be compared.');
  }

  const complex = result.complex;
  const band = complex.band || (result.band && { minHz: result.band.minHz, maxHz: result.band.maxHz }) ||
    { minHz: LOWEST_HZ, maxHz: HIGHEST_HZ };
  const frequencies = complex.frequencies;
  const indices = [];

  const predictedRe = new Float64Array(frequencies.length);
  const predictedIm = new Float64Array(frequencies.length);
  const measuredRe = new Float64Array(frequencies.length);
  const measuredIm = new Float64Array(frequencies.length);
  const weights = new Float64Array(frequencies.length);

  const settings = result.applyTo === 'target'
    ? { delayMs: result.delay.ms, inverted: result.polarity === 'inverted', gainDb: result.gainDb, allPass: result.allPass }
    : { delayMs: -result.delay.ms, inverted: result.polarity === 'inverted', gainDb: result.gainDb, allPass: result.allPass };
  const ap = allPassMultiplier(settings.allPass, frequencies, complex.sampleRate || 48000);
  const scale = Math.pow(10, (settings.gainDb || 0) / 20) * (settings.inverted ? -1 : 1);
  const delaySeconds = settings.delayMs / 1000;

  for (let i = 0; i < frequencies.length; i += 1) {
    const frequency = frequencies[i];
    const sample = sampleCurve(trace, frequency);
    if (!sample) continue;
    const angle = -2 * Math.PI * frequency * delaySeconds;
    let bRe = complex.bRe[i] * scale;
    let bIm = complex.bIm[i] * scale;
    if (ap) {
      const rotatedRe = bRe * ap.re[i] - bIm * ap.im[i];
      const rotatedIm = bRe * ap.im[i] + bIm * ap.re[i];
      bRe = rotatedRe;
      bIm = rotatedIm;
    }
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    predictedRe[i] = complex.aRe[i] + (bRe * cos - bIm * sin);
    predictedIm[i] = complex.aIm[i] + (bRe * sin + bIm * cos);
    measuredRe[i] = sample.magnitude * Math.cos(sample.phaseRad);
    measuredIm[i] = sample.magnitude * Math.sin(sample.phaseRad);
    weights[i] = complex.weights[i];
    if (frequency < band.minHz || frequency > band.maxHz) continue;
    if (!(weights[i] > 0)) continue;
    if (!Number.isFinite(predictedRe[i]) || !Number.isFinite(measuredRe[i])) continue;
    indices.push(i);
  }

  if (indices.length < 12) {
    return fail('The verification measurement and the prediction share too few usable bins in the overlap.');
  }

  // The residual delay: how much later the measurement sits than the
  // prediction, from the correlation of the two complex sums.
  let residualMs = 0;
  let bestCorrelation = -Infinity;
  const steps = 400;
  const span = 2;
  for (let k = 0; k <= steps; k += 1) {
    const candidate = -span + (2 * span * k) / steps;
    const angle = -2 * Math.PI * candidate / 1000;
    let re = 0;
    let im = 0;
    let power = 0;
    for (const index of indices) {
      const frequency = frequencies[index];
      const rotation = angle * frequency;
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      const rotatedRe = predictedRe[index] * cos - predictedIm[index] * sin;
      const rotatedIm = predictedRe[index] * sin + predictedIm[index] * cos;
      // <rotated prediction, measurement>
      re += rotatedRe * measuredRe[index] + rotatedIm * measuredIm[index];
      im += rotatedIm * measuredRe[index] - rotatedRe * measuredIm[index];
      power += rotatedRe * rotatedRe + rotatedIm * rotatedIm;
    }
    if (!(power > 0)) continue;
    const correlation = Math.hypot(re, im) / Math.sqrt(power);
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      // The prediction must be delayed by this much to sit on the measurement,
      // so the measurement is already that much later.
      residualMs = candidate;
    }
  }

  const deviations = [];
  let weight = 0;
  let sumSquared = 0;
  let worst = 0;
  let levelSum = 0;
  for (const index of indices) {
    const predictedDb = 20 * Math.log10(Math.max(1e-12,
      Math.hypot(predictedRe[index], predictedIm[index])));
    const measuredDb = 20 * Math.log10(Math.max(1e-12,
      Math.hypot(measuredRe[index], measuredIm[index])));
    const delta = measuredDb - predictedDb;
    const w = weights[index];
    deviations.push({ frequency: frequencies[index], deltaDb: delta });
    levelSum += delta * w;
    weight += w;
    sumSquared += delta * delta * w;
    worst = Math.max(worst, Math.abs(delta));
  }
  if (!(weight > 0)) return fail('The verification found no weighted bin to compare.');
  const meanDb = levelSum / weight;
  const rmsDb = Math.sqrt(sumSquared / weight);

  let verdict = 'differs';
  let cause = 'something other than the delay';
  let note;
  if (rmsDb <= 1.5 && Math.abs(residualMs) <= 0.05) {
    verdict = 'matches';
    cause = 'nothing to correct';
    note = 'The measured sum sits within ' + rmsDb.toFixed(1) + ' dB of the prediction, so the alignment ' +
      'is confirmed.';
  } else if (Math.abs(residualMs) > 0.05 && rmsDb <= 3.5) {
    verdict = 'close';
    cause = 'delay';
    note = 'The measured sum sits ' + Math.abs(residualMs).toFixed(2) + ' ms ' +
      (residualMs > 0 ? 'later' : 'earlier') + ' than predicted at ' + rmsDb.toFixed(1) + ' dB of level ' +
      'difference: re-align with that arrival and check again.';
  } else if (Math.abs(meanDb) > 2) {
    verdict = 'differs';
    cause = 'level';
    note = 'The measured sum is ' + Math.abs(meanDb).toFixed(1) + ' dB ' +
      (meanDb > 0 ? 'louder' : 'quieter') + ' than predicted, which a delay cannot explain: check the ' +
      'levels and the routing before trusting either curve.';
  } else {
    verdict = 'differs';
    cause = 'the room or the capture';
    note = 'The measured sum differs by ' + rmsDb.toFixed(1) + ' dB and no single delay explains it: the ' +
      'capture may not be of the same arrangement, or the room changed between them.';
  }

  return {
    ok: true,
    message: '',
    verdict,
    cause,
    note,
    residualMs,
    deviation: { meanDb, rmsDb, worstDb: worst },
    bins: indices.length,
    deviations,
    band: { minHz: band.minHz, maxHz: band.maxHz },
  };
}

/**
 * Recalculate an alignment from what the verification found: the delivered
 * system sits `residualMs` later than predicted, so the delay that is actually
 * needed is smaller by that much. Nothing else is changed.
 */
export function recalculateAlignment(result, verification, options = {}) {
  if (!result || !result.ok) return fail('Run the automatic alignment before recalculating it.');
  if (!verification || !verification.ok) {
    return fail('Verifying the alignment is what a recalculation is built from.');
  }
  if (verification.verdict === 'matches') {
    return fail('The verification already matches the prediction, so nothing needs recalculating.');
  }
  const residual = Number(verification.residualMs);
  if (!Number.isFinite(residual) || Math.abs(residual) < 0.02) {
    return fail('The verification found no arrival the delay could correct.');
  }

  const resolution = clamp(options.resolutionMs, 0.01, 1, result.delay.resolutionMs);
  const totalMs = Math.max(0, result.delay.ms - residual);
  const snapped = snapDelay(totalMs, resolution);
  const applyTo = snapped.delayMs >= 0 ? 'target' : 'reference';
  const delayMs = Math.abs(snapped.delayMs);

  const settings = {
    delayMs: applyTo === 'target' ? delayMs : -delayMs,
    inverted: result.polarity === 'inverted',
    gainDb: result.gainDb,
    allPass: result.allPass,
  };
  const next = alignPoints(result, settings);
  if (!next) return fail('The recalculation found no curve to predict from.');

  const updated = {
    ...result,
    applyTo,
    polarity: settings.inverted ? 'inverted' : 'normal',
    delay: {
      ...result.delay,
      ms: delayMs,
      requestedMs: totalMs,
      snappedMs: snapped.delayMs,
      lostMs: snapped.lostMs,
      pathMm: (delayMs / 1000) * SPEED_OF_SOUND * 1000,
      referenceMs: applyTo === 'reference' ? delayMs : 0,
      targetMs: applyTo === 'target' ? delayMs + result.delay.arrivalOffsetMs : result.delay.arrivalOffsetMs,
    },
    points: next.points,
    after: next.evaluation || result.after,
    warnings: (result.warnings || []).concat([
      'Recalculated from the verification: the measured sum sat ' + Math.abs(residual).toFixed(2) +
      ' ms ' + (residual > 0 ? 'later' : 'earlier') + ' than predicted, so the delay is ' +
      (residual > 0 ? 'reduced' : 'increased') + ' by that much.',
    ]),
    verification,
    recalculated: true,
  };
  updated.improvement = {
    ...result.improvement,
    summationDb: updated.after.meanDb - result.before.meanDb,
    objective: Number.isFinite(updated.after.objective) && Number.isFinite(result.before.objective)
      ? updated.after.objective - result.before.objective
      : NaN,
  };
  return { ok: true, message: '', result: updated, verification };
}

function formatDelay(value) {
  const number = Number(value) || 0;
  const sign = number < 0 ? '−' : '';
  return sign + Math.abs(number).toFixed(2) + ' ms';
}

function formatLevel(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return (number >= 0 ? '+' : '') + number.toFixed(1) + ' dB';
}

function formatHz(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  if (number >= 1000) {
    const thousands = number / 1000;
    return (thousands >= 10 ? thousands.toFixed(1) : thousands.toFixed(2)).replace(/\.0+$/, '') + ' kHz';
  }
  return number.toFixed(0) + ' Hz';
}

function formatAllPass(entry) {
  if (!entry) return '';
  if (entry.order === 1) return 'first-order at ' + formatHz(entry.frequency);
  return 'second-order at ' + formatHz(entry.frequency) + ', Q ' + Number(entry.q).toFixed(2);
}

/**
 * The recommendation as text the operator can read into a processor: what to
 * enter on which loudspeaker, at what resolution, and what it predicts.
 */
export function dspSettingsText(result, options = {}) {
  if (!result || !result.ok) return '';
  const opts = options || {};
  const mode = ALIGN_MODES.find((entry) => entry.id === result.mode);
  const level = ALIGN_LEVELS.find((entry) => entry.id === result.level);
  const lines = [];

  lines.push('Align — automatic loudspeaker alignment');
  lines.push('Mode: ' + (mode ? mode.label : result.mode) +
    ' · ' + (level ? level.label : result.level));
  lines.push('Overlap: ' + formatHz(result.band.minHz) + ' – ' + formatHz(result.band.maxHz) +
    ' (' + result.band.octaves.toFixed(2) + ' octaves, ' +
    (result.band.detected === 'manual' ? 'set by hand'
      : result.band.crossingHz ? 'crossover detected at ' + formatHz(result.band.crossingHz)
        : 'detected from the overlap') + ')');
  lines.push('');

  if (result.multiPosition) {
    lines.push('Delay: add ' + result.delay.ms.toFixed(2) + ' ms to ' +
      (result.applyTo === 'reference'
        ? (result.reference && result.reference.label) || 'the reference'
        : (result.target && result.target.label) || 'the target'));
  } else if (result.delay.ms < 0.005) {
    lines.push('Delay: none needed on either channel (the pair already arrives together)');
  } else {
    lines.push('Delay: add ' + result.delay.ms.toFixed(2) + ' ms to ' +
      (result.applyTo === 'reference'
        ? (result.reference && result.reference.label) || 'the reference'
        : (result.target && result.target.label) || 'the target') +
      ' (' + Math.round(result.delay.pathMm) + ' mm of path at 343 m/s)');
    lines.push('       ' + ((result.reference && result.reference.label) || 'reference') + ': ' +
      result.delay.referenceMs.toFixed(2) + ' ms · ' +
      ((result.target && result.target.label) || 'target') + ': ' +
      result.delay.targetMs.toFixed(2) + ' ms');
  }
  lines.push('Resolution: ' + result.delay.resolutionMs.toFixed(2) + ' ms' +
    (Math.abs(result.delay.lostMs) > 1e-9
      ? ' (snapped, ' + result.delay.lostMs.toFixed(2) + ' ms from the exact answer)'
      : ' (the answer is on the grid)'));
  lines.push('Polarity: ' +
    ((result.target && result.target.label) || 'the target') + ' ' + result.polarity);
  if (result.gainDb) {
    lines.push('Gain: ' + formatLevel(result.gainDb) + ' on ' +
      ((result.target && result.target.label) || 'the target'));
  } else {
    lines.push('Gain: none');
  }
  if (result.allPass && result.allPass.length) {
    result.allPass.forEach((entry, index) => {
      lines.push('All-pass ' + (index + 1) + ': ' + formatAllPass(entry));
    });
  } else {
    lines.push('All-pass: none');
  }
  if (result.delay.arrivalOffsetMs) {
    lines.push('Arrival offset: ' + formatDelay(result.delay.arrivalOffsetMs) +
      ' later than the reference, as asked for');
  }

  lines.push('');
  lines.push('Predicted summation: ' + formatLevel(result.after.meanDb) +
    ' against the louder source in the band');
  lines.push('Average phase deviation: ' + (Number.isFinite(result.before.phaseErrorDeg)
    ? result.before.phaseErrorDeg.toFixed(0) + '° before · ' : '') +
    (Number.isFinite(result.after.phaseErrorDeg) ? result.after.phaseErrorDeg.toFixed(0) + '° after' : '—'));
  lines.push('Improvement: ' + formatLevel(result.improvement.summationDb) + ' of summation');
  lines.push('Latency added: ' + (result.latency.maxAddedMs > 0
    ? 'up to ' + result.latency.maxAddedMs.toFixed(2) + ' ms'
    : 'none'));
  lines.push('Confidence: ' + result.confidence.level);

  if (result.positions && result.positions.length) {
    lines.push('');
    lines.push('Positions:');
    for (const position of result.positions) {
      lines.push('  ' + position.label + ' (weight ' + position.weight + '): ' +
        formatLevel(position.summationDb) + ' summation' +
        (Number.isFinite(position.phaseErrorDeg) ? ', ' + position.phaseErrorDeg.toFixed(0) + '° of phase' : ''));
    }
  }

  lines.push('');
  if (opts.processor) {
    lines.push('Enter these on ' + opts.processor + '.');
  } else {
    lines.push('Enter these on the processor or in the loudspeaker’s own DSP.');
  }
  lines.push('They are a prediction from the measured curves — verify them with both loudspeakers running.');
  return lines.join('\n');
}

/** The settings alone, without the report, for a clipboard or a preset. */
export function dspSettingsPayload(result) {
  if (!result || !result.ok) return null;
  return {
    kind: 'align-auto-alignment',
    generated: new Date().toISOString(),
    mode: result.mode,
    level: result.level,
    overlapHz: { min: result.band.minHz, max: result.band.maxHz, octaves: result.band.octaves },
    delayMs: result.delay.ms,
    resolutionMs: result.delay.resolutionMs,
    applyTo: result.applyTo,
    polarity: result.polarity,
    gainDb: result.gainDb,
    allPass: result.allPass,
    reference: result.reference ? result.reference.label : '',
    target: result.target ? result.target.label : '',
    summationDb: result.after.meanDb,
    improvementDb: result.improvement.summationDb,
    confidence: result.confidence.level,
  };
}

/* ---------- drawing ---------- */

function roundedRect(ctx, x, y, w, h, radius) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function prepare(canvas) {
  const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
  const width = canvas.clientWidth || 320;
  const height = canvas.clientHeight || 220;
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function shortFrequency(frequency) {
  return frequency >= 1000
    ? (frequency / 1000).toFixed(frequency >= 10000 ? 0 : 1) + 'k'
    : frequency.toFixed(0);
}

function plotFrame(ctx, width, height) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(10, 16, 11, 0.96)';
  ctx.strokeStyle = 'rgba(161, 191, 150, 0.16)';
  ctx.lineWidth = 1;
  roundedRect(ctx, 0.5, 0.5, width - 1, height - 1, 14);
  ctx.fill();
  ctx.stroke();
}

function frequencyAxis(ctx, points, plot, colour) {
  const low = points[0].frequency;
  const high = points[points.length - 1].frequency;
  const xFor = (frequency) => plot.x + (Math.log(frequency / low) / Math.log(high / low)) * plot.w;

  ctx.font = '9px ui-monospace, monospace';
  ctx.textAlign = 'center';
  [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].forEach((frequency) => {
    if (frequency < low || frequency > high) return;
    const x = xFor(frequency);
    ctx.strokeStyle = colour || 'rgba(161, 191, 150, 0.10)';
    ctx.beginPath();
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.h);
    ctx.stroke();
    ctx.fillStyle = 'rgba(156, 159, 149, 0.8)';
    ctx.fillText(shortFrequency(frequency),
      Math.min(plot.x + plot.w - 8, Math.max(plot.x + 8, x)), plot.y + plot.h + 12);
  });
  return xFor;
}

function emptyNote(ctx, width, height, text) {
  ctx.fillStyle = 'rgba(156, 159, 149, 0.9)';
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(text, width / 2, height / 2);
}

function drawTrace(ctx, points, plot, view, key, colour, lineWidth, dash) {
  if (!view[key]) return;
  const low = points[0].frequency;
  const high = points[points.length - 1].frequency;
  let started = false;
  ctx.beginPath();
  for (const point of points) {
    const value = point[key];
    if (!Number.isFinite(value)) {
      started = false;
      continue;
    }
    const x = plot.x + (Math.log(point.frequency / low) / Math.log(high / low)) * plot.w;
    const y = view.yFor(value);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.strokeStyle = colour;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.setLineDash(dash || []);
  ctx.stroke();
  ctx.setLineDash([]);
}

function bandShade(ctx, data, plot, low) {
  const band = data.band;
  if (!band) return;
  const high = data.points[data.points.length - 1].frequency;
  const xFor = (frequency) => plot.x + (Math.log(frequency / low) / Math.log(high / low)) * plot.w;
  const from = xFor(Math.max(low, band.minHz));
  const to = xFor(Math.min(high, band.maxHz));
  if (!(to > from)) return;
  ctx.fillStyle = 'rgba(120, 235, 160, 0.07)';
  ctx.fillRect(from, plot.y, to - from, plot.h);
  ctx.strokeStyle = 'rgba(120, 235, 160, 0.22)';
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(from, plot.y);
  ctx.lineTo(from, plot.y + plot.h);
  ctx.moveTo(to, plot.y);
  ctx.lineTo(to, plot.y + plot.h);
  ctx.stroke();
  ctx.setLineDash([]);
}

/**
 * The magnitude chart: the two loudspeakers on their own, the sum before the
 * alignment and the sum it predicts. Drawn dim behind the corrected curve so a
 * before and after can be read at the same time.
 */
export function drawAlignMagnitude(canvas, data, view) {
  if (!canvas) return;
  if (!data || !data.points || data.points.length < 2) {
    const { ctx, width, height } = prepare(canvas);
    plotFrame(ctx, width, height);
    emptyNote(ctx, width, height, 'Press AUTO ALIGN to predict the pair');
    return;
  }
  const { ctx, width, height } = prepare(canvas);
  if (width < 60 || height < 60) return;
  plotFrame(ctx, width, height);

  const plot = { x: 34, y: 12, w: width - 46, h: height - 34 };
  const low = data.points[0].frequency;
  const high = data.points[data.points.length - 1].frequency;

  let minimum = Infinity;
  let maximum = -Infinity;
  for (const point of data.points) {
    const values = [];
    if (view.main) values.push(point.aDb);
    if (view.sub) values.push(point.bDb);
    if (view.beforeSum) values.push(point.sumBeforeDb);
    if (view.afterSum) values.push(point.sumAfterDb);
    for (const value of values) {
      if (!Number.isFinite(value)) continue;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return;
  const pad = Math.max(6, (maximum - minimum) * 0.12);
  let dbLow = Math.floor((minimum - pad) / 6) * 6;
  let dbHigh = Math.ceil((maximum + pad) / 6) * 6;
  if (dbHigh - dbLow < 36) {
    const mid = (dbHigh + dbLow) / 2;
    dbLow = Math.floor((mid - 18) / 6) * 6;
    dbHigh = Math.ceil((mid + 18) / 6) * 6;
  }
  const yFor = (db) => plot.y + plot.h - ((db - dbLow) / (dbHigh - dbLow)) * plot.h;
  view.yFor = yFor;

  frequencyAxis(ctx, data.points, plot);

  ctx.textAlign = 'right';
  ctx.font = '9px ui-monospace, monospace';
  for (let db = Math.ceil(dbLow / 6) * 6; db <= dbHigh; db += 6) {
    const y = yFor(db);
    ctx.strokeStyle = db === 0 ? 'rgba(161, 191, 150, 0.24)' : 'rgba(161, 191, 150, 0.08)';
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(156, 159, 149, 0.8)';
    ctx.fillText(db.toFixed(0), plot.x - 4, y + 3);
  }

  bandShade(ctx, data, plot, low);

  drawTrace(ctx, data.points, plot, view, 'aDb', 'rgba(226, 235, 214, 0.55)', 1.4);
  drawTrace(ctx, data.points, plot, view, 'bDb', 'rgba(143, 199, 250, 0.6)', 1.4);
  drawTrace(ctx, data.points, plot, view, 'sumBeforeDb', 'rgba(255, 176, 82, 0.55)', 1.3, [5, 4]);
  drawTrace(ctx, data.points, plot, view, 'sumAfterDb', '#7cf0a8', 2.2);

  ctx.fillStyle = 'rgba(156, 159, 149, 0.9)';
  ctx.textAlign = 'left';
  ctx.fillText('dB', plot.x - 30, plot.y + 4);
}

/**
 * The phase chart: the two loudspeakers as they arrive, the correction applied
 * to the target, and the phase of the corrected sum. A wrap is left as a break
 * in the line rather than drawn as a jump.
 */
export function drawAlignPhase(canvas, data, view) {
  if (!canvas) return;
  if (!data || !data.points || data.points.length < 2) {
    const { ctx, width, height } = prepare(canvas);
    plotFrame(ctx, width, height);
    emptyNote(ctx, width, height, 'The corrected phase appears here');
    return;
  }
  const { ctx, width, height } = prepare(canvas);
  if (width < 60 || height < 60) return;
  plotFrame(ctx, width, height);

  const plot = { x: 34, y: 12, w: width - 46, h: height - 34 };
  const low = data.points[0].frequency;
  const high = data.points[data.points.length - 1].frequency;

  const mode = view.phaseMode === 'unwrapped' ? 'unwrapped' : 'wrapped';
  const prepareValue = (value, previous) => {
    if (!Number.isFinite(value)) return NaN;
    if (mode === 'wrapped') return value;
    let next = value;
    while (next - previous > 180) next -= 360;
    while (previous - next > 180) next += 360;
    return next;
  };

  const series = [];
  const addSeries = (key, colour, lineWidth, dash) => {
    if (!view[key]) return;
    let previous = NaN;
    const values = data.points.map((point) => {
      const raw = point[key];
      if (!Number.isFinite(raw)) return NaN;
      const value = Number.isFinite(previous) ? prepareValue(raw, previous) : raw;
      previous = value;
      return value;
    });
    series.push({ key, colour, lineWidth, dash, values });
  };

  addSeries('aPhaseDeg', 'rgba(226, 235, 214, 0.5)', 1.3);
  addSeries('bPhaseBeforeDeg', 'rgba(143, 199, 250, 0.45)', 1.2, [4, 3]);
  addSeries('bPhaseAfterDeg', 'rgba(120, 210, 255, 0.85)', 1.5);
  addSeries('sumAfterPhaseDeg', '#7cf0a8', 2.2);

  let minimum = Infinity;
  let maximum = -Infinity;
  for (const entry of series) {
    for (const value of entry.values) {
      if (!Number.isFinite(value)) continue;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  }
  if (!Number.isFinite(minimum)) {
    emptyNote(ctx, width, height, 'Neither curve carries phase');
    return;
  }
  // A wrapped chart always shows a whole turn, so 0° sits where it belongs.
  let lowDeg = mode === 'wrapped' ? -180 : Math.floor(minimum / 90) * 90;
  let highDeg = mode === 'wrapped' ? 180 : Math.ceil(maximum / 90) * 90;
  if (highDeg - lowDeg < 90) {
    const mid = (highDeg + lowDeg) / 2;
    lowDeg = Math.floor((mid - 45) / 90) * 90;
    highDeg = Math.ceil((mid + 45) / 90) * 90;
  }
  const yFor = (degrees) => plot.y + plot.h - ((degrees - lowDeg) / (highDeg - lowDeg)) * plot.h;

  frequencyAxis(ctx, data.points, plot);

  ctx.textAlign = 'right';
  ctx.font = '9px ui-monospace, monospace';
  const step = Math.max(30, Math.round((highDeg - lowDeg) / 6 / 30) * 30);
  for (let degrees = Math.ceil(lowDeg / step) * step; degrees <= highDeg; degrees += step) {
    const y = yFor(degrees);
    ctx.strokeStyle = degrees === 0 ? 'rgba(161, 191, 150, 0.24)' : 'rgba(161, 191, 150, 0.08)';
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(156, 159, 149, 0.8)';
    ctx.fillText(degrees.toFixed(0) + '°', plot.x - 4, y + 3);
  }

  bandShade(ctx, data, plot, low);

  for (const entry of series) {
    let started = false;
    ctx.beginPath();
    for (let i = 0; i < data.points.length; i += 1) {
      const value = entry.values[i];
      if (!Number.isFinite(value)) {
        started = false;
        continue;
      }
      const frequency = data.points[i].frequency;
      const x = plot.x + (Math.log(frequency / low) / Math.log(high / low)) * plot.w;
      const y = yFor(value);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else if (mode === 'wrapped' && Math.abs(value - entry.values[i - 1]) > 180) {
        // The line would be a full turn; it is a wrap, so the line breaks.
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = entry.colour;
    ctx.lineWidth = entry.lineWidth;
    ctx.lineJoin = 'round';
    ctx.setLineDash(entry.dash || []);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.fillStyle = 'rgba(156, 159, 149, 0.9)';
  ctx.textAlign = 'left';
  ctx.fillText('phase', plot.x - 30, plot.y + 4);
}
