# Align

A loudspeaker alignment tool that runs in the browser: dual-channel transfer function, delay finder,
impulse response, coherence and EQ suggestions. No build step, no dependencies, nothing leaves the
device — all audio is captured and analysed locally.

Open `index.html` (or tap Run) and press **Start**.

## What it measures

Two signals are compared sample by sample over overlapping windows:

- **reference** — the signal being fed to the system
- **measurement** — the signal coming back from the microphone

The averaged cross spectrum gives the complex transfer function `H = Sxy / Sxx`, from which the app
shows magnitude, phase and coherence. Its inverse transform is the cross-correlation, whose peak is
the delay between the two signals. Delay compensation rotates that delay out of the phase, so the
phase trace shows the system's own phase rather than a slope caused by distance and latency.

## Reference modes

**Generated (single input)** — the reference is the exact noise or sweep the app plays. One
microphone is enough, which is what works on a phone. The catch is that the absolute delay includes
the browser's input/output latency, so treat the delay reading as a relative number between
measurements rather than a physical distance.

**Input 2 (loopback)** — the reference is whatever arrives on input channel 2, which is the true
dual-channel method (Smaart's normal configuration). It needs a two-input interface with the
stimulus also routed to input 2. The delay reading here is the real acoustic path difference, which
is what you want for aligning subwoofers to mains or comparing box positions.

## Using the iPhone's built-in microphone

No interface is needed to try the app. The phone microphone is a single input, and in
*Generated* mode the app plays the reference itself, so one mic is enough.

1. Open the page in Safari (not an in-app browser) and press **Start**, allowing microphone access.
2. Set **Input** to *iPhone microphone*. *Automatic* takes whatever iOS routes to, which is also
   fine; the status line names the device the app actually got.
3. Leave **Reference** on *Generated (single input)* and **Measurement input** on *Input 1*. The
   app forces both when the input turns out to be mono, and the status line confirms
   "phone microphone · generated reference".
4. The phone's speaker and microphone are the same device, so keep the level low and put the phone on
   a stand away from the speaker, or use headphones, to avoid howl (acoustic feedback).
5. Read the trace as relative: the delay includes the phone's input/output latency, so compare the
   Δ between captures rather than trusting the absolute value.

If the input meters move but you hear nothing, press the iPhone's volume buttons — iOS keeps a
separate volume for web audio, and the silent switch does not always affect it.

A built-in mic is omnidirectional and uncalibrated, so the magnitude curve is the room and the mic's
own response together. Treat it as a functional check until the interface is connected.

## Using a USB-C audio interface on iPhone

iOS treats a connected USB audio interface as the system audio device: Safari's microphone and its
output both move to the interface, so the app records from the interface instead of the phone mic.
No driver or native app is needed, but iOS only re-picks the route when the audio stream is opened.

1. Connect the interface to the iPhone's USB-C port. Most bus-powered interfaces run fine; a
   multi-input interface with phantom power may need a powered USB-C hub.
2. Open this page in Safari (it must be HTTPS — the preview link is), press **Start**, and allow
   microphone access.
3. Set **Input** to *USB audio interface* (or pick it by name under *Detected inputs*). iOS keeps
   the previous route until the stream is reopened, so press **Restart** if you chose it before
   plugging the interface in.
4. The **Input** panel now shows the device name, its channel count and the running sample rate, plus
   live meters for input 1 and input 2. If both meters sit at zero, the phone mic is still in use:
   tap **Restart**, which closes and reopens the stream so iOS follows the new route.
5. Watch which meter moves and set **Measurement input** to that channel.
6. For the true dual-channel method, feed the interface's second input with the reference signal
   (loopback, or the processor output), set **Reference** to *Input 2 (loopback)* and pick the input
   the reference arrives on.
7. Set the interface to 48 kHz, turn off any onboard EQ, dynamics or reverb, and enable phantom power
   for a condenser measurement mic.

Practical notes for iOS:

- Safari exposes at most the first two inputs of a multichannel interface.
- The app runs at whatever sample rate the audio context gets; the actual rate is shown in the Input
  panel. Everything is analysed against that rate, so a 44.1 kHz interface works fine.
- iOS ignores a pinned `deviceId` in many cases; the app falls back to the current route and says so
  in the status line, which is why the Input panel reports the device it really got.
- Audio stops when you leave Safari or lock the screen, and resumes on Start.

### If Start does nothing or the page disappears

Browsers built into other apps (including a chat app's own browser) usually cannot open the
microphone, and iOS can dismiss the web view as soon as something asks for audio. Open this address
in **Safari** instead — tap the share icon, then **Open in Safari**. When audio fails the app now says
so on screen and offers a Copy link button, instead of failing silently.

## Typical alignment workflow

1. Play pink noise into the system at a moderate level.
2. Point the mic at the first source (or put it in the listening position) and let the trace settle.
3. Read the delay in the metrics row.
4. Press **Capture A**.
5. Move to the second source, or change the delay/EQ you are testing.
6. Compare: the **Δ vs A** metric shows the delay difference directly, and the ghost trace shows
   the first magnitude response behind the live one.

To align two sources, add physical or processor delay until the Δ is zero (or a whole multiple of
the crossover period), and use the phase trace to confirm they track through the crossover region.

## Controls

- **Input** — *iPhone microphone*, *USB audio interface*, or a specific device under *Detected
  inputs*. Changing it while running reopens the stream, which is when iOS picks the new route.
- **Signal** — pink noise (the usual choice), white noise, a sine, or a 20 Hz–20 kHz log sweep.
- **Level** — output level of the stimulus.
- **FFT size** — 8192 to 65536. Bigger windows give finer frequency resolution (1.5 Hz at 32768 /
  48 kHz) and a longer delay range, but average more slowly.
- **Averaging** — how quickly the exponential average forgets old frames. Slow for a stable read,
  fast while things are moving.
- **Smoothing** — fractional-octave smoothing for a readable magnitude trace.
- **Normalize** — references the magnitude to the 300 Hz–3 kHz band average so repeated
  measurements line up.
- **Compensate** — removes the measured delay from the phase. Turn it off to see the raw phase
  including delay.
- **Offset (ms) / Find delay** — locks the compensation offset. Find delay runs a long FFT over the
  last 65536 samples and stores the total there; the reading stays the same before and after.
- **Capture A / Clear A** — snapshot for A/B comparison.

## EQ suggestions

The response is compared in 1/3-octave bands against the local median, and bands that deviate by
more than 3 dB (with coherence above 0.5) are listed as corrections. They are a starting point for a
parametric EQ, not a substitute for judgement: a dip is usually better fixed by geometry or delay
than by boosting.

## Limits worth knowing

- Levels are **dBFS**, not dB SPL. Absolute SPL needs a calibrated mic and a sensitivity offset,
  which this version does not apply.
- No RTA, spectrogram, or multi-time-window view yet.
- Browser audio is resampled to the context rate; very fine low-frequency work benefits from a
  proper two-channel interface in loopback mode.
- On iOS the microphone needs HTTPS (the preview link is).
- Reflections dominate small rooms. Gating the impulse response is the next thing this would need
  for meaningful in-room magnitude curves.

## Files

- `js/fft.js` — radix-2 FFT, Hann window
- `js/signals.js` — deterministic looping noise, sine and sweep generation
- `js/audio-engine.js` — capture (ScriptProcessor) and looping stimulus, ring buffers
- `js/analyser.js` — averaging, transfer function, coherence, impulse response, EQ suggestions
- `js/charts.js` — canvas plots
- `js/app.js` — UI wiring
