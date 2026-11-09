import { generateSignal } from './signals.js';

// Capture uses ScriptProcessorNode and the stimulus an AudioBufferSourceNode.
// Both are old, boring Web Audio and work on iOS Safari; AudioWorklet turned
// out to be the piece that killed the browser on the phone.

class Ring {
  constructor(capacity) {
    this.cap = capacity;
    this.data = new Float32Array(capacity);
    this.written = 0;
  }

  push(chunk) {
    const cap = this.cap;
    let start = this.written % cap;
    let offset = 0;
    let remaining = chunk.length;
    while (remaining > 0) {
      const n = Math.min(remaining, cap - start);
      this.data.set(chunk.subarray(offset, offset + n), start);
      start = (start + n) % cap;
      offset += n;
      remaining -= n;
    }
    this.written += chunk.length;
  }

  /** Copy target.length samples starting at absolute index startIndex. */
  read(target, startIndex) {
    const cap = this.cap;
    const n = target.length;
    const oldest = this.written - cap;
    for (let i = 0; i < n; i++) {
      const index = startIndex + i;
      if (index < oldest || index >= this.written || index < 0) {
        target[i] = 0;
        continue;
      }
      target[i] = this.data[((index % cap) + cap) % cap];
    }
  }
}

function mediaError(err) {
  const name = err && err.name ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new Error('microphone permission was denied');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new Error('no microphone was found');
  }
  return new Error('could not open the microphone: ' + (err && err.message ? err.message : err));
}

function messageOf(err) {
  return err && err.message ? err.message : String(err);
}

function permissionDenied(err) {
  const name = err && err.name ? err.name : '';
  return name === 'NotAllowedError' || name === 'SecurityError';
}

// Labels that identify the device's own microphone instead of a connected
// interface: iOS reports "iPhone Microphone", a Mac "MacBook Pro Microphone".
function looksBuiltIn(label) {
  return /iphone|ipad|ipod|built[- ]?in|internal|macbook|imac|display/i.test(label || '');
}

function rmsOf(channel) {
  let sum = 0;
  for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i];
  return Math.sqrt(sum / channel.length);
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.running = false;
    this.stream = null;
    this.micRing = null;
    this.refRing = null;
    this.channels = 1;
    this.deviceChannels = 1;
    this.micLevel = 0;
    this.channelLevel = [0, 0];
    this.deviceLabel = '';
    this.deviceIdUsed = '';
    this.exactDeviceRejected = false;
    this.usedFallbackConstraints = false;
    this.inputMode = 'auto';
    this.modeSatisfied = true;
    this.builtInInput = false;
    this.generated = null;
    this.signal = 'pink';
    this.sineHz = 1000;
    this.level = 0.2;
    this.playerNode = null;
    this.captureNode = null;
    this.sinkNode = null;
    this.gainNode = null;
    this.refOffset = 0;
    this.refAligned = false;
    this.refSamples = [];
  }

  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : 48000;
  }

  get micWritten() {
    return this.micRing ? this.micRing.written : 0;
  }

  /**
   * Open the input and start playing the reference.
   * options: { mode: 'auto' | 'phone' | 'interface', deviceId }
   */
  async start(options) {
    const opts = typeof options === 'string' ? { deviceId: options } : options || {};
    const mode = opts.mode || 'auto';
    const deviceId = opts.deviceId || '';
    const progress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

    // iOS only lets audio start from inside the tap that called us, so the new
    // context is created before anything is awaited.
    let ctx;
    try {
      ctx = new AudioContext({ latencyHint: 'interactive' });
    } catch (err) {
      throw new Error('audio is unavailable in this browser: ' + messageOf(err));
    }

    const oldCtx = this.ctx;
    this.releaseGraph();
    if (oldCtx && oldCtx !== ctx) oldCtx.close().catch(() => {});
    this.ctx = ctx;

    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch (err) {
        throw new Error('could not start audio here: ' + messageOf(err));
      }
    }

    progress('opening microphone');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('this browser cannot capture audio');
    }

    // Try progressively simpler requests. iOS rejects some constraint sets
    // outright (especially channelCount on the built-in microphone), and a
    // mono phone mic is fine for the generated-reference mode.
    const attempts = [];
    if (deviceId) attempts.push({ deviceId: { exact: deviceId }, channelCount: { ideal: 2, max: 2 } });
    attempts.push({ channelCount: { ideal: 2, max: 2 } });
    attempts.push({});
    attempts.push(true);

    let stream = null;
    let lastError = null;
    this.exactDeviceRejected = false;
    this.usedFallbackConstraints = false;

    for (let i = 0; i < attempts.length; i++) {
      try {
        stream = await this.openStream(attempts[i]);
        this.exactDeviceRejected = i > 0 && Boolean(deviceId);
        this.usedFallbackConstraints = i > 0;
        break;
      } catch (err) {
        lastError = err;
        // A refused permission will not get better with looser constraints.
        if (permissionDenied(err)) break;
      }
    }

    if (!stream) throw mediaError(lastError || new Error('no microphone available'));
    this.stream = stream;

    // Device labels only appear once permission has been granted, so the
    // source choice is applied after a first stream exists.
    if (mode !== 'auto' && !deviceId) {
      const wanted = await this.deviceForMode(mode);
      const currentTrack = stream.getAudioTracks()[0];
      const current =
        currentTrack && currentTrack.getSettings ? currentTrack.getSettings().deviceId || '' : '';
      if (wanted && wanted !== current) {
        let switched = null;
        try {
          switched = await this.openStream({
            deviceId: { exact: wanted },
            channelCount: { ideal: 2, max: 2 },
          });
        } catch (err) {
          // Some inputs refuse a channelCount, so ask once more without it.
          try {
            switched = await this.openStream({ deviceId: { exact: wanted } });
          } catch (fallbackError) {
            // iOS refused the pinned device; keep the route it opened.
          }
        }
        if (switched) {
          stream.getTracks().forEach((t) => t.stop());
          stream = switched;
          this.stream = stream;
        }
      }
    }

    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('the audio input did not provide a track');

    const settings = track.getSettings ? track.getSettings() : {};
    this.deviceLabel = track.label || 'audio input';
    this.builtInInput = looksBuiltIn(this.deviceLabel);
    // The built-in microphone is single-channel even when a channelCount
    // request makes Safari report two, so it always takes the generated
    // reference on input 1.
    this.channels = this.builtInInput ? 1 : settings.channelCount || 1;
    this.deviceChannels = this.channels;
    this.deviceIdUsed = settings.deviceId || '';
    this.inputMode = mode;
    this.modeSatisfied = this.inputMatchesMode(mode, this.deviceLabel);

    const capacity = Math.round(ctx.sampleRate * 4);
    this.micRing = new Ring(capacity);
    this.refRing = new Ring(capacity);
    this.channelLevel = [0, 0];
    this.micLevel = 0;

    progress('starting audio');

    try {
      const source = ctx.createMediaStreamSource(stream);
      const micRing = this.micRing;
      const refRing = this.refRing;

      // ScriptProcessor rather than AudioWorklet: iOS Safari is stable with it,
      // and a fault inside a worklet takes the whole browser down with it.
      this.captureNode = ctx.createScriptProcessor(4096, 2, 1);
      this.captureNode.onaudioprocess = (event) => {
        const input = event.inputBuffer;
        if (!input || input.numberOfChannels === 0) return;
        const left = input.getChannelData(0);
        // A restart may already have replaced the rings; ignore late chunks.
        if (!left || this.micRing !== micRing) return;
        const right = input.numberOfChannels > 1 ? input.getChannelData(1) : null;
        micRing.push(left);
        refRing.push(right || new Float32Array(left.length));

        const leftRms = rmsOf(left);
        const rightRms = right ? rmsOf(right) : 0;
        this.channelLevel[0] = this.channelLevel[0] * 0.85 + leftRms * 0.15;
        this.channelLevel[1] = this.channelLevel[1] * 0.85 + rightRms * 0.15;
        this.micLevel = this.channelLevel[0];

        // A mono device is up-mixed to two channels with silence in the second,
        // so energy there means the interface really is stereo.
        if (!this.builtInInput && rightRms > 1e-5 && this.deviceChannels < 2) {
          this.deviceChannels = 2;
        }
      };

      // A muted sink keeps the capture node pulled by the graph.
      this.sinkNode = ctx.createGain();
      this.sinkNode.gain.value = 0;
      source.connect(this.captureNode);
      this.captureNode.connect(this.sinkNode);
      this.sinkNode.connect(ctx.destination);

      this.gainNode = ctx.createGain();
      this.gainNode.gain.value = this.level;
      this.gainNode.connect(ctx.destination);
    } catch (err) {
      throw new Error('could not start the audio engine: ' + messageOf(err));
    }

    this.running = true;
    this.buildSignal(true);
    return this.channels;
  }

  /** Ask for an input, applying only the constraints that were given. */
  openStream(constraints) {
    let audio = constraints;
    if (audio !== true) {
      audio = Object.assign(
        { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        audio || {},
      );
    }
    return navigator.mediaDevices.getUserMedia({ audio: audio, video: false });
  }

  /** The device a source choice wants, by label; '' when nothing matches. */
  async deviceForMode(mode) {
    let devices = [];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch (err) {
      return '';
    }
    const inputs = devices.filter((device) => device.kind === 'audioinput' && device.deviceId);
    if (mode === 'phone') {
      const phone = inputs.find((device) => looksBuiltIn(device.label));
      return phone ? phone.deviceId : '';
    }
    const external = inputs.find((device) => device.label && !looksBuiltIn(device.label));
    return external ? external.deviceId : '';
  }

  inputMatchesMode(mode, label) {
    if (mode !== 'phone' && mode !== 'interface') return true;
    if (!label || label === 'audio input') return true;
    const builtIn = looksBuiltIn(label);
    return mode === 'phone' ? builtIn : !builtIn;
  }

  /** Drop the stream and every node, leaving the context for stop()/start(). */
  releaseGraph() {
    this.running = false;
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.playerNode) {
      try {
        this.playerNode.stop();
      } catch (err) {
        /* never started */
      }
    }
    if (this.captureNode) this.captureNode.onaudioprocess = null;

    [this.playerNode, this.captureNode, this.sinkNode, this.gainNode].forEach((node) => {
      if (!node) return;
      try {
        node.disconnect();
      } catch (err) {
        /* already disconnected */
      }
    });
    this.playerNode = null;
    this.captureNode = null;
    this.sinkNode = null;
    this.gainNode = null;
    this.micRing = null;
    this.refRing = null;
    this.generated = null;
    this.micLevel = 0;
    this.channelLevel = [0, 0];
    this.refOffset = 0;
    this.refAligned = false;
    this.refSamples = [];
  }

  async stop() {
    this.releaseGraph();
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      try {
        await ctx.close();
      } catch (err) {
        /* already closed */
      }
    }
    this.micLevel = 0;
  }

  setSignal(signal) {
    this.signal = signal;
    if (this.ctx) this.buildSignal();
  }

  setSineHz(hz) {
    this.sineHz = hz;
    if (this.signal === 'sine' && this.ctx) this.buildSignal();
  }

  setLevel(level) {
    this.level = level;
    if (this.gainNode && this.ctx) {
      this.gainNode.gain.setTargetAtTime(level, this.ctx.currentTime, 0.02);
    }
  }

  /** Rebuild the stimulus. `fade` eases the level in instead of jumping to it. */
  buildSignal(fade) {
    if (!this.ctx || !this.gainNode) return;

    if (this.playerNode) {
      try {
        this.playerNode.stop();
      } catch (err) {
        /* not started yet */
      }
      try {
        this.playerNode.disconnect();
      } catch (err) {
        /* already disconnected */
      }
      this.playerNode = null;
    }

    if (this.signal === 'silent') {
      this.generated = null;
      return;
    }

    const data = generateSignal(this.signal, this.sampleRate, this.sineHz);
    const buffer = this.ctx.createBuffer(1, data.length, this.sampleRate);
    buffer.copyToChannel(data, 0);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(this.gainNode);
    source.start();

    // Ease in: dropping a full-level noise loop straight onto a car stereo or
    // a PA is a shock, and there is no time to reach for the volume in the tap
    // that started it.
    if (fade) {
      const now = this.ctx.currentTime;
      const gain = this.gainNode.gain;
      const target = Math.max(this.level, 1e-4);
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(1e-4, now);
      gain.exponentialRampToValueAtTime(target, now + 1.2);
    }

    this.generated = data;
    this.playerNode = source;
    // The stimulus is a plain looping buffer with no playback-position
    // reporting, so the reference is aligned by microphone index and the
    // delay finder measures the resulting constant offset directly.
    this.refOffset = 0;
    this.refAligned = true;
    this.refSamples = [];
  }

  /** Copy a window of one captured channel (0 = input 1, 1 = input 2). */
  readChannel(target, startIndex, channel) {
    const ring = channel === 1 ? this.refRing : this.micRing;
    if (!ring) {
      target.fill(0);
      return;
    }
    ring.read(target, startIndex);
  }

  readMic(target, startIndex) {
    this.readChannel(target, startIndex, 0);
  }

  readRefCaptured(target, startIndex) {
    this.readChannel(target, startIndex, 1);
  }

  readGeneratedRef(target, startIndex) {
    const buffer = this.generated;
    const n = target.length;
    if (!buffer || buffer.length === 0) {
      target.fill(0);
      return;
    }
    const len = buffer.length;
    const start = startIndex + Math.round(this.refOffset);
    let index = ((start % len) + len) % len;
    for (let i = 0; i < n; i++) {
      target[i] = buffer[index];
      index += 1;
      if (index >= len) index -= len;
    }
  }
}
