/*
 * The hardware screen's judgement logic, exercised in Node against synthetic
 * inputs.
 *
 *   node tests/hardware.mjs
 *
 * This tests how a result is DECIDED from a measurement — the tolerances, the
 * flatness arithmetic, the deviation from expected — and that nothing is
 * reported as PASS when nothing was measured. It is not a hardware test: no
 * audio interface is opened and no result here says anything about any device.
 */

import { createHardwareCheck, TOLERANCE, PASS, FAIL, UNVERIFIED } from '../js/hardware.js';

let passed = 0;
let failed = 0;

function report(name, pass, detail) {
  if (pass) passed += 1;
  else failed += 1;
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + ' — ' + detail);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function whiteNoise(length, seed) {
  const random = mulberry32(seed);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = random() * 2 - 1;
  return out;
}

// Enough of a document for the constructor and for reportLines(); the
// judgements themselves never touch the DOM.
globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
};
globalThis.window = { devicePixelRatio: 1 };
// Node 22 defines navigator as a getter, so it has to be redefined rather than
// assigned.
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'node-test', mediaDevices: null },
  configurable: true,
  writable: true,
});

const SIGNAL_LENGTH = 8192 * 8;

/** An engine stub that replays synthetic signals through readChannel. */
function fakeEngine(options) {
  const settings = options || {};
  const channels = settings.channels === undefined ? 4 : settings.channels;
  const rate = settings.rate || 48000;
  return {
    running: settings.running !== false,
    ctx: { sampleRate: rate, state: 'running' },
    interrupted: settings.interrupted || '',
    trackIssue: settings.trackIssue || '',
    requestedChannels: 4,
    channels,
    actualChannels: channels,
    deviceLabel: settings.label || 'Test interface',
    sampleRate: rate,
    droppedCallbacks: settings.droppedCallbacks || 0,
    channelDuplicated: !!settings.duplicated,
    channelCorrelation: settings.correlation || new Float64Array([1, 0.01, 0.02, 0.03]),
    channelLevel: settings.levels || [0.1, 0.1, 0.1, 0.1],
    channelClippedUntil: [0, 0, 0, 0],
    micWritten: settings.written === undefined ? 60000 : settings.written,
    readChannel: settings.readChannel || ((target) => target.fill(0)),
    start: async () => channels,
    stop: () => {},
  };
}

function makeScreen(engine) {
  return createHardwareCheck({ engine, setStatus: () => {}, sourceOptions: () => ({}) });
}

/* 1. The tolerances are the documented ones. */
report('Tolerances are the documented numbers',
  TOLERANCE.loopbackRippleDb === 0.5 && TOLERANCE.loopbackCoherence === 0.95
  && TOLERANCE.micCoherence === 0.8 && TOLERANCE.loopbackDelayMs === 0.1,
  'ripple ' + TOLERANCE.loopbackRippleDb + ' dB, coherence ' + TOLERANCE.loopbackCoherence +
  ', mic coherence ' + TOLERANCE.micCoherence + ', delay ±' + TOLERANCE.loopbackDelayMs + ' ms');

/* 2. Channel count decides the interface verdict. */
{
  const four = makeScreen(fakeEngine({ channels: 4 }));
  four.state.running = true;
  const fourVerdict = four.judgements.interfaceResult();
  const three = makeScreen(fakeEngine({ channels: 3 }));
  three.state.running = true;
  const threeVerdict = three.judgements.interfaceResult();
  report('Four inputs pass the interface test and three fail it',
    fourVerdict.result === PASS && threeVerdict.result === FAIL,
    '4 channels → ' + fourVerdict.result + ', 3 channels → ' + threeVerdict.result +
    ' (' + threeVerdict.why + ')');
}

/* 3. Duplicate inputs are caught even when all four are loud. */
{
  const engine = fakeEngine({
    channels: 4,
    levels: [0.2, 0.2, 0.2, 0.2],
    correlation: new Float64Array([1, 0.9999, 0.4, 0.2]),
  });
  const screen = makeScreen(engine);
  screen.state.running = true;
  screen.state.levels = [0.2, 0.2, 0.2, 0.2];
  const verdict = screen.judgements.inputsResult();
  report('An input carrying the same signal as input 1 fails', verdict.result === FAIL,
    verdict.result + ' — ' + verdict.why);

  const good = makeScreen(fakeEngine({ channels: 4, levels: [0.2, 0.2, 0.2, 0.2] }));
  good.state.running = true;
  good.state.levels = [0.2, 0.2, 0.2, 0.2];
  const goodVerdict = good.judgements.inputsResult();
  report('Four independent, live inputs pass', goodVerdict.result === PASS,
    goodVerdict.result + ' — ' + goodVerdict.why);
}

/* 4. A silent reference is not passed. */
{
  const screen = makeScreen(fakeEngine({ channels: 4 }));
  screen.state.running = true;
  screen.state.refLevel = 0;
  const silent = screen.judgements.referenceResult();
  screen.state.refLevel = 0.2;
  const live = screen.judgements.referenceResult();
  report('A silent reference is not passed',
    silent.result !== PASS && live.result === PASS,
    'silent → ' + silent.result + ', live → ' + live.result + ' (' + live.why + ')');
}

/* 5. A flat loopback passes and a coloured one fails. */
function runPair(transform) {
  const source = whiteNoise(SIGNAL_LENGTH, 3);
  const engine = fakeEngine({ levels: [0.2, 0.2, 0.2, 0.2], written: SIGNAL_LENGTH });
  // Channel 0 carries the source, channel 1 the transformed copy.
  engine.readChannel = (target, startIndex, channel) => {
    let state = 0;
    for (let i = 0; i < target.length; i++) {
      const index = startIndex + i;
      const value = index >= 0 && index < SIGNAL_LENGTH ? source[index] : 0;
      if (channel === 1) {
        const out = transform(value, index, state);
        state = out.state;
        target[i] = out.value;
      } else {
        target[i] = value;
      }
    }
  };
  const screen = makeScreen(engine);
  screen.state.running = true;
  screen.state.levels = [0.2, 0.2, 0.2, 0.2];
  screen.state.loopFrom = 0;
  screen.state.loopTo = 1;
  screen.runLoopback();
  return screen.state.loopback;
}

{
  const flat = runPair((value) => ({ value, state: 0 }));
  report('A flat loopback measures flat, coherent and undelayed',
    !!flat && flat.result === PASS && !!flat.measured
    && flat.measured.ripple < TOLERANCE.loopbackRippleDb
    && flat.measured.coherence > TOLERANCE.loopbackCoherence
    && Math.abs(flat.measured.delayMs) <= TOLERANCE.loopbackDelayMs,
    flat && flat.measured
      ? 'ripple ' + flat.measured.ripple.toFixed(3) + ' dB, coherence ' +
        (flat.measured.coherence * 100).toFixed(1) + '%, delay ' + flat.measured.delayMs.toFixed(3) +
        ' ms, verdict ' + flat.result
      : 'no measurement');
}

{
  // A one-pole low-pass colours the curve: it must not pass the flatness test.
  const coloured = runPair((value, index, state) => {
    const next = 0.9 * state + value;
    return { value: next, state: next };
  });
  report('A coloured loopback fails the flatness test',
    !!coloured && coloured.result === FAIL,
    coloured && coloured.measured
      ? 'ripple ' + coloured.measured.ripple.toFixed(2) + ' dB, coherence ' +
        (coloured.measured.coherence * 100).toFixed(1) + '%, verdict ' + coloured.result
      : 'no measurement');
}

/* 6. A delayed loopback is caught by the delay tolerance. */
{
  const delaySamples = 48; // 1 ms at 48 kHz
  const source = whiteNoise(SIGNAL_LENGTH, 9);
  const engine = fakeEngine({ levels: [0.2, 0.2, 0.2, 0.2], written: SIGNAL_LENGTH });
  engine.readChannel = (target, startIndex, channel) => {
    for (let i = 0; i < target.length; i++) {
      const index = startIndex + i - (channel === 1 ? delaySamples : 0);
      target[i] = index >= 0 && index < SIGNAL_LENGTH ? source[index] : 0;
    }
  };
  const screen = makeScreen(engine);
  screen.state.running = true;
  screen.state.levels = [0.2, 0.2, 0.2, 0.2];
  screen.state.loopFrom = 0;
  screen.state.loopTo = 1;
  screen.runLoopback();
  const measured = screen.state.loopback;
  const expected = (delaySamples / 48000) * 1000;
  report('A 1 ms loopback delay is measured and fails the tolerance',
    !!measured && measured.result === FAIL && !!measured.measured
    && Math.abs(measured.measured.delayMs - expected) < 0.05,
    measured && measured.measured
      ? 'measured ' + measured.measured.delayMs.toFixed(3) + ' ms against ' + expected.toFixed(3) +
        ' ms, verdict ' + measured.result
      : 'no measurement');
}

/* 7. Nothing measured is never reported as PASS. */
{
  const screen = makeScreen(fakeEngine({ channels: 4, levels: [0, 0, 0, 0] }));
  const text = screen.reportLines();
  const lines = text.split('\n').filter((line) => /^(Loopback|Mic [ABC]|Inputs|Interface|Reference):/.test(line));
  const anyPass = lines.some((line) => line.includes(': PASS'));
  report('Nothing measured is never reported as PASS', !anyPass,
    lines.map((line) => line.split(':')[0] + ' ' + line.split(': ')[1].split(' — ')[0]).join(', '));
}

/* 8. The report states what was measured. */
{
  const screen = makeScreen(fakeEngine({
    channels: 4, levels: [0.1, 0.1, 0.1, 0.1], rate: 44100, label: 'Test interface',
  }));
  const text = screen.reportLines();
  report('The report states the device, channels and rate',
    text.includes('Device: Test interface') && text.includes('Channels delivered: 4')
    && text.includes('Sample rate: 44100'),
    text.split('\n').slice(2, 9).join(' | '));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
