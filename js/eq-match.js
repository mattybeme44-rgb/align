/*
 * Building EQ filters that bring one measured curve onto another.
 *
 * The Auto-EQ action aims at a target curve. This aims at a curve that was
 * actually measured — another speaker, a saved capture, a reference — because
 * matching two boxes of the same system is a different job from matching a
 * target. Pure arithmetic: the designer decides what to do with the filters.
 */

export const MATCH_MIN_DEVIATION_DB = 2.5;
export const MATCH_MAX_FILTERS = 6;
export const MATCH_MAX_CUT_DB = 12;
export const MATCH_MAX_LIFT_DB = 6;
export const MATCH_COHERENCE_GATE = 0.35;

const BAND_CENTRES = [
  40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000,
  1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000,
];

const BAND_RATIO = Math.pow(2, 1 / 6);

function bandMean(trace, frequency) {
  if (!trace || !(trace.bins > 2) || !trace.magDb) return null;
  const df = Number.isFinite(trace.df) && trace.df > 0
    ? trace.df
    : (trace.sampleRate > 0 && trace.fftSize > 1 ? trace.sampleRate / trace.fftSize : null);
  if (!df) return null;
  const low = Math.max(1, Math.floor((frequency / BAND_RATIO) / df));
  const high = Math.min(trace.bins - 1, Math.ceil((frequency * BAND_RATIO) / df));
  if (!(high >= low)) return null;

  let sum = 0;
  let count = 0;
  let coherence = 0;
  for (let k = low; k <= high; k += 1) {
    const level = trace.magDb[k];
    if (!Number.isFinite(level)) continue;
    sum += level;
    if (trace.coh && Number.isFinite(trace.coh[k])) coherence += trace.coh[k];
    count += 1;
  }
  if (!count) return null;
  return { levelDb: sum / count, coherence: coherence / count };
}

function reference(trace) {
  let sum = 0;
  let count = 0;
  for (const centre of [200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000]) {
    const band = bandMean(trace, centre);
    if (!band) continue;
    sum += band.levelDb;
    count += 1;
  }
  return count ? sum / count : 0;
}

/**
 * The filters that would move `live` onto `other`.
 *
 * Both are normalised to their own 200 Hz–2 kHz average first, so the match is
 * about tone rather than level. A band is used only when both curves are
 * coherent there, the difference is at least 2.5 dB, and there is room for the
 * filter. Cuts are allowed to be deeper than lifts, as with Auto-EQ.
 */
export function matchFiltersToCurve(live, other, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(0, options.limit) : MATCH_MAX_FILTERS;
  if (!live || !other) {
    return { filters: [], added: 0, message: 'both curves are needed for a match', isError: true };
  }
  if (!(limit > 0)) {
    return { filters: [], added: 0, message: 'no empty filter rows — remove one to match', isError: true };
  }

  const liveReference = reference(live);
  const otherReference = reference(other);
  const candidates = [];

  for (const centre of BAND_CENTRES) {
    const here = bandMean(live, centre);
    const there = bandMean(other, centre);
    if (!here || !there) continue;
    if (here.coherence < MATCH_COHERENCE_GATE || there.coherence < MATCH_COHERENCE_GATE) continue;

    const difference = (here.levelDb - liveReference) - (there.levelDb - otherReference);
    if (Math.abs(difference) < MATCH_MIN_DEVIATION_DB) continue;
    candidates.push({ frequency: centre, deviationDb: difference });
  }

  candidates.sort((a, b) => Math.abs(b.deviationDb) - Math.abs(a.deviationDb));

  const filters = [];
  for (const candidate of candidates) {
    if (filters.length >= limit) break;
    const gainDb = Math.max(-MATCH_MAX_CUT_DB, Math.min(MATCH_MAX_LIFT_DB, -candidate.deviationDb));
    if (Math.abs(gainDb) < 0.5) continue;
    filters.push({
      frequency: candidate.frequency,
      gainDb: Math.round(gainDb * 10) / 10,
      q: 1.4,
      deviationDb: Math.round(candidate.deviationDb * 10) / 10,
    });
  }

  if (!filters.length) {
    return {
      filters: [],
      added: 0,
      message: 'nothing to match: no band differs by 2.5 dB where both curves are coherent',
      isError: true,
    };
  }

  return {
    filters,
    added: filters.length,
    message: filters.length + (filters.length === 1 ? ' filter built' : ' filters built') +
      ' from the strongest differences — a starting point to drag and trim',
    isError: false,
  };
}
