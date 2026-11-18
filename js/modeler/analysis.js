/*
 * Alignment analysis in the browser.
 *
 * This is the web version of the app's Alignment analysis card, reading the same
 * way: Capture A against Capture B, one third-octave band at a time, across one
 * of three bands. Every finding keeps what the data says, the evidence behind it,
 * the prediction for a change, how far the measurement supports it, and the
 * measurement that would verify it.
 *
 * Nothing is proposed that the two captures cannot support. A band whose
 * coherence is too low has no phase, so no phase finding and no delay is offered
 * for it; and if no phase can be read, no advice is given at all.
 *
 * One thing this reader cannot carry over from the app: the two captures here are
 * the app's saved or held traces, so their arrival is the delay the capture was
 * stored with, and the polarity is the one the engine recorded. The phase is the
 * measured phase, and the sum preview beside it is a prediction from the stored
 * curves, never a measurement.
 */

import { buildSumPreview } from '../sum-preview.js';

export const ANALYSIS_BANDS = [
  { id: 'subs', title: 'Subs 40–120', label: '40–120 Hz', min: 40, max: 120 },
  { id: 'crossover', title: 'Crossover 60–250', label: '60–250 Hz', min: 60, max: 250 },
  { id: 'lowEnd', title: 'Low end 40–320', label: '40–320 Hz', min: 40, max: 320 },
];

export function analysisBandById(id) {
  return ANALYSIS_BANDS.find((band) => band.id === id) || ANALYSIS_BANDS[0];
}

function wrap(degrees) {
  let value = Number(degrees) % 360;
  if (value > 180) value -= 360;
  if (value < -180) value += 360;
  return value;
}

function frequencyLabel(hz) {
  const frequency = Number(hz);
  if (!(frequency > 0)) return '—';
  if (frequency < 1000) return frequency.toFixed(0) + ' Hz';
  const kilo = frequency / 1000;
  return (kilo === Math.round(kilo) ? kilo.toFixed(0) : kilo.toFixed(1)) + ' kHz';
}

function rangeLabel(low, high) {
  return frequencyLabel(low) + '–' + frequencyLabel(high);
}

function bandValues(trace, low, high, threshold) {
  const bins = Number(trace.bins) || 0;
  const df = Number(trace.df) > 0 ? Number(trace.df) : 0;
  if (!(bins > 2) || !(df > 0)) return { db: null, phase: null, coherence: 0 };

  const k0 = Math.max(1, Math.ceil(low / df));
  const k1 = Math.min(bins - 1, Math.floor(high / df));
  if (k1 < k0) return { db: null, phase: null, coherence: 0 };

  let power = 0;
  let count = 0;
  let coherenceSum = 0;
  let sinSum = 0;
  let cosSum = 0;
  let phaseBins = 0;

  for (let k = k0; k <= k1; k += 1) {
    const rawCoherence = trace.coh ? Number(trace.coh[k]) : NaN;
    coherenceSum += Number.isFinite(rawCoherence)
      ? Math.max(0, Math.min(1, rawCoherence)) : 0;
    count += 1;

    const rawLevel = trace.magDb ? Number(trace.magDb[k]) : NaN;
    if (Number.isFinite(rawLevel)) {
      power += Math.pow(10, Math.min(60, Math.max(-200, rawLevel)) / 10);
    }

    const rawPhase = trace.phaseDeg ? Number(trace.phaseDeg[k]) : NaN;
    if (Number.isFinite(rawCoherence) && rawCoherence >= threshold &&
      Number.isFinite(rawPhase)) {
      const angle = (rawPhase * Math.PI) / 180;
      sinSum += Math.sin(angle);
      cosSum += Math.cos(angle);
      phaseBins += 1;
    }
  }

  if (!count) return { db: null, phase: null, coherence: 0 };
  return {
    db: power > 0 ? 10 * Math.log10(power / count) : null,
    phase: phaseBins > 0 ? (Math.atan2(sinSum, cosSum) * 180) / Math.PI : null,
    coherence: coherenceSum / count,
  };
}

/** One third-octave point of the pair across the chosen band. */
export function analysisPoints(captureA, captureB, band, threshold = 0.35) {
  const points = [];
  const low = Number(band && band.min) || 40;
  const high = Number(band && band.max) || 320;
  const ratio = Math.pow(2, 1 / 3);

  for (let centre = 20; centre <= 20000; centre *= ratio) {
    if (centre < low * 0.999 || centre > high * 1.001) continue;
    const edgeLow = centre / Math.pow(2, 1 / 6);
    const edgeHigh = centre * Math.pow(2, 1 / 6);
    const a = bandValues(captureA.trace, edgeLow, edgeHigh, threshold);
    const b = bandValues(captureB.trace, edgeLow, edgeHigh, threshold);
    const phaseDiff = a.phase !== null && b.phase !== null ? wrap(a.phase - b.phase) : null;
    points.push({
      centre,
      levelA: a.db,
      levelB: b.db,
      phaseA: a.phase,
      phaseB: b.phase,
      phaseDiff,
      coherence: Math.min(a.coherence, b.coherence),
      usable: phaseDiff !== null,
    });
  }
  return points;
}

/**
 * The relative delay the phase difference implies, from a least-squares slope of
 * the unwrapped difference against frequency. Null when fewer than four bands
 * carry phase.
 */
export function delayFromPhase(points) {
  const usable = points.filter((point) => point.usable);
  if (usable.length < 4) return null;

  let previous = usable[0].phaseDiff;
  let accumulated = usable[0].phaseDiff;
  const unwrapped = [{ frequency: usable[0].centre, deg: accumulated }];
  for (let index = 1; index < usable.length; index += 1) {
    const value = usable[index].phaseDiff;
    let step = value - previous;
    while (step > 180) step -= 360;
    while (step < -180) step += 360;
    accumulated += step;
    previous = value;
    unwrapped.push({ frequency: usable[index].centre, deg: accumulated });
  }

  const count = unwrapped.length;
  const meanF = unwrapped.reduce((sum, point) => sum + point.frequency, 0) / count;
  const meanP = unwrapped.reduce((sum, point) => sum + point.deg, 0) / count;
  let numerator = 0;
  let denominator = 0;
  for (const point of unwrapped) {
    const df = point.frequency - meanF;
    numerator += df * (point.deg - meanP);
    denominator += df * df;
  }
  if (!(denominator > 0)) return null;
  const slope = numerator / denominator;
  const milliseconds = (-slope / 360) * 1000;
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function meanSum(sumPreview, band) {
  if (!sumPreview) return null;
  const inside = sumPreview.points.filter((point) =>
    point.frequency >= band.min && point.frequency <= band.max);
  if (!inside.length) return null;
  const mean = inside.reduce((sum, point) => sum + point.sumDb, 0) / inside.length;
  return Number.isFinite(mean) ? mean : null;
}

function confidenceLabel(coherence) {
  if (coherence >= 0.85) return 'High — mean coherence ' + coherence.toFixed(2);
  if (coherence >= 0.6) return 'Fair — mean coherence ' + coherence.toFixed(2);
  return 'Low — mean coherence ' + coherence.toFixed(2);
}

function polarityWord(capture) {
  return String(capture.polarity || 'unknown').toLowerCase();
}

function arrivalFinding(captureA, captureB, delta, coherence, slopeDelay, bandLabel) {
  const earlier = delta > 0 ? captureB : captureA;
  const later = delta > 0 ? captureA : captureB;
  const amount = Math.abs(delta);
  const evidence = [
    captureA.label + ' arrived at ' + Number(captureA.arrivalMs).toFixed(2) + ' ms, ' +
      captureB.label + ' at ' + Number(captureB.arrivalMs).toFixed(2) + ' ms — ' +
      amount.toFixed(2) + ' ms apart.',
    'Mean coherence across ' + bandLabel + ' is ' + coherence.toFixed(2) + '.',
  ];
  if (slopeDelay !== null) {
    evidence.push('The measured phase difference implies ' + Math.abs(slopeDelay).toFixed(2) +
      ' ms of relative delay, so the two readings agree.');
  }
  return {
    id: 'arrival',
    kind: 'arrival',
    headline: earlier.label + ' arrives ' + amount.toFixed(2) + ' ms before ' + later.label + '.',
    evidence,
    band: bandLabel,
    proposal: 'Delay ' + earlier.label + ' by ' + amount.toFixed(2) + ' ms — ' +
      Math.round(amount * 343) + ' mm of extra path — so its arrival meets ' + later.label + '.',
    expected: 'With the arrivals together the two phase traces should move onto each other across ' +
      bandLabel + ', wherever both responses have the same shape. The pair’s summed level should ' +
      'rise where it cancels now.',
    confidence: confidenceLabel(coherence),
    verification: 'Apply it in the loudspeaker processor, then measure both sources running ' +
      'together and compare the summed magnitude and phase across ' + bandLabel + ' with each ' +
      'source alone.',
  };
}

function phaseFinding(captureA, captureB, usable, bandLabel) {
  const wide = usable.filter((point) => Math.abs(point.phaseDiff) > 90);
  if (!wide.length) return null;
  const worst = usable.reduce((best, point) =>
    Math.abs(point.phaseDiff) > Math.abs(best.phaseDiff) ? point : best, usable[0]);
  const wrapping = Math.abs(worst.phaseDiff);
  const nearInversion = wrapping > 150;
  const extent = wide.length === 1
    ? frequencyLabel(worst.centre)
    : rangeLabel(Math.min(...wide.map((point) => point.centre)),
        Math.max(...wide.map((point) => point.centre)));

  return {
    id: 'phase',
    kind: 'phase',
    headline: nearInversion
      ? captureA.label + ' and ' + captureB.label + ' are close to opposed around ' + extent + '.'
      : captureA.label + ' and ' + captureB.label + ' disagree by more than 90° around ' + extent + '.',
    evidence: [
      wide.length + ' of ' + usable.length + ' usable bands differ by more than 90°.',
      'The largest difference is ' + wrapping.toFixed(0) + '° at ' + frequencyLabel(worst.centre) + '.',
      'Coherence in that band is ' + worst.coherence.toFixed(2) + '.',
    ],
    band: extent,
    proposal: nearInversion
      ? 'Delay the pair as the arrival reading suggests first. If the dip at ' + extent +
        ' survives that, test a polarity flip on one source.'
      : 'Check the relative delay before anything else: the disagreement grows the way a timing ' +
        'error does. Test a polarity flip only if the delay does not resolve ' + extent + '.',
    expected: 'A correct delay moves the phase traces together. A polarity flip moves them ' +
      'together only where the responses are otherwise aligned, so it is never the first guess.',
    verification: 'Re-measure the pair together and check that the small dip around ' + extent +
      ' is filled in rather than moved elsewhere.',
  };
}

function timingFinding(delta, slopeDelay, coherence, bandLabel) {
  if (slopeDelay === null || Math.abs(delta) < 0.05) return null;
  if (Math.abs(slopeDelay - Math.abs(delta)) <= 0.25) return null;
  return {
    id: 'quality-timing',
    kind: 'quality',
    headline: 'The arrival and phase readings disagree.',
    evidence: [
      'Arrival difference: ' + Math.abs(delta).toFixed(2) + ' ms.',
      'Phase slope over ' + bandLabel + ': ' + Math.abs(slopeDelay).toFixed(2) + ' ms.',
      'Mean coherence: ' + coherence.toFixed(2) + '.',
    ],
    band: bandLabel,
    proposal: null,
    expected: null,
    confidence: 'Low',
    verification: 'Recapture both sources with the same reference, phase compensation off and ' +
      'nothing changed in the room between them.',
  };
}

function summationFinding(captureA, captureB, delta, band, bandLabel) {
  if (Number(captureA.trace.fftSize) !== Number(captureB.trace.fftSize)) return null;
  if (Math.abs(Number(captureA.trace.sampleRate) - Number(captureB.trace.sampleRate)) >= 1) return null;

  const before = buildSumPreview(captureA.trace, captureB.trace, {});
  const beforeMean = meanSum(before, band);
  if (beforeMean === null) return null;

  const aligned = Math.abs(delta) < 0.05
    ? before
    : delta > 0
      ? buildSumPreview(captureA.trace, captureB.trace, { delayMs: delta })
      : buildSumPreview(captureB.trace, captureA.trace, { delayMs: -delta });
  const afterMean = meanSum(aligned, band);
  if (afterMean === null) return null;

  const gain = afterMean - beforeMean;
  const direction = gain >= 0 ? 'rises' : 'falls';
  return {
    id: 'summation',
    kind: 'summation',
    headline: Math.abs(delta) < 0.05
      ? 'Predicted sum as the pair arrived: ' + beforeMean.toFixed(1) + ' dB across ' + bandLabel + '.'
      : 'Predicted sum ' + direction + ' ' + Math.abs(gain).toFixed(1) +
        ' dB once the earlier source is delayed.',
    evidence: [
      'Predicted sum as it arrived: ' + beforeMean.toFixed(1) + ' dB across ' + bandLabel + '.',
      'Predicted sum with ' + Math.abs(delta).toFixed(2) + ' ms of extra delay: ' +
        afterMean.toFixed(1) + ' dB.',
      'Complex addition of the two stored captures — a prediction, not a measurement.',
    ],
    band: bandLabel,
    proposal: null,
    expected: null,
    confidence: 'Prediction',
    verification: 'Only a new combined measurement can confirm it. The prediction assumes both ' +
      'captures share a timing reference, the same level calibration and that neither source moves.',
  };
}

function polarityFinding(captureA, captureB, coherence, bandLabel) {
  const polA = polarityWord(captureA);
  const polB = polarityWord(captureB);
  if (!polA || !polB || polA === 'unknown' || polB === 'unknown' || polA === polB) return null;
  return {
    id: 'polarity',
    kind: 'polarity',
    headline: captureA.label + ' and ' + captureB.label + ' were captured with opposite polarity.',
    evidence: [
      captureA.label + ': ' + polA + '.',
      captureB.label + ': ' + polB + '.',
      'A polarity flip cannot be seen in magnitude alone, which is why it is checked separately.',
    ],
    band: bandLabel,
    proposal: 'Confirm the wiring on both paths, then either invert one source or correct the wiring.',
    expected: 'Once the polarity matches, the pair should sum rather than cancel where their ' +
      'phase already agrees.',
    confidence: confidenceLabel(coherence),
    verification: 'Re-measure both sources alone and together, and check that the arrival times ' +
      'are unchanged while the summation improves.',
  };
}

function refusal(points, usable, bandLabel) {
  const lines = [usable.length + ' of ' + points.length + ' third-octave bands in ' + bandLabel +
    ' have usable phase in both captures.'];
  const best = points.reduce((most, point) => (point.coherence > most.coherence ? point : most), points[0]);
  if (best) lines.push('The best band coherence is ' + best.coherence.toFixed(2) + ' at ' +
    frequencyLabel(best.centre) + '.');
  lines.push('Below 35 % coherence a phase reading is not a measurement of the room; it is noise.');
  return {
    findings: [{
      id: 'quality-coverage',
      kind: 'quality',
      headline: 'Not enough usable overlap to analyse.',
      evidence: lines,
      band: bandLabel,
      proposal: null,
      expected: null,
      confidence: 'Insufficient',
      verification: 'Raise the test-signal level, lower the noise or take the captures again ' +
        'where both sources are genuinely present across ' + bandLabel + '.',
    }],
    headline: 'Capture again before acting on this pair.',
    bandLabel,
    usableBands: usable.length,
    totalBands: points.length,
  };
}

/**
 * Read a pair of captures across a band and say what the data supports.
 *
 * `captureA` and `captureB` each carry `label`, `trace` (magDb, phaseDeg, coh,
 * bins, df, fftSize, sampleRate), `arrivalMs` and `polarity` ("normal",
 * "inverted" or "unknown").
 */
export function analysePair(captureA, captureB, options = {}) {
  if (!captureA || !captureB || !captureA.trace || !captureB.trace) {
    return {
      findings: [],
      headline: 'Hold Capture A and Capture B before asking for an analysis.',
      bandLabel: '',
      usableBands: 0,
      totalBands: 0,
    };
  }

  const band = analysisBandById(options.band);
  const threshold = Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : 0.35;
  const points = analysisPoints(captureA, captureB, band, threshold);
  const usable = points.filter((point) => point.usable);
  const bandLabel = rangeLabel(band.min, band.max);

  if (points.length < 3 || usable.length < 3) return refusal(points, usable, bandLabel);

  const meanCoherence = usable.reduce((sum, point) => sum + point.coherence, 0) / usable.length;
  const confidence = confidenceLabel(meanCoherence);
  const delta = Number(captureA.arrivalMs) - Number(captureB.arrivalMs);
  const slopeDelay = delayFromPhase(points);

  const findings = [];
  if (Number.isFinite(delta) && Math.abs(delta) >= 0.05) {
    findings.push(arrivalFinding(captureA, captureB, delta, meanCoherence, slopeDelay, bandLabel));
  }
  const phase = phaseFinding(captureA, captureB, usable, bandLabel);
  if (phase) findings.push(phase);
  const timing = timingFinding(Number.isFinite(delta) ? delta : 0, slopeDelay, meanCoherence, bandLabel);
  if (timing) findings.push(timing);
  const summation = summationFinding(captureA, captureB, Number.isFinite(delta) ? delta : 0, band, bandLabel);
  if (summation) findings.push(summation);
  const polarity = polarityFinding(captureA, captureB, meanCoherence, bandLabel);
  if (polarity) findings.push(polarity);

  let headline;
  if (findings.some((finding) => finding.kind === 'polarity' || finding.kind === 'quality')) {
    headline = 'Read the notes below before changing anything.';
  } else if (Math.abs(delta) < 0.05) {
    headline = captureA.label + ' and ' + captureB.label + ' arrive together within 0.05 ms.';
  } else {
    const earlier = delta > 0 ? captureB.label : captureA.label;
    const later = delta > 0 ? captureA.label : captureB.label;
    headline = earlier + ' arrives ' + Math.abs(delta).toFixed(2) + ' ms before ' + later +
      ' across ' + bandLabel + '.';
  }

  return {
    findings,
    headline,
    bandLabel,
    usableBands: usable.length,
    totalBands: points.length,
    confidence,
    slopeDelayMs: slopeDelay,
  };
}
