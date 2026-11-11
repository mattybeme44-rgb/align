# Align

A loudspeaker alignment tool that runs in the browser: dual-channel transfer function, delay finder,
impulse response, coherence and EQ suggestions. No build step, no dependencies, nothing leaves the
device — all audio is captured and analysed locally.

Open `index.html` (or tap Run) and press **Start**.

To see it working without any hardware or microphone permission, press **Demo measurement** in the
Input card (or **Show a demo** on the banner). The whole analysis path runs on a synthetic speaker —
3.7 ms of propagation delay, room gain low down, a dip near 260 Hz, presence at 2.4 kHz and a soft
top-octave roll-off, with a little noise so coherence is not a flat 100%. Nothing is captured, so it
also works in browsers that cannot open the microphone at all, which makes it the way to check the
app renders and the maths runs before a real measurement.

## Launching it from the phone's Home Screen

Align installs as a home-screen web app: no App Store, no signing, and it opens full screen from its
own icon.

1. Open **https://mattybeme44-rgb.github.io/align/** in Safari — not in an app's browser. That is the
   app's public address, published straight from this repository by GitHub Pages.
2. Press **Start** once there and allow the microphone, so iOS has the permission on record.
3. Tap the **Share** icon, choose **Add to Home Screen**, and confirm.
4. Launch it from the Align icon from then on. There is no address bar, and it keeps its own storage
   and its own place in the app switcher.

The page shows these steps once itself, when it is opened in Safari on an iPhone; **Dismiss** hides
the card for good.

What makes it an app rather than a tab:

- `manifest.webmanifest` — name, icon, colours and `display: standalone`, so the launch is full
  screen.
- `apple-mobile-web-app-*` meta tags in `index.html` — iOS's own version of the same, plus the
  status bar style and the name under the icon.
- `sw.js` — an offline shell, registered from `js/app.js`. It is **network first**: a reload always
  takes the newest published files, and the cached copy is used only when the network fails, so the
  app still starts in a room with no signal and can never be stuck on an old version.

iOS draws the Home Screen icon from a 180×180 PNG, `apple-touch-icon.png` at the repository root; the
manifest's PNGs (`icons/icon-192.png`, `icons/icon-512.png`) carry the same artwork for other browsers.
All three are rasterised from `icons/icon.svg`, so replacing the SVG and re-deriving the PNGs is all a
new icon needs.

In a home-screen app the microphone may still be refused on some iOS versions — a WebKit limitation
rather than an app bug. If **Start** fails there, open the same link in Safari; the app says so on
screen when that happens.

### Sending it to somebody else

**Share** at the top of the page opens iOS's share sheet with Align's address, so the link goes
straight into Messages, Mail or WhatsApp; **Share Align** on the Share card does the same from further
down the page, and **Copy link** puts the address on the clipboard.

**Share measurement** sends what is on screen as text — delay, polarity, coherence, the analysis
settings and the EQ suggestions — which is how a result leaves the phone without a screenshot. It says
there is nothing to share until a measurement has run, and it only offers the result the app is
showing, never a hidden capture.

Neither button hands out a private `--preview` address: the public one is used instead. Where a browser
has no share sheet, both fall back to the clipboard, and the Share card's field shows the text so it
can be selected by hand.

### Enabling Pages (one setting)

The deploy job needs the repository's Pages site to exist, and a workflow token is not allowed to
create it. If the address says "There isn't a GitHub Pages site here", open the repository's
**Settings → Pages**, set **Build and deployment → Source** to **GitHub Actions**, and save. The next
push deploys, or press **Re-run jobs** on the **Actions** tab.

As a stop-gap that needs no Pages, the same files can be served from a CDN straight out of the
public repository:
<https://raw.githack.com/mattybeme44-rgb/align/main/index.html> (tap **Open the page** on its first
screen). That address is somebody else's service, so treat it as temporary.

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
2. Open this page in Safari (it must be HTTPS — the published link is), press **Start**, and allow
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

### Measuring through a Bluetooth output

Bluetooth adds its own latency — usually 100–300 ms — and keeps adjusting it as
its buffer drains and refills. That latency sits inside the measurement and it
moves while you watch, which is why a delay reading over Bluetooth can look as
if it is inverting and jumping at once. Align does three things about it:

- it finds and locks the coarse delay itself with a 131072-sample probe (2.7 s at
  48 kHz), so the number no longer hops by a whole FFT window (341 ms at
  16384 / 48 kHz);
- after that the short window only looks for the peak within a fraction of a
  window either side of zero, so it cannot pick the branch a whole window away in
  the first place, and one bad frame can no longer throw the number across the
  screen;
- polarity is shown only when coherence is high enough for the sign of the peak
  to mean anything, and it changes only after three frames agree, so the
  normal/inverted readout stops flickering. It shows `—` when it cannot tell.

If the status line says **delay keeps moving**, the loss is the link rather than
the room. Use a cable, or the loopback input of a USB-C interface, for anything
that has to be trusted. While you are in the car, also switch off the stereo's
own loudness, EQ and speed-dependent volume where it allows it: they are a second
curve between the phone and the microphone, and a second volume control in front
of the app's **Level**.

### Measuring with the phone's own speaker

The phone microphone and the phone's own speaker are the same device, and the
round trip through iOS — capture buffer, speaker, microphone and the resampling
between them — is often close to half of the default 16384-sample window. That is
exactly where a circular correlation is ambiguous: the peak lands on either side
of the boundary from one frame to the next, and the reading flips between +170 ms
and −170 ms while you watch.

The two-stage delay measurement above is what keeps that steady: the long probe
puts the offset where it belongs, and from then on the short window can no longer
reach the branch a window away. Give it about three seconds after **Start** —
that is how long the probe needs to fill — and the reading settles. If it still
moves after that, the path really is moving (see **delay keeps moving**) and the
delay is only relative. Keep the level low and the phone still, and use a USB-C
interface in loopback mode for anything that has to be trusted.

### If Safari says the page is private

That is the **preview** address (`something--preview.freemilk.app`), which FreeMilk opens for you and
only FreeMilk can open — a normal browser has no session for it. The app says so on its banner when
it notices it is running on a preview host.

Use the published address instead: **https://mattybeme44-rgb.github.io/align/**. It is HTTPS, so the
microphone works there, and it is the address to add to the Home Screen.

### If Start does nothing or the page disappears

Browsers built into other apps (a chat app's own browser included) usually cannot open the
microphone, and iOS closes the whole web view the moment one asks for it — the screen jumps back to
the Home Screen.

The page knows when it is running inside such a browser, so it says so on load and gives **Copy
link** at the top. Press that, open **Safari**, paste the address into the address bar, and press
**Start** there, allowing the microphone. **Try here anyway** skips the warning if you want to test
the browser you are in.

When audio fails inside the page — for instance on a browser with no microphone API — the app also
says which step failed instead of failing silently.

## Typical alignment workflow

1. Play pink noise into the system at a moderate level.
2. Point the mic at the first source (or put it in the listening position) and let the trace settle.
3. Read the delay in the metrics row.
4. Press **Capture A**.
5. Move to the second source, or change the delay/EQ you are testing.
6. Compare: the **Δ vs A** metric shows the delay difference directly, and the ghost trace shows
   the first magnitude response behind the live one. **Capture B** adds a third curve with its own
   **Δ vs B**, and **Arm average / Capture average** settles a power average of repeated captures
   into one pink ghost.
7. Turn on **Gate the impulse response** and drag its band tight around the direct arrival to see the
   loudspeaker rather than the room, then open **Waterfall view** to watch the decay slice by slice.
   Save a measurement from **Saved measurements** to compare a later position against it, or export
   the whole measurement as a **CSV**.

To align two sources, add physical or processor delay until the Δ is zero (or a whole multiple of
the crossover period), and use the phase trace to confirm they track through the crossover region.

## Controls

- **Input** — *iPhone microphone*, *USB audio interface*, or a specific device under *Detected
  inputs*. Changing it while running reopens the stream, which is when iOS picks the new route.
- **Signal** — pink noise (the usual choice), white noise, a sine, or a 20 Hz–20 kHz log sweep.
- **Level** — output level of the stimulus. It starts at 20% and fades in over
  about a second, so a car stereo or a PA already turned up does not get the
  full noise burst the instant Start is pressed.
- **FFT size** — 8192 to 65536. Bigger windows give finer frequency resolution (1.5 Hz at 32768 /
  48 kHz) and a longer delay range, but average more slowly.
- **Averaging** — how quickly the exponential average forgets old frames. Slow for a stable read,
  fast while things are moving.
- **Smoothing** — fractional-octave smoothing for a readable magnitude trace.
- **Target curve** — Off by default; **Flat**, a −1 dB per octave tilt above 1 kHz, or a room curve with
  a +6 dB low end, or a curve you draw yourself in the **Target curve editor** (Edit target) and save
  beside the built-ins. The chosen target is drawn as a faint dashed line behind the live curve on the same
  dB scale, the vertical range widens to include it, and the cursor readout gains a **Δ target** figure
  in dB. The choice is remembered between launches.
- **Normalize** — references the magnitude to the 300 Hz–3 kHz band average so repeated
  measurements line up.
- **Phase / Coherence** — show or hide the phase pane and the coherence band under the magnitude
  curve. All three share the same log-frequency axis, so a feature can be read straight down the
  chart: the magnitude curve with its 3 dB grid, the phase against ±180°, and coherence against 1.
  The phase is read against 1 kHz and eased between frames, so it settles rather than flickering, and
  it is only drawn where coherence is high enough for it to mean anything. The legend at the top says
  which trace is which, and **Capture A / B** add snapshots to it.
- **Compensate** — removes the measured delay from the phase. Turn it off to see the raw phase
  including delay.
- **Level calibration (dB) / Show input level as dB SPL** — the input readout is dBFS by default; a
  calibrated microphone's sensitivity offset turns it into dB SPL. The offset and the unit are
  remembered between launches.
- **Offset (ms) / Find delay** — locks the compensation offset. Find delay runs a long FFT over the
  last 131072 samples and stores the total there; the reading stays the same before and after. The app
  also does this by itself while the measured delay is past what the fine search can hold — a
  Bluetooth output's latency, or the phone's own speaker and microphone, usually is — and stops once an
  offset is typed in or Find delay pressed.
- **Gate the impulse response** — windows the impulse response before the transform, so the magnitude
  curve shows the loudspeaker rather than the room. Drag the band on the impulse plot to move it, grab
  its edges to change the width, or type start and width in milliseconds. A **GATED** badge marks the
  transfer function while it is on.
- **Waterfall view** — the impulse response as a decaying stack of magnitude slices, one window further
  past the impulse peak each time. The time-range and amplitude sliders set how far the slices run and
  how tall the stack is drawn, the gate is marked on the axis, and **Done** returns to the main screen.
  It opens from the Impulse response card once a measurement is running.
- **Capture A / B, Clear A / B** — two snapshots for A/B/C comparison, with **Δ vs A** and **Δ vs B**
  in the metrics row and both ghost traces behind the live one.
- **Arm peak hold / Clear peak** — pins the highest magnitude at each frequency since it was armed,
  drawn as a dim line that only rises.
- **Arm average / Capture average / Clear average** — a running power average of the curves captured
  into it, drawn as a pink dashed ghost and labelled with how many it holds. It resets when the
  measurement is restarted.
- **Capture library** — save the live measurement, Capture A or Capture B with a name, note and the
  settings it was taken with, kept in this browser between launches. Tap entries to overlay up to eight
  curves at once, search, sort, rename, annotate or delete. Phase-capable saves carry a phase overlay
  with its own preview delay. **Export library** writes the whole library as one JSON file and **Import
  library** adds what is not already stored, validating the file before touching anything.
- **EQ designer** — add up to eight peaking, low-shelf, high-shelf and high-pass filters, drag their
  nodes on a log-frequency chart, edit frequency, gain and Q as rows, and read the predicted corrected
  response in lime over the measurement as a dim ghost. It shows the maximum boost and the mean
  deviation from the chosen target, and **Copy filter list** puts the values on the clipboard. The set
  is remembered between launches and never changes the measurement, the gate or the captures.
- **Capture polarity** — compares each held capture's main lobe with the live arrival and says **Inverted
  vs A** or **Same as A** in the metrics row and the status pill, from the wrapped phase difference once
  the delay between the two arrivals is taken out. **Show A/B inverted** previews the correction on the
  phase curves only; amplitude response alone cannot show polarity.
- **Mic calibration file** — **Import calibration** under Analysis reads the frequency/dB file a
  measurement microphone maker ships, takes that response off the displayed magnitude and the band
  table, and leaves phase, coherence and the impulse response as measured. The **cal** badge on the
  transfer card names what is loaded and offers to replace or remove it. It is separate from the dB SPL
  level offset.
- **Export CSV** — one row per frequency bin with frequency, magnitude, phase, coherence and the
  impulse response, plus a header naming the sample rate, FFT size, smoothing, delay, polarity and
  gate; it downloads as a file.

## EQ suggestions

The response is compared in 1/3-octave bands against the local median, and bands that deviate by
more than 3 dB (with coherence above 0.5) are listed as corrections. They are a starting point for a
parametric EQ, not a substitute for judgement: a dip is usually better fixed by geometry or delay
than by boosting.

## Limits worth knowing

- Levels are **dBFS** unless a calibration offset is entered; absolute SPL needs a calibrated mic and
  its sensitivity figure.
- Browser audio is resampled to the context rate; very fine low-frequency work benefits from a
  proper two-channel interface in loopback mode.
- On iOS the microphone needs HTTPS (the published link is).
- Reflections dominate small rooms. Gating the impulse response and reading the waterfall is what
  makes an in-room magnitude curve meaningful.
- A Bluetooth output's latency is neither small nor steady, and it is part of every reading. The app
  locks and smooths what it can; below roughly 1.3 s the delay is usable as a relative number, and
  beyond that the display says it could not settle it.
- Saved measurements and the target/calibration choices live in this browser's storage, so clearing
  site data removes them.

## Files

- `js/fft.js` — radix-2 FFT, Hann window
- `js/signals.js` — deterministic looping noise, sine and sweep generation
- `js/audio-engine.js` — capture (ScriptProcessor) and looping stimulus, ring buffers
- `js/analyser.js` — averaging, transfer function, coherence, impulse response,
  delay tracking, EQ suggestions
- `js/charts.js` — canvas plots: magnitude, phase and coherence on one frequency axis, the target,
  the ghost traces, and the impulse response with its gate
- `js/waterfall.js` — the waterfall's slices and its canvas plot
- `js/app.js` — UI wiring
- `manifest.webmanifest` — home-screen name, icon and full-screen launch
- `sw.js` — offline shell (network first)
- `icons/icon.svg` — app icon
- `icons/icon-192.png`, `icons/icon-512.png`, `apple-touch-icon.png` — the same icon as PNG, for the
  manifest and for iOS's Home Screen
- `.github/workflows/pages.yml` — publishes the repository root to GitHub Pages on every push to
  `main`
