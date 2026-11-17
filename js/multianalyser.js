import { Analyser } from './analyser.js';

/**
 * Three transfer functions against one electrical reference.
 *
 * Each microphone gets its own Analyser, so its cross spectrum, coherence,
 * delay and impulse response are kept apart from the others — nothing is shared
 * but the reference window every one of them is compared against and the sample
 * count that puts all three on the same timebase.
 */
export class MultiAnalyser {
  constructor(fftSize, sampleRate, count) {
    this.sampleRate = sampleRate;
    this.count = Math.max(1, Math.min(3, count || 3));
    this.fftSize = fftSize;
    this.analysers = [];
    for (let i = 0; i < this.count; i++) {
      this.analysers.push(new Analyser(fftSize, sampleRate));
    }
    this.updateRate = 0.1;
  }

  get bins() {
    return this.fftSize / 2 + 1;
  }

  get df() {
    return this.sampleRate / this.fftSize;
  }

  get frames() {
    return this.analysers.length ? this.analysers[0].frames : 0;
  }

  setFftSize(size) {
    this.fftSize = size;
    for (const analyser of this.analysers) analyser.setFftSize(size);
  }

  setSampleRate(rate) {
    this.sampleRate = rate;
    for (const analyser of this.analysers) {
      // setFftSize() rebuilds df and every buffer against the new rate.
      analyser.sampleRate = rate;
      analyser.setFftSize(this.fftSize);
    }
  }

  /** How quickly each analyser follows: 0.01 slow … 1 every frame. */
  setUpdateRate(rate) {
    const value = Math.max(0.005, Math.min(1, Number(rate) || 0.1));
    this.updateRate = value;
    for (const analyser of this.analysers) analyser.updateRate = value;
  }

  reset() {
    for (const analyser of this.analysers) analyser.reset();
  }

  /**
   * One window pair per microphone, all against the same reference window.
   * A microphone that is not connected is passed as null and is not fed.
   */
  accumulate(windows, ref) {
    if (!ref) return;
    for (let i = 0; i < this.analysers.length; i++) {
      const mic = windows && windows[i] ? windows[i] : null;
      if (!mic || !hasEnergy(mic)) continue;
      this.analysers[i].accumulate(mic, ref);
    }
  }

  /** Display-ready results, one per microphone. */
  results(options) {
    return this.analysers.map((analyser) => analyser.results(options));
  }
}

/** Silence is not a measurement, so a dead input never enters the average. */
function hasEnergy(window) {
  let sum = 0;
  for (let i = 0; i < window.length; i++) sum += window[i] * window[i];
  return Math.sqrt(sum / Math.max(1, window.length)) > 1e-7;
}
