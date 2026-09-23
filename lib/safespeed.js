'use strict';

/**
 * Advisory speed and warning-trigger logic.
 *
 * Part 4 used  V = 3.6 * sqrt(g * R * (f + e))  with f = 0.15 and e = 0.07
 * hard-coded for every curve, then warned whenever the driver was within a
 * fixed 200 m of the curve and above V.
 *
 * The friction factor is unchanged and deliberate: f = 0.15 is IRC:73 / IRC:38
 * design practice, and this system is for Indian rural highways, so the whole
 * model stays inside one standard. (An AASHTO speed-dependent curve is
 * available for sensitivity analysis only -- see `sideFriction`.)
 *
 * What did change:
 *
 *  - e = 0.07 was assumed for every curve, including unbanked ones, which
 *    raises the advisory speed above what the curve can deliver. Superelevation
 *    is now derived per curve from the IRC procedure, or measured; see
 *    lib/superelevation.js.
 *  - The fixed 200 m trigger is replaced by a deceleration criterion: the alert
 *    fires when the driver can no longer reach the advisory speed by the curve
 *    entry at a comfortable rate.
 *  - The governing curve is the most demanding one ahead, not the nearest.
 */

export const GRAVITY = 9.81;

/** Conservative default when a curve's superelevation has not been surveyed. */
export const UNKNOWN_SUPERELEVATION = 0;

/**
 * Design side-friction factor.
 *
 * DEFAULT IS IRC. This system is built for Indian rural highways, and the rest
 * of the model -- superelevation, the e_max cap, the restricted-speed formula
 * -- is derived from IRC:73 / IRC:38. Mixing an AASHTO friction curve into an
 * otherwise IRC model would be a mixed-standard result that is hard to defend:
 * IRC's own restricted speed sqrt(127 R (e_max + 0.15)) assumes exactly the
 * constant 0.15 used here.
 *
 * IRC specifies f = 0.15 as the maximum design side friction, so the advisory
 * speed computed from it is the highest speed at which friction demand stays
 * within the design limit.
 *
 * 'aashto' retains the speed-dependent Green Book curve (0.17 at 30 km/h
 * falling to 0.09 at 120) for sensitivity analysis only. The two agree within
 * 2 km/h below R = 230 m and diverge on gentle curves, where AASHTO is the more
 * conservative of the two: 91 vs 96 km/h at R = 360 m, 100 vs 109 at R = 500.
 */
export const DEFAULT_FRICTION_MODEL = 'irc';

/** IRC:73 / IRC:38 maximum design side-friction factor. */
export const IRC_SIDE_FRICTION = 0.15;

const FRICTION_TABLE = [
  [30, 0.17], [40, 0.165], [50, 0.16], [60, 0.15], [70, 0.14],
  [80, 0.14], [90, 0.13], [100, 0.12], [110, 0.11], [120, 0.09]
];

export function sideFriction(speedKmh, model = DEFAULT_FRICTION_MODEL) {
  if (model === 'irc' || model === 'fixed') return IRC_SIDE_FRICTION;
  if (!Number.isFinite(speedKmh)) return FRICTION_TABLE[0][1];
  if (speedKmh <= FRICTION_TABLE[0][0]) return FRICTION_TABLE[0][1];
  const last = FRICTION_TABLE[FRICTION_TABLE.length - 1];
  if (speedKmh >= last[0]) return last[1];
  for (let i = 1; i < FRICTION_TABLE.length; i += 1) {
    const [upperSpeed, upperFriction] = FRICTION_TABLE[i];
    const [lowerSpeed, lowerFriction] = FRICTION_TABLE[i - 1];
    if (speedKmh <= upperSpeed) {
      const t = (speedKmh - lowerSpeed) / (upperSpeed - lowerSpeed);
      return lowerFriction + t * (upperFriction - lowerFriction);
    }
  }
  return last[1];
}

/**
 * Advisory speed for a curve, in km/h.
 *
 * Solves V = sqrt(127 * R * (e + f(V))), where the friction factor depends on
 * the very speed being solved for.
 *
 * With the IRC model f is constant, so this reduces to the closed form
 * V = sqrt(127 R (e + 0.15)); the solver is kept general so the AASHTO
 * sensitivity run works through the same code path.
 *
 * Bisection, not fixed-point iteration. The obvious iteration
 * V <- sqrt(127 R (e + f(V))) has |dV'/dV| > 1 where the friction table is
 * steepest (110-120 km/h), so above roughly R = 700 m it enters a limit cycle
 * instead of converging: five passes returned 107.2 km/h for R = 1000 m against
 * a true root of 113.9, and the result was not even monotone in radius --
 * 85 radii between 100 and 1200 m returned a LOWER advisory speed for a LARGER
 * curve. Since g(V) = V - sqrt(127 R (e + f(V))) is strictly increasing (f is
 * non-increasing in V), the root is unique and bisection always finds it.
 *
 * @param {number} radiusMetres
 * @param {object} [options]
 * @param {number} [options.superelevation] - as a fraction, e.g. 0.07 for 7%.
 * @param {'irc'|'aashto'} [options.frictionModel] - defaults to IRC.
 * @param {number} [options.comfortLateralG] - optional ride-comfort ceiling.
 */
export function advisorySpeedKmh(radiusMetres, options = {}) {
  const {
    superelevation = UNKNOWN_SUPERELEVATION,
    frictionModel = DEFAULT_FRICTION_MODEL,
    comfortLateralG = null
  } = options;
  if (!Number.isFinite(radiusMetres) || radiusMetres <= 0) return Infinity;

  const balance = candidate =>
    candidate - Math.sqrt(127 * radiusMetres *
      Math.max(0.02, superelevation + sideFriction(candidate, frictionModel)));

  let low = 0.1;
  let high = 400;
  if (balance(high) < 0) return high;
  for (let i = 0; i < 60; i += 1) {
    const middle = (low + high) / 2;
    if (balance(middle) < 0) low = middle;
    else high = middle;
  }
  let speed = (low + high) / 2;

  if (comfortLateralG) {
    // Lateral-acceleration ceiling, the basis of ball-bank advisory speeds.
    const comfortSpeed = 3.6 * Math.sqrt(comfortLateralG * GRAVITY * radiusMetres);
    speed = Math.min(speed, comfortSpeed);
  }
  return speed;
}

/** The Part 4 formula, retained so comparison runs can reproduce its output. */
export function advisorySpeedPart4(radiusMetres) {
  return 3.6 * Math.sqrt(GRAVITY * radiusMetres * (0.15 + 0.07));
}

/** Tyre-road adhesion ceiling; urgency is capped here so it stays orderable. */
export const MAX_DECELERATION = 9.81;

/**
 * Floor on usable braking distance, in metres.
 *
 * The required-deceleration formula diverges as the curve entry arrives, so
 * some floor is needed or a 4 km/h exceedance 25 m from a curve demands 12
 * m/s^2 and fires a BRAKE alert. Clamping the distance -- rather than switching
 * to a different formula -- keeps urgency continuous and monotone: a_req rises
 * as the curve approaches, reaches D/(2 * this) at the clamp, and holds there.
 */
const MIN_USABLE_DISTANCE_METRES = 15;

/**
 * Deceleration required to arrive at the curve entry at the advisory speed.
 *
 * @returns {number} m/s^2. 0 when no slowing is needed, capped at
 *          MAX_DECELERATION when the remaining distance has run out.
 */
export function requiredDeceleration(speedKmh, advisoryKmh, distanceMetres, reactionSeconds = 1.2) {
  if (!(speedKmh > advisoryKmh)) return 0;
  const speed = speedKmh / 3.6;
  const advisory = advisoryKmh / 3.6;
  const usable = distanceMetres - speed * reactionSeconds;
  if (usable <= 0) return MAX_DECELERATION;
  return Math.min(MAX_DECELERATION, (speed * speed - advisory * advisory) / (2 * usable));
}

/**
 * Urgency score, on the scale of required deceleration in m/s^2.
 *
 * Two measures, combined by taking the larger, never by switching between them:
 *
 *  1. Required deceleration, with the usable distance floored at
 *     MIN_USABLE_DISTANCE_METRES. Without the floor it diverges at the curve
 *     entry; with a hard switch to another formula instead, urgency COLLAPSED
 *     at the boundary -- measured at 8.27 dropping to 1.39 one metre later,
 *     turning a BRAKE alert into an advisory for a driver 20 km/h over the
 *     advisory speed and already committed to the curve. Clamping keeps the
 *     value continuous and monotone as the curve approaches.
 *
 *  2. Lateral-acceleration overshoot, (V / V_advisory)^2 - 1, scaled to the
 *     same units. This is the floor that matters on tight curves: where the
 *     advisory speed is below about 31 km/h it exceeds the clamped braking
 *     term, and it is the physically meaningful quantity once the vehicle is
 *     in the curve, since a_lat / a_lat_max = (V / V_advisory)^2.
 */
export function curveUrgency(speedKmh, advisoryKmh, distanceMetres, reactionSeconds = 1.2) {
  if (!(speedKmh > advisoryKmh)) return 0;
  const speed = speedKmh / 3.6;
  const advisory = advisoryKmh / 3.6;
  const rawUsable = distanceMetres - speed * reactionSeconds;
  const usable = Math.max(MIN_USABLE_DISTANCE_METRES, rawUsable);
  const braking = (speed * speed - advisory * advisory) / (2 * usable);

  // The lateral term applies ONLY once the vehicle is committed. Left
  // ungated it fires at any distance, so a driver above the advisory speed of
  // a curve 1.5 km away is alerted immediately -- measured as an advisory at
  // 1500 m for 60 km/h approaching a 50 km/h curve. Braking distance is the
  // right measure while there is still distance to brake in.
  const lateral = rawUsable < MIN_USABLE_DISTANCE_METRES
    ? ((speedKmh / advisoryKmh) ** 2 - 1) * 2.5
    : 0;

  return Math.min(MAX_DECELERATION, Math.max(braking, lateral, 0));
}

/**
 * Alert thresholds in m/s^2 of required deceleration.
 * Release thresholds sit below the trigger thresholds to give hysteresis, so
 * the alert cannot chatter on and off at the boundary — the Part 4 UI would
 * flicker every time speed crossed the advisory value.
 */
export const ALERT_LEVELS = [
  { level: 'brake', trigger: 2.8, release: 2.2, label: 'BRAKE' },
  { level: 'warning', trigger: 1.5, release: 1.1, label: 'Slow down for curve' },
  { level: 'advisory', trigger: 0.7, release: 0.5, label: 'Curve ahead' }
];

/**
 * Wording used once the vehicle is INSIDE the curve.
 *
 * The urgency value is unchanged -- it stays continuous across the entry, and
 * under-stating it there would recreate the collapse that `curveUrgency`
 * documents. Only the instruction changes, because "BRAKE" is the wrong
 * instruction mid-corner: braking and cornering draw on the same grip budget,
 * and an abrupt application unsettles the car at the moment it is least able to
 * absorb it. At 85 km/h on a 155 m curve the tyres are already using 3.6 m/s2
 * laterally, leaving 5.9 of the 6.9 m/s2 available -- enough to slow, not
 * enough to invite emergency braking. Progressive deceleration is the advice.
 */
export const IN_CURVE_LABELS = {
  brake: 'Too fast — ease off',
  warning: 'Too fast for this curve',
  advisory: 'In curve — hold speed down'
};

/** The label to display, given the alert level and whether the driver is in the curve. */
export function alertLabel(level, inCurve = false) {
  if (level === 'none') return '';
  if (inCurve && IN_CURVE_LABELS[level]) return IN_CURVE_LABELS[level];
  const definition = ALERT_LEVELS.find(entry => entry.level === level);
  return definition ? definition.label : '';
}

const LEVEL_RANK = { none: 0, advisory: 1, warning: 2, brake: 3 };

/**
 * Decide the alert level, given the previous level so hysteresis can be applied.
 */
export function classifyAlert(requiredDecelerationValue, previousLevel = 'none') {
  const previousRank = LEVEL_RANK[previousLevel] || 0;
  for (const definition of ALERT_LEVELS) {
    const rank = LEVEL_RANK[definition.level];
    const threshold = rank <= previousRank ? definition.release : definition.trigger;
    if (requiredDecelerationValue >= threshold) return definition;
  }
  return { level: 'none', trigger: 0, release: 0, label: '' };
}

/**
 * Pick the governing curve from those ahead.
 *
 * Part 4 chose the *nearest* curve, so a gentle bend 30 m ahead could mask a
 * hairpin 120 m beyond it. The governing curve is the one demanding the most
 * deceleration right now.
 *
 * @param {Array<{radius: number, distanceAhead: number, superelevation?: number}>} curves
 */
export function selectGoverningCurve(curves, speedKmh, options = {}) {
  let governing = null;
  for (const curve of curves) {
    if (curve.distanceAhead < 0) continue;
    const advisory = advisorySpeedKmh(curve.radius, {
      ...options,
      superelevation: Number.isFinite(curve.superelevation) ? curve.superelevation : options.superelevation
    });
    const deceleration = curveUrgency(speedKmh, advisory, curve.distanceAhead, options.reactionSeconds);
    const candidate = { ...curve, advisorySpeedKmh: advisory, requiredDeceleration: deceleration };
    if (!governing ||
        candidate.requiredDeceleration > governing.requiredDeceleration ||
        (candidate.requiredDeceleration === governing.requiredDeceleration &&
         candidate.distanceAhead < governing.distanceAhead)) {
      governing = candidate;
    }
  }
  return governing;
}

/**
 * How far ahead geometry is needed, given the current speed: enough to cover
 * reaction plus a full comfortable deceleration to a slow curve, with margin.
 * Part 4's fixed 500 m is too short at highway speed and wasteful in town.
 */
export function requiredLookAheadMetres(speedKmh, options = {}) {
  const { minimum = 300, maximum = 1500, comfortableDeceleration = 1.5, reactionSeconds = 1.2 } = options;
  const speed = Math.max(0, speedKmh) / 3.6;
  const distance = speed * reactionSeconds + (speed * speed) / (2 * comfortableDeceleration);
  // Margin of 2.0, not 1.6. At 1.6 the geometry held at 100 km/h reached 465 m
  // while the advisory for a 60 m curve was due at 492 m -- the warning would
  // have arrived after the point it was needed. Verified by sweeping every
  // speed and radius in the operating range; see the look-ahead test.
  return Math.min(maximum, Math.max(minimum, distance * 2.0));
}
