/*
 * The impulse response as a WAV file.
 *
 * 32-bit float, mono, at the measurement's own sample rate, so a convolution
 * engine or another analysis tool reads exactly what was measured instead of a
 * picture of it. Written by hand: a WAV header is short and this way the file
 * needs no dependency and no encoding step that could change the samples.
 */

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

/** A mono 32-bit float WAV of the samples given. */
export function encodeFloat32Wav(samples, sampleRate) {
  const rate = Math.round(Number(sampleRate));
  if (!samples || !samples.length || !(rate > 0)) return null;

  const frames = samples.length;
  const dataBytes = frames * 4;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');

  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 3, true); // IEEE float
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 4, true); // bytes per second
  view.setUint16(32, 4, true); // block align
  view.setUint16(34, 32, true); // bits per sample

  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < frames; i += 1) {
    const value = Number(samples[i]);
    view.setFloat32(44 + i * 4, Number.isFinite(value) ? value : 0, true);
  }

  return bytes;
}

/**
 * The impulse response from its peak, for the window asked for.
 *
 * The app keeps the response as its real and imaginary parts; the real part is
 * the signal a convolution engine wants. The window runs from the peak onward,
 * which is where the direct sound and the reflections it is made of live.
 */
export function impulseSlice(res, windowMs) {
  if (!res || !res.irRe || !(res.sampleRate > 0)) return null;
  const length = res.irRe.length;
  if (!(length > 8)) return null;

  let peak = 0;
  let energy = -Infinity;
  for (let i = 0; i < length; i += 1) {
    const re = res.irRe[i];
    const im = res.irIm ? res.irIm[i] : 0;
    const value = re * re + im * im;
    if (value > energy) {
      energy = value;
      peak = i;
    }
  }
  if (!(energy > 0)) return null;

  const requestedMs = Number.isFinite(Number(windowMs)) && Number(windowMs) > 0 ? Number(windowMs) : 20;
  const wanted = Math.max(16, Math.round((requestedMs / 1000) * res.sampleRate));
  const available = length - peak;
  const frames = Math.min(wanted, available);
  if (!(frames > 16)) return null;

  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) samples[i] = res.irRe[peak + i] || 0;

  return {
    samples,
    sampleRate: res.sampleRate,
    peakMs: (peak / res.sampleRate) * 1000,
    lengthMs: (frames / res.sampleRate) * 1000,
  };
}

/** A file name that says what is in the file and how it was taken. */
export function impulseFileName(slice, delayMs) {
  const rate = slice && slice.sampleRate ? Math.round(slice.sampleRate) : 48000;
  const delay = Number.isFinite(Number(delayMs)) ? Number(delayMs).toFixed(2) : '0.00';
  return 'align-impulse-' + rate + 'Hz-delay' + delay + 'ms.wav';
}
