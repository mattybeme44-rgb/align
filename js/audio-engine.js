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
  return /iphone|ipad|ipod|built[- ]?in|internal|macbook|imac|display|android|pixel|galaxy|phone/i.test(label || '');
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
    /** One ring per device channel, so every input keeps its own samples. */
    this.rings = [];
    this.channels = 1;
    this.deviceChannels = 1;
    /** What the browser actually handed over, after the capture graph opened. */
    this.actualChannels = 1;
    this.requestedChannels = 2;
    this.micLevel = 0;
    this.channelLevel = [0, 0, 0, 0];
    this.channelClippedUntil = [0, 0, 0, 0];
    /** Logical input -> device channel. Channel 4 is the electrical reference. */
    this.routing = { a: 0, b: 1, c: 2, ref: 3 };
    /** True when two or more inputs are carrying the very same signal. */
    this.channelDuplicated = false;
    /** ScriptProcessor callbacks that arrived late, a sign of underruns. */
    this.droppedCallbacks = 0;
    this.lastCallbackTime = 0;
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
    this.interrupted = '';
    this.trackIssue = '';
  }

  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : 48000;
  }

  get micWritten() {
    return this.rings[0] ? this.rings[0].written : 0;
  }

  /** How many inputs actually carry audio, out of the four possible. */
  get inputCount() {
    return Math.max(0, Math.min(4, this.channels));
  }

  /** The device channel a logical input (a, b, c, ref) is routed to. */
  deviceChannelFor(logical) {
    const value = this.routing[logical];
    return Number.isInteger(value) ? value : 0;
  }

  /**
   * Open the input and start playing the reference.
   * options: { mode: 'auto' | 'phone' | 'interface', deviceId }
   */
  async start(options) {
    const opts = typeof options === 'string' ? { deviceId: options } : options || {};
    const mode = opts.mode || 'auto';
    const deviceId = opts.deviceId || '';
    // The measurement screen asks for one or two channels; the multi-microphone
    // workspace asks for four. The browser decides what it will actually give.
    const wanted = Math.max(1, Math.min(4, Math.round(Number(opts.channels) || 2)));
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

    // A call, the lock screen or another app can take the context away; the
    // meters then freeze with no other sign of why.
    this.interrupted = '';
    if (ctx.addEventListener) {
      ctx.addEventListener('statechange', () => {
        if (this.ctx !== ctx) return;
        this.interrupted = ctx.state === 'running' ? '' : ctx.state;
      });
    }

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
    const channelAttempts = [];
    for (let count = wanted; count >= 2; count--) {
      channelAttempts.push({ channelCount: { ideal: count, max: count } });
    }
    if (deviceId) {
      channelAttempts.forEach((base) => {
        attempts.push(Object.assign({}, base, { deviceId: { exact: deviceId } }));
      });
    }
    channelAttempts.forEach((base) => attempts.push(base));
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
      const wantedDevice = await this.deviceForMode(mode);
      const currentTrack = stream.getAudioTracks()[0];
      const current =
        currentTrack && currentTrack.getSettings ? currentTrack.getSettings().deviceId || '' : '';
      if (wantedDevice && wantedDevice !== current) {
        let switched = null;
        try {
          switched = await this.openStream({
            deviceId: { exact: wantedDevice },
            channelCount: { ideal: wanted, max: wanted },
          });
        } catch (err) {
          // Some inputs refuse a channelCount, so ask once more without it.
          try {
            switched = await this.openStream({ deviceId: { exact: wantedDevice } });
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

    this.trackIssue = '';
    if (track.addEventListener) {
      track.addEventListener('ended', () => {
        this.trackIssue = 'the microphone stream ended';
      });
      track.addEventListener('mute', () => {
        this.trackIssue = 'the system muted the microphone';
      });
      track.addEventListener('unmute', () => {
        this.trackIssue = '';
      });
    }

    let settings = track.getSettings ? track.getSettings() : {};
    this.deviceLabel = track.label || 'audio input';
    this.builtInInput = looksBuiltIn(this.deviceLabel);

    // An interface can open with fewer channels than asked for — one when a
    // stereo or four-channel request was ignored — and then the reference and
    // the extra microphones have nothing to read. Ask once more for exactly the
    // number wanted before accepting what the browser opened.
    if (!this.builtInInput && wanted > 1 && (settings.channelCount || 0) < wanted) {
      try {
        const more = await this.openStream({
          channelCount: { exact: wanted },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        });
        const moreSettings = more.getAudioTracks()[0] && more.getAudioTracks()[0].getSettings
          ? more.getAudioTracks()[0].getSettings()
          : {};
        if ((moreSettings.channelCount || 0) > (settings.channelCount || 0)) {
          stream.getTracks().forEach((t) => t.stop());
          stream = more;
          this.stream = stream;
          settings = moreSettings;
        } else {
          more.getTracks().forEach((t) => t.stop());
        }
      } catch (err) {
        /* the device or the browser will not give that many channels */
      }
    }

    const source = ctx.createMediaStreamSource(stream);
    const streamChannels = Math.max(settings.channelCount || 0, source.channelCount || 0, 1);
    // The built-in microphone is single-channel whatever the browser reports,
    // so it always takes the generated reference on input 1.
    this.channels = this.builtInInput ? 1 : Math.min(streamChannels, wanted);
    this.deviceChannels = this.channels;
    this.actualChannels = this.channels;
    this.requestedChannels = wanted;
    this.deviceIdUsed = settings.deviceId || '';
    this.inputMode = mode;
    this.modeSatisfied = this.inputMatchesMode(mode, this.deviceLabel);

    const capacity = Math.round(ctx.sampleRate * 4);
    this.rings = [];
    for (let c = 0; c < 4; c++) this.rings.push(new Ring(capacity));
    this.micRing = this.rings[0];
    this.refRing = this.rings[1];
    this.channelLevel = [0, 0, 0, 0];
    this.channelClippedUntil = [0, 0, 0, 0];
    this.channelDuplicated = false;
    this.droppedCallbacks = 0;
    this.lastCallbackTime = 0;
    this.micLevel = 0;

    progress('starting audio');

    try {
      const rings = this.rings;
      const inputChannels = Math.max(1, Math.min(4, this.channels));

      // ScriptProcessor rather than AudioWorklet: iOS Safari is stable with it,
      // and a fault inside a worklet takes the whole browser down with it.
      //
      // The input channel count has to match what the device actually gives us:
      // Safari on the iPhone can hand a mono microphone to a stereo-input
      // processor and then deliver nothing but silence.
      // 8192 frames is 170 ms of audio at 48 kHz: the callback is where the
      // browser hands over the input, so a buffer that size absorbs a main
      // thread stall instead of dropping the samples that were taken during it.
      const node = ctx.createScriptProcessor(8192, inputChannels, 1);
      this.captureNode = node;
      // The empty channel of a device that sends fewer channels than the node
      // was built for, allocated once rather than on every audio callback.
      let silence = null;
      let callbacks = 0;

      node.onaudioprocess = (event) => {
        // A restart may already have replaced the graph; ignore late chunks.
        if (this.captureNode !== node) return;
        const input = event.inputBuffer;
        if (!input || input.numberOfChannels === 0) return;

        // Underrun surveillance: a callback that arrives well after its
        // expected time means the main thread missed audio.
        if (event.playbackTime > 0) {
          const step = input.length / this.sampleRate;
          if (this.lastCallbackTime > 0) {
            const gap = event.playbackTime - this.lastCallbackTime;
            if (gap > step * 1.8) this.droppedCallbacks += 1;
          }
          this.lastCallbackTime = event.playbackTime;
        }

        const block = input.getChannelData(0);
        if (!silence || silence.length !== block.length) silence = new Float32Array(block.length);

        // Every channel is pushed in the same callback, so all four inputs share
        // the one sample counter the analysis reads against.
        for (let c = 0; c < inputChannels; c++) {
          const data = c < input.numberOfChannels ? input.getChannelData(c) : null;
          const samples = data || silence;
          rings[c].push(samples);

          const level = data ? rmsOf(samples) : 0;
          this.channelLevel[c] = this.channelLevel[c] * 0.85 + level * 0.15;
          if (data) {
            for (let i = 0; i < samples.length; i++) {
              if (Math.abs(samples[i]) >= 0.999) {
                this.channelClippedUntil[c] = Date.now() + 750;
                break;
              }
            }
          }
        }
        this.micLevel = this.channelLevel[0];

        callbacks += 1;
        if (callbacks % 8 === 0) this.checkChannelSeparation(inputChannels);
      };

      // A near-muted sink keeps the capture node pulled by the graph. Exact
      // zero is what some iOS builds treat as "nothing to render" and skip.
      this.sinkNode = ctx.createGain();
      this.sinkNode.gain.value = 0.0001;
      source.connect(node);
      node.connect(this.sinkNode);
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
    this.rings = [];
    this.generated = null;
    this.micLevel = 0;
    this.channelLevel = [0, 0, 0, 0];
    this.channelDuplicated = false;
    this.droppedCallbacks = 0;
    this.lastCallbackTime = 0;
    this.refOffset = 0;
    this.refAligned = false;
    this.refSamples = [];
  }

  /**
   * Compare the inputs against the first one and note when they are carrying
   * the very same signal: a browser or a driver that up-mixes one channel into
   * four would otherwise look like four working microphones.
   */
  checkChannelSeparation(count) {
    if (count < 2 || this.rings.length < 2) {
      this.channelDuplicated = false;
      return;
    }

    const probe = 4096;
    const base = this.rings[0].written - probe;
    if (probe > 0 && this.rings[0].written < probe * 2) return;

    const window = new Float32Array(probe);
    const other = new Float32Array(probe);
    this.rings[0].read(window, base);
    const baseRms = rmsOf(window);

    let measured = 0;
    let duplicated = 0;

    for (let c = 1; c < count; c++) {
      this.rings[c].read(other, base);
      const rms = rmsOf(other);
      if (rms < 1e-5 || baseRms < 1e-5) continue;
      measured += 1;

      let dot = 0;
      for (let i = 0; i < probe; i++) dot += window[i] * other[i];
      const correlation = dot / (probe * baseRms * rms);
      const sameLevel = Math.abs(rms - baseRms) / Math.max(baseRms, 1e-9) < 0.01;
      if (correlation > 0.9995 && sameLevel) duplicated += 1;
    }

    this.channelDuplicated = measured > 0 && duplicated === measured;
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

  /** Copy a window of one device channel: 0 = input 1 … 3 = input 4. */
  readChannel(target, startIndex, channel) {
    const ring = this.rings[channel];
    if (!ring) {
      target.fill(0);
      return;
    }
    ring.read(target, startIndex);
  }

  readMic(target, startIndex) {
    this.readChannel(target, startIndex, this.deviceChannelFor('a'));
  }

  readRefCaptured(target, startIndex) {
    this.readChannel(target, startIndex, this.deviceChannelFor('ref'));
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
