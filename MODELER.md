# System Data Modeler

The modelling workspace of the Align web app: import measured loudspeaker
responses, arrange them into a system, predict the complex sum, align the sources
and compare the prediction with a measurement.

Open it with **Data Modeler** in the toolbar of the web app. It is a separate
full-screen workspace of the browser edition. Nothing in it touches the live
measurement, the audio path or a processor: it reads what the measurement app has
already captured, and it computes.

---

## 1. What the reference product documents

The request names Rational Acoustics **Smaart Data Modeler** as the reference.
Its public documentation was read for this report (21 Aug, through the site and
the two PDFs below), because the request asks for the reference's verified
feature set to be separated from the requested feature set.

Sources:

- Landing page — https://www.rationalacoustics.com/pages/data-modeler-landing-page
- Product page — https://www.rationalacoustics.com/products/smaart-data-modeler
- Documentation index — https://support.rationalacoustics.com/support/solutions/articles/150000179777-data-modeler-documentation
- User Guide, 44 pp., "Release 1.1" — https://downloads.rationalacoustics.com/documentation/smaart-dm/Smaart_DM_User_Guide.pdf
- Quick Start Guide, 10 pp. — https://downloads.rationalacoustics.com/documentation/smaart-dm/SmaartDataModelerQuickstartGuide.pdf
- Release notes through v1.2.1 — https://support.rationalacoustics.com/support/solutions/articles/150000179779-smaart-data-modeler-release-notes
- Powersoft XML export — https://support.rationalacoustics.com/support/solutions/articles/150000222688-export-project-as-powersoft-xml
- Target-curve format — https://support.rationalacoustics.com/support/solutions/articles/150000165955-how-to-create-and-import-target-curve-files
- Smaart 9.6 "What's new" — https://support.rationalacoustics.com/support/solutions/articles/150000181439-what-s-new-in-smaart

What the documentation actually states, in short:

- Data Modeler is **DSP modelling software**, not an analyser: it has **no audio
  I/O and does not capture measurements**. Its input is transfer-function data.
- Its only documented input format is **`.trf` from measurement-capable Smaart v7
  or newer** (v6 and older are explicitly unsupported); data moves in by Import
  Trace, Import Trace Folder, drag-and-drop, or Smaart's "Create DSP Channel from
  Selected". Target curves arrive as magnitude-only `.crv`.
- **No FRD, CSV, TXT, WAV/impulse or Open Sound Meter import is documented**;
  a v1.0.2 release note even removed non-`.trf` imports to DSP channels.
- The object model is **Project → DSP channels (+ link channels) → traces → Sum
  Results**, i.e. a loudspeaker is modelled as channels plus traces. There is
  **no loudspeaker library** with manufacturer, model number, impedance,
  sensitivity or directivity fields in the documented project configuration.
- Per channel: polarity, level (−100…+100 dB, 0.1 dB), delay (ms, adjustable
  increment, default 0.1 ms), bypass, and unlimited IIR filters. Link channels
  share DSP across a group. **FIR is explicitly not supported.**
- **Sum mode** adds selected traces with the "absolute phase" of each — the guide
  shows comb notches in the sum and says all contributors must share one
  microphone position and one measurement/reference channel. The guide describes
  the outcome (a sum computed from phase with an automatic time offset between
  measurement time references) but does **not** state explicitly that complex
  arithmetic is used; no formula or "never add dB" statement appears.
- There is **no automatic alignment optimizer**: what exists is Sum Mode
  electing the longest MTR as the reference and applying a time offset to the
  earlier arrival, called "a great starting point" for the DSP delay. No search
  limits, no polarity recommendation, no objective weighting, no confidence
  metric and no alternative solutions are documented.
- **No impulse-response, group-delay or prediction-vs-measurement view is
  documented** for Data Modeler; its Modeler plot is phase above magnitude
  "without Live Impulse Response". Phase wrapping, unwrapping and phase-difference
  traces are not documented as such; coherence blanking (default 20 %) is.
- Export is documented: **Project as PDF**, **Project as LPIF** and **Project as
  Powersoft XML** (plus Bose PEQ XML in 1.2.1). DSP settings export, not a
  measurement report.
- There is no documented multi-position prediction, spatial weighting, geometric
  propagation or room-acoustic prediction; the speed-of-sound setting affects only
  the wavelength readout.

Some requested capabilities therefore go **beyond** the reference product, and
some are shaped differently here. That is called out in the matrix below rather
than blurred.

---

## 2. Capability matrix

Statuses used:

- **Verified** — implemented, and checked by the automated numerical tests
  (section 5).
- **Implemented** — implemented and syntax-checked; it needs a browser/device
  session to be called verified, because this environment cannot click the UI.
- **Partial** — a stated subset is implemented; the rest is named.
- **Not implemented** — deliberately absent.
- **Blocked** — cannot be done honestly with the available information.

### A. The requested capabilities

| Requested capability | In Smaart Data Modeler | Status here | Notes |
|---|---|---|---|
| A real modelling environment, not a drawing | Documented as DSP modelling with no audio I/O | **Verified** (engine) / **Implemented** (screen) | Every trace is computed from imported or measured data. |
| New primary section, leaving the app intact | — | **Implemented** | `Data Modeler` in the toolbar; the measurement screen and its screens are untouched. |
| Data library | Not found (channels + traces only) | **Implemented** | Loudspeakers with datasets, search, rename, delete, details. |
| Model workspace | Project → channels → traces → sum | **Implemented** | Sources, groups, positions, per-source DSP. |
| Frequency response | Yes | **Verified** | Magnitude on a 20 Hz–20 kHz log axis. |
| Phase response | Yes (phase-above-magnitude plot) | **Verified** | Wrapped and unwrapped, coherence-aware. |
| Impulse response | **Not found** for Data Modeler | **Verified** (derived) | Derived by inverse transform of the summed model; labelled derived, never presented as measured. |
| Group delay | **Not found** | **Verified** | From the slope of unwrapped phase, blanked at low coherence and deep nulls. |
| Complex summation | Outcome documented, arithmetic not stated | **Verified** | Complex addition; two equal coherent sources read +6.02 dB, opposite phase cancels. |
| DSP processing | Yes, IIR only, per-channel and linked | **Implemented** | PEQ, shelves, HP/LP/BP/notch/AP, gain, delay, polarity, bypass, reorder. |
| Alignment optimizer | **Not found** (only an automatic time offset) | **Verified** | Delay/polarity search with six objectives, alternatives, nulls, confidence, tradeoff. |
| Prediction vs measurement | **Not found** (no difference or error trace) | **Implemented** | Overlay, difference trace, mean/RMS/largest error, band table. |
| Export and reporting | PDF, LPIF, Powersoft XML, Bose XML | **Implemented** | System CSV, sum FRD, text report, project JSON; not the vendor formats. |
| Dockable, resizable, collapsible panels | — | **Implemented** | Dock left/centre/right, native vertical resize, collapse; layout persisted. |

### B. Import (`3.` in the request)

| Requested source | Reference | Status here | Notes |
|---|---|---|---|
| Align's own measurement sessions | — | **Implemented** | Reads the capture library entries and the current live/held capture. |
| Standard FRD | Not supported in DM | **Verified** | Parsed by content, not just extension. |
| Phase-inclusive response files | Not supported in DM | **Verified** | Phase kept only where the file carries it. |
| TXT and CSV | Not supported in DM | **Verified** | Comma, tab, semicolon or whitespace. |
| WAV impulse responses | Not supported in DM | **Verified** | 8/16/24/32-bit PCM and 32/64-bit float; windowed and transformed. |
| Smaart export formats | `.trf` is DM's own input | **Blocked** | `.trf` is proprietary; a `.trf` file is refused with a message naming the alternatives. |
| Open Sound Meter exports | Not documented for DM | **Partial** | Read through the same columns; not separately verified against an OSM file. |
| Manufacturer data | — | **Implemented** | Via FRD/text, marked as manufacturer data. |
| Flexible column mapping | Not found | **Implemented** | Column, unit (Hz/kHz, dB/linear, deg/rad) and preview before import. |
| Frequency, magnitude, phase, coherence, delay, sample rate, distance, mic position, calibration, reference, conditions, phase validity | Partially: `.trf` carries frequency/magnitude/phase/coherence/MTR; sample rate is project-level; the rest is not stored | **Implemented** | Dataset metadata and model fields carry all of them when the source has them. |
| Warn when two datasets are incompatible | Only prose best practice | **Implemented** | Prediction states when a source has no phase, and the optimizer grades confidence. |

### C. Loudspeaker library (`4.`)

| Field | Reference | Status here |
|---|---|---|
| Manufacturer, model number, type | Not found | **Implemented** |
| Frequency/phase data, impulse when available | Only as traces | **Implemented** |
| Nominal impedance, sensitivity | Not found | **Implemented** |
| Measurement distance, reference delay | Not found | **Implemented** |
| Crossover, directivity, specs, notes | Not found | **Implemented** |
| Several datasets per speaker | One trace per channel | **Implemented** |
| Manufacturer vs measured vs theoretical | Traces only | **Implemented** per model and per dataset |
| Save a measurement as a reusable model | Traces can be saved as `.trf` | **Implemented** |

### D. Math and timing (`5.`–`7.`)

| Capability | Status here | Evidence |
|---|---|---|
| Magnitude/phase complex response engine | **Verified** | Every point is stored as re/im on the grid. |
| Never add dB magnitudes | **Verified** | `sumResponses` adds complex pressure only. |
| 2, 4, 8, 16-source sums, main/sub, arrays | **Verified** (16 in the benchmark) | Arbitrary counts up to the practical limit. |
| Show individual and sum together | **Implemented** | Each trace has its own visibility and colour. |
| Delay in ms, µs, distance, negative offsets, step, numeric entry, sweep | **Verified** | Phase rotation φ = −2πfτ; the optimizer sweeps delay. |
| Sound speed setting | **Verified** | Free-field time and one-over-distance level. |
| Polarity, wrapping, unwrapping, relative phase, phase difference | **Verified** | 180° polarity, wrap/unwrap, phase error in the comparison. |
| Phase alignment at a band | **Implemented** (optimizer phase objective) | Band-limited, not a single-frequency click. |
| Constructive/destructive indication | **Implemented** | Null list with depth and frequency. |

### E. DSP (`8.`)

| Capability | Status here | Notes |
|---|---|---|
| Parametric EQ (frequency, gain, Q/bandwidth, multiple bands) | **Verified** | Exact biquad response. |
| High and low shelf | **Verified** | Same coefficients as the EQ designer. |
| Butterworth, Linkwitz-Riley, Bessel crossovers with slopes | **Verified** | LR is two cascaded Butterworth sections; Bessel at 2/3/4/6/8 order only. |
| High-pass, low-pass, band-pass | **Verified** | Band-pass above its high edge is refused if the edges are crossed. |
| All-pass 1st and 2nd order | **Verified** | Unity magnitude. |
| Gain, delay, polarity, bypass, reorder | **Implemented** | Delay and polarity are source-level; chain order is commutative for a response, and reorder is provided anyway. |
| Each filter's magnitude and phase shown | **Verified** | Drawn in the model, not sketched. |
| Generic DSP import/export | **Partial** | Export to REW-style text plus biquads; chain import is not implemented. |
| Device-specific profiles | **Not implemented** | Would need verified data per processor; none is available here. |

### F. Optimizer (`9.`)

| Capability | Status here | Evidence |
|---|---|---|
| Reference and target selection, band, delay limits/step, polarity, objective | **Verified** | Known 2 ms case recovered; inverted polarity found. |
| Objectives: broadband summation, crossover region, minimum cancellation, minimum phase difference, smoothness, custom weights | **Verified** (numerical) / **Implemented** (UI) | Six objectives. |
| Recommended delay, polarity, predicted summation, cancellation regions, confidence, alternatives | **Verified** | Returned together with data-quality grading. |
| Before/after overlay | **Partial** | The chart redraws, and snapshots keep the before; no single ghosted "after" trace. |
| No claim of one universally optimal delay | **Implemented** | Every result carries the tradeoff and the advice to re-measure. |

### G. Graphs and interaction (`10.`, `14.`)

| Capability | Status here |
|---|---|
| Magnitude, wrapped/unwrapped phase, group delay, impulse, difference, filter response | **Implemented** |
| Log frequency axis, dB windows, frequency limits, smoothing, cursor, markers | **Implemented** (smoothing and wrapping verified numerically) |
| Trace visibility, colour, grouping, A/B, reference locking | **Implemented** (reference = snapshot recall) |
| Zoom, pan, wheel zoom, double-click reset | **Implemented** |
| 60 FPS target | **Implemented** — drawing is on demand, never per analysis frame; see the benchmark. |

### H. Arrays, positions, verification (`11.`–`13.`)

| Capability | Reference | Status here |
|---|---|---|
| Multi-source arrays, named groups, group-level gain/delay/polarity | Yes (channels + link channels) | **Implemented** |
| Group changes do not destroy source settings | — | **Implemented** (effective values are computed, nothing is overwritten) |
| Multiple positions with per-position datasets and weights | Not documented | **Partial** — per-position datasets and position weights are stored and per-source datasets are used per position; a weighted multi-position optimisation across all positions at once is not implemented. |
| Free-field propagation from distance and speed | Only wavelength | **Implemented** (verified) |
| Room-acoustic or directivity prediction | Not claimed | **Not implemented** — deliberately not claimed without the physical data. |
| Overlay predicted and measured, error trace, numeric comparison | Not found | **Implemented** |
| Automatic writing to amplifiers | Not found | **Not implemented** — deliberately; settings are only ever reported. |

### I. Application requirements (`17.`–`19.`)

| Requirement | Status |
|---|---|
| Dense, readable engineering UI; no giant controls | **Implemented** |
| Dark instrument styling with the app's panels | **Implemented** (the app itself is dark) |
| Keyboard shortcuts | **Partial** — the toolbar and fields work; no `[D]`-style hotkeys. |
| Mouse wheel zoom, touch-friendly controls, responsive laptop and phone | **Implemented** (CSS reflows to one column) |
| Share the app's measurement engine, library, sharing, FFT, EQ maths | **Implemented** — imported, not duplicated. |
| No duplicate systems | **Implemented** — the module's own pure engine plus the app's library/sharing. |
| Tests and benchmarks | **Implemented** — section 5. |

---

## 3. Architecture

All of the module lives in `js/modeler/`; nothing else in the app changed except
the toolbar entry and the wiring in `js/app.js`.

- `curve.js` — the 400-point 20 Hz–20 kHz log grid (the same grid the capture
  library samples onto), interpolation, phase unwrap/wrap, fractional-octave
  smoothing, band statistics, curve comparison and the tolerant FRD/TXT/CSV
  reader with its column mapping.
- `filters.js` — biquads: coefficients, exact complex response, the chain
  product, Butterworth/Linkwitz-Riley/Bessel crossover design, text export.
  Peaking and shelving coefficients come from the app's own EQ routine, so the
  EQ designer and the modeler cannot disagree.
- `wav.js` — RIFF/WAV reading (PCM 8/16/24/32 and float 32/64, extensible
  format), windowing and the forward transform of an impulse.
- `model.js` — the complex engine: source evaluation with gain/delay/polarity and
  its chain, group application, complex summation, group delay, impulse
  synthesis, the alignment optimizer, comparison and project/snapshot shapes.
- `chart.js` — the canvas chart: magnitude and phase panes, group delay,
  impulse and difference modes, zoom/pan/cursor, trace colours and visibility.
- `store.js` — browser storage for the project and the panel layout, reporting
  failure rather than claiming a save.
- `ui.js` — the workspace: library, import and mapping, sources, groups and
  positions, DSP chain, optimizer, comparison, snapshots, exports.

Reused from the app: `js/fft.js`, `js/parametric-eq.js` (biquads and the
band list), `js/speaker.js` grid and impulse helpers, `js/sharing.js` for
share-sheet files, the capture library, the live/held measurement, the status
pill and the toolbar.

## 4. What is deliberately refused

- A magnitude-only curve is never given an invented phase. Its phase stays
  absent, the phase pane says so, and a sum that rests on an assumed phase is
  labelled a prediction.
- Decibel magnitudes are never added. Summation is complex addition.
- A `.trf` file is refused with a message naming text/FRD alternatives, rather
  than being half-read.
- No setting is written to a processor, an amplifier or the app's audio path.
- No room reflection, directivity or room-acoustic result is claimed; the
  free-field switch says it is free-field only.
- A malformed, short or foreign file is refused whole, with a message.

## 5. Verification

Run on a remote Mac with Node 22 (`node --check` for syntax, then the numerical
suite). The suite is in the repository as `tests/modeler.mjs`, so it can be run
again with `node tests/modeler.mjs`:

- **Syntax**: every module, `js/app.js`, `js/validation.js`, `sw.js` — OK.
- **Numerical suite (27 checks, all pass)**: +6.02 dB coherent sum; cancellation;
  180° polarity; delay→group delay; group-delay blanking; LR4/LR8/Butterworth
  crossovers (−6.02/−3.01 dB at fc, slopes below it); Bessel refusal; optimizer
  known 2 ms; optimizer inverted polarity; objectives/alternatives/confidence;
  flat-curve smoothing; comma/tab/semicolon files with header mapping;
  magnitude-only retention; short-file refusal; phase wrapping and unwrapping;
  derived impulse at its window origin; float32 and 16-bit WAV; low-pass rolloff;
  all-pass unity; peaking gain; bypass; complex-vs-dB summation.
- **In-app validation page (`validate.html`)**: **29 passed · 0 failed**,
  executed under Node with a DOM stub, so the same list the page runs is green.
- **Screen wiring (`node tests/modeler-ui.mjs`)**: **8 passed · 0 failed** — the
  workspace opens, a project of two subwoofers with real datasets is loaded, all
  four graph modes are drawn, every one of the 135 elements the screen reads is
  present in `index.html` with no duplicate ids, and it closes. It runs against a
  stub document, so it proves the wiring and the names, not the layout.
- **Benchmark** (Node, 48 kHz, 400-point grid): a 12-filter chain over the whole
  grid ≈ 1 ms; a 16-source complex sum ≈ 0.25 ms; group delay ≈ 0.2 ms; an 8192
  impulse ≈ 2 ms; a 4001-step two-polarity optimizer ≈ 17 ms. The chart draws on
  demand, so a delay or filter change repaints once, not once per analysis frame.

Not verified here, and named rather than claimed:

- **The screen itself was not clicked in a browser**: the scripts parse, the
  maths runs, and the screen's wiring was run against a stub document; no button
  was pressed and no pointer moved. Tap **Data Modeler** and try one import
  before trusting the layout on your own phone.
- **The live/held import with a real microphone or interface** was not exercised;
  it reads the app's own results and can only be verified at the desk.
- **A Smaart `.trf`** was not available and is not read.
- **A manufacturer FRD from a third party** was not available; the reader was
  tested on synthetic files with the same shape.
- **Multi-position weighting across all positions at once** is not implemented.
- **Chain import, device-specific DSP profiles, keyboard shortcuts and a PDF
  report** are not implemented here (CSV, FRD, text and project JSON are).

## 6. The request, restated as shipped

The workspace opens from **Data Modeler** in the browser toolbar. It offers the
library, import and mapping, sources, groups and positions, magnitude/phase,
group delay, impulse, complex summation, DSP chain, alignment optimizer,
prediction against measurement, snapshots with undo/redo, and CSV/FRD/report
exports. It is a tool for predicting and aligning, and every result says what it
rests on.
