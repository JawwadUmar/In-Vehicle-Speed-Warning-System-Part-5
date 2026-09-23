'use strict';

/**
 * Curvature estimation for road centrelines.
 *
 * Pipeline: resample to uniform arc length -> Savitzky-Golay smoothing ->
 * sliding-window Taubin circle fit -> significance test -> curve extraction.
 *
 * Why this differs from Part 4:
 *
 *  1. Part 4 fitted a circle to a fixed window of 7 *nodes*. OSM node spacing
 *     is irregular (1 m to >100 m), so the window covered an unknown arc
 *     length and radii were not comparable between road segments. Here the
 *     geometry is resampled to a fixed spacing first, so a "40 m window"
 *     really is 40 m everywhere.
 *
 *  2. Part 4 used the Kasa (naive algebraic) fit, which is strongly biased
 *     towards *small* radii on short, noisy arcs -- exactly the regime here.
 *     Taubin's fit is essentially unbiased at the same cost.
 *
 *  3. Part 4's only quality gate was an RMSE threshold. A straight road with a
 *     few metres of digitising noise passes that gate and yields a spurious
 *     radius. Here a window must also *turn*: the heading deflection across it
 *     has to exceed a threshold, with a consistent turn direction.
 */

import { cumulativeDistances, pathLength, projectOntoPolyline } from './geo.js';

export const DEFAULTS = {
  resampleSpacingMetres: 5,
  smoothingWindowMetres: 40,
  fitWindowMetres: 40,
  // Curvature is tested at two scales. A sagitta grows with the square of the
  // window length while digitising noise does not, so a long window is the only
  // way to see a gentle curve through noisy geometry; a short window keeps the
  // spatial resolution needed to place a sharp curve accurately.
  fitWindowsMetres: [40, 100],
  fitStepMetres: 10,
  minRadiusMetres: 8,
  maxRadiusMetres: 1200,
  maxFitRmseMetres: 2.5,
  minDeflectionDegrees: 6,
  minCurveLengthMetres: 15,
  // A window must bend more than the residual noise can explain. The sagitta of
  // the fitted arc has to stand clear of the fit residual, and the radius implied
  // by the heading change has to agree with the radius the circle fit returned.
  // Without these two gates, digitising noise on a straight road produces a
  // steady stream of phantom curves -- the Part 4 RMSE gate alone does not stop
  // it, because noise fits a large circle perfectly well.
  minSagittaToNoise: 3,
  maxRadiusDisagreement: 0.6,
  // Floor on the assumed positional noise, in metres. OSM centrelines are
  // typically digitised to 1-5 m, and on sparsely noded geometry the residual
  // cannot reveal that: with nodes 50 m apart, a straight line through noisy
  // nodes and a genuinely wiggly road are indistinguishable. Assuming at least
  // this much error is the honest position, and it is what stops sparse
  // geometry from being treated as noise-free.
  minAssumedNoiseMetres: 1
};

/** Resample a polyline to uniform arc-length spacing. */
export function resample(points, spacing = DEFAULTS.resampleSpacingMetres) {
  if (!Array.isArray(points) || points.length < 2) return points ? [...points] : [];
  const along = cumulativeDistances(points);
  const total = along[along.length - 1];
  if (!(total > spacing)) return [{ ...points[0] }, { ...points[points.length - 1] }];

  const count = Math.max(2, Math.round(total / spacing) + 1);
  const step = total / (count - 1);
  const output = [];
  let segment = 1;
  for (let i = 0; i < count; i += 1) {
    const target = i * step;
    while (segment < along.length - 1 && along[segment] < target) segment += 1;
    const segmentLength = along[segment] - along[segment - 1];
    const t = segmentLength > 1e-9 ? (target - along[segment - 1]) / segmentLength : 0;
    output.push({
      x: points[segment - 1].x + t * (points[segment].x - points[segment - 1].x),
      y: points[segment - 1].y + t * (points[segment].y - points[segment - 1].y)
    });
  }
  return output;
}

/**
 * Savitzky-Golay smoothing (quadratic, symmetric window) applied to x and y
 * independently. A quadratic filter is used rather than a moving average
 * because a moving average flattens curvature -- it would inflate every radius.
 * Endpoints fall back to the largest symmetric window that fits.
 */
export function smooth(points, windowMetres = DEFAULTS.smoothingWindowMetres, spacing = DEFAULTS.resampleSpacingMetres) {
  const halfWidth = Math.floor((windowMetres / spacing) / 2);
  if (halfWidth < 1 || points.length < 5) return points.map(point => ({ ...point }));
  return points.map((point, index) => {
    const usable = Math.min(halfWidth, index, points.length - 1 - index);
    if (usable < 2) return { ...point };
    const coefficients = savitzkyGolayCoefficients(usable);
    let x = 0;
    let y = 0;
    for (let offset = -usable; offset <= usable; offset += 1) {
      const weight = coefficients[offset + usable];
      x += weight * points[index + offset].x;
      y += weight * points[index + offset].y;
    }
    return { x, y };
  });
}

const coefficientCache = new Map();

function savitzkyGolayCoefficients(halfWidth) {
  const cached = coefficientCache.get(halfWidth);
  if (cached) return cached;
  // Quadratic smoothing coefficients: c_i = (3(3m^2 + 3m - 1 - 5i^2)) / ((2m+3)(2m+1)(2m-1))
  const m = halfWidth;
  const denominator = (2 * m + 3) * (2 * m + 1) * (2 * m - 1);
  const coefficients = [];
  for (let i = -m; i <= m; i += 1) {
    coefficients.push(3 * (3 * m * m + 3 * m - 1 - 5 * i * i) / denominator);
  }
  coefficientCache.set(halfWidth, coefficients);
  return coefficients;
}

/**
 * Taubin algebraic circle fit. Returns null for degenerate (collinear) input.
 * @returns {{centreX: number, centreY: number, radius: number, rmse: number}|null}
 */
export function fitCircleTaubin(points) {
  const n = points.length;
  if (n < 3) return null;

  let meanX = 0;
  let meanY = 0;
  for (const point of points) {
    meanX += point.x;
    meanY += point.y;
  }
  meanX /= n;
  meanY /= n;

  let Mxx = 0, Myy = 0, Mxy = 0, Mxz = 0, Myz = 0, Mzz = 0;
  for (const point of points) {
    const x = point.x - meanX;
    const y = point.y - meanY;
    const z = x * x + y * y;
    Mxx += x * x;
    Myy += y * y;
    Mxy += x * y;
    Mxz += x * z;
    Myz += y * z;
    Mzz += z * z;
  }
  Mxx /= n; Myy /= n; Mxy /= n; Mxz /= n; Myz /= n; Mzz /= n;

  const Mz = Mxx + Myy;
  const covXY = Mxx * Myy - Mxy * Mxy;
  const varZ = Mzz - Mz * Mz;

  const a3 = 4 * Mz;
  const a2 = -3 * Mz * Mz - Mzz;
  const a1 = varZ * Mz + 4 * covXY * Mz - Mxz * Mxz - Myz * Myz;
  const a0 = Mxz * (Mxz * Myy - Myz * Mxy) + Myz * (Myz * Mxx - Mxz * Mxy) - varZ * covXY;
  const a22 = a2 + a2;
  const a33 = a3 + a3 + a3;

  // Newton iteration on the characteristic polynomial, started at the origin.
  let x = 0;
  let y = a0;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const derivative = a1 + x * (a22 + x * a33);
    if (Math.abs(derivative) < 1e-18) break;
    const previousX = x;
    const previousY = y;
    x -= y / derivative;
    if (!Number.isFinite(x) || x < 0) { x = previousX; break; }
    y = a0 + x * (a1 + x * (a2 + x * a3));
    if (Math.abs(y) >= Math.abs(previousY)) { x = previousX; break; }
    if (Math.abs((x - previousX) / (x || 1)) < 1e-12) break;
  }

  const determinant = x * x - x * Mz + covXY;
  if (Math.abs(determinant) < 1e-12) return null;

  const centreX = (Mxz * (Myy - x) - Myz * Mxy) / (determinant * 2);
  const centreY = (Myz * (Mxx - x) - Mxz * Mxy) / (determinant * 2);
  const radius = Math.sqrt(centreX * centreX + centreY * centreY + Mz);
  if (!Number.isFinite(radius) || radius <= 0) return null;

  const absoluteCentreX = centreX + meanX;
  const absoluteCentreY = centreY + meanY;
  let squaredError = 0;
  for (const point of points) {
    const residual = Math.hypot(point.x - absoluteCentreX, point.y - absoluteCentreY) - radius;
    squaredError += residual * residual;
  }

  return {
    centreX: absoluteCentreX,
    centreY: absoluteCentreY,
    radius,
    rmse: Math.sqrt(squaredError / n)
  };
}

/**
 * The Part 4 fit, kept so the two estimators can be compared directly in the
 * validation report. Do not use it in the warning path.
 */
export function fitCircleKasa(points) {
  const n = points.length;
  if (n < 3) return null;
  let sumX = 0, sumY = 0, sumXX = 0, sumYY = 0, sumXY = 0;
  let sumXXX = 0, sumXYY = 0, sumXXY = 0, sumYYY = 0;
  for (const { x, y } of points) {
    const xx = x * x;
    const yy = y * y;
    sumX += x; sumY += y; sumXX += xx; sumYY += yy; sumXY += x * y;
    sumXXX += xx * x; sumXYY += x * yy; sumXXY += xx * y; sumYYY += yy * y;
  }
  const matrix = [[sumXX, sumXY, sumX], [sumXY, sumYY, sumY], [sumX, sumY, n]];
  const vector = [-(sumXXX + sumXYY), -(sumXXY + sumYYY), -(sumXX + sumYY)];
  const solution = solve3x3(matrix, vector);
  if (!solution) return null;
  const [a, b, c] = solution;
  const centreX = -a / 2;
  const centreY = -b / 2;
  const radiusSquared = centreX * centreX + centreY * centreY - c;
  if (!(radiusSquared > 0)) return null;
  const radius = Math.sqrt(radiusSquared);
  let squaredError = 0;
  for (const point of points) {
    const residual = Math.hypot(point.x - centreX, point.y - centreY) - radius;
    squaredError += residual * residual;
  }
  return { centreX, centreY, radius, rmse: Math.sqrt(squaredError / n) };
}

function solve3x3(matrix, vector) {
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-9) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let i = column; i < 4; i += 1) augmented[column][i] /= divisor;
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let i = column; i < 4; i += 1) augmented[row][i] -= factor * augmented[column][i];
    }
  }
  return augmented.map(row => row[3]);
}

/** Signed heading change across a window, in degrees. Positive is a left turn. */
export function signedDeflectionDegrees(points) {
  let total = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const ax = points[i].x - points[i - 1].x;
    const ay = points[i].y - points[i - 1].y;
    const bx = points[i + 1].x - points[i].x;
    const by = points[i + 1].y - points[i].y;
    const cross = ax * by - ay * bx;
    const dot = ax * bx + ay * by;
    if (Math.hypot(ax, ay) < 1e-9 || Math.hypot(bx, by) < 1e-9) continue;
    total += Math.atan2(cross, dot) * 180 / Math.PI;
  }
  return total;
}

/**
 * RMS separation between the raw resampled polyline and its smoothed version:
 * an estimate of how noisily the road was digitised.
 *
 * This has to be measured *before* smoothing is applied. The fit residual of a
 * smoothed polyline is almost zero by construction -- smoothing destroys the
 * evidence of noise -- so an RMSE gate applied after smoothing, as an obvious
 * implementation would do, silently passes every phantom curve that noise
 * creates.
 */
export function estimateGeometryNoise(rawPoints, smoothedPoints, halfWidth = 4) {
  const count = rawPoints.length;
  if (count === 0 || smoothedPoints.length < 2) return 0;
  // Measure the ORIGINAL nodes against the smoothed centreline, by perpendicular
  // offset. Comparing the resampled polyline instead is wrong: resampling
  // interpolates along the straight lines between nodes, so the residual it
  // yields shrinks as node spacing grows and reports sparse, noisy geometry as
  // pristine. On 25 m OSM nodes with 0.8 m of noise that under-read the noise by
  // 10x and let roughly nine phantom curves per kilometre through the gate.
  const cumulative = cumulativeDistances(smoothedPoints);
  let squared = 0;
  for (const point of rawPoints) {
    const projection = projectOntoPolyline(smoothedPoints, point, cumulative);
    squared += projection ? projection.offset ** 2 : 0;
  }
  const residual = Math.sqrt(squared / count);
  // The smoothed curve partly follows the noise, so the raw-minus-smoothed
  // residual under-reads the true noise. For a Savitzky-Golay filter the
  // residual variance is sigma^2 (1 - 2c0 + sum(c^2)), and sum(c^2) = c0, so the
  // correction is 1/sqrt(1 - c0).
  const coefficients = savitzkyGolayCoefficients(Math.max(2, halfWidth));
  const centre = coefficients[Math.max(2, halfWidth)];
  const attenuation = Math.sqrt(Math.max(0.2, 1 - centre));
  return residual / attenuation;
}

/**
 * Positional noise of the original nodes, measured without smoothing.
 *
 * `estimateGeometryNoise` compares nodes against a smoothed centreline and
 * corrects for the filter's attenuation, but that correction assumes the filter
 * averages many independent noisy samples. It does not when nodes are far
 * apart: a 40 m Savitzky-Golay window over geometry digitised at 32 m spacing
 * contains one or two real nodes, so the smoothed line simply passes through
 * the noise and the residual collapses. Measured on a synthetic corridor built
 * with exactly 1.2 m of node noise at 15-45 m spacing, that estimator returned
 * 0.34 m -- an under-read of 3.5x, in the direction that lets phantom curves
 * through the significance gate.
 *
 * This estimator uses no filter at all. Each interior node is compared with the
 * chord joining its two neighbours. The offset is the sum of the real sagitta
 * over that span and a noise term whose variance is sigma^2 (1 + t^2 + (1-t)^2)
 * for a node t of the way along the chord, so dividing by that factor puts
 * every node on the same scale. The offsets are then combined by their median
 * rather than their mean: the sagitta term is zero on tangents and positive on
 * curves, so a mean would be inflated by the curves themselves, while the
 * median survives as long as the corridor is not mostly curve.
 *
 * Only the cross-track component is used. Noise along the direction of travel
 * slides a node forwards or backwards on its own alignment, which barely
 * changes the geometry, and including it makes the estimate depend on how the
 * chord fraction is computed -- taking the full 2-D offset with a chord
 * fraction derived from the same noisy points cancels most of the along-track
 * term and under-read a known 1.2 m noise level as 0.70 m. A half-normal
 * distribution's median is 0.6745 times its scale, which converts back to
 * sigma.
 */
export function estimateNodeNoise(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  const offsets = [];
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    const spanX = c.x - a.x;
    const spanY = c.y - a.y;
    const span = Math.hypot(spanX, spanY);
    if (span < 1e-6) continue;
    // Offset of b from the a->c chord, and where along that chord it falls,
    // both in the chord's own frame so the along-track component never enters.
    const cross = ((b.x - a.x) * spanY - (b.y - a.y) * spanX) / span;
    const t = Math.min(1, Math.max(0,
      ((b.x - a.x) * spanX + (b.y - a.y) * spanY) / (span * span)));
    offsets.push(Math.abs(cross) / Math.sqrt(1 + t * t + (1 - t) * (1 - t)));
  }
  if (offsets.length === 0) return 0;
  offsets.sort((p, q) => p - q);
  return offsets[offsets.length >> 1] / 0.6745;
}

/**
 * Sliding-window curvature profile over an already resampled+smoothed polyline.
 *
 * `options.geometryNoiseMetres` should carry the estimate from
 * `estimateGeometryNoise`; a window is only accepted when its sagitta stands
 * clear of that noise level. A random walk with 0.9 m of positional noise
 * produces apparent radii of 200-600 m over a 40 m window, and no amount of
 * residual checking after smoothing will reject them -- only comparing the bend
 * against the noise that could have produced it will.
 */
export function curvatureProfile(points, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const noiseFloor = Math.max(settings.geometryNoiseMetres || 0, settings.minAssumedNoiseMetres || 0.1);
  const spacing = settings.resampleSpacingMetres;
  const windowSize = Math.max(5, Math.round(settings.fitWindowMetres / spacing) + 1);
  const step = Math.max(1, Math.round(settings.fitStepMetres / spacing));
  const along = cumulativeDistances(points);
  const profile = [];

  for (let start = 0; start + windowSize <= points.length; start += step) {
    const window = points.slice(start, start + windowSize);
    const fit = fitCircleTaubin(window);
    const deflection = signedDeflectionDegrees(window);
    const centreDistance = (along[start] + along[start + windowSize - 1]) / 2;
    if (!fit) {
      profile.push({ distanceAlong: centreDistance, radius: Infinity, rmse: 0, deflection, significant: false });
      continue;
    }
    const span = along[start + windowSize - 1] - along[start];
    const deflectionRadians = Math.abs(deflection) * Math.PI / 180;

    // Radius implied purely by how much the heading turned over the window.
    const radiusFromDeflection = deflectionRadians > 1e-6 ? span / deflectionRadians : Infinity;
    const disagreement = Number.isFinite(radiusFromDeflection)
      ? Math.abs(fit.radius - radiusFromDeflection) / Math.max(fit.radius, radiusFromDeflection)
      : 1;

    // Sagitta of the fitted arc across the window.
    const sagitta = (span * span) / (8 * fit.radius);

    const significant =
      Math.abs(deflection) >= settings.minDeflectionDegrees &&
      fit.rmse <= settings.maxFitRmseMetres &&
      fit.radius >= settings.minRadiusMetres &&
      fit.radius <= settings.maxRadiusMetres &&
      sagitta >= settings.minSagittaToNoise * noiseFloor &&
      disagreement <= settings.maxRadiusDisagreement;

    profile.push({
      distanceAlong: centreDistance,
      startDistance: along[start],
      endDistance: along[start + windowSize - 1],
      radius: fit.radius,
      rmse: fit.rmse,
      deflection,
      sagitta,
      radiusFromDeflection,
      disagreement,
      significant
    });
  }
  return profile;
}

/**
 * Group consecutive significant windows of the same turn direction into curves.
 *
 * `radius` is the minimum over the group, which is the conservative choice: it
 * yields the lowest advisory speed for the sharpest part of the curve.
 * `medianRadius` is reported alongside it for validation work, where the
 * conservative bias would distort the comparison against surveyed values.
 */
export function extractCurves(profile, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const curves = [];
  let group = null;

  const flush = () => {
    if (!group) return;
    const startDistance = group.windows[0].startDistance;
    const endDistance = group.windows[group.windows.length - 1].endDistance;
    if (endDistance - startDistance >= settings.minCurveLengthMetres) {
      const radii = group.windows.map(window => window.radius).sort((a, b) => a - b);
      curves.push({
        startDistance,
        endDistance,
        lengthMetres: endDistance - startDistance,
        radius: radii[0],
        medianRadius: radii[Math.floor(radii.length / 2)],
        direction: group.sign > 0 ? 'left' : 'right',
        deflectionDegrees: group.windows.reduce((total, window) => total + window.deflection, 0),
        maxRmse: Math.max(...group.windows.map(window => window.rmse))
      });
    }
    group = null;
  };

  for (const window of profile) {
    if (!window.significant) { flush(); continue; }
    const sign = Math.sign(window.deflection);
    if (group && group.sign === sign) group.windows.push(window);
    else { flush(); group = { sign, windows: [window] }; }
  }
  flush();
  return curves;
}

/**
 * Merge curve records that overlap in chainage, keeping the smallest radius.
 * Used to combine the results of the different window scales; overlapping
 * detections describe the same bend, and the conservative radius is the one
 * that governs the advisory speed.
 */
export function mergeCurves(curves, minGapMetres = 5) {
  const sorted = [...curves].sort((a, b) => a.startDistance - b.startDistance);
  const merged = [];
  for (const curve of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && curve.startDistance <= previous.endDistance + minGapMetres &&
        previous.direction === curve.direction) {
      previous.endDistance = Math.max(previous.endDistance, curve.endDistance);
      previous.lengthMetres = previous.endDistance - previous.startDistance;
      if (curve.radius < previous.radius) {
        previous.radius = curve.radius;
        previous.medianRadius = curve.medianRadius;
      }
      previous.deflectionDegrees = Math.abs(curve.deflectionDegrees) > Math.abs(previous.deflectionDegrees)
        ? curve.deflectionDegrees : previous.deflectionDegrees;
      previous.maxRmse = Math.max(previous.maxRmse, curve.maxRmse);
      previous.scales = [...new Set([...(previous.scales || []), ...(curve.scales || [])])];
    } else {
      merged.push({ ...curve });
    }
  }
  return merged;
}

/**
 * Convenience wrapper: raw local-frame polyline in, curve list out.
 * The returned curves carry distances along the *resampled* polyline, which is
 * the same arc-length parameterisation the caller should use for projection.
 */
export function analysePolyline(localPoints, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  if (!Array.isArray(localPoints) || localPoints.length < 2) {
    return { resampled: [], curves: [], profile: [], geometryNoiseMetres: 0, lengthMetres: 0 };
  }
  const resampled = resample(localPoints, settings.resampleSpacingMetres);
  const smoothed = smooth(resampled, settings.smoothingWindowMetres, settings.resampleSpacingMetres);
  const halfWidth = Math.floor((settings.smoothingWindowMetres / settings.resampleSpacingMetres) / 2);
  const geometryNoiseMetres = Math.max(
    settings.minAssumedNoiseMetres,
    estimateGeometryNoise(localPoints, smoothed, halfWidth)
  );

  const windows = settings.fitWindowsMetres && settings.fitWindowsMetres.length
    ? settings.fitWindowsMetres
    : [settings.fitWindowMetres];

  let profile = [];
  let curves = [];
  for (const fitWindowMetres of windows) {
    const scaleSettings = { ...settings, fitWindowMetres, geometryNoiseMetres };
    const scaleProfile = curvatureProfile(smoothed, scaleSettings);
    profile = profile.concat(scaleProfile.map(window => ({ ...window, scale: fitWindowMetres })));
    curves = curves.concat(
      extractCurves(scaleProfile, scaleSettings).map(curve => ({ ...curve, scales: [fitWindowMetres] }))
    );
  }

  return {
    resampled: smoothed,
    curves: mergeCurves(curves),
    profile,
    geometryNoiseMetres,
    lengthMetres: pathLength(smoothed)
  };
}
