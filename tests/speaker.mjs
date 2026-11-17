/*
 * Speaker-capture checks, run with Node:
 *
 *   node tests/speaker.mjs
 *
 * Synthetic data with known answers throughout: a catalogue, an impulse
 * envelope decimated from a known impulse response, saved-capture traces fed
 * to the sum prediction, and the storage round trip. Nothing here is a live
 * measurement, and none of it is evidence about a real interface.
 */

import {
  DEFAULT_SPEAKERS,
  addCustomSpeaker,
  curveFrequency,
  impulseEnvelope,
  isSpeakerCapture,
  libraryTrace,
  normalizeImpulseEnvelope,
  normalizeSpeakerCapture,
  normalizeSpeakerList,
  speakerById,
} from '../js/speaker.js';
import { buildSumPreview, bestOverlap } from '../js/sum-preview.js';
import { parseLibrary, mergeLibrary, serializeLibrary, LIBRARY_VERSION } from '../js/library.js';

let passed = 0;
let failed = 0;

function report(name, pass, detail) {
  if (pass) passed += 1;
  else failed += 1;
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + ' — ' + detail);
}

function approx(value, expected, tolerance) {
  return Math.abs(value - expected) <= tolerance;
}

/* 1. The catalogue carries the rig this tool is built for. */
{
  const names = DEFAULT_SPEAKERS.map((speaker) => speaker.name);
  const subs = DEFAULT_SPEAKERS.filter((speaker) => speaker.group === 'Subwoofers');
  const wanted = ['Main L Inner', 'Main L Outer', 'Main R Inner', 'Main R Outer',
    'Mid Delay L', 'Mid Delay R', 'Rear Delay L', 'Rear Delay R'];
  const ok = subs.length === 8 && names[0] === 'Subwoofer 1' && names[7] === 'Subwoofer 8' &&
    wanted.every((name) => names.includes(name));
  report('The default catalogue lists subs, mains and delays', ok,
    subs.length + ' subwoofers, ' + names.length + ' speakers in total');
}

/* 2. A custom speaker is added once; a repeat name is refused. */
{
  const first = addCustomSpeaker(DEFAULT_SPEAKERS, 'Front Fill L');
  const again = addCustomSpeaker([...first.speakers], 'front fill l');
  const found = speakerById(first.speakers, first.speakers[first.speakers.length - 1].id);
  const empty = addCustomSpeaker(DEFAULT_SPEAKERS, '   ');
  report('Custom speakers are added once and deduplicated',
    first.ok && !again.ok && !!found && found.name === 'Front Fill L' && !empty.ok,
    first.ok ? 'added, repeat name refused, empty name refused' : 'add failed');
}

/* 3. The impulse envelope finds a known arrival. */
{
  const fftSize = 8192;
  const sampleRate = 48000;
  const irDb = new Float32Array(fftSize).fill(-120);
  const peakIndex = 73;
  irDb[peakIndex] = 20;
  // A decay tail: -40 dB for 10 ms after the arrival.
  for (let i = peakIndex + 1; i < peakIndex + 480 && i < fftSize; i += 1) irDb[i] = -40;

  const envelope = impulseEnvelope(irDb, sampleRate, fftSize);
  const peakBucket = envelope ? envelope.values.indexOf(Math.max(...envelope.values)) : -1;
  const bucketTime = envelope ? envelope.startMs + peakBucket * envelope.stepMs : NaN;
  report('The stored envelope places a known arrival correctly',
    !!envelope &&
      approx(envelope.peakMs, (peakIndex / sampleRate) * 1000, 0.01) &&
      approx(bucketTime, 0, envelope.stepMs / 2) &&
      Math.max(...envelope.values) === 20 &&
      approx(envelope.startMs, -5, 0.001) &&
      approx(envelope.stepMs, 1, 0.02),
    envelope ? 'peak ' + envelope.peakMs.toFixed(3) + ' ms, bucket at ' +
      bucketTime.toFixed(2) + ' ms, start ' + envelope.startMs + ' ms' : 'null');
}

/* 4. A circular impulse response wraps safely; empty data is refused. */
{
  const fftSize = 8192;
  const sampleRate = 48000;
  const irDb = new Float32Array(fftSize).fill(-120);
  irDb[fftSize - 3] = 12;
  const wrapped = impulseEnvelope(irDb, sampleRate, fftSize);
  const clean = wrapped ? wrapped.values.every((value) => Number.isFinite(value)) : false;
  const peakBucket = wrapped ? wrapped.values.indexOf(Math.max(...wrapped.values)) : -1;
  const bucketTime = wrapped ? wrapped.startMs + peakBucket * wrapped.stepMs : NaN;

  const empty = impulseEnvelope(new Float32Array(fftSize).fill(-120), sampleRate, fftSize);
  const junk = impulseEnvelope(null, sampleRate, fftSize);

  report('The envelope wraps a circular IR and refuses empty data',
    !!wrapped && clean && approx(bucketTime, 0, wrapped.stepMs / 2) &&
      Math.max(...wrapped.values) === 12 && empty === null && junk === null,
    wrapped ? 'wrapped peak lands in the 0 ms bucket; empty IR and null input refused'
      : 'wrap failed');
}

/* 5. A saved curve reads back as a prediction trace on the log grid. */
{
  const entry = {
    curve: new Array(400).fill(-3),
    phase: new Array(400).fill(0),
    fftSize: 16384,
    sampleRate: 48000,
  };
  const trace = libraryTrace(entry);
  const first = trace ? trace.frequencies[0] : NaN;
  const last = trace ? trace.frequencies[trace.frequencies.length - 1] : NaN;
  report('A saved curve maps onto the 20 Hz – 20 kHz log grid',
    !!trace && approx(first, 20, 1e-6) && approx(last, 20000, 1) &&
      approx(curveFrequency(0, 400), 20, 1e-6) && approx(curveFrequency(399, 400), 20000, 1),
    trace ? 'grid ends ' + last.toFixed(1) + ' Hz' : 'null');
}

/* 6. Two identical saved speakers predict +6 dB. */
{
  const entry = {
    curve: new Array(400).fill(0),
    phase: new Array(400).fill(0),
    fftSize: 16384,
    sampleRate: 48000,
  };
  const data = buildSumPreview(libraryTrace(entry), libraryTrace(entry), { delayMs: 0 });
  const worst = data ? data.points.reduce((max, point) => Math.max(max, Math.abs(point.sumDb - 6)), 0) : Infinity;
  report('Two identical saved speakers predict +6 dB', !!data && worst < 0.05,
    data ? 'worst deviation ' + worst.toFixed(4) + ' dB across ' + data.points.length + ' points'
      : 'no prediction');
}

/* 7. The prediction finds a known delay between two saved speakers. */
{
  const entryA = { curve: new Array(400).fill(0), phase: new Array(400).fill(0), fftSize: 16384, sampleRate: 48000 };
  // B arrives 1 ms after A: phase(f) = -360° · f · 0.001 s.
  const entryB = {
    curve: new Array(400).fill(0),
    phase: entryA.curve.map((_, index) => -360 * curveFrequency(index, 400) * 0.001),
    fftSize: 16384,
    sampleRate: 48000,
  };
  const found = bestOverlap(libraryTrace(entryA), libraryTrace(entryB), {});
  // Delaying B further makes it worse; aligning means advancing it, so the
  // convention reports the negative of the arrival difference.
  report('A known 1.0 ms arrival difference is found from saved curves',
    !!found && approx(found.delayMs, -1.0, 0.1),
    found ? found.delayMs.toFixed(2) + ' ms (expected −1.00 ± 0.10)' : 'nothing found');
}

/* 8. A saved curve without phase refuses to predict rather than guessing 0°. */
{
  const entryA = { curve: new Array(400).fill(0), phase: new Array(400).fill(0), fftSize: 16384, sampleRate: 48000 };
  const entryB = { curve: new Array(400).fill(0), fftSize: 16384, sampleRate: 48000 };
  const data = buildSumPreview(libraryTrace(entryA), libraryTrace(entryB), { delayMs: 0 });
  const overlap = bestOverlap(libraryTrace(entryA), libraryTrace(entryB), {});
  report('A magnitude-only capture is refused by the prediction',
    data === null && overlap === null,
    'buildSumPreview and bestOverlap both return null');
}

/* 9. Speaker-capture fields survive a storage round trip. */
{
  const item = {
    schema: 3,
    id: 'm-test',
    name: 'Subwoofer 2 · 14:05',
    date: new Date().toISOString(),
    curve: [0, -1, -2, -3],
    phase: [0, -10, -20, -30],
    phaseCoherence: [1, 1, 0.9, 0.8],
    speaker: { id: 'sub-2', name: 'Subwoofer 2', group: 'Subwoofers' },
    venue: 'The Hall',
    event: 'Sunday show',
    micPosition: { label: 'FOH centre', distanceM: 18.5, heightM: 1.4 },
    inputs: { device: 'Scarlett 4i4', micChannel: 0, refChannel: 3, channelsDetected: '4 ch', sampleRate: 48000 },
    calibration: { name: 'U1 file', offsetDb: -1.5 },
    impulse: { startMs: -5, stepMs: 1, peakMs: 2.4, values: [-60, -20, 0, -10, -40] },
    tags: ['sub', ' array'],
  };
  const serialized = serializeLibrary([item]);
  const parsed = parseLibrary(serialized);
  const normalize = (raw) => ({ ...raw, ...normalizeSpeakerCapture(raw) });
  const merged = parsed.ok ? mergeLibrary([], parsed.items, normalize, () => 'm-fresh') : null;
  const stored = merged && merged.items[0];

  const good = !!stored &&
    isSpeakerCapture(stored) &&
    stored.speaker.name === 'Subwoofer 2' &&
    stored.venue === 'The Hall' &&
    stored.micPosition.distanceM === 18.5 &&
    stored.inputs.refChannel === 3 &&
    stored.calibration.offsetDb === -1.5 &&
    Array.isArray(stored.impulse.values) && stored.impulse.values.length === 5 &&
    stored.impulse.values[2] === 0 &&
    stored.tags.join(',') === 'sub,array';

  report('A speaker capture survives serialize → parse → merge', parsed.ok && good && merged.added === 1,
    parsed.ok ? 'added ' + merged.added + ', impulse ' + stored.impulse.values.length + ' points, tags ' + stored.tags.join('|')
      : parsed.message);
}

/* 10. Corrupt speaker fields degrade safely, never to invented data. */
{
  const junk = normalizeSpeakerCapture({
    speaker: { name: '   ' },
    micPosition: { distanceM: -5 },
    impulse: { startMs: 'nope', stepMs: -3, values: ['x', 1, -200, 99] },
    tags: [null, 'ok', 7],
    venue: 42,
  });
  const clamped = normalizeImpulseEnvelope({ startMs: -2, stepMs: 0.5, peakMs: 1, values: [-200, 99, 'x'] });

  const ok = junk.speaker === null &&
    junk.micPosition === null &&
    junk.venue === '' &&
    junk.tags.join(',') === 'ok' &&
    Array.isArray(junk.impulse.values) && junk.impulse.values.length === 4 &&
    junk.impulse.values[0] === -120 && junk.impulse.values[1] === 1 &&
    junk.impulse.values[2] === -120 && junk.impulse.values[3] === 40 &&
    clamped !== null && clamped.values.length === 3 &&
    clamped.values[0] === -120 && clamped.values[1] === 40 && clamped.values[2] === -120;

  report('Corrupt speaker fields are dropped or clamped, not invented', ok,
    'speaker/micPosition null, tag kept, out-of-range envelope samples clamp to −120…+40 dB');
}

/* 11. An older capture without speaker fields stays readable. */
{
  const legacy = { name: 'Old capture', curve: [0, -1, -2], schema: 2 };
  const normalized = normalizeSpeakerCapture(legacy);
  const trace = libraryTrace({ ...legacy, ...normalized });
  report('A pre-speaker capture still reads as a trace',
    normalized.speaker === null && !isSpeakerCapture(normalized) && !!trace &&
      trace.magDb.length === 3 && trace.phaseDeg === null,
    'magnitude kept, no speaker, no phase');
}

/* 12. The library envelope version stays compatible. */
{
  report('The library envelope version accepts this format', LIBRARY_VERSION >= 1,
    'LIBRARY_VERSION ' + LIBRARY_VERSION);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
