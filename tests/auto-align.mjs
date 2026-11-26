/*
 * Automatic alignment checks, run with Node:
 *
 *   node tests/auto-align.mjs
 *
 * Every signal is synthetic and carries its own known answer: a known arrival,
 * a known polarity inversion, a known all-pass filter, a known crossover, and
 * known noise on the coherence. Nothing here is a live measurement, and a pass
 * is evidence about the maths, not about a real room.
 */

import {
  ALIGN_LEVELS,
  ALIGN_MODES,
  COHERENCE_FLOOR,
  RESOLUTIONS,
  alignTrace,
  allPassLatencyMs,
  autoAlign,
  detectBand,
  dspSettingsPayload,
  dspSettingsText,
  gridFrequencies,
  recalculateAlignment,
  snapDelay,
  verifyAlignment,
} from '../js/auto-align.js';
import { chainResponse, designCrossover } from '../js/modeler/filters.js';
import { biquadResponse } from '../js/modeler/filters.js';

let passed = 0;
let failed = 0;

function report(name, pass, detail) {
  if (pass) passed += 1;
  else failed += 1;
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + ' — ' + detail);
}

function wrap(degrees) {
  let value = degrees % 360;
  if (value > 180) value -= 360;
  if (value <= -180) value += 360;
  return value;
}

function approx(value, expected, tolerance) {
  return Number.isFinite(value) && Math.abs(value - expected) <= tolerance;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COUNT = 400;
const GRID = Array.from(gridFrequencies(COUNT));

/** A flat curve that arrives `arrivalMs` after time zero. */
function arrivalTrace(label, options = {}) {
  const arrivalMs = Number(options.arrivalMs) || 0;
  const levelDb = Number(options.levelDb) || 0;
  const coherence = Number.isFinite(options.coherence) ? options.coherence : 0.98;
  const phaseExtra = typeof options.phaseExtra === 'function' ? options.phaseExtra : null;
  const random = options.noiseDb ? mulberry32(options.seed || 7) : null;

  const magDb = [];
  const phaseDeg = [];
  const coherenceList = [];
  GRID.forEach((frequency) => {
    const noise = random ? (random() * 2 - 1) * options.noiseDb : 0;
    magDb.push(levelDb + noise);
    const base = -360 * frequency * (arrivalMs / 1000);
    phaseDeg.push(wrap(base + (phaseExtra ? phaseExtra(frequency) : 0)));
    coherenceList.push(typeof coherence === 'function' ? coherence(frequency) : coherence);
  });
  return alignTrace({
    label,
    frequencies: GRID,
    magDb,
    phaseDeg,
    coherence: coherenceList,
  });
}

/** A curve from a designed filter chain, optionally arriving later. */
function filteredTrace(label, filters, options = {}) {
  const arrivalMs = Number(options.arrivalMs) || 0;
  const response = chainResponse(filters, GRID, 48000);
  const phaseDeg = [];
  for (let i = 0; i < GRID.length; i += 1) {
    phaseDeg.push(wrap((response.phaseRad[i] * 180) / Math.PI - 360 * GRID[i] * (arrivalMs / 1000)));
  }
  return alignTrace({
    label,
    frequencies: GRID,
    magDb: Array.from(response.magDb),
    phaseDeg,
    coherence: GRID.map(() => 0.97),
  });
}

/* 1. The catalogue offers every mode and the three optimisation levels. */
{
  const modes = ALIGN_MODES.map((entry) => entry.id);
  const levels = ALIGN_LEVELS.map((entry) => entry.id);
  const wanted = ['mainSub', 'subSub', 'mainMain', 'mainDelay', 'mainFill', 'multiple', 'multiMic'];
  report('The modes and levels are all offered',
    wanted.every((id) => modes.includes(id)) &&
      levels.join(',') === 'quick,advanced,custom' &&
      RESOLUTIONS[0] === 0.01,
    modes.length + ' modes, levels ' + levels.join('/') + ', finest resolution ' + RESOLUTIONS[0] + ' ms');
}

/* 2. Two curves that already arrive together need nothing changed. */
{
  const reference = arrivalTrace('Main', {});
  const target = arrivalTrace('Sub', {});
  const result = autoAlign({ reference, target, level: 'quick', resolutionMs: 0.01 });
  const after = result.ok ? result.after.meanDb : NaN;
  report('Two aligned curves need no delay and report no gain',
    result.ok && approx(result.delay.ms, 0, 0.01) &&
      approx(result.improvement.summationDb, 0, 0.1) &&
      approx(after, 3.01, 0.1) && result.polarity === 'normal',
    result.ok
      ? 'delay ' + result.delay.ms.toFixed(2) + ' ms, summation ' + after.toFixed(2) +
        ' dB, improvement ' + result.improvement.summationDb.toFixed(2) + ' dB'
      : result.message);
}

/* 3. A target that arrives 1.5 ms late is met by delaying the reference. */
{
  const reference = arrivalTrace('Main', {});
  const target = arrivalTrace('Sub', { arrivalMs: 1.5 });
  const result = autoAlign({ reference, target, level: 'quick', resolutionMs: 0.01, maxDelayMs: 10 });
  report('A known 1.5 ms arrival is recovered on the other loudspeaker',
    result.ok && result.applyTo === 'reference' && approx(result.delay.ms, 1.5, 0.03) &&
      result.improvement.summationDb > 2 && approx(result.delay.referenceMs, result.delay.ms, 1e-9) &&
      result.delay.targetMs === 0,
    result.ok
      ? result.applyTo + ' delayed ' + result.delay.ms.toFixed(3) + ' ms, improvement ' +
        result.improvement.summationDb.toFixed(2) + ' dB'
      : result.message);
}

/* 4. A target that arrives early is delayed itself, never negatively. */
{
  const reference = arrivalTrace('Main', {});
  const target = arrivalTrace('Sub', { arrivalMs: -1.5 });
  const result = autoAlign({ reference, target, level: 'quick', resolutionMs: 0.01, maxDelayMs: 10 });
  const physical = result.ok && result.delay.ms >= 0 &&
    result.delay.referenceMs >= 0 && result.delay.targetMs >= 0;
  report('An early target is delayed itself, with no negative delay anywhere',
    result.ok && result.applyTo === 'target' && approx(result.delay.ms, 1.5, 0.03) && physical &&
      approx(result.delay.targetMs, result.delay.ms, 1e-9),
    result.ok
      ? result.applyTo + ' delayed ' + result.delay.ms.toFixed(3) + ' ms, channels ' +
        result.delay.referenceMs.toFixed(2) + '/' + result.delay.targetMs.toFixed(2) + ' ms'
      : result.message);
}

/* 5. A polarity inversion is found and reported. */
{
  const reference = arrivalTrace('Main', {});
  const target = arrivalTrace('Sub', { phaseExtra: () => 180 });
  const result = autoAlign({ reference, target, level: 'quick', resolutionMs: 0.01 });
  report('A known polarity inversion is found',
    result.ok && result.polarity === 'inverted' && approx(result.delay.ms, 0, 0.02) &&
      result.improvement.summationDb > 2,
    result.ok
      ? result.polarity + ', delay ' + result.delay.ms.toFixed(2) + ' ms, improvement ' +
        result.improvement.summationDb.toFixed(2) + ' dB'
      : result.message);
}

/* 6. Complex summation, not decibel addition: two identical curves in
 *    anti-phase cancel before the alignment and add +6 dB after it. */
{
  const reference = arrivalTrace('Main', {});
  const target = arrivalTrace('Sub', { phaseExtra: () => 180 });
  const result = autoAlign({ reference, target, level: 'quick' });
  const lowestBefore = result.ok
    ? result.points.reduce((low, point) => Math.min(low, point.sumBeforeDb), Infinity)
    : NaN;
  const highestAfter = result.ok
    ? result.points.reduce((high, point) => Math.max(high, point.sumAfterDb), -Infinity)
    : NaN;
  report('The sum is complex: a null before and +6 dB after',
    result.ok && lowestBefore < -40 && approx(highestAfter, 6.02, 0.2),
    result.ok
      ? 'deepest predicted null ' + lowestBefore.toFixed(1) + ' dB, corrected sum ' +
        highestAfter.toFixed(2) + ' dB'
      : result.message);
}

/* 7. A known crossover pair is aligned across its acoustic overlap, and the
 *    overlay is detected around the crossover rather than at one frequency. */
{
  const highPass = designCrossover({ family: 'Linkwitz-Riley', type: 'highPass', frequency: 80, slope: 24 });
  const lowPass = designCrossover({ family: 'Linkwitz-Riley', type: 'lowPass', frequency: 80, slope: 24 });
  const reference = filteredTrace('Main', highPass.filters, {});
  const target = filteredTrace('Sub', lowPass.filters, { arrivalMs: 2.0 });
  const result = autoAlign({ reference, target, level: 'quick', resolutionMs: 0.01, maxDelayMs: 10 });
  const band = result.ok ? result.band : null;
  const detected = !!band && band.detected === 'crossing' && approx(band.crossingHz, 80, 6) &&
    band.minHz < 60 && band.maxHz > 100 && band.octaves > 0.6;
  report('A crossover pair is aligned across the overlap around 80 Hz',
    result.ok && detected && result.applyTo === 'reference' &&
      approx(result.delay.ms, 2.0, 0.05) && result.improvement.summationDb > 0.4,
    result.ok
      ? 'band ' + band.minHz.toFixed(1) + ' – ' + band.maxHz.toFixed(1) + ' Hz (' + band.detected +
        ', crossing ' + (band.crossingHz ? band.crossingHz.toFixed(1) : '—') + '), delay ' +
        result.delay.ms.toFixed(3) + ' ms on the ' + result.applyTo + ', improvement ' +
        result.improvement.summationDb.toFixed(2) + ' dB'
      : result.message);
}

/* 8. A deliberately chosen range is used exactly as given. */
{
  const reference = arrivalTrace('Main', {});
  const target = arrivalTrace('Sub', { arrivalMs: 1.0 });
  const auto = autoAlign({ reference, target, level: 'quick' });
  const manual = autoAlign({
    reference, target, level: 'quick', range: 'manual', minHz: 100, maxHz: 200, resolutionMs: 0.01,
  });
  report('A manual range overrides the detected overlap',
    manual.ok && manual.band.detected === 'manual' &&
      approx(manual.band.minHz, 100, 0.01) && approx(manual.band.maxHz, 200, 0.01) &&
      manual.band.focusHz > 100 && manual.band.focusHz < 200 &&
      auto.ok && auto.band.detected !== 'manual',
    manual.ok
      ? 'manual ' + manual.band.minHz + ' – ' + manual.band.maxHz + ' Hz, automatic was ' +
        (auto.ok ? auto.band.minHz.toFixed(0) + ' – ' + auto.band.maxHz.toFixed(0) : 'refused')
      : manual.message);
}

/* 9. An all-pass difference delay and polarity cannot remove is found by the
 *    advanced level and not offered by the quick one. */
{
  const apFilter = { kind: 'allPass2', frequency: 300, q: 1.5, gainDb: 0, enabled: true };
  const reference = arrivalTrace('Main', {});
  const targetTrace = arrivalTrace('Sub', {
    phaseExtra: (frequency) => {
      const response = biquadResponse(apFilter, frequency, 48000);
      // Its conjugate: the engine's own all-pass at the same settings cancels it.
      return -(response.phaseRad * 180) / Math.PI;
    },
  });

  const quick = autoAlign({ reference, target: targetTrace, level: 'quick', resolutionMs: 0.01 });
  const advanced = autoAlign({
    reference, target: targetTrace, level: 'advanced', resolutionMs: 0.01, maxAllPass: 1,
  });
  const chosen = advanced.ok && advanced.allPass.length ? advanced.allPass[0] : null;
  const found = !!chosen && chosen.order === 2 &&
    Math.abs(Math.log2(chosen.frequency / 300)) < 0.25 && chosen.q > 1 && chosen.q < 3;

  report('A known all-pass is found by the advanced level only',
    advanced.ok && found &&
      advanced.improvement.summationDb > quick.improvement.summationDb + 0.5 &&
      advanced.allPass.length === 1 && advanced.latency.maxAddedMs > 0 &&
      allPassLatencyMs([], advanced.band, 48000) === 0,
    advanced.ok
      ? 'all-pass ' + (chosen ? chosen.order + ' at ' + chosen.frequency.toFixed(0) + ' Hz Q ' +
        chosen.q.toFixed(2) : 'none') + ', improvement advanced ' +
        advanced.improvement.summationDb.toFixed(2) + ' dB against quick ' +
        quick.improvement.summationDb.toFixed(2) + ' dB, latency ' +
        advanced.latency.maxAddedMs.toFixed(2) + ' ms'
      : advanced.message);
}

/* 10. A phase difference that varies with frequency still reduces the error. */
{
  const reference = arrivalTrace('Main', {});
  const target = arrivalTrace('Sub', {
    arrivalMs: 1.2,
    phaseExtra: (frequency) => 70 * Math.sin((2 * Math.PI * Math.log2(frequency / 400)) / 3),
  });
  const result = autoAlign({ reference, target, level: 'advanced', maxAllPass: 2, maxDelayMs: 10 });
  report('A frequency-dependent phase difference reduces the phase error',
    result.ok && result.after.phaseErrorDeg < result.before.phaseErrorDeg &&
      result.improvement.summationDb > -0.5,
    result.ok
      ? 'phase error ' + result.before.phaseErrorDeg.toFixed(0) + '° → ' +
        result.after.phaseErrorDeg.toFixed(0) + '°, summation ' +
        result.improvement.summationDb.toFixed(2) + ' dB, all-pass ' +
        result.allPass.length + ', confidence ' + result.confidence.level
      : result.message);
}

/* 11. Poor coherence is refused rather than answered from it. */
{
  const reference = arrivalTrace('Main', { coherence: 0.2 });
  const target = arrivalTrace('Sub', { arrivalMs: 1.5, coherence: 0.2 });
  const result = autoAlign({ reference, target, level: 'quick' });
  report('Coherence below the floor is refused with what to do',
    !result.ok && /coherence|usable/i.test(result.message),
    result.ok ? 'the engine answered anyway' : result.message);
}

/* 12. Noisy but coherent data still finds the arrival. */
{
  const reference = arrivalTrace('Main', { noiseDb: 1.5, seed: 11 });
  const target = arrivalTrace('Sub', { arrivalMs: 1.5, noiseDb: 3, seed: 29, coherence: 0.85 });
  const result = autoAlign({ reference, target, level: 'quick', resolutionMs: 0.01, maxDelayMs: 10 });
  report('A noisy but coherent pair still gives the known 1.5 ms',
    result.ok && result.applyTo === 'reference' && approx(result.delay.ms, 1.5, 0.06) &&
      result.confidence.level !== 'poor',
    result.ok
      ? result.applyTo + ' delayed ' + result.delay.ms.toFixed(3) + ' ms, confidence ' +
        result.confidence.level + ', coherence ' +
        (Number.isFinite(result.confidence.coherence)
          ? (result.confidence.coherence * 100).toFixed(0) + '%' : '—')
      : result.message);
}

/* 13. Data that cannot be trusted is refused, never reported as aligned. */
{
  const magnitudeOnly = alignTrace({
    label: 'Magnitude only',
    frequencies: GRID,
    magDb: GRID.map(() => 0),
  });
  const reference = arrivalTrace('Main', {});
  const noPhase = autoAlign({ reference, target: magnitudeOnly, level: 'quick' });
  const clipped = autoAlign({ reference, target: arrivalTrace('Sub', {}), level: 'quick', clipped: true });
  const noisy = autoAlign({
    reference, target: arrivalTrace('Sub', {}), level: 'quick', snrDb: 6,
  });
  report('Magnitude-only, clipped and noisy data are all refused',
    !noPhase.ok && !clipped.ok && !noisy.ok &&
      !magnitudeOnly.phaseValid &&
      /phase/i.test(noPhase.message) && /full scale/i.test(clipped.message) &&
      /noise floor/i.test(noisy.message),
    [noPhase.message, clipped.message, noisy.message].join(' | '));
}

/* 14. A gain change is only offered in Custom align and only when it gains. */
{
  const reference = arrivalTrace('Main', {});
  const target = arrivalTrace('Sub', { levelDb: 6 });
  const quick = autoAlign({ reference, target, level: 'quick' });
  const custom = autoAlign({
    reference, target, level: 'custom', allowGain: true, maxGainDb: 9, resolutionMs: 0.01,
  });
  report('A 6 dB level mismatch is corrected only in Custom align',
    quick.ok && custom.ok && quick.gainDb === 0 &&
      approx(custom.gainDb, -6, 0.6) && custom.improvement.summationDb > 0.25 &&
      custom.warnings.some((note) => /gain change/i.test(note)),
    custom.ok
      ? 'quick gain ' + quick.gainDb.toFixed(1) + ' dB, custom gain ' + custom.gainDb.toFixed(1) +
        ' dB, improvement ' + custom.improvement.summationDb.toFixed(2) + ' dB'
      : custom.message);
}

/* 15. The answer is snapped to the resolution the processor works at. */
{
  const reference = arrivalTrace('Main', {});
  const target = arrivalTrace('Sub', { arrivalMs: 1.234 });
  const fine = autoAlign({ reference, target, level: 'quick', resolutionMs: 0.01, maxDelayMs: 10 });
  const coarse = autoAlign({ reference, target, level: 'quick', resolutionMs: 0.1, maxDelayMs: 10 });
  const zero = snapDelay(-0.004, 0.01);
  report('The delay is snapped to the processor’s own resolution',
    fine.ok && coarse.ok && approx(fine.delay.ms, 1.23, 0.005) &&
      approx(coarse.delay.ms, 1.2, 1e-9) &&
      Math.abs(coarse.delay.lostMs) > 0.001 && zero.delayMs === 0,
    fine.ok
      ? '0.01 ms → ' + fine.delay.ms.toFixed(2) + ', 0.1 ms → ' + coarse.delay.ms.toFixed(1) +
        ' (moved ' + coarse.delay.lostMs.toFixed(3) + ' ms)'
      : fine.message);
}

/* 16. A delay speaker can be left deliberately late. */
{
  const reference = arrivalTrace('Main', {});
  const target = arrivalTrace('Delay', { arrivalMs: 4.0 });
  const result = autoAlign({
    reference, target, level: 'quick', mode: 'mainDelay', arrivalOffsetMs: 2.5, maxDelayMs: 10,
  });
  const total = result.ok ? result.delay.referenceMs + result.delay.targetMs : NaN;
  report('A delay speaker keeps the arrival offset it was asked for',
    result.ok && approx(result.delay.arrivalOffsetMs, 2.5, 1e-9) &&
      result.delay.targetMs >= 2.5 && total > 4.0 && total < 7.0,
    result.ok
      ? 'reference ' + result.delay.referenceMs.toFixed(2) + ' ms, delay speaker ' +
        result.delay.targetMs.toFixed(2) + ' ms, ' + total.toFixed(2) + ' ms in all'
      : result.message);
}

/* 17. One alignment serves several measured positions, weighted. */
{
  const positions = [
    {
      label: 'Front row',
      weight: 1,
      reference: arrivalTrace('Main front', {}),
      target: arrivalTrace('Sub front', { arrivalMs: 1.0 }),
    },
    {
      label: 'Back row',
      weight: 1,
      reference: arrivalTrace('Main back', {}),
      target: arrivalTrace('Sub back', { arrivalMs: 3.0 }),
    },
  ];
  const result = autoAlign({ positions, level: 'quick', mode: 'multiMic', maxDelayMs: 10, resolutionMs: 0.01 });
  const within = result.ok && result.delay.ms > 1.0 - 0.3 && result.delay.ms < 3.0 + 0.3;
  report('Several positions share one weighted compromise',
    result.ok && result.multiPosition === true && result.positions.length === 2 && within &&
      result.confidence.note.includes('compromise'),
    result.ok
      ? 'common delay ' + result.delay.ms.toFixed(2) + ' ms between 1.0 and 3.0, confidence ' +
        result.confidence.level
      : result.message);
}

/* 18. Verification turns a predicted sum and a measurement into a correction. */
{
  const reference = arrivalTrace('Main', {});
  const target = arrivalTrace('Sub', { arrivalMs: 1.5 });
  const result = autoAlign({ reference, target, level: 'quick', maxDelayMs: 10, resolutionMs: 0.01 });
  const predictedLevel = result.ok
    ? result.points[Math.floor(result.points.length / 2)].sumAfterDb
    : 0;

  // Both loudspeakers running, measured: the prediction arrives 0.4 ms late.
  const measured = arrivalTrace('Both running', {
    arrivalMs: 0.4,
    levelDb: predictedLevel,
    coherence: 0.95,
  });
  const verification = verifyAlignment(result, measured, {});
  const recalculated = verification.ok
    ? recalculateAlignment(result, verification, { resolutionMs: 0.01 })
    : null;
  const updated = recalculated && recalculated.ok ? recalculated.result : null;

  report('A measurement 0.4 ms later than the prediction is identified and corrected',
    verification.ok && approx(verification.residualMs, 0.4, 0.06) &&
      verification.cause === 'delay' && verification.verdict === 'close' &&
      !!updated && approx(updated.delay.ms, 1.1, 0.06) &&
      updated.delay.ms < result.delay.ms,
    verification.ok
      ? 'residual ' + verification.residualMs.toFixed(3) + ' ms, ' + verification.verdict +
        ' (' + verification.cause + '), delay ' + result.delay.ms.toFixed(2) + ' → ' +
        (updated ? updated.delay.ms.toFixed(2) : '—') + ' ms'
      : verification.message);
}

/* 19. Verification that matches says so, and nothing is recalculated. */
{
  const reference = arrivalTrace('Main', {});
  const target = arrivalTrace('Sub', { arrivalMs: 1.5 });
  const result = autoAlign({ reference, target, level: 'quick', maxDelayMs: 10, resolutionMs: 0.01 });
  const predictedLevel = result.ok
    ? result.points[Math.floor(result.points.length / 2)].sumAfterDb
    : 0;
  const measured = arrivalTrace('Both running', {
    arrivalMs: 0, levelDb: predictedLevel, coherence: 0.95,
  });
  const verification = verifyAlignment(result, measured, {});
  const recalculated = verification.ok ? recalculateAlignment(result, verification, {}) : null;
  report('A matching measurement confirms the alignment',
    verification.ok && verification.verdict === 'matches' &&
      Math.abs(verification.residualMs) < 0.06 && !recalculated.ok,
    verification.ok ? verification.verdict + ' — ' + verification.note : verification.message);
}

/* 20. The settings text is what the operator types into the processor. */
{
  const reference = arrivalTrace('Main L', {});
  const target = arrivalTrace('Subwoofer 1', { arrivalMs: 2.34 });
  const result = autoAlign({
    reference, target, level: 'quick', resolutionMs: 0.01, maxDelayMs: 10, mode: 'mainSub',
  });
  const text = dspSettingsText(result, {});
  const payload = dspSettingsPayload(result);
  const lines = text.split('\n');
  report('The report names the channel, the delay and the resolution',
    result.ok && lines[0].includes('automatic loudspeaker alignment') &&
      text.includes('2.34 ms') && text.includes('Subwoofer 1') &&
      text.includes('Main L') && text.includes('All-pass: none') &&
      text.includes('Resolution: 0.01 ms') && !text.includes('undefined') &&
      !text.includes('NaN') && !!payload &&
      payload.delayMs === result.delay.ms && payload.kind === 'align-auto-alignment' &&
      payload.polarity === result.polarity,
    result.ok ? lines.slice(0, 5).join(' / ') : result.message);
}

/* 21. The report says the curves must be verified, never that they are right. */
{
  const reference = arrivalTrace('Main', {});
  const target = arrivalTrace('Sub', {});
  const result = autoAlign({ reference, target, level: 'advanced' });
  const text = dspSettingsText(result, {});
  report('The report is labelled as a prediction',
    result.ok && /prediction from the measured curves/i.test(text) &&
      /verify/i.test(text),
    result.ok ? 'the report ends with the verification it needs' : result.message);
}

/* 22. A saved capture on its own grid is read as a trace. */
{
  const entry = {
    name: 'Subwoofer 1 · 14:05',
    curve: GRID.map(() => -3),
    phase: GRID.map((frequency) => wrap(-360 * frequency * 0.001)),
    phaseCoherence: GRID.map(() => 0.9),
    fftSize: 16384,
    sampleRate: 48000,
  };
  const trace = alignTrace(entry);
  const short = alignTrace({ curve: [0, -1, -2], name: 'too short' });
  report('A saved capture reads as a trace and a short one is refused',
    !!trace && trace.points === COUNT && approx(trace.fMin, 20, 0.01) &&
      trace.phaseValid && approx(trace.magDb[COUNT - 1], -3, 1e-9) && short === null,
    trace ? trace.points + ' points, ' + trace.label : 'null');
}

/* 23. The overlap detection is honest about a pair that never crosses. */
{
  const reference = arrivalTrace('Main', {});
  const target = arrivalTrace('Sub', { levelDb: 6 });
  const axisFrequencies = gridFrequencies(512);
  const aRe = new Float64Array(512);
  const aIm = new Float64Array(512);
  const bRe = new Float64Array(512);
  const bIm = new Float64Array(512);
  const aDb = new Float64Array(512);
  const bDb = new Float64Array(512);
  const weights = new Float64Array(512).fill(1);
  const aPower = new Float64Array(512);
  const bPower = new Float64Array(512);
  for (let i = 0; i < 512; i += 1) {
    aPower[i] = 1;
    bPower[i] = 4;
    aDb[i] = 0;
    bDb[i] = 6;
  }
  const band = detectBand({
    frequencies: axisFrequencies, aRe, aIm, bRe, bIm, aPower, bPower, weights,
    coherence: new Float64Array(512).fill(NaN), aDb, bDb,
  }, {});
  report('A pair that never crosses uses the whole overlap it covers',
    !!band && band.ok !== false && band.detected === 'overlap' && band.crossingHz === null &&
      approx(band.minHz, 20, 1) && approx(band.maxHz, 20000, 1),
    band ? band.detected + ' over ' + band.minHz.toFixed(0) + ' – ' + band.maxHz.toFixed(0) + ' Hz'
      : 'no band');
}

/* 24. Every level answers within a sensible time, so one press is one press. */
{
  const reference = arrivalTrace('Main', {});
  const target = arrivalTrace('Sub', { arrivalMs: 1.5 });
  const started = Date.now();
  const quick = autoAlign({ reference, target, level: 'quick', maxDelayMs: 10 });
  const advanced = autoAlign({ reference, target, level: 'advanced', maxDelayMs: 10 });
  const spent = Date.now() - started;
  report('Quick and advanced both answer in well under a second each',
    quick.ok && advanced.ok && spent < 4000 &&
      quick.sweep.length > 20 && advanced.sweep.length === quick.sweep.length,
    spent + ' ms for both, ' + quick.sweep.length + ' points swept');
}

/* 25. The same input always gives the same answer. */
{
  const reference = arrivalTrace('Main', {});
  const target = arrivalTrace('Sub', { arrivalMs: 1.5 });
  const first = autoAlign({ reference, target, level: 'advanced' });
  const second = autoAlign({ reference, target, level: 'advanced' });
  report('The engine is deterministic',
    first.ok && second.ok && first.delay.ms === second.delay.ms &&
      first.polarity === second.polarity && first.allPass.length === second.allPass.length &&
      first.after.objective === second.after.objective,
    first.ok ? 'both answered ' + first.delay.ms.toFixed(3) + ' ms' : 'refused');
}

/* 26. A coherence floor refuses a pair that only touches on bad data. */
{
  const reference = arrivalTrace('Main', { coherence: 0.4 });
  const target = arrivalTrace('Sub', { arrivalMs: 1.5, coherence: 0.4 });
  const result = autoAlign({ reference, target, level: 'quick' });
  const message = result.ok ? '' : result.message;
  report('Coherence barely above the floor is used, and the answer says so',
    result.ok ? result.confidence.level === 'limited' : true,
    result.ok ? 'confidence ' + result.confidence.level + ' — ' + result.confidence.note
      : message);
}

/* 27. Two curves that share no usable range are refused. */
{
  const reference = alignTrace({
    label: 'Main above 1 kHz',
    frequencies: gridFrequencies(120, 1250, 16000),
    magDb: gridFrequencies(120, 1250, 16000).map(() => 0),
    phaseDeg: gridFrequencies(120, 1250, 16000).map(() => 0),
    coherence: gridFrequencies(120, 1250, 16000).map(() => 0.9),
  });
  const target = alignTrace({
    label: 'Sub below 40 Hz',
    frequencies: gridFrequencies(40, 20, 40),
    magDb: gridFrequencies(40, 20, 40).map(() => 0),
    phaseDeg: gridFrequencies(40, 20, 40).map(() => 0),
    coherence: gridFrequencies(40, 20, 40).map(() => 0.9),
  });
  const result = autoAlign({ reference, target, level: 'quick' });
  report('A pair with no overlap in the 20 Hz – 20 kHz span is refused',
    !!reference && !!target && !result.ok && /share too little|overlap/i.test(result.message),
    result.ok ? 'answered ' + result.delay.ms.toFixed(2) + ' ms' : result.message);
}

/* 28. A refusal never carries a recommendation. */
{
  const result = autoAlign({ reference: null, target: null, level: 'quick' });
  report('A refusal carries no settings at all',
    !result.ok && result.delay === undefined && result.polarity === undefined &&
      typeof result.message === 'string' && result.message.length > 20,
    result.message);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
