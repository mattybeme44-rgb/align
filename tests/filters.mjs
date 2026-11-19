/*
 * Filter maths — the sections the Data Modeler's DSP chain and its crossover
 * designer are built from.
 *
 * These assertions are analytic: a first-order high-pass reaches its corner
 * 3 dB down and its pass band flat, an all-pass has unity magnitude and the
 * phase the textbook gives it, a Butterworth section rolls off at its order,
 * and a Linkwitz-Riley pair sums flat. They run on the coefficients the app
 * actually uses, so a change in the design code cannot quietly move a curve.
 *
 * Run: node tests/filters.mjs
 */

import {
  biquadResponse,
  filterCoefficients,
  designCrossover,
  butterworthQs,
} from '../js/modeler/filters.js';

const FS = 48000;
let passed = 0;
const failed = [];

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log('PASS  ' + name + (detail ? ' — ' + detail : ''));
  } else {
    failed.push(name);
    console.log('FAIL  ' + name + (detail ? ' — ' + detail : ''));
  }
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

function magDb(filter, hz, fs = FS) {
  return 20 * Math.log10(Math.max(1e-12, biquadResponse(filter, hz, fs).mag));
}

function phaseDeg(filter, hz, fs = FS) {
  return (biquadResponse(filter, hz, fs).phaseRad * 180) / Math.PI;
}

/** The product of a section list at one frequency, as a complex value. */
function chainAt(filters, hz, fs = FS) {
  let mag = 1;
  let phase = 0;
  for (const filter of filters) {
    const response = biquadResponse(filter, hz, fs);
    mag *= response.mag;
    phase += response.phaseRad;
  }
  return { re: mag * Math.cos(phase), im: mag * Math.sin(phase), mag, phase };
}

/* ---------- first-order sections ---------- */

const hp1 = { kind: 'highPass1', frequency: 1000, q: 0.7071 };
const lp1 = { kind: 'lowPass1', frequency: 1000, q: 0.7071 };
const ap1 = { kind: 'allPass1', frequency: 1000, q: 0.7071 };

const hpTop = magDb(hp1, 20000);
check('a first-order high-pass is flat in its pass band',
  near(hpTop, 0, 0.2), hpTop.toFixed(2) + ' dB at 20 kHz, want 0.00');

const hpCorner = magDb(hp1, 1000);
check('a first-order high-pass is 3 dB down at its corner',
  near(hpCorner, -3.01, 0.1), hpCorner.toFixed(2) + ' dB at 1 kHz, want −3.01');

const lpBottom = magDb(lp1, 20);
const lpCorner = magDb(lp1, 1000);
check('a first-order low-pass is flat at the bottom and 3 dB down at its corner',
  near(lpBottom, 0, 0.1) && near(lpCorner, -3.01, 0.1),
  lpBottom.toFixed(2) + ' dB at 20 Hz, ' + lpCorner.toFixed(2) + ' dB at 1 kHz');

const apMags = [20, 1000, 20000].map((hz) => biquadResponse(ap1, hz, FS).mag);
check('a first-order all-pass has unity magnitude everywhere',
  apMags.every((mag) => near(mag, 1, 1e-6)),
  apMags.map((mag) => mag.toFixed(6)).join(', '));

const apLow = phaseDeg(ap1, 20);
const apHigh = phaseDeg(ap1, 20000);
check('a first-order all-pass turns from 0° to −180° across the band',
  near(apLow, 0, 4) && near(Math.abs(apHigh), 180, 4),
  apLow.toFixed(1) + '° at 20 Hz, ' + apHigh.toFixed(1) + '° at 20 kHz');

const apCorner = phaseDeg(ap1, 1000);
check('a first-order all-pass is −90° at its corner',
  near(apCorner, -90, 1.5), apCorner.toFixed(1) + '° at 1 kHz, want −90°');

/* ---------- Butterworth design ---------- */

const butterQs = butterworthQs(4);
check('a fourth-order Butterworth is two sections with the textbook Q values',
  butterQs.qs.length === 2 &&
  near(butterQs.qs[0], 0.5412, 0.001) && near(butterQs.qs[1], 1.3066, 0.001),
  butterQs.qs.map((q) => q.toFixed(4)).join(', '));

const butterLp = designCrossover({ family: 'Butterworth', type: 'lowPass', frequency: 1000, slope: 24 });
const butterHp = designCrossover({ family: 'Butterworth', type: 'highPass', frequency: 1000, slope: 24 });
check('the Butterworth designer returns an enabled section set',
  butterLp.ok && butterLp.filters.length === 2 && butterHp.ok && butterHp.filters.length === 2,
  butterLp.filters.length + ' low-pass sections, ' + butterHp.filters.length + ' high-pass');

// Measured an octave apart in the stop band, clear of the knee and of Nyquist,
// where the bilinear filter steepens.
const lpLow = chainAt(butterLp.filters, 2000).mag;
const lpHigh = chainAt(butterLp.filters, 4000).mag;
const slope = 20 * Math.log10(lpHigh / lpLow);
check('a 24 dB/octave Butterworth low-pass rolls off at 24 dB per octave',
  near(slope, -24, 1), slope.toFixed(2) + ' dB per octave between 2 and 4 kHz');

const hpFlat = 20 * Math.log10(chainAt(butterHp.filters, 20000).mag);
const hpAtCorner = 20 * Math.log10(chainAt(butterHp.filters, 1000).mag);
check('a fourth-order Butterworth high-pass is flat at the top and 3 dB down at the corner',
  near(hpFlat, 0, 0.3) && near(hpAtCorner, -3.01, 0.2),
  hpFlat.toFixed(2) + ' dB at 20 kHz, ' + hpAtCorner.toFixed(2) + ' dB at 1 kHz');

/* ---------- Linkwitz-Riley summation ---------- */

const lrLp = designCrossover({ family: 'Linkwitz-Riley', type: 'lowPass', frequency: 1000, slope: 24 });
const lrHp = designCrossover({ family: 'Linkwitz-Riley', type: 'highPass', frequency: 1000, slope: 24 });
check('a Linkwitz-Riley 24 dB/octave design is two second-order sections a side',
  lrLp.ok && lrLp.filters.length === 2 && lrHp.ok && lrHp.filters.length === 2,
  lrLp.filters.length + ' low-pass sections, ' + lrHp.filters.length + ' high-pass');

const sumAt = (hz) => {
  const low = chainAt(lrLp.filters, hz);
  const high = chainAt(lrHp.filters, hz);
  return Math.hypot(low.re + high.re, low.im + high.im);
};
const sums = [500, 1000, 2000, 4000].map((hz) => 20 * Math.log10(Math.max(1e-12, sumAt(hz))));
check('a Linkwitz-Riley pair sums flat through its crossover',
  sums.every((db) => near(db, 0, 0.1)),
  sums.map((db) => db.toFixed(2) + ' dB').join(', '));

const sectionAtCorner = 20 * Math.log10(chainAt(lrLp.filters, 1000).mag);
check('each Linkwitz-Riley side is 6 dB down at the crossover',
  near(sectionAtCorner, -6.02, 0.2), sectionAtCorner.toFixed(2) + ' dB, want −6.02');

/* ---------- Bessel and the other families ---------- */

const besselHp = designCrossover({ family: 'Bessel', type: 'highPass', frequency: 1000, slope: 18 });
check('a third-order Bessel high-pass designs a first-order and a second-order section',
  besselHp.ok && besselHp.filters.length === 2 &&
  besselHp.filters.some((filter) => filter.kind === 'highPass1'),
  besselHp.filters.map((filter) => filter.kind + ' Q ' + filter.q).join(' · '));

const besselTop = 20 * Math.log10(chainAt(besselHp.filters, 20000).mag);
check('the Bessel high-pass is flat in its pass band', near(besselTop, 0, 0.4),
  besselTop.toFixed(2) + ' dB at 20 kHz');

const besselSix = designCrossover({ family: 'Bessel', type: 'lowPass', frequency: 1000, slope: 6 });
check('a sixth-order Bessel at 6 dB/octave is refused rather than faked',
  besselSix.ok === false && besselSix.filters.length === 0,
  besselSix.message);

const lrSix = designCrossover({ family: 'Linkwitz-Riley', type: 'lowPass', frequency: 1000, slope: 6 });
check('a Linkwitz-Riley design at 6 dB/octave is refused', lrSix.ok === false, lrSix.message);

/* ---------- all-pass section ---------- */

const ap2 = { kind: 'allPass2', frequency: 1000, q: 0.7071 };
const ap2Mags = [20, 500, 1000, 4000, 20000].map((hz) => biquadResponse(ap2, hz, FS).mag);
check('a second-order all-pass has unity magnitude everywhere',
  ap2Mags.every((mag) => near(mag, 1, 1e-6)),
  ap2Mags.map((mag) => mag.toFixed(6)).join(', '));

const ap2Low = phaseDeg(ap2, 20);
const ap2High = phaseDeg(ap2, 20000);
// biquadResponse reports the angle of a difference of two arguments, so a whole
// turn can come back as the small angle just after it.
const ap2Turned = near(ap2High, 0, 6) || near(Math.abs(ap2High), 360, 6);
check('a second-order all-pass completes a whole turn',
  near(ap2Low, 0, 4) && ap2Turned,
  ap2Low.toFixed(1) + '° at 20 Hz, ' + ap2High.toFixed(1) + '° at 20 kHz');

/* ---------- coefficients stay finite and stable ---------- */

const extremes = [10, 20, 20000, 23999];
const finite = extremes.every((hz) => {
  const c = filterCoefficients({ kind: 'highPass1', frequency: hz, q: 0.7071 }, FS);
  return [c.b0, c.b1, c.a1].every((value) => Number.isFinite(value));
});
check('coefficients stay finite at the edges of the audio band', finite,
  extremes.join(', ') + ' Hz');

if (failed.length) {
  console.log('\n' + failed.length + ' failed: ' + failed.join('; '));
  process.exitCode = 1;
} else {
  console.log('\n' + passed + ' passed, 0 failed');
}
