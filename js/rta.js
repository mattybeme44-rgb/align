/*
 * The input level band by band, the way a real-time analyser reads it:
 * third-octave or octave bars from 25 Hz to 16 kHz, taken from the
 * short-window spectrum columns the live spectrograph already computes.
 */

export const RTA_THIRD_OCTAVE_CENTRES = [
  25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315,
  400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150,
  4000, 5000, 6300, 8000, 10000, 12500, 16000,
];

export const RTA_OCTAVE_CENTRES = [
  31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
];

/**
 * The input level in each band, in dBFS, from the log-spaced dBFS columns the
 * spectrograph uses (80 columns, 20 Hz up to the sample rate's limit).
 */
export function bandsFromSpectrumColumns(columns, rate, octaves) {
  if (!columns || columns.length < 8 || !(rate > 0) || !(octaves > 0)) return [];

  const upper = Math.min(20000, rate / 2);
  if (!(upper > 20)) return [];
  const count = columns.length;

  const centres = octaves >= 1 ? RTA_OCTAVE_CENTRES : RTA_THIRD_OCTAVE_CENTRES;
  const ratio = Math.pow(2, octaves / 2);

  const bands = [];
  for (const centre of centres) {
    if (centre > upper) continue;
    const low = centre / ratio;
    const high = centre * ratio;

    let sum = 0;
    let counted = 0;
    for (let c = 0; c < count; c++) {
      const f = 20 * Math.exp((c / (count - 1)) * Math.log(upper / 20));
      if (f < low || f > high) continue;
      const value = columns[c];
      if (!Number.isFinite(value)) continue;
      sum += Math.pow(10, value / 10);
      counted += 1;
    }
    if (!counted) continue;
    bands.push({ frequency: centre, db: 10 * Math.log10(sum / counted) });
  }
  return bands;
}
