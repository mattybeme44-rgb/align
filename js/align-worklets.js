// AudioWorklet processors for Align. Loaded with audioWorklet.addModule() from
// a real URL: iOS WebKit is unreliable with blob: URLs for worklet modules.

class AlignPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = null;
    this.pos = 0;
    this.running = false;
    this.blocks = 0;
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
    const buffer = this.buffer;
    if (!this.running || !buffer || buffer.length === 0) {
      out.fill(0);
      return true;
    }
    const len = buffer.length;
    let pos = this.pos;
    for (let i = 0; i < out.length; i++) {
      out[i] = buffer[pos];
      pos += 1;
      if (pos >= len) pos -= len;
    }
    this.pos = pos;

    // Report the playback position occasionally so the main thread can tie the
    // microphone timeline to the reference buffer.
    this.blocks += 1;
    if (this.blocks % 8 === 0) {
      this.port.postMessage({ type: 'pos', pos: pos });
    }
    return true;
  }
}

class AlignCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    // Batch blocks into ~43 ms chunks: one message instead of one per 128
    // frames, which keeps the main thread (and iOS) much happier.
    this.chunk = 2048;
    this.left = new Float32Array(this.chunk);
    this.right = new Float32Array(this.chunk);
    this.fill = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const left = input[0];
    if (!left) return true;
    const right = input.length > 1 ? input[1] : null;

    for (let i = 0; i < left.length; i++) {
      this.left[this.fill] = left[i];
      this.right[this.fill] = right ? right[i] : 0;
      this.fill += 1;

      if (this.fill >= this.chunk) {
        this.port.postMessage(
          { a: this.left, b: this.right, stereo: Boolean(right) },
          [this.left.buffer, this.right.buffer],
        );
        this.left = new Float32Array(this.chunk);
        this.right = new Float32Array(this.chunk);
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor('align-player', AlignPlayer);
registerProcessor('align-capture', AlignCapture);
