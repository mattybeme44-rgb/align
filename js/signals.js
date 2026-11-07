/** Deterministic noise and test signal generation. */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Make a buffer genuinely loopable: generate `length + fade` samples and
 * cross-fade the tail over the head, so the wrap point is continuous.
 */
function loopify(length, fade, generate) {
  const total = length + fade;
  const raw = new Float32Array(total);
  generate(raw);

  for (let i = 0; i < fade; i++) {
    const w = i / fade;
    raw[i] = raw[i] * w + raw[i + length] * (1 - w);
  }

  const out = new Float32Array(length);
  out.set(raw.subarray(0, length));
  return out;
}

function normalize(data, peak) {
  let max = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > max) max = a;
  }
  if (max > 0) {
    const g = peak / max;
    for (let i = 0; i < data.length; i++) data[i] *= g;
  }
  return data;
}

function noise(noiseType, length) {
  const rand = mulberry32(0x9e3779b9);
  const out = new Float32Array(length);
  if (noiseType === 'white') {
    for (let i = 0; i < length; i++) out[i] = rand() * 2 - 1;
    return out;
  }
  // Paul Kellet's pink filter.
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < length; i++) {
    const w = rand() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    out[i] = pink * 0.11;
  }
  return out;
}

/**
 * Build a looping test signal.
 * kind: 'pink' | 'white' | 'sine' | 'sweep'
 */
export function generateSignal(kind, sampleRate, sineHz) {
  const fade = 2048;

  if (kind === 'white' || kind === 'pink') {
    const length = Math.round(sampleRate * 4);
    const out = loopify(length, fade, (target) => {
      target.set(noise(kind, target.length));
    });
    return normalize(out, 0.85);
  }

  if (kind === 'sine') {
    const hz = Math.min(20000, Math.max(20, sineHz || 1000));
    const seconds = 2;
    const length = Math.round(sampleRate * seconds);
    const cycles = Math.max(1, Math.round(hz * seconds));
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = 0.6 * Math.sin((2 * Math.PI * cycles * i) / length);
    }
    return out;
  }

  if (kind === 'sweep') {
    const length = Math.round(sampleRate * 4);
    const sweepSeconds = 3;
    const sweepSamples = Math.round(sampleRate * sweepSeconds);
    const f0 = 20;
    const f1 = 20000;
    const ratio = f1 / f0;
    const out = new Float32Array(length);
    for (let i = 0; i < sweepSamples; i++) {
      const t = i / sweepSamples;
      // Exponential sweep phase integral.
      const phase = ((2 * Math.PI * f0 * sweepSeconds) / Math.log(ratio)) * (Math.pow(ratio, t) - 1);
      out[i] = 0.7 * Math.sin(phase);
    }
    const ramp = Math.round(sampleRate * 0.01);
    for (let i = 0; i < ramp && i < sweepSamples; i++) {
      const g = i / ramp;
      out[i] *= g;
    }
    for (let i = 0; i < ramp; i++) {
      const idx = sweepSamples - 1 - i;
      if (idx > 0) out[idx] *= i / ramp;
    }
    return out;
  }

  return new Float32Array(Math.round(sampleRate));
}
