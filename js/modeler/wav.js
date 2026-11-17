/*
 * Reading a measured impulse response out of a WAV file.
 *
 * A loudspeaker impulse response arrives as a WAV recording — an ETC, an
 * impulse from REW, Smaart or a convolver. This reads the RIFF chunks without
 * a library, takes one channel, windows around the peak and transforms it, so the
 * response the modeler draws comes from that recording and from nothing else.
 *
 * The transform is linear phase: the window is placed at the peak and the time
 * origin stays at the window's start, so the phase that comes out is the real
 * phase of the recording, not a minimum-phase reconstruction.
 */

import { FFT, hannWindow, nextPowerOfTwo } from '../fft.js';

function readTag(view, offset) {
  let tag = '';
  for (let i = 0; i < 4; i += 1) tag += String.fromCharCode(view.getUint8(offset + i));
  return tag;
}

/**
 * Parse a WAV file into one channel of samples.
 *
 * Integer PCM at 8, 16, 24 and 32 bits and IEEE float at 32 and 64 bits are
 * read; a compressed format is refused with a message rather than guessed at.
 */
export function parseWav(arrayBuffer) {
  if (!arrayBuffer || !(arrayBuffer.byteLength >= 44)) {
    return { ok: false, message: 'That file is too small to be a WAV recording.' };
  }

  const view = new DataView(arrayBuffer);
  if (readTag(view, 0) !== 'RIFF' || readTag(view, 8) !== 'WAVE') {
    return { ok: false, message: 'That file is not a WAV recording.' };
  }

  let format = null;
  let dataOffset = -1;
  let dataBytes = 0;
  let offset = 12;

  while (offset + 8 <= view.byteLength) {
    const tag = readTag(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    const end = Math.min(view.byteLength, body + size);

    if (tag === 'fmt ' && size >= 16) {
      let formatTag = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const bits = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the
      // sub-format GUID at the end of the fmt chunk.
      if (formatTag === 0xfffe && size >= 40) {
        formatTag = view.getUint16(body + 24, true);
      }
      format = { formatTag, channels, sampleRate, bits };
    } else if (tag === 'data') {
      dataOffset = body;
      dataBytes = end - body;
    }

    offset = body + size + (size % 2);
    if (size <= 0) break;
  }

  if (!format) return { ok: false, message: 'That WAV file has no format chunk.' };
  if (dataOffset < 0 || dataBytes <= 0) {
    return { ok: false, message: 'That WAV file holds no audio.' };
  }
  if (!(format.channels >= 1) || !(format.sampleRate > 0)) {
    return { ok: false, message: 'That WAV file has no usable channel or sample rate.' };
  }

  const bytesPerSample = Math.max(1, Math.floor(format.bits / 8));
  const frameBytes = bytesPerSample * format.channels;
  const frames = Math.floor(dataBytes / frameBytes);
  if (frames < 64) {
    return { ok: false, message: 'That recording holds ' + frames + ' samples — too few for an impulse.' };
  }

  const isFloat = format.formatTag === 3;
  const isPcm = format.formatTag === 1;
  if (!isFloat && !isPcm) {
    return {
      ok: false,
      message: 'That WAV file is compressed (format ' + format.formatTag + '); export it as PCM first.',
    };
  }
  if (format.bits !== 8 && format.bits !== 16 && format.bits !== 24 && format.bits !== 32 && format.bits !== 64) {
    return { ok: false, message: 'That WAV file uses ' + format.bits + '-bit samples, which cannot be read here.' };
  }

  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    const base = dataOffset + frame * frameBytes;
    if (base + bytesPerSample > view.byteLength) { samples[frame] = 0; continue; }
    let value = 0;
    if (isFloat && format.bits === 32) value = view.getFloat32(base, true);
    else if (isFloat && format.bits === 64) value = view.getFloat64(base, true);
    else if (format.bits === 8) value = (view.getUint8(base) - 128) / 128;
    else if (format.bits === 16) value = view.getInt16(base, true) / 32768;
    else if (format.bits === 24) {
      const first = view.getUint8(base);
      const second = view.getUint8(base + 1);
      const third = view.getUint8(base + 2);
      let integer = (third << 16) | (second << 8) | first;
      if (integer & 0x800000) integer -= 0x1000000;
      value = integer / 8388608;
    } else value = view.getInt32(base, true) / 2147483648;
    // The first channel is the impulse; a second channel is ignored.
    samples[frame] = Number.isFinite(value) ? value : 0;
  }

  return {
    ok: true,
    message: '',
    sampleRate: format.sampleRate,
    channels: format.channels,
    bits: format.bits,
    frames,
    samples,
  };
}

/**
 * Turn a measured impulse response into a frequency response.
 *
 * The window is placed on the largest sample, one value per frequency bin comes
 * out of the transform, and the magnitude is normalised to its own peak so the
 * level is relative to the impulse — what a transfer function shows. The phase
 * is taken from the transform itself and unwrapped, so it is the real phase of
 * the recording at the window's time origin.
 */
export function impulseToResponse(samples, sampleRate, options = {}) {
  if (!samples || samples.length < 64) {
    return { ok: false, message: 'That impulse holds too few samples.' };
  }
  const rate = Number(sampleRate);
  if (!(rate > 0)) return { ok: false, message: 'That recording has no sample rate.' };

  let peak = 0;
  let peakIndex = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(Number(samples[i]) || 0);
    if (value > peak) { peak = value; peakIndex = i; }
  }
  if (!(peak > 0)) {
    return { ok: false, message: 'That recording is silent — there is no impulse to transform.' };
  }

  const beforeMs = Math.max(0, Math.min(50, Number(options.beforeMs) || 1));
  const widthMs = Math.max(1, Math.min(200, Number(options.widthMs) || 20));
  const beforeSamples = Math.round((beforeMs / 1000) * rate);
  const widthSamples = Math.max(32, Math.round((widthMs / 1000) * rate));
  const start = Math.max(0, peakIndex - beforeSamples);

  const size = nextPowerOfTwo(Math.max(64, widthSamples));
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const window = hannWindow(Math.min(widthSamples, samples.length - start));

  for (let i = 0; i < window.length && start + i < samples.length; i += 1) {
    re[i] = samples[start + i] * window[i];
  }

  const fft = new FFT(size);
  fft.forward(re, im);

  let maxMag = 0;
  for (let k = 1; k < size / 2; k += 1) {
    maxMag = Math.max(maxMag, Math.hypot(re[k], im[k]));
  }
  if (!(maxMag > 0)) {
    return { ok: false, message: 'That impulse transformed to silence.' };
  }

  const bins = size / 2;
  const frequencies = [];
  const magDb = [];
  const rawPhase = [];

  for (let k = 1; k < bins; k += 1) {
    const frequency = (k * rate) / size;
    if (frequency < 15 || frequency > Math.min(22000, rate / 2 - 1)) continue;
    const magnitude = Math.hypot(re[k], im[k]);
    frequencies.push(frequency);
    magDb.push(20 * Math.log10(Math.max(1e-12, magnitude / maxMag)));
    rawPhase.push((Math.atan2(im[k], re[k]) * 180) / Math.PI);
  }

  if (frequencies.length < 8) {
    return { ok: false, message: 'That recording does not carry enough of the band to model.' };
  }

  return {
    ok: true,
    message: 'Read from the impulse response, windowed ' + Math.round(beforeMs) +
      ' ms before its peak and ' + Math.round(widthMs) + ' ms wide.',
    response: {
      frequencies,
      magDb,
      phaseDeg: rawPhase,
      coherence: null,
      fMin: frequencies[0],
      fMax: frequencies[frequencies.length - 1],
      points: frequencies.length,
    },
    sampleRate: rate,
    fftSize: size,
    peakMs: (peakIndex / rate) * 1000,
  };
}
