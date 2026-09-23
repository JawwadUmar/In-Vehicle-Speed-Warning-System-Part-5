'use strict';

/**
 * Superelevation, per IRC design practice.
 *
 * Part 4 assumed e = 7% on every curve, which advises too fast wherever the
 * curve is not actually banked. The first revision swung to e = 0, which never
 * advises too fast but is so conservative that on a two-lane rural highway it
 * would alert on essentially every curve for essentially every driver -- a
 * warning system nobody keeps switched on.
 *
 * This module takes the middle position: derive the superelevation the curve
 * would have been given if it were built to standard, and be explicit that it
 * is design-implied rather than measured.
 *
 * ---------------------------------------------------------------------------
 * The procedure (IRC:73 / IRC:38)
 *
 *   1. e = Vd^2 / (225 R)
 *
 *      The 225 is not arbitrary. Equilibrium on a banked curve is
 *      e + f = V^2/(127 R), where 127 = 12.96 * 9.81 converts km/h to m/s.
 *      IRC banks the curve to fully counteract centrifugal force at 75% of the
 *      design speed with f = 0, so e = (0.75 Vd)^2/(127 R) = Vd^2/(226 R).
 *      Three quarters rather than the full design speed because over-banking
 *      makes slow vehicles slide towards the inner edge and rut it.
 *
 *   2. Cap at e_max: 7% in plain and rolling terrain, 10% on hill roads not
 *      bound by snow.
 *
 *   3. If capped, check the friction left to find: f = Vd^2/(127 R) - e_max.
 *      If f exceeds 0.15 the curve is substandard for that design speed, and
 *      the allowable speed is restricted to sqrt(127 R (e_max + 0.15)).
 *
 * ---------------------------------------------------------------------------
 * Why the design speed does not have to be known precisely
 *
 * Step 1 exceeds the cap whenever R < Vd^2 / 15.75. Even at the lowest
 * plausible design speed that is every curve below about 268 m radius, so
 * across the range where warnings actually fire, every plausible design speed
 * returns the same e = e_max. The assumption only changes the advisory speed
 * for radii of roughly 270-640 m, and only changes the warning *decision* in a
 * narrow band near 450 m. `designSpeedSensitivity` below reports exactly where
 * a given corridor sits, so the assumption can be defended rather than asserted.
 *
 * NOTE: the design-speed table reproduces IRC:73 as commonly cited. Verify the
 * values against the edition being referenced before publishing.
 */

export const MAX_SUPERELEVATION = {
  plain: 0.07,
  rolling: 0.07,
  mountainous: 0.10,
  steep: 0.10
};

/** Ruling / minimum design speeds in km/h, by road class and terrain. */
export const DESIGN_SPEEDS = {
  NH: { plain: [100, 80], rolling: [80, 65], mountainous: [50, 40], steep: [40, 30] },
  SH: { plain: [100, 80], rolling: [80, 65], mountainous: [50, 40], steep: [40, 30] },
  MDR: { plain: [80, 65], rolling: [65, 50], mountainous: [40, 30], steep: [30, 25] },
  ODR: { plain: [65, 50], rolling: [50, 40], mountainous: [30, 25], steep: [25, 20] },
  VR: { plain: [50, 40], rolling: [40, 35], mountainous: [25, 20], steep: [25, 20] }
};

export const DEFAULT_SIDE_FRICTION = 0.15;

/**
 * Design speed for a road class and terrain.
 * @param {'ruling'|'minimum'} basis - 'minimum' is the conservative choice and
 *   is the default: it yields the lower e, hence the lower advisory speed.
 */
export function designSpeedKmh(roadClass = 'SH', terrain = 'rolling', basis = 'minimum') {
  const row = DESIGN_SPEEDS[roadClass] || DESIGN_SPEEDS.SH;
  const pair = row[terrain] || row.rolling;
  return basis === 'ruling' ? pair[0] : pair[1];
}

/**
 * The full IRC superelevation calculation for one curve.
 *
 * @returns {{
 *   superelevation: number,        // adopted e, as a fraction
 *   rawSuperelevation: number,     // before the cap
 *   capped: boolean,               // the cap governed, so Vd barely matters
 *   frictionDemand: number,        // f still required at the design speed
 *   substandard: boolean,          // that f exceeds 0.15
 *   restrictedSpeedKmh: number     // IRC's allowable speed for the curve
 * }}
 */
export function ircSuperelevation(radiusMetres, options = {}) {
  const {
    designSpeed = 65,
    maxSuperelevation = 0.07,
    maxSideFriction = DEFAULT_SIDE_FRICTION
  } = options;

  if (!Number.isFinite(radiusMetres) || radiusMetres <= 0) {
    return {
      superelevation: 0, rawSuperelevation: 0, capped: false,
      frictionDemand: Infinity, substandard: true, restrictedSpeedKmh: 0
    };
  }

  const rawSuperelevation = (designSpeed * designSpeed) / (225 * radiusMetres);
  const capped = rawSuperelevation > maxSuperelevation;
  const superelevation = capped ? maxSuperelevation : rawSuperelevation;

  const totalDemand = (designSpeed * designSpeed) / (127 * radiusMetres);
  const frictionDemand = totalDemand - superelevation;

  return {
    superelevation,
    rawSuperelevation,
    capped,
    frictionDemand,
    substandard: frictionDemand > maxSideFriction,
    restrictedSpeedKmh: Math.sqrt(127 * radiusMetres * (maxSuperelevation + maxSideFriction))
  };
}

/**
 * Radius below which the cap governs for a given design speed, i.e. below which
 * the design speed assumption has no effect on the answer at all.
 */
export function capGovernsBelowRadius(designSpeed, maxSuperelevation = 0.07) {
  return (designSpeed * designSpeed) / (225 * maxSuperelevation);
}

/**
 * How much a set of curves actually depends on the design-speed assumption.
 * Intended for the build report and for the paper's sensitivity statement.
 */
export function designSpeedSensitivity(radii, options = {}) {
  const {
    candidateSpeeds = [65, 80, 100],
    maxSuperelevation = 0.07
  } = options;

  let insensitive = 0;
  let maxSpread = 0;
  const sensitiveRadii = [];

  for (const radius of radii) {
    const values = candidateSpeeds.map(speed =>
      ircSuperelevation(radius, { designSpeed: speed, maxSuperelevation }).superelevation);
    const spread = Math.max(...values) - Math.min(...values);
    if (spread < 1e-9) insensitive += 1;
    else {
      sensitiveRadii.push(radius);
      if (spread > maxSpread) maxSpread = spread;
    }
  }

  return {
    total: radii.length,
    insensitive,
    sensitive: radii.length - insensitive,
    maxSuperelevationSpread: maxSpread,
    sensitiveRadii,
    capGovernsBelow: capGovernsBelowRadius(Math.min(...candidateSpeeds), maxSuperelevation)
  };
}

/**
 * Resolve the superelevation to use for one curve.
 *
 * Precedence: a measured value always wins; otherwise the design-implied value;
 * otherwise nothing, and the caller falls back to its own conservative default.
 *
 * @param {number} radiusMetres
 * @param {object} policy - { designSpeed, maxSuperelevation, mode }
 *   mode: 'design' (default), 'zero' (report the conservative bound), or
 *         'measured-only' (use nothing unless a measured value exists).
 * @param {number|null} measured - a surveyed value for this curve, if any.
 * @returns {{ value: number, source: 'measured'|'design-implied'|'assumed-zero' }}
 */
export function resolveSuperelevation(radiusMetres, policy = {}, measured = null) {
  if (Number.isFinite(measured)) {
    return { value: measured, source: 'measured' };
  }
  const { mode = 'design', designSpeed = 65, maxSuperelevation = 0.07 } = policy;
  if (mode === 'zero' || mode === 'measured-only') {
    return { value: 0, source: 'assumed-zero' };
  }
  const result = ircSuperelevation(radiusMetres, { designSpeed, maxSuperelevation });
  return { value: result.superelevation, source: 'design-implied' };
}

/**
 * Nearest measured superelevation to a point, from a compact
 * [[latitude, longitude, e], ...] table. Matching is by proximity so that a
 * survey stays valid across layer rebuilds, when curve ids change.
 */
export function measuredSuperelevationNear(table, latitude, longitude, toleranceMetres = 60) {
  if (!Array.isArray(table) || table.length === 0) return null;
  const metresPerDegreeLat = 111320;
  const metresPerDegreeLon = 111320 * Math.cos(latitude * Math.PI / 180);
  let best = null;
  let bestDistance = Infinity;
  for (const [entryLat, entryLon, value] of table) {
    const dx = (entryLon - longitude) * metresPerDegreeLon;
    const dy = (entryLat - latitude) * metresPerDegreeLat;
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = value;
    }
  }
  return bestDistance <= toleranceMetres ? best : null;
}
