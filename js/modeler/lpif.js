/*
 * Loudspeaker Processing Interchange Format (LPIF) export.
 *
 * Written to Eclipse Audio's published LPIF specification (version 3.6, 22
 * September 2026, eclipseaudio.com/lpif): a preset object with an array of
 * processing blocks, each carrying its own sample rate, delay, gain, mute, invert
 * and either IIR filters or raw biquads. Rational Acoustics' Data Modeler
 * exports its system EQ presets in this format, and its presets "do not include
 * FIR filters nor IIR filter biquad coefficients" per the spec, so the filters
 * here are written as IIR filter specifications, which is what a receiver reads.
 *
 * The filter types are the ones the specification lists. Only the ones with
 * coefficients this app computes are written; a filter the app cannot describe
 * in the spec's own terms is left out and named in the note.
 */

const PLATFORM = 'general';

const TYPE_NAMES = {
  peaking: 'parametric',
  lowShelf: 'low-shelf',
  highShelf: 'high-shelf',
  highPass: 'highpass-butterworth',
  lowPass: 'lowpass-butterworth',
  bandPass: 'band-pass',
  notch: 'notch',
  allPass1: 'allpass',
  allPass2: 'allpass',
  highPass1: 'highpass-butterworth',
  lowPass1: 'lowpass-butterworth',
  gain: 'gain',
};

/** The processing blocks for the current system, as the spec lays them out. */
export function buildLpif(project, options = {}) {
  const settings = (project && project.settings) || {};
  const sources = (project && project.sources) || [];
  const blocks = [];
  const skipped = [];

  let channel = 0;
  for (const source of sources) {
    if (source.muted) continue;
    const filters = (source.filters || []).filter((filter) => filter && filter.enabled !== false);
    if (!filters.length) continue;

    const iir = [];
    for (const filter of filters) {
      const type = TYPE_NAMES[filter.kind];
      if (!type) {
        skipped.push((filter.kind || 'a filter') + ' in ' + source.name);
        continue;
      }
      if (type === 'gain') {
        // A gain is written on the block, not as a filter.
        continue;
      }
      const entry = {
        enable: true,
        platform: PLATFORM,
        type,
        frequency: Math.max(10, Math.min(20000, Math.round(Number(filter.frequency) || 1000))),
        order: 2,
        gain: Number(filter.gainDb) || 0,
      };
      if (type === 'parametric' || type === 'low-shelf' || type === 'high-shelf') {
        entry.q = Math.max(0.1, Number(filter.q) || 0.7071);
      }
      iir.push(entry);
    }

    const block = {
      type: 'output-b',
      channel,
      'channel-name': String(source.name || '').slice(0, 40),
      'sample-rate': Math.round(Number(options.sampleRate) || 48000),
      delay: Number(source.delayMs) || 0,
      gain: Number(source.gainDb) || 0,
      mute: false,
      invert: source.polarity === 'inverted',
    };
    if (iir.length) block.iir = iir;
    blocks.push(block);
    channel += 1;
  }

  // The system EQ of a linked group is a preset of its own, as the spec writes
  // an EQ preset with processing blocks of type "eq".
  const eqFilters = [];
  for (const group of project.groups || []) {
    if (group.muted) continue;
    for (const filter of group.filters || []) {
      const type = TYPE_NAMES[filter.kind];
      if (!type || type === 'gain' || filter.enabled === false) continue;
      eqFilters.push({
        enable: true,
        platform: PLATFORM,
        type,
        frequency: Math.max(10, Math.min(20000, Math.round(Number(filter.frequency) || 1000))),
        order: 2,
        gain: Number(filter.gainDb) || 0,
        ...(type === 'parametric' || type.endsWith('shelf')
          ? { q: Math.max(0.1, Number(filter.q) || 0.7071) }
          : {}),
      });
    }
  }

  const preset = {
    title: String((options.title || settings.projectName || 'Align system')).slice(0, 80),
    program: 'Align · System Data Modeler',
    'program-version': '2026.11',
    'date-time': new Date().toISOString(),
    'processing-blocks': blocks.concat(eqFilters.length ? [{
      type: 'eq',
      'channel-name': 'System EQ',
      'group-channel-names': (project.groups || []).map((group) => group.name).slice(0, 8),
      'sample-rate': Math.round(Number(options.sampleRate) || 48000),
      delay: 0,
      gain: 0,
      mute: false,
      invert: false,
      iir: eqFilters,
    }] : []),
  };

  return {
    ok: blocks.length > 0,
    message: blocks.length
      ? (skipped.length ? 'Left out filters with no LPIF type: ' + skipped.join(', ') + '.' : '')
      : 'No source with an enabled filter is in the sum, so there is nothing to write.',
    preset,
    blockCount: blocks.length,
  };
}

export function lpifText(project, options = {}) {
  const built = buildLpif(project, options);
  return { ...built, text: JSON.stringify({ preset: built.preset }, null, 2) };
}
