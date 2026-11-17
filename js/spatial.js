/*
 * Spatial averaging across the three measurement microphones.
 *
 * The three transfer functions share one FFT size and sample rate, so their
 * bins already sit on the same frequency grid — nothing is resampled here.
 * Phase is never averaged; each microphone keeps its own.
 */

export const SPATIAL_MODES = [
  { id: 'power', label: 'Power average' },
  { id: 'db', label: 'dB average' },
  { id: 'coherence', label: 'Coherence-weighted' },
];

export const SPATIAL_MODE_IDS = SPATIAL_MODES.map((mode) => mode.id);

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Combine the enabled microphones into one curve.
 *
 * results  — per-microphone result sets, in A/B/C order
 * enabled  — which microphones take part
 * mode     — 'power' | 'db' | 'coherence'
 * correct  — per-microphone additive correction curves in dB, or null
 *
 * Returns { magDb, contributions, usable }: the averaged curve, each
 * microphone's share of it (0…1) and how many microphones contributed.
 *
 * A bin no enabled microphone could contribute to is NaN, not a number: a
 * curve that reads "no data" in the gap is honest, one that reads −140 dB is a
 * measurement the app never made. Each mode divides by its own count of the
 * microphones that actually had a value there, so an input that dropped out
 * cannot bias the average downwards.
 */
export function spatialAverage(results, enabled, mode, correct) {
  const first = results && results[0];
  const bins = first ? first.bins : 0;
  const values = new Float32Array(Math.max(0, bins));
  const count = results ? results.length : 0;
  const contributions = new Array(count).fill(0);

  const active = [];
  for (let i = 0; i < count; i++) {
    const result = results[i];
    const on = enabled ? !!enabled[i] : true;
    if (on && result && result.bins === bins) active.push(i);
  }

  if (!bins || active.length === 0) {
    for (let k = 0; k < values.length; k++) values[k] = NaN;
    return { magDb: values, contributions, usable: 0 };
  }

  const share = new Float64Array(count);
  let totalWeight = 0;

  for (let k = 1; k < bins; k++) {
    let power = 0;
    let powerCount = 0;
    let dbSum = 0;
    let dbCount = 0;
    let weightedPower = 0;
    let weightSum = 0;

    for (const index of active) {
      const result = results[index];
      let db = result.magDb[k];
      if (!finite(db)) continue;

      const correction = correct ? correct[index] : null;
      if (correction && finite(correction[k])) db += correction[k];

      const value = Math.pow(10, db / 10);

      if (mode === 'db') {
        dbSum += db;
        dbCount += 1;
      } else if (mode === 'coherence') {
        // Coherence squared: a microphone the reference barely agrees with
        // contributes little, one that tracks it contributes fully.
        const coherence = finite(result.coh[k])
          ? Math.max(0, Math.min(1, result.coh[k]))
          : 0;
        const weight = coherence * coherence;
        if (weight <= 0) continue;
        weightedPower += value * weight;
        weightSum += weight;
        totalWeight += weight;
        share[index] += weight;
      } else {
        power += value;
        powerCount += 1;
      }
    }

    if (mode === 'db') {
      values[k] = dbCount ? dbSum / dbCount : NaN;
    } else if (mode === 'coherence') {
      values[k] = weightSum > 0 ? 10 * Math.log10(weightedPower / weightSum) : NaN;
    } else {
      values[k] = powerCount ? 10 * Math.log10(power / powerCount) : NaN;
    }
  }

  values[0] = NaN;

  if (mode === 'coherence' && totalWeight > 0) {
    for (let i = 0; i < count; i++) contributions[i] = share[i] / totalWeight;
  } else {
    for (const index of active) contributions[index] = 1 / active.length;
  }

  return { magDb: values, contributions, usable: active.length };
}

/** The plain mean of the per-microphone coherences, for the readout. */
export function meanCoherence(results, enabled) {
  const list = [];
  for (let i = 0; i < (results ? results.length : 0); i++) {
    const result = results[i];
    if (!result || (enabled && !enabled[i])) continue;
    let sum = 0;
    let count = 0;
    const k0 = Math.max(1, Math.round(200 / result.df));
    const k1 = Math.min(result.bins - 1, Math.round(10000 / result.df));
    for (let k = k0; k <= k1; k++) {
      sum += finite(result.coh[k]) ? result.coh[k] : 0;
      count += 1;
    }
    if (count) list.push(sum / count);
  }
  return list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0;
}
