/*
 * The room's modes, the impulse-response file, the session log and the EQ match,
 * against numbers with a known answer.
 *
 *   node tests/roommodes.mjs
 *
 * The modes come from the classic rectangular-room formula, so a room of known
 * size has known frequencies; the WAV header is bytes; the log and the match are
 * plain data. Nothing here is a live measurement.
 */

import { computeRoomModes, nearestBandCentre, measuredBand } from '../js/roommodes.js';
import { encodeFloat32Wav, impulseSlice, impulseFileName } from '../js/irwav.js';
import {
  appendEntry,
  filterEntries,
  entriesToCsv,
  normalizeEntries,
  loadEntries,
  persistEntries,
  SESSION_LOG_LIMIT,
} from '../js/sessionlog.js';
import { matchFiltersToCurve } from '../js/eq-match.js';

let passed = 0;
let failed = 0;

function report(name, pass, detail) {
  if (pass) passed += 1;
  else failed += 1;
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + ' — ' + detail);
}

const ROOM = { widthM: 4, lengthM: 5, heightM: 2.5 };

/* 1. The axial modes of a known room. */
{
  const modes = computeRoomModes(ROOM);
  const length1 = modes.find((mode) => mode.orderLabel === 'L1');
  const width1 = modes.find((mode) => mode.orderLabel === 'W1');
  const height1 = modes.find((mode) => mode.orderLabel === 'H1');
  const expected = [34.3, 42.9, 68.6];
  const measured = [length1 && length1.frequency, width1 && width1.frequency, height1 && height1.frequency];
  const close = measured.every((value, index) => Math.abs(value - expected[index]) < 0.15);
  report('Axial modes of a 4 × 5 × 2.5 m room', close,
    'L1 ' + measured[0] + ' Hz, W1 ' + measured[1] + ' Hz, H1 ' + measured[2] + ' Hz');
}

/* 2. Every mode is in range, sorted strongest first, and carries its type. */
{
  const modes = computeRoomModes(ROOM);
  const all = computeRoomModes(ROOM, { limit: 400 });
  const inRange = modes.every((mode) => mode.frequency >= 20 && mode.frequency <= 300);
  const sorted = modes.every((mode, index) => index === 0 || modes[index - 1].strength >= mode.strength);
  const types = new Set(all.map((mode) => mode.type));
  report('Modes stay between 20 and 300 Hz, strongest first, with all three types',
    all.length > 12 && modes.length === 30 && inRange && sorted &&
      types.has('axial') && types.has('tangential') && types.has('oblique'),
    all.length + ' modes in all, ' + modes.length + ' listed · first ' + modes[0].frequency + ' Hz ' +
      modes[0].typeLabel + ' · types ' + Array.from(types).join('/'));
}

/* 3. The nearest third-octave centre, from the app's own ladder. */
{
  const a = nearestBandCentre(43);
  const b = nearestBandCentre(31);
  report('Modes snap to the nearest third-octave band', a === 40 && b === 31.5,
    '43 Hz → ' + a + ' Hz, 31 Hz → ' + b + ' Hz');
}

/* 4. A peak in the measurement reads as a deviation in its band. */
{
  const bins = 400;
  const magDb = new Float32Array(bins);
  const coh = new Float32Array(bins).fill(1);
  for (let k = 56; k <= 70; k += 1) magDb[k] = 6;
  const res = { magDb, coh, bins, df: 1 };
  const band = measuredBand(res, 63);
  const quiet = measuredBand(res, 250);
  report('A raised band reads as a deviation, a flat one as zero',
    band && band.deviationDb > 4 && quiet && Math.abs(quiet.deviationDb) < 0.01 && band.coherence > 0.9,
    '63 Hz ' + (band ? band.deviationDb.toFixed(1) : '—') + ' dB, 250 Hz ' +
      (quiet ? quiet.deviationDb.toFixed(1) : '—') + ' dB');
}

/* 5. The WAV file is a 32-bit float, mono, at the rate it was measured. */
{
  const bytes = encodeFloat32Wav(new Float32Array([0, 0.5, -0.25]), 48000);
  const view = new DataView(bytes.buffer);
  const ascii = (offset) => String.fromCharCode(bytes[offset], bytes[offset + 1],
    bytes[offset + 2], bytes[offset + 3]);
  const format = view.getUint16(20, true);
  const channels = view.getUint16(22, true);
  const rate = view.getUint32(24, true);
  const bits = view.getUint16(34, true);
  const size = view.getUint32(40, true);
  const second = view.getFloat32(48, true);
  report('The impulse file is a mono 32-bit float WAV',
    ascii(0) === 'RIFF' && ascii(8) === 'WAVE' && ascii(12) === 'fmt ' && ascii(36) === 'data' &&
      format === 3 && channels === 1 && rate === 48000 && bits === 32 && size === 12 &&
      Math.abs(second - 0.5) < 1e-6 && bytes.length === 44 + 12,
    'fmt ' + format + ', ' + channels + ' channel, ' + rate + ' Hz, ' + bits + ' bits, ' +
      size + ' bytes of samples');
}

/* 6. The slice runs from the impulse peak for the window asked for. */
{
  const length = 4800;
  const irRe = new Float32Array(length);
  irRe[480] = 1;
  irRe[481] = 0.5;
  const slice = impulseSlice({ irRe, irIm: new Float32Array(length), sampleRate: 48000 }, 20);
  report('The impulse slice starts at the peak and lasts the window',
    slice && slice.samples.length === 960 && Math.abs(slice.peakMs - 10) < 0.01 &&
      Math.abs(slice.samples[0] - 1) < 1e-6 && Math.abs(slice.lengthMs - 20) < 0.01,
    slice ? slice.samples.length + ' samples · peak ' + slice.peakMs.toFixed(2) + ' ms · ' +
      slice.lengthMs.toFixed(1) + ' ms' : 'no slice');
  report('The file name carries the rate and the delay',
    impulseFileName({ sampleRate: 48000 }, 3.25) === 'align-impulse-48000Hz-delay3.25ms.wav',
    impulseFileName({ sampleRate: 48000 }, 3.25));
}

/* 7. The session log keeps the newest first, trims to its limit, filters and exports. */
{
  let log = [];
  for (let i = 0; i < 5; i += 1) {
    log = appendEntry(log, { at: 1000 + i, kind: 'capture', label: 'Capture ' + i, detail: i + ' ms' });
  }
  const newest = log[0].label === 'Capture 4';
  const filtered = filterEntries(log, 'Capture 2');
  const many = Array.from({ length: SESSION_LOG_LIMIT + 30 }, (unused, index) => ({
    at: index, kind: 'export', label: 'Report ' + index,
  }));
  const trimmed = normalizeEntries(many);
  const csv = entriesToCsv(log);
  report('The log is newest first, searchable, trimmed and exportable',
    newest && filtered.length === 1 && trimmed.length === SESSION_LOG_LIMIT &&
      csv.startsWith('time,type,what,figures') && csv.split('\n').length === 6 &&
      csv.includes('"Capture 4"'),
    log.length + ' entries · ' + filtered.length + ' on search · ' + trimmed.length + ' after trim');

  const storage = {
    value: null,
    getItem() { return this.value; },
    setItem(key, text) { this.value = text; },
  };
  persistEntries(log, storage);
  const reloaded = loadEntries(storage);
  report('The log survives a reload through its storage', reloaded.length === 5 &&
    reloaded[0].label === 'Capture 4', reloaded.length + ' entries read back');
}

/* 8. The EQ match moves the live curve onto the other one. */
{
  const bins = 800;
  const flat = { magDb: new Float32Array(bins), coh: new Float32Array(bins).fill(1), bins, df: 1 };
  const bumped = { magDb: new Float32Array(bins), coh: new Float32Array(bins).fill(1), bins, df: 1 };
  for (let k = 90; k <= 112; k += 1) bumped.magDb[k] = 6;

  const outcome = matchFiltersToCurve(bumped, flat, { limit: 6 });
  const filter = outcome.filters[0];
  report('A band that sits 6 dB high asks for a cut there',
    outcome.added === 1 && filter && filter.frequency === 100 && filter.gainDb < -4,
    outcome.added + ' filter · ' + (filter ? filter.frequency + ' Hz at ' + filter.gainDb + ' dB' : 'none'));

  const same = matchFiltersToCurve(flat, flat, { limit: 6 });
  report('Identical curves ask for nothing', same.added === 0 && same.isError,
    same.message);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
