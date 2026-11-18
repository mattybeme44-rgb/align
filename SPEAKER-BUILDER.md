# Custom Speaker Builder

The System Data Modeler's loudspeaker library, fed from a specification sheet
instead of an EASE file. It lives in **System Data Modeler → Custom speaker
builder** (the card under the library) and produces ordinary library entries:
the same datasets the Room Designer already places, aims and predicts.

The screen is `js/modeler/builder-ui.js`; the arithmetic is
`js/modeler/speaker-builder.js`; the three pictures are
`js/modeler/builder-chart.js`. Nothing else in the app was replaced: the
prediction is still `acoustics.js` on top of `model.js`.

---

## 1. What a specification becomes

A saved speaker is a library model with

- the entered specification in `model.generic`, untouched by anything attached
  later;
- one generated dataset per section, plus the whole-cabinet power sum when the
  crossover frequencies are known;
- a set of 6 dB beamwidths on each dataset, horizontal and vertical, in exactly
  the shape an imported CLF file produces;
- previous versions of the specification in `model.revisions`;
- the accuracy label the library shows, derived from the datasets present.

A dataset generated here is magnitude-only. It carries `phaseDeg: null`,
`hasPhase: false`, `provenance: 'theoretical'` and `generated: true`. The
modeler's summation therefore says the phase is assumed, and no screen presents
the result as an alignment.

## 2. The response curve

On the model's own 400-point, 20 Hz – 20 kHz log grid:

- inside a section's band the level is the section's sensitivity at 1 W / 1 m,
  plus any deviation points the operator entered (interpolated in dB over log
  frequency, held beyond the ends);
- below the band's lower limit the level falls by the entered LF slope, in dB per
  octave, from that limit;
- above the band's upper limit it falls by the entered HF slope;
- where two sections meet, each one gets a −3 dB knee at the crossover frequency
  with the entered slope. At the crossover two equal sections therefore sum to
  their own level, not to a bump;
- the whole cabinet is only produced when every section boundary has a crossover
  frequency, and then as a **power sum**: `10·log₁₀ Σ 10^(Lᵢ/10)`. A generic model
  has no crossover phase, so a complex sum would be invented. It is labelled
  "cabinet power sum" wherever it appears;
- a frequency-response tolerance is stored and reported. It is never drawn as a
  made-up ripple: the generated curve inside the band is a nominal shape, and
  the screen says so.

### Sensitivity

Both ratings are stored, and neither is treated as the other:

- `dB SPL at 1 W / 1 m` is the figure the curve uses;
- `dB SPL at 2.83 V / 1 m` is converted through the nominal impedance:
  `L(1 W) = L(2.83 V) − 10·log₁₀(2.83² / Z)`;
  at 8 Ω the two agree, at 4 Ω the voltage rating reads about 3.01 dB higher, at
  16 Ω about 3.00 dB lower;
- a maximum SPL from a power rating (`sensitivity + 10·log₁₀ P`) is shown as a
  calculation, never as a replacement for a published rating.

Section sensitivities and maximum SPLs are kept per section. They are never added
together: two sections' peak SPLs do not make a cabinet peak SPL.

## 3. Directivity

The entered coverage is a nominal width in degrees, horizontal and vertical,
with the reference definition it was published at (−6 dB by default) and one of
three angular tapers (quadratic, cosine, steep). All three reach the stated
reference at half the stated width.

The room prediction's attenuation model is a 6 dB width. A width published at
another reference is converted, not used as if it were the same figure:

- quadratic: `w₆ = w · √(6 / reference)`
- cosine: `w₆ = w · (2/π)·arccos(1 − 6/reference)`
- steep: `w₆ = w · (6 / reference)^0.25`

Each dataset entry carries `widthHDeg` and `widthVDeg` as well as the single
`widthDeg`. `acoustics.js` applies the horizontal width to the horizontal angle
and the vertical width to the vertical angle and adds the two dB attenuations —
the separable approximation of a rectangular pattern. A dataset with one width
(a CLF file) keeps the previous total-angle model, so nothing that worked before
changes its answer.

An omnidirectional model generates no beamwidths at all: aim is stored and
drawn, and the screen says it cannot change the predicted level.

A **beamwidth table** can be imported as `Hz, H°, V°` per line (or `Hz, width°`
for a symmetrical pattern), comma, tab, semicolon or whitespace separated, with
headers and comments tolerated. Every row is validated before the table is
applied; an impossible width, a duplicate band or fewer than two bands refuses
the whole file. It is a table of widths, not a polar measurement.

Measured horizontal or vertical polar data and a full 3D balloon are **not**
generated or parsed here. A CLF file's published widths can be attached as
manufacturer data; AFMG GLL is refused with a message because decoding it needs
AFMG's licensed SDK. Nothing is invented to fill the gap.

## 4. Multi-way cabinets

The builder supports one to six sections. Each has its own band, sensitivity,
maximum continuous and peak SPL, power rating, impedance, acoustic-offset field
and label. A crossover field and slope sit between each pair.

- Without a crossover the sections are offered separately and are **never**
  combined.
- Acoustic offsets and crossover phase are not invented: the offset field is
  stored when the operator has one, and the generated data carries no phase
  either way.
- Each section becomes its own dataset, so a source in the Room Designer can use
  the LF section alone or the mid/high section alone. When a section needs its
  own processing, use it as its own source in the model workspace: gain, delay,
  polarity and the whole DSP chain then apply to that section alone.

## 5. Subwoofers

Choosing Subwoofer or a low-frequency cabinet adds a configuration block with
the enclosure type (sealed, ported, band-pass, horn-loaded, tapped horn,
cardioid, custom), driver configuration and port tuning. All of it is recorded
as specification, none of it is turned into a response: an enclosure response is
not inferred from a type, a tuning or a set of dimensions. The entered published
range, sensitivity, maximum SPL and response are what the prediction uses, and
measured complex data replaces it when attached.

## 6. The Pioneer XY-3B example

`Pioneer XY-3B — Generic Specification Model` loads the operator-supplied
figures as editable starting values:

- 50° horizontal × 35° vertical nominal coverage;
- LF 102 dB SPL (1 W / 1 m), maximum peak 139 dB;
- mid/high 107 dB SPL (1 W / 1 m), maximum peak 136 dB;
- 55 Hz – 17 kHz;
- 530 × 1080 × 540 mm.

It is labelled **GENERIC — APPROXIMATE DIRECTIVITY** on the model, in the
library badge, on its datasets and in the builder's accuracy panel. It is not an
EASE, GLL or CLF dataset and not independently verified manufacturer data. No
crossover, phase, acoustic offset or polar data was supplied, so the two sections
are separate datasets and the cabinet power sum is not offered.

Loading the example when a speaker with that name is already in the library opens
the saved one for editing instead of adding a second identical entry; **Save as
new** is there when a copy is wanted.

## 7. Accuracy labels

| Label | Meaning | When it is used |
|---|---|---|
| **Generic model** | Approximate response and coverage from entered specifications | Only generated datasets are attached |
| **Manufacturer model** | Manufacturer acoustic data | Only manufacturer datasets |
| **Measured model** | Measurements with documented conditions | Only measured datasets |
| **Hybrid model** | More than one kind of data | A specification plus measured or manufacturer data |
| **No acoustic data** | Nothing to predict from | No dataset at all |

The library badge shows the label, and a generic model shows the required
caveat instead of a short word.

Warnings are shown in the builder for what is missing: no phase, no directivity
(omni), no acoustic centre, no frequency-response tolerance, no sensitivity (a
96 dB placeholder is used), no crossover for a multi-way, and the fact that a
published sensitivity is not a calibrated SPL.

## 8. Choosing which data drives a prediction

The **Data sources and prediction** block lists every dataset on the speaker,
ordered by the data-source hierarchy — measured, manufacturer, imported, then the
generic estimate — with its kind, whether it carries phase, and how many
beamwidth points it has. **Use for prediction** sets
`generic.preferredDatasetId` and points every source using that loudspeaker at
the chosen dataset. Nothing is replaced automatically: attaching a measurement
leaves the generic estimate in place and does not change the dataset a source
uses until the operator chooses it.

## 9. Revisions

Every save that changes a speaker pushes the previous specification onto
`model.revisions` (newest first, twelve kept) with its date, a summary and a copy
of the full specification. **Restore** loads one back into the builder; nothing is
saved until **Update speaker** is pressed. Generated datasets are replaced on
save, so a source that used one follows the new curve; attached measured and
manufacturer datasets are never touched.

## 10. The JSON schema

Exported with **Export definition** as `align.custom-speaker/1`. Import validates
the whole file before adding anything.

```
{
  "schema": "align.custom-speaker/1",
  "app": "Align web · System Data Modeler",
  "exportedAt": "ISO 8601",
  "note": "string",
  "speaker": {
    "name": "string",                    required
    "manufacturer": "string",
    "model": "string",                   model number
    "type": "Subwoofer | Full-range | Top / main | Monitor | Custom",
    "impedanceOhm": number,
    "sensitivityDb": number,             reference section, for the library list
    "distanceM": number,                 always 1 for a generated model
    "crossoverText": "string",
    "directivityText": "string",
    "specs": "string",
    "notes": "string",
    "generic": {                          the entered specification
      "schema": "align.custom-speaker/1",
      "id": "string",
      "name": "string",
      "manufacturer": "string",
      "modelNumber": "string",
      "type": "subwoofer | full-range | mid-high | low-cabinet | point-source |
               horn-loaded | line-array | multi-way | custom",
      "description": "string",
      "driverCount": number,
      "enclosure": { "type": "sealed | ported | bandpass | horn | tapped-horn | cardioid | custom",
                     "drivers": "string", "portTuningHz": number | null },
      "band": { "fMin": Hz, "fMax": Hz, "toleranceDb": number | null },
      "crossovers": [ { "hz": Hz, "slopeDbPerOct": number, "family": "string" } ],
      "sensitivity": { "at1W": dB | null, "atVolts": dB | null,
                       "volts": 2.83, "impedanceOhm": number },
      "output": { "maxContinuousDb": dB | null, "maxPeakDb": dB | null, "powerW": W | null },
      "directivity": { "model": "omni | constant | frequency",
                       "hDeg": degrees, "vDeg": degrees,
                       "referenceDb": number, "profile": "quadratic | cosine | steep",
                       "referenceBand": "string",
                       "points": [ { "hz": Hz, "hDeg": degrees, "vDeg": degrees } ] },
      "response": { "mode": "flat | points",
                    "lowSlope": dB/oct, "highSlope": dB/oct,
                    "points": [ { "hz": Hz, "db": dB } ] },
      "physical": { "widthM": m, "heightM": m, "depthM": m, "weightKg": kg | null,
                    "acousticCenter": { "xM": m, "yM": m, "zM": m } | null,
                    "mounting": "free | flown | stacked | wall | soffit | custom",
                    "rotatableHorn": boolean, "colour": "#rrggbb" },
      "sections": [ { "id": "string", "label": "string",
                      "band": { "fMin": Hz, "fMax": Hz },
                      "sensitivityDb": dB | null,
                      "maxContinuousDb": dB | null, "maxPeakDb": dB | null,
                      "powerW": W | null, "impedanceOhm": ohm | null,
                      "offsetMs": ms | null, "phase": "unknown | measured",
                      "note": "string" } ],
      "notes": "string",
      "labelCaveat": "GENERIC — APPROXIMATE DIRECTIVITY",
      "preferredDatasetId": "string",
      "revision": number,
      "createdAt": "ISO 8601",
      "updatedAt": "ISO 8601"
    },
    "datasets": [                        400 points each; the model grid
      { "id": "string", "label": "string",
        "provenance": "theoretical | manufacturer | measured",
        "generated": boolean, "sectionId": "string",
        "curve": { "magDb": [400 numbers], "phaseDeg": null | [400 numbers],
                   "coherence": null | [400 numbers] },
        "points": 400, "hasPhase": boolean, "phaseOrigin": "none | measured",
        "fMin": Hz, "fMax": Hz, "sampleRate": number, "fftSize": number,
        "delayMs": ms,
        "conditions": { ... },
        "directivity": [ { "frequency": Hz, "widthDeg": degrees,
                           "widthHDeg": degrees, "widthVDeg": degrees,
                           "profile": "string" } ],
        "directivityProfile": "string",
        "note": "string", "importedAt": "ISO 8601" }
    ],
    "revisions": [ { "id": "string", "savedAt": "ISO 8601", "note": "string",
                     "summary": "string", "spec": { ...a full specification... } } ]
  }
}
```

Anything else is refused with a message: a foreign `schema`, no name, a dataset
whose magnitude array is not the model grid, or a file with neither a
specification nor a dataset.

## 11. Using a built speaker

1. **Data Modeler → Custom speaker builder → New speaker** (or the Pioneer
   example), enter the figures, **Save to library**.
2. The library lists it with its accuracy badge and its datasets. **Use as
   source** adds it to the model workspace.
3. **Room Designer** lists it in the library; place it, set X/Y/Z, aim, gain,
   delay, polarity and EQ.
4. Predict: the coverage map, the response at a virtual microphone and the
   arrivals all come from the existing engine, using the generated curve and
   beamwidths.

Nothing is written to hardware. A generic model's summation is a prediction with
an assumed phase, and the screens say so.

## 12. Verification

Numerical suite: `node tests/speaker-builder.mjs`. It covers unit conversions,
sensitivity conversion through impedance, taper attenuation and reference
conversion, beamwidth interpolation, the generated response and its rolloffs,
empty fields staying empty, the crossover power sum, the Pioneer figures,
validation, accuracy labels, the data-source order, save and reload,
export/import refusals, revisions, and the end-to-end path — build, save,
normalise, place, aim, apply gain/delay/DSP and compute an audience heat map.

It was written in the same pass as the feature but **not executed in this
session**: this environment has no terminal or Node runtime for the web
repository. Run it before relying on the numbers; the expected values are stated
in the test names.

**Exercised in the browser** on the published private preview, at phone width,
through the web inspector:

- the Data Modeler opens; the **Custom speaker builder** card is present;
- **Pioneer XY-3B example** fills the form with 55–17000 Hz, 50° × 35°, LF
  102 dB / 139 dB, mid/high 107 dB / 136 dB and 530 × 1080 × 540 mm, and draws
  the response, the polar approximation and the cabinet box with its coverage
  cone;
- **Save to library** writes the entry with the *GENERIC — APPROXIMATE
  DIRECTIVITY* badge and its datasets, and the card switches to **Update
  speaker**; the entry survives a page reload;
- the **Room Designer** lists it, places it as a main, and computes the coverage
  map and the predicted response from it.

Two defects were found by that check and fixed: the cabinet drawing built one
corner key by numeric addition (`"00"` instead of `"000"`), which threw and left
the cabinet half-drawn; and an empty crossover field was coerced to 0 and then
clamped to 10 Hz, which put a spurious crossover into a saved speaker. The
Room Designer's loudspeaker select was also never populated — a pre-existing
gap, now filled from the modeler's library — so a saved speaker could not be
placed at all until it was fixed.

Not verified here, and named rather than claimed:

- the numerical suite above has not been run in this environment;
- no real manufacturer sheet was typed in beyond the Pioneer example, and an
  imported CLF, FRD or WAV was not attached to a built speaker in the browser;
- the room prediction of a generic speaker was not compared with a measurement
  of the same cabinet;
- the phone-width layout of the **Room Designer's own** left column is a
  pre-existing limitation of that workspace (its panel is not reachable at
  320 px, so the check placed the cabinet from the Data Modeler's
  *Loudspeakers in the room* panel). The builder card itself is usable at that
  width, though long text is clipped inside its inputs.
