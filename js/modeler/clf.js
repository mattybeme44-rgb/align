/*
 * Common Loudspeaker Format (CLF) reader.
 *
 * CLF1 and CLF2 are TAB/space-delimited text files whose fields are written
 * as <KEY> value, as documented by the CLF group (clfgroup.org): CLF v1 from
 * 2005 carries octave data on a 10° grid, CLF2 from 2011 carries third-octave
 * data on a 5° grid with optional phase, filters and multipart files.
 *
 * What this reader takes is the part of the format that is published: the
 * metadata keys, the per-band SENSITIVITY, IMPEDANCE and 6DB-WIDTH-HOR lists.
 * The polar-balloon blocks of CLF2 are only specified in the licensed
 * authoring kit, so they are not decoded here — the importer says so instead
 * of guessing at a grid it cannot verify. EASE GLL and SPK are not read at all:
 * GLL needs AFMG's licensed SDK and SPK has no public specification.
 *
 * The values are kept exactly as the file writes them. The file does not state
 * the reference the sensitivity list is relative to, so it is not assumed.
 */

import { gridFrequency } from './curve.js';

export const CLF_POINTS = 400;

const COMMENT = /^\s*#/;

function keyValue(line) {
  const match = line.match(/^\s*<([A-Za-z0-9_-]+)>\s*(.*)$/);
  if (!match) return null;
  return { key: match[1].toUpperCase(), value: match[2].trim() };
}

function numbers(text) {
  return String(text || '')
    .split(/[\s,;]+/)
    .map((token) => Number(token))
    .filter((value) => Number.isFinite(value));
}

/** The octave or third-octave band centres between two limits. */
export function clfBands(minBand, maxBand, thirdOctave) {
  const low = Number(minBand) > 0 ? Number(minBand) : 63;
  const high = Number(maxBand) > low ? Number(maxBand) : 16000;
  const ratio = thirdOctave ? Math.pow(2, 1 / 3) : 2;
  const bands = [];
  let frequency = low;
  while (frequency <= high * 1.001 && bands.length < 64) {
    bands.push(frequency);
    frequency *= ratio;
  }
  return bands;
}

/**
 * Read a CLF text file.
 *
 * Returns `manufacturer` metadata, the band list, and the per-band level,
 * impedance and 6 dB horizontal beamwidth the file provides. Missing values are
 * left missing; nothing is interpolated into a grid the file did not state.
 */
export function parseClf(text, fileName) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, message: 'That file is empty.' };
  }

  const keys = new Map();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line || COMMENT.test(line)) continue;
    const entry = keyValue(line);
    if (!entry) continue;
    if (!keys.has(entry.key)) keys.set(entry.key, entry.value);
  }

  const versionText = keys.get('VERSION') || '';
  const version = Number(versionText.split(/\s+/)[0]);
  if (!keys.has('MINBAND') && !keys.has('SENSITIVITY')) {
    return { ok: false, message: 'That file does not carry CLF fields — it may not be a CLF file.' };
  }

  const thirdOctave = Number.isFinite(version) ? version >= 2 : false;
  const minBand = Number(keys.get('MINBAND')) || 63;
  const maxBand = Number(keys.get('MAXBAND')) || 16000;
  const bands = clfBands(minBand, maxBand, thirdOctave);

  const sensitivity = numbers(keys.get('SENSITIVITY'));
  const impedance = numbers(keys.get('IMPEDANCE'));
  const beamwidth = numbers(keys.get('6DB-WIDTH-HOR'));

  const warnings = [];
  if (!sensitivity.length && !beamwidth.length) {
    warnings.push('the file carries no sensitivity or beamwidth figures to model');
  }
  if (sensitivity.length && sensitivity.length !== bands.length) {
    warnings.push('the sensitivity list holds ' + sensitivity.length + ' values for ' + bands.length + ' bands');
  }
  if (beamwidth.length && beamwidth.length !== bands.length) {
    warnings.push('the 6 dB width list holds ' + beamwidth.length + ' values for ' + bands.length + ' bands');
  }
  if (keys.has('CLF2')) {
    warnings.push('CLF2 polar-balloon blocks are only in the licensed authoring kit and were not read; ' +
      'only the published band keys are used');
  }

  const readings = [];
  for (let i = 0; i < bands.length; i += 1) {
    const level = i < sensitivity.length ? sensitivity[i] : null;
    readings.push({
      frequency: bands[i],
      levelDb: Number.isFinite(level) ? level : null,
      impedanceOhm: i < impedance.length && Number.isFinite(impedance[i]) ? impedance[i] : null,
      beamwidthDeg: i < beamwidth.length && Number.isFinite(beamwidth[i]) ? beamwidth[i] : null,
    });
  }

  return {
    ok: true,
    message: warnings.join(' · '),
    warnings,
    manufacturer: {
      name: keys.get('MODELNAME') || (fileName ? String(fileName).replace(/\.[^.]+$/, '') : 'CLF loudspeaker'),
      maker: keys.get('MANUFACTURER') || '',
      description: keys.get('DESCRIPTION') || '',
      website: keys.get('WEB-SITE') || '',
      version: keys.get('VERSION') || '',
      minBand,
      maxBand,
      thirdOctave,
      sensitivityInfo: keys.get('SENSITIVITY-INFO') || '',
      impedanceInfo: keys.get('IMPEDANCE-INFO') || '',
      beamwidthInfo: keys.get('6DB-WIDTH-HOR-INFO') || '',
      radiation: keys.get('RADIATION') || '',
      measurementDistance: Number(keys.get('MEASUREMENT-DISTANCE')) || null,
      environment: keys.get('MEASUREMENT-ENVIRONMENT') || '',
      kind: keys.get('TYPE') || '',
    },
    bands,
    readings,
    fileName: fileName || '',
  };
}

/**
 * A manufacturer response on the model grid from a CLF file.
 *
 * The levels are plotted at the file's own band centres, interpolated between
 * them in dB. The CLF file gives no phase, so the curve is magnitude-only —
 * phase is never invented for it, and the model is marked manufacturer data.
 */
export function clfResponse(clf) {
  if (!clf || !clf.ok || !clf.readings || !clf.readings.length) {
    return { ok: false, message: 'That CLF file carries no level to plot.' };
  }
  const known = clf.readings.filter((reading) => Number.isFinite(reading.levelDb));
  if (!known.length) {
    return { ok: false, message: 'That CLF file carries no level to plot.' };
  }

  const magDb = new Float32Array(CLF_POINTS);
  for (let i = 0; i < CLF_POINTS; i += 1) {
    const frequency = gridFrequency(i, CLF_POINTS);
    if (frequency <= known[0].frequency) {
      magDb[i] = known[0].levelDb;
      continue;
    }
    if (frequency >= known[known.length - 1].frequency) {
      magDb[i] = known[known.length - 1].levelDb;
      continue;
    }
    let index = 0;
    while (index < known.length - 1 && known[index + 1].frequency < frequency) index += 1;
    const low = known[index];
    const high = known[index + 1];
    const span = Math.log(high.frequency / low.frequency);
    const t = span > 0 ? Math.log(frequency / low.frequency) / span : 0;
    magDb[i] = low.levelDb + (high.levelDb - low.levelDb) * t;
  }

  return {
    ok: true,
    message: 'Projected from the manufacturer bands as written; the file does not state its reference level.',
    magDb: Array.from(magDb),
    fMin: known[0].frequency,
    fMax: known[known.length - 1].frequency,
    directivity: clf.readings
      .filter((reading) => Number.isFinite(reading.beamwidthDeg) && reading.beamwidthDeg > 0)
      .map((reading) => ({ frequency: reading.frequency, widthDeg: reading.beamwidthDeg })),
  };
}
