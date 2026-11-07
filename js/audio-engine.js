import { generateSignal } from './signals.js';

const PLAYER_CODE = `
class AlignPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = null;
    this.pos = 0;
    this.running = false;
    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'buffer') {
        this.buffer = msg.buffer;
        this.pos = 0;
      } else if (msg.type === 'start') {
        this.running = true;
      } else if (msg.type === 'stop') {
        this.running = false;
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const buf = this.buffer;
    if (!this.running || !buf || buf.length === 0) {
      out.fill(0);
      return true;
    }
    const len = buf.length;
    let pos = this.pos;
    for (let i = 0; i < out.length; i++) {
      out[i] = buf[pos];
      pos += 1;
      if (pos >= len) pos -= len;
    }
    this.pos = pos;
    this.blocks = (this.blocks || 0) + 1;
    if (this.blocks % 8 === 0) {
      this.port.postMessage({ type: 'pos', pos: pos });
    }
    return true;
  }
}
registerProcessor('align-player', AlignPlayer);
`;

const CAPTURE_CODE = `
class AlignCapture extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const left = input[0];
    if (!left) return true;
    const right = input.length > 1 ? input[1] : null;
    const copyLeft = new Float32Array(left.length);
    copyLeft.set(left);
    let copyRight = null;
    if (right) {
      copyRight = new Float32Array(right.length);
      copyRight.set(right);
    }
    this.port.postMessage({ a: copyLeft, b: copyRight });
    return true;
  }
}
registerProcessor('align-capture', AlignCapture);
`;

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
    this.generated = null;
    this.signal = 'pink';
    this.sineHz = 1000;
    this.level = 0.35;
    this.playerNode = null;
    this.captureNode = null;
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

  async start(deviceId) {
    await this.stop();

    let ctx;
    try {
      ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    } catch (err) {
      ctx = new AudioContext({ latencyHint: 'interactive' });
    }
    this.ctx = ctx;
    if (ctx.state === 'suspended') await ctx.resume();
    if (!ctx.audioWorklet) throw new Error('AudioWorklet is not supported in this browser');

    const playerUrl = URL.createObjectURL(new Blob([PLAYER_CODE], { type: 'application/javascript' }));
    const captureUrl = URL.createObjectURL(new Blob([CAPTURE_CODE], { type: 'application/javascript' }));
    try {
      await ctx.audioWorklet.addModule(playerUrl);
      await ctx.audioWorklet.addModule(captureUrl);
    } finally {
      URL.revokeObjectURL(playerUrl);
      URL.revokeObjectURL(captureUrl);
    }

    const audioConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2, max: 2 },
    };

    let stream;
    this.exactDeviceRejected = false;
    if (deviceId) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: Object.assign({}, audioConstraints, { deviceId: { exact: deviceId } }),
          video: false,
        });
      } catch (err) {
        // iOS often refuses a pinned device even when the interface is the
        // current route, so fall back to whatever iOS offers.
        this.exactDeviceRejected = true;
        stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
      }
    } else {
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
    }
    this.stream = stream;

    const track = stream.getAudioTracks()[0];
    const settings = track && track.getSettings ? track.getSettings() : {};
    this.channels = settings.channelCount || 1;
    this.deviceChannels = this.channels;
    this.deviceIdUsed = settings.deviceId || '';
    this.deviceLabel = (track && track.label) || 'audio input';

    const capacity = Math.round(ctx.sampleRate * 4);
    this.micRing = new Ring(capacity);
    this.refRing = new Ring(capacity);

    const source = ctx.createMediaStreamSource(stream);

    this.captureNode = new AudioWorkletNode(ctx, 'align-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
    });

    this.captureNode.port.onmessage = (event) => {
      const message = event.data;
      const left = message.a;
      const right = message.b;
      if (!left) return;
      this.micRing.push(left);
      this.refRing.push(right || new Float32Array(left.length));

      const leftRms = rmsOf(left);
      const rightRms = right ? rmsOf(right) : 0;
      this.channelLevel[0] = this.channelLevel[0] * 0.85 + leftRms * 0.15;
      this.channelLevel[1] = this.channelLevel[1] * 0.85 + rightRms * 0.15;
      this.micLevel = this.channelLevel[0];

      // A mono device is up-mixed to two channels with silence in the second,
      // so energy there means the interface really is stereo.
      if (rightRms > 1e-5 && this.deviceChannels < 2) this.deviceChannels = 2;
    };

    // A muted sink keeps the capture node pulled by the graph.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(this.captureNode);
    this.captureNode.connect(sink);
    sink.connect(ctx.destination);

    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = this.level;
    this.gainNode.connect(ctx.destination);

    this.playerNode = new AudioWorkletNode(ctx, 'align-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.playerNode.connect(this.gainNode);
    this.playerNode.port.onmessage = (event) => {
      const message = event.data;
      if (message && message.type === 'pos' && this.micRing) {
        // The mapping from microphone index to playback position is only
        // sampled a few times: message latency would otherwise jitter it,
        // and a stable constant is all the delay finder needs.
        if (this.refSamples.length < 7) {
          this.refSamples.push(message.pos - this.micRing.written);
          if (this.refSamples.length === 7) {
            const sorted = this.refSamples.slice().sort((a, b) => a - b);
            this.refOffset = sorted[3];
            this.refAligned = true;
          }
        }
      }
    };

    this.running = true;
    this.buildSignal();
    return this.channels;
  }

  async stop() {
    this.running = false;
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.playerNode) {
      try {
        this.playerNode.disconnect();
      } catch (err) {
        /* already disconnected */
      }
      this.playerNode = null;
    }
    if (this.captureNode) {
      try {
        this.captureNode.disconnect();
      } catch (err) {
        /* already disconnected */
      }
      this.captureNode = null;
    }
    if (this.gainNode) {
      try {
        this.gainNode.disconnect();
      } catch (err) {
        /* already disconnected */
      }
      this.gainNode = null;
    }
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch (err) {
        /* already closed */
      }
      this.ctx = null;
    }
    this.generated = null;
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

  buildSignal() {
    if (!this.ctx || !this.playerNode) return;
    if (this.signal === 'silent') {
      this.generated = null;
      this.playerNode.port.postMessage({ type: 'stop' });
      return;
    }
    const buffer = generateSignal(this.signal, this.sampleRate, this.sineHz);
    this.generated = buffer;
    this.refOffset = 0;
    this.refAligned = false;
    this.refSamples = [];
    this.playerNode.port.postMessage({ type: 'buffer', buffer: buffer });
    this.playerNode.port.postMessage({ type: 'start' });
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
