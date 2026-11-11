/*
 * The input level band by band, the way a real-time analyser reads it:
 * from a whole octave down to a sixteenth of one, 25 Hz to 16 kHz, taken
 * from the short-window spectrum the live analyser computes.
 */

export const RTA_WIDTHS = [
  { id: 'octave', subtitle: 'octave', octaves: 1 },
  { id: 'third', subtitle: '1/3 octave', octaves: 1 / 3 },
  { id: 'sixth', subtitle: '1/6 octave', octaves: 1 / 6 },
  { id: 'twelfth', subtitle: '1/12 octave', octaves: 1 / 12 },
  { id: 'sixteenth', subtitle: '1/16 octave', octaves: 1 / 16 },
];

export const RTA_THIRD_OCTAVE_CENTRES = [
  25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315,
  400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150,
  4000, 5000, 6300, 8000, 10000, 12500, 16000,
];

export const RTA_OCTAVE_CENTRES = [
  31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
];

/** The width named by the selector, falling back to third octave. */
export function rtaWidth(id) {
  return RTA_WIDTHS.find((width) => width.id === id) || RTA_WIDTHS[1];
}

/**
 * The centres for any band width, on the base-two grid: 1 kHz × 2^(k/n), with
 * n bands to the octave. The two widths that always had centres of their own
 * keep them, so the familiar 31.5 and 63 Hz labels stay put.
 */
export function rtaCentres(octaves) {
  if (octaves >= 1) return RTA_OCTAVE_CENTRES;
  if (Math.abs(octaves - 1 / 3) < 1e-9) return RTA_THIRD_OCTAVE_CENTRES;

  const n = Math.max(1, Math.round(1 / octaves));
  const first = Math.ceil(n * Math.log2(25 / 1000));
  const last = Math.floor(n * Math.log2(16000 / 1000));
  const centres = [];
  for (let k = first; k <= last; k++) centres.push(1000 * Math.pow(2, k / n));
  return centres;
}

/**
 * The level in each band from a linear FFT spectrum: `values[k]` is the level
 * of the bin at `k * binHz`, in dBFS.
 *
 * A band narrower than one bin — the sixteenth-octave setting below a couple
 * of hundred hertz — reads the nearest bin rather than dropping the bar, so
 * the low end is still there to see.
 */
export function bandsFromBinSpectrum(values, binHz, octaves) {
  if (!values || values.length < 3 || !(binHz > 0) || !(octaves > 0)) return [];

  const top = values.length - 1;
  const upper = binHz * top;
  if (!(upper > 20)) return [];

  const ratio = Math.pow(2, octaves / 2);
  const bands = [];

  for (const centre of rtaCentres(octaves)) {
    if (centre > upper) continue;

    const low = Math.max(binHz, centre / ratio);
    const high = centre * ratio;

    let first = Math.ceil(low / binHz);
    let last = Math.floor(high / binHz);
    if (last < first) {
      const nearest = Math.round(centre / binHz);
      first = nearest;
      last = nearest;
    }
    first = Math.min(top, Math.max(1, first));
    last = Math.min(top, Math.max(first, last));

    let sum = 0;
    let counted = 0;
    for (let bin = first; bin <= last; bin++) {
      const value = values[bin];
      if (!Number.isFinite(value)) continue;
      sum += Math.pow(10, value / 10);
      counted += 1;
    }
    if (!counted) continue;
    bands.push({ frequency: centre, db: 10 * Math.log10(sum / counted) });
  }
  return bands;
}
