'use strict';

/**
 * Curve detection from a continuous curvature profile kappa(s).
 *
 * The sliding-window detector in curvature.js asks each window in isolation
 * "are you a curve?". That works when the curve has a long circular portion,
 * but a spiralled curve does not: with IRC transition lengths the high-curvature
 * core can be shorter than the fit window, so no single window clears the
 * significance gate and the curve is missed outright. Measured on synthetic
 * spiral-arc-spiral alignments with 1 m of noise, a 360 m curve with a 60 m
 * circular portion was found in 0 of 12 trials.
 *
 * The fix is to stop testing windows and start testing curves. Curvature is
 * differentiated once from the heading, giving kappa(s) along the whole
 * alignment. A curve is then a maximal run of sustained, same-signed curvature
 * -- which naturally includes both spirals, because their curvature is non-zero
 * -- and the significance test is applied to that whole run.
 *
 * That is what buys the sensitivity. Sagitta grows with the square of length,
 * so testing a 210 m spiral-arc-spiral curve as one object instead of as a
 * sequence of 100 m windows raises the signal against a fixed noise floor by
 * roughly a factor of four. For R = 360 m with 75 m spirals, whole-curve
 * mid-ordinate is 6.3 m against a 100 m window's 3.5 m.
 *
 * The radius is then taken from the high-curvature core rather than from the
 * run as a whole, because the run includes the spirals and averaging over them
 * would report a radius flatter than the sharpest part of the curve -- the
 * unsafe direction.
 */

import { cumulativeDistances, pathLength } from './geo.js';
import { resample, smooth, fitCircleTaubin, estimateNodeNoise, analysePolyline } from './curvature.js';

export const PROFILE_DEFAULTS = {
  resampleSpacingMetres: 5,
  /** Also derived from the noise; see `scaleForNoise`. */
  smoothingWindowMetres: null,
  /**
   * Baseline for the heading estimate, and the window over which the heading is
   * differentiated to give curvature. Both are normally left unset and derived
   * from the measured geometry noise -- see `scaleForNoise`. Setting either
   * pins that window and disables the scaling for it.
   */
  headingBaselineMetres: null,
  curvatureWindowMetres: null,
  /**
   * The gentlest curve the detector is asked to resolve. Above this radius the
   * IRC advisory speed exceeds anything a passenger car reaches on a two-lane
   * rural highway, so there is nothing to warn about and no reason to pay for
   * the longer window that resolving it would cost.
   */
  resolutionCeilingRadiusMetres: 500,
  /** Bounds on the derived curvature window. */
  minCurvatureWindowMetres: 60,
  maxCurvatureWindowMetres: 220,
  /** A run ends when curvature falls below this fraction of the run's peak. */
  runFloorFraction: 0.15,
  /** Absolute curvature floor, 1/m: below this the road is treated as straight. */
  curvatureFloor: 1 / 2000,
  minTotalDeflectionDegrees: 8,
  minCurveLengthMetres: 25,
  /** The core is where curvature is at least this fraction of the robust peak. */
  coreFraction: 0.7,
  /**
   * Percentile used as the "peak" curvature of a run, instead of the maximum.
   * The maximum of a noisy signal is biased upwards by the largest noise
   * excursion, and on a 360 m curve with 1 m of digitising noise that excursion
   * is far sharper than the curve itself: taking the true maximum collapsed the
   * core onto a noise spike and returned radii 57-70% too small, which would
   * advise absurdly low speeds on gentle curves.
   */
  peakPercentile: 0.85,
  /**
   * A core shorter than this cannot support a trustworthy circle fit, so it is
   * widened until it does -- at the cost of including some of the transition.
   */
  minCoreLengthMetres: 40,
  minSagittaToNoise: 3,
  minAssumedNoiseMetres: 1,
  minRadiusMetres: 8,
  maxRadiusMetres: 1500
};

/**
 * Choose the analysis windows from the measured geometry noise.
 *
 * A curve of radius R departs from its chord by a mid-ordinate of W^2 / (8R)
 * over a window of length W. For that departure to be measurable against
 * positional noise of standard deviation `sigma` it has to clear the noise by
 * the same margin the significance test demands, so
 *
 *     W^2 / (8R) >= k * sigma     ->     W >= sqrt(8 * k * sigma * R)
 *
 * with k = 3. Fixing the window at 40 m, as this detector originally did, makes
 * the implied ceiling sqrt(1600 / 24) = 67 m: every curve gentler than that is
 * being read out of noise. Measured on a 5.3 km synthetic rural highway with
 * 1.2 m of node noise, the fixed 40 m window reported R = 148 m for a designed
 * 340 m curve (-56%), 118 m for a designed 260 m curve (-55%), and missed a
 * 500 m curve entirely; the derived window (120 m at that noise level) returned
 * 319 m, 272 m and 539 m, and found all six curves.
 *
 * Longer is not free -- the heading is blurred over the window, so the apex
 * smears and a short sharp curve is flattened -- which is why the window is
 * tied to the gentlest radius worth resolving rather than made as long as
 * possible. On a ghat-section test road (radii 45-110 m, arcs 55-80 m) the
 * derived window was still the more accurate of the two.
 */
export function scaleForNoise(noiseMetres, settings) {
  const sigma = Math.max(noiseMetres, settings.minAssumedNoiseMetres || 0.1);
  const required = Math.sqrt(8 * settings.minSagittaToNoise * sigma *
    settings.resolutionCeilingRadiusMetres);
  const curvatureWindowMetres = settings.curvatureWindowMetres ?? clamp(
    roundTo(required, settings.resampleSpacingMetres),
    settings.minCurvatureWindowMetres, settings.maxCurvatureWindowMetres);
  return {
    curvatureWindowMetres,
    headingBaselineMetres: settings.headingBaselineMetres ?? Math.max(
      2 * settings.resampleSpacingMetres, roundTo(curvatureWindowMetres / 2, settings.resampleSpacingMetres)),
    smoothingWindowMetres: settings.smoothingWindowMetres ?? Math.max(
      20, roundTo(curvatureWindowMetres * 2 / 3, settings.resampleSpacingMetres))
  };
}

function clamp(value, low, high) { return Math.min(high, Math.max(low, value)); }
function roundTo(value, step) { return Math.max(step, Math.round(value / step) * step); }

/**
 * Heading at each point, from a centred difference over `baseline` metres.
 * Returned unwrapped, so it can be differentiated without branch cuts.
 */
export function headingProfile(points, spacing, baselineMetres) {
  const half = Math.max(1, Math.round(baselineMetres / (2 * spacing)));
  const headings = new Array(points.length);
  for (let i = 0; i < points.length; i += 1) {
    const a = points[Math.max(0, i - half)];
    const b = points[Math.min(points.length - 1, i + half)];
    headings[i] = Math.atan2(b.y - a.y, b.x - a.x);
  }
  // Unwrap.
  for (let i = 1; i < headings.length; i += 1) {
    let delta = headings[i] - headings[i - 1];
    while (delta > Math.PI) { headings[i] -= 2 * Math.PI; delta -= 2 * Math.PI; }
    while (delta < -Math.PI) { headings[i] += 2 * Math.PI; delta += 2 * Math.PI; }
  }
  return headings;
}

/**
 * Curvature from the heading, by least-squares slope over a symmetric window.
 * kappa = d(psi)/ds, signed: positive is a left turn.
 */
export function curvatureFromHeading(headings, spacing, windowMetres) {
  const half = Math.max(1, Math.round(windowMetres / (2 * spacing)));
  const curvature = new Array(headings.length).fill(0);
  for (let i = 0; i < headings.length; i += 1) {
    const usable = Math.min(half, i, headings.length - 1 - i);
    if (usable < 1) { curvature[i] = 0; continue; }
    // Slope of psi against s over the window; sum(k^2) is the normaliser.
    let numerator = 0;
    let denominator = 0;
    for (let k = -usable; k <= usable; k += 1) {
      numerator += k * headings[i + k];
      denominator += k * k;
    }
    curvature[i] = numerator / (denominator * spacing);
  }
  return curvature;
}

/**
 * Extract curves from a curvature profile.
 *
 * A run is seeded where |kappa| exceeds the floor, then extended in both
 * directions while the sign holds and |kappa| stays above a fraction of the
 * run's own peak -- that extension is what captures the spirals.
 */
export function extractCurvesFromProfile(points, curvature, along, settings) {
  const {
    runFloorFraction, curvatureFloor, minTotalDeflectionDegrees,
    minCurveLengthMetres, coreFraction, minSagittaToNoise,
    geometryNoiseMetres, minRadiusMetres, maxRadiusMetres
  } = settings;
  const noise = Math.max(geometryNoiseMetres || 0, settings.minAssumedNoiseMetres || 0.1);

  const curves = [];
  const claimed = new Array(points.length).fill(false);

  for (;;) {
    // Seed at the largest unclaimed curvature.
    let seed = -1;
    let seedValue = curvatureFloor;
    for (let i = 0; i < curvature.length; i += 1) {
      if (claimed[i]) continue;
      if (Math.abs(curvature[i]) > seedValue) { seedValue = Math.abs(curvature[i]); seed = i; }
    }
    if (seed < 0) break;

    const sign = Math.sign(curvature[seed]);
    const floor = Math.max(curvatureFloor, seedValue * runFloorFraction);

    let start = seed;
    while (start > 0 && !claimed[start - 1] &&
           Math.sign(curvature[start - 1]) === sign &&
           Math.abs(curvature[start - 1]) >= floor) start -= 1;
    let end = seed;
    while (end < curvature.length - 1 && !claimed[end + 1] &&
           Math.sign(curvature[end + 1]) === sign &&
           Math.abs(curvature[end + 1]) >= floor) end += 1;

    for (let i = start; i <= end; i += 1) claimed[i] = true;
    if (end - start < 2) continue;

    const lengthMetres = along[end] - along[start];
    if (lengthMetres < minCurveLengthMetres) continue;

    // Total heading change across the run, by integrating kappa.
    let deflection = 0;
    for (let i = start; i < end; i += 1) {
      deflection += 0.5 * (curvature[i] + curvature[i + 1]) * (along[i + 1] - along[i]);
    }
    const deflectionDegrees = deflection * 180 / Math.PI;
    if (Math.abs(deflectionDegrees) < minTotalDeflectionDegrees) continue;

    // Whole-curve significance: the mid-ordinate of the run must stand clear of
    // the noise. Using the full run rather than a fixed window is the point of
    // this detector -- for a spiralled curve the run is two to three times the
    // window length, and sagitta grows with the square of length.
    const meanRadius = Math.abs(lengthMetres / deflection);
    const midOrdinate = meanRadius * (1 - Math.cos(Math.abs(deflection) / 2));
    if (midOrdinate < minSagittaToNoise * noise) continue;

    // Radius from the high-curvature core, not from the whole run: the run
    // includes the spirals, and averaging over them reports a flatter radius
    // than the sharpest part of the curve.
    //
    // The "peak" is a high percentile rather than the maximum. Using the true
    // maximum lets one noise excursion define the core, and on gentle curves
    // that excursion is sharper than the curve -- measured at 57-70% radius
    // under-estimation before this change.
    const magnitudes = [];
    for (let i = start; i <= end; i += 1) magnitudes.push(Math.abs(curvature[i]));
    const sorted = [...magnitudes].sort((a, b) => a - b);
    const peak = sorted[Math.min(sorted.length - 1, Math.floor(settings.peakPercentile * sorted.length))];
    const absolutePeak = sorted[sorted.length - 1];
    const coreThreshold = peak * coreFraction;

    // Centre the core on the robust peak, not on the seed, which is the raw
    // maximum and therefore the noisiest point in the run.
    let centre = seed;
    let bestGap = Infinity;
    for (let i = start; i <= end; i += 1) {
      const gap = Math.abs(Math.abs(curvature[i]) - peak);
      if (gap < bestGap) { bestGap = gap; centre = i; }
    }

    let coreStart = centre;
    let coreEnd = centre;
    while (coreStart > start && Math.abs(curvature[coreStart - 1]) >= coreThreshold) coreStart -= 1;
    while (coreEnd < end && Math.abs(curvature[coreEnd + 1]) >= coreThreshold) coreEnd += 1;

    // A short core cannot support a circle fit. Widen it towards whichever side
    // still has curvature, accepting some transition rather than fitting noise.
    while (along[coreEnd] - along[coreStart] < settings.minCoreLengthMetres) {
      const canGrowStart = coreStart > start;
      const canGrowEnd = coreEnd < end;
      if (!canGrowStart && !canGrowEnd) break;
      if (!canGrowEnd || (canGrowStart &&
          Math.abs(curvature[coreStart - 1]) >= Math.abs(curvature[coreEnd + 1]))) coreStart -= 1;
      else coreEnd += 1;
    }

    const corePoints = points.slice(coreStart, coreEnd + 1);
    const fit = corePoints.length >= 3 ? fitCircleTaubin(corePoints) : null;
    // Fall back to the reciprocal of peak curvature when the core is too short
    // to fit. Peak curvature on noisy data is biased high, hence radius biased
    // low, which is the conservative direction.
    const radius = fit && Number.isFinite(fit.radius) ? fit.radius : (peak > 0 ? 1 / peak : Infinity);
    if (!(radius >= minRadiusMetres && radius <= maxRadiusMetres)) continue;

    curves.push({
      startDistance: along[start],
      endDistance: along[end],
      lengthMetres,
      radius,
      medianRadius: peak > 0 ? 1 / peak : radius,
      peakCurvature: absolutePeak,
      direction: sign > 0 ? 'left' : 'right',
      deflectionDegrees,
      maxRmse: fit ? fit.rmse : 0,
      coreStartDistance: along[coreStart],
      coreEndDistance: along[coreEnd],
      coreLengthMetres: along[coreEnd] - along[coreStart],
      // How much of the run is spiral rather than circular. Reported rather
      // than acted on: on OSM geometry the spiral's footprint is usually below
      // the noise, so this is an indication, not a measurement.
      transitionLengthMetres: Math.max(0, (lengthMetres - (along[coreEnd] - along[coreStart])) / 2)
    });
  }

  return curves.sort((a, b) => a.startDistance - b.startDistance);
}

/**
 * Full pipeline: raw local-frame polyline in, curve list out.
 * Mirrors the shape of `analysePolyline` so the two are interchangeable.
 */
export function analysePolylineByProfile(localPoints, options = {}) {
  const settings = { ...PROFILE_DEFAULTS, ...options };
  if (!Array.isArray(localPoints) || localPoints.length < 2) {
    return { resampled: [], curves: [], profile: [], geometryNoiseMetres: 0, lengthMetres: 0 };
  }

  const resampled = resample(localPoints, settings.resampleSpacingMetres);

  // Measure the noise first -- the analysis windows are derived from it -- and
  // measure it straight off the original nodes. Any smoothing-based estimate
  // would have to be smoothed with a window that is not known yet, and on
  // coarsely noded geometry it under-reads the noise badly (see
  // `estimateNodeNoise`).
  const geometryNoiseMetres = Math.max(
    settings.minAssumedNoiseMetres, estimateNodeNoise(localPoints));

  const scale = scaleForNoise(geometryNoiseMetres, settings);
  const smoothed = smooth(resampled, scale.smoothingWindowMetres, settings.resampleSpacingMetres);

  const along = cumulativeDistances(smoothed);
  const headings = headingProfile(smoothed, settings.resampleSpacingMetres, scale.headingBaselineMetres);
  const curvature = curvatureFromHeading(headings, settings.resampleSpacingMetres, scale.curvatureWindowMetres);

  const curves = extractCurvesFromProfile(smoothed, curvature, along, {
    ...settings, geometryNoiseMetres
  });

  return {
    resampled: smoothed,
    curves,
    profile: curvature.map((value, index) => ({
      distanceAlong: along[index],
      curvature: value,
      radius: value !== 0 ? 1 / Math.abs(value) : Infinity
    })),
    geometryNoiseMetres,
    scale,
    lengthMetres: pathLength(smoothed)
  };
}

/**
 * Dispatcher used by the build tool and the runtime, so both always agree on
 * which detector produced a layer's curves.
 *
 * 'profile' is the default on the strength of a head-to-head measurement
 * (tools/compare-detectors.js): against the sliding-window detector it is more
 * accurate on ordinary noisy curves (-3% vs -9% at R=155, -7% vs -14% at
 * R=230), finds 360 m curves the window detector misses entirely, halves the
 * short-circular-arc bias (+6% vs +13%), and produces the same zero phantom
 * curves on straight roads at every node spacing tested.
 *
 * 'window' is kept so the comparison stays runnable and reproducible.
 */
export function analyseAlignment(localPoints, options = {}) {
  if (options.detector === 'window') return analysePolyline(localPoints, options);
  if (options.detector === 'profile') return analysePolylineByProfile(localPoints, options);

  // 'auto', the default. The profile detector differentiates the heading over a
  // window, so the first and last ~30 m of any chain have a degraded curvature
  // estimate. On a long road that is irrelevant; on a short stub it is the whole
  // chain, and the detector returns nothing where the window detector still
  // finds curves. Measured on the sample data: 0 curves vs 2 on an 83 m chain,
  // 0 vs 1 on a 47 m chain, while both found the same 2 on a 182 m chain.
  //
  // The threshold has to track the curvature window, since the degraded end
  // zone is half a window at each end: a chain shorter than about twice the
  // window is all edge.
  const lengthMetres = pathLength(localPoints);
  const settings = { ...PROFILE_DEFAULTS, ...options };
  const window = scaleForNoise(settings.minAssumedNoiseMetres, settings).curvatureWindowMetres;
  const minimum = options.profileMinLengthMetres ?? Math.max(150, 2 * window);
  const result = lengthMetres >= minimum
    ? analysePolylineByProfile(localPoints, options)
    : analysePolyline(localPoints, options);
  result.detector = lengthMetres >= minimum ? 'profile' : 'window';
  return result;
}
