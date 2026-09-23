'use strict';

/**
 * Ties matching, corridor construction and curvature analysis together, and
 * provides the client-side tracker that keeps distance-to-curve live between
 * corridor refreshes.
 */

import { createLocalFrame, cumulativeDistances, projectOntoPolyline, distanceMetres } from './geo.js';
import { DEFAULTS as CURVATURE_DEFAULTS } from './curvature.js';
import { analyseAlignment, PROFILE_DEFAULTS } from './curvatureprofile.js';
import { matchPosition, buildCorridor, normaliseWays } from './roadgraph.js';
import { resolveSuperelevation, measuredSuperelevationNear } from './superelevation.js';

/**
 * Produce the corridor payload sent to the client.
 *
 * The returned `points` are the *resampled and smoothed* centreline, and each
 * curve's distances are arc lengths along exactly that polyline. The client can
 * therefore recompute cumulative distances from the points it received and get
 * the same parameterisation, without having to reproduce the smoothing.
 */
export function buildCorridorPayload(elements, position, headingDegrees, lookAheadMetres, options = {}) {
  const ways = Array.isArray(elements) && elements[0]?.points ? elements : normaliseWays(elements);
  if (ways.length === 0) return null;

  const match = matchPosition(ways, position, headingDegrees, options.matching);
  if (!match) return null;

  const corridor = buildCorridor(ways, match, lookAheadMetres, options.corridor);
  if (!corridor || corridor.points.length < 3) return null;

  const frame = createLocalFrame(corridor.points[0]);
  const localPoints = corridor.points.map(point => frame.toLocal(point));
  const analysis = analyseAlignment(localPoints, {
    ...CURVATURE_DEFAULTS, ...PROFILE_DEFAULTS, ...options.curvature
  });
  if (analysis.resampled.length < 2) return null;

  const geographicPoints = analysis.resampled.map(point => {
    const geographic = frame.toGeographic(point);
    return [round(geographic.latitude, 7), round(geographic.longitude, 7)];
  });

  // Superelevation is resolved here rather than copied from the layer's curve
  // records, because the corridor's curves are re-derived from the geometry and
  // would not line up with stored ids. Since the design-implied value is a pure
  // function of radius and design speed, computing it in both places gives the
  // same number; only measured values need the spatial lookup.
  const policy = options.superelevationPolicy || null;
  const measuredTable = options.measuredSuperelevation || null;
  const cumulative = cumulativeDistances(analysis.resampled);
  const apexOf = curve => {
    const midpoint = (curve.startDistance + curve.endDistance) / 2;
    let i = 1;
    while (i < cumulative.length - 1 && cumulative[i] < midpoint) i += 1;
    return frame.toGeographic(analysis.resampled[i]);
  };

  // Prefer the curve records the layer was built with, when the caller has
  // them. They were derived once, offline, from the whole stitched chain; the
  // corridor here is a sliding window a few hundred metres long, and the
  // curvature profile is degraded over half an analysis window at each of its
  // ends. Re-deriving from the corridor therefore makes the reported radius
  // depend on where the vehicle happened to be when the corridor was last
  // rebuilt. Measured on the 5.3 km test road at 100 km/h: a 500 m curve read
  // 525 m for four seconds and then 329 m on the next corridor rebuild, which
  // flipped a silent approach into a BRAKE alert with no advisory before it.
  //
  // Only the geometry is re-derived live -- distance along the corridor -- which
  // is what has to be live.
  // When the layer's records are available they are authoritative, even when
  // none of them fall on this corridor: that means there is no curve here, not
  // that the corridor should be re-analysed. Falling back would reintroduce the
  // very flicker this avoids, on exactly the corridors where the projection is
  // hardest.
  const projected = options.layerCurves
    ? projectLayerCurves(options.layerCurves, analysis.resampled, frame, corridor.wayIds)
    : null;
  const curves = projected || analysis.curves;

  return {
    lookAheadMetres,
    curveSource: projected ? 'layer' : 'corridor',
    lengthMetres: round(analysis.lengthMetres, 1),
    matchOffsetMetres: round(match.offset, 1),
    travelBearing: round(match.travelBearing, 1),
    wayIds: corridor.wayIds,
    truncated: corridor.truncated,
    atNetworkEnd: corridor.atNetworkEnd === true,
    points: geographicPoints,
    superelevationPolicy: policy,
    curves: curves.map(curve => {
      const record = {
        startDistance: round(curve.startDistance, 1),
        endDistance: round(curve.endDistance, 1),
        radius: round(curve.radius, 2),
        medianRadius: round(curve.medianRadius, 2),
        direction: curve.direction,
        deflectionDegrees: round(curve.deflectionDegrees, 1),
        maxRmse: round(curve.maxRmse, 2)
      };
      if (Number.isFinite(curve.transitionLengthMetres)) {
        record.transitionLengthMetres = round(curve.transitionLengthMetres, 1);
        record.coreLengthMetres = round(curve.coreLengthMetres, 1);
      }
      if (policy) {
        const apex = apexOf(curve);
        const measured = measuredTable
          ? measuredSuperelevationNear(measuredTable, apex.latitude, apex.longitude)
          : null;
        const resolved = resolveSuperelevation(curve.radius, policy, measured);
        record.superelevation = round(resolved.value, 4);
        record.superelevationSource = resolved.source;
      }
      return record;
    })
  };
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Re-express the layer's curve records as distances along this corridor.
 *
 * The layer stores each curve's entry, apex and exit as coordinates, so placing
 * one on the corridor is a projection rather than a re-analysis. A curve is
 * kept only if both its ends land on the corridor within a few metres of it,
 * which drops curves on a parallel road and curves that the corridor only
 * clips.
 */
function projectLayerCurves(layerCurves, resampledLocal, frame, wayIds) {
  if (!Array.isArray(layerCurves) || layerCurves.length === 0) return [];
  const cumulative = cumulativeDistances(resampledLocal);
  const total = cumulative[cumulative.length - 1];
  const onCorridor = new Set(wayIds || []);
  const placed = [];

  for (const curve of layerCurves) {
    if (!curve || !Array.isArray(curve.entry) || !Array.isArray(curve.exit)) continue;
    // Cheap rejection first: a curve whose ways are not in this corridor at all
    // cannot be on it.
    if (onCorridor.size && Array.isArray(curve.wayIds) &&
        !curve.wayIds.some(id => onCorridor.has(id))) continue;

    const place = point => Array.isArray(point)
      ? projectOntoPolyline(resampledLocal,
        frame.toLocal({ latitude: point[0], longitude: point[1] }), cumulative)
      : null;
    const entryAt = place(curve.entry);
    const exitAt = place(curve.exit);
    const apexAt = place(curve.apex);
    if (!entryAt || !exitAt) continue;

    // A point that projects far off the polyline fell outside the corridor, so
    // its distance is a clamp rather than a measurement. One landing is enough
    // to say the curve is on this corridor: the driver may already be past its
    // apex, in which case only the exit is still ahead, or the corridor may
    // reach its entry but not yet its apex. Both are cases where the curve must
    // still be reported -- the first is the in-curve warning, the second is the
    // approach alert.
    const lands = at => at !== null && at.offset <= 25;
    if (!lands(entryAt) && !lands(exitAt) && !lands(apexAt)) continue;
    const entryClipped = !lands(entryAt);
    const exitClipped = !lands(exitAt);

    const startDistance = Math.max(0, Math.min(entryAt.distanceAlong, exitAt.distanceAlong));
    const endDistance = Math.min(total, Math.max(entryAt.distanceAlong, exitAt.distanceAlong));
    if (endDistance - startDistance < 5) continue;

    placed.push({
      ...curve,
      startDistance,
      endDistance,
      lengthMetres: endDistance - startDistance,
      entryClipped,
      exitClipped,
      fromLayer: true
    });
  }

  return placed.sort((a, b) => a.startDistance - b.startDistance);
}

/**
 * Holds the current corridor and answers "where am I on it, and what is ahead?"
 * on every GPS fix.
 *
 * This is the fix for the most serious Part 4 defect: there, distance-to-curve
 * was frozen at the value computed when the geometry was fetched, so it drifted
 * by hundreds of metres between refreshes. Here the live fix is projected onto
 * the corridor each time, so the distance is always current.
 */
export class CorridorTracker {
  constructor(options = {}) {
    this.corridor = null;
    this.frame = null;
    this.localPoints = null;
    this.cumulative = null;
    this.receivedAt = 0;
    this.maxOffsetMetres = options.maxOffsetMetres ?? 45;
    this.maxAgeMs = options.maxAgeMs ?? 180000;
    // How far the match may move along the corridor between fixes. Generous
    // enough for a long GPS gap at speed, tight enough that a doubled-back
    // alignment cannot teleport the match to the other leg.
    this.searchBackMetres = options.searchBackMetres ?? 25;
    // Ceiling on how fast the match may advance, in m/s. The window is derived
    // from elapsed time rather than being a fixed 400 m: a fixed forward window
    // is wide enough to contain the opposite leg of a hairpin, so a single
    // sideways GPS excursion could latch the match onto the returning
    // carriageway, after which chainage ran backwards while the vehicle moved
    // forward and the corridor ahead was simply wrong.
    this.maxAdvanceSpeed = options.maxAdvanceSpeed ?? 60;
    this.lastDistanceAlong = null;
    this.lastLocatedAt = null;
  }

  /** @param {object} payload Result of `buildCorridorPayload`. */
  setCorridor(payload, receivedAt = Date.now()) {
    if (!payload || !Array.isArray(payload.points) || payload.points.length < 2) {
      this.corridor = null;
      return;
    }
    this.corridor = payload;
    this.receivedAt = receivedAt;
    this.frame = createLocalFrame({ latitude: payload.points[0][0], longitude: payload.points[0][1] });
    this.localPoints = payload.points.map(([latitude, longitude]) =>
      this.frame.toLocal({ latitude, longitude }));
    this.cumulative = cumulativeDistances(this.localPoints);
    // A fresh corridor starts at the vehicle, so an unconstrained match is safe
    // here and seeds the continuity window for subsequent fixes.
    this.lastDistanceAlong = null;
    this.lastLocatedAt = null;
  }

  clear() {
    this.corridor = null;
    this.frame = null;
    this.localPoints = null;
    this.cumulative = null;
    this.lastDistanceAlong = null;
    this.lastLocatedAt = null;
  }

  get lengthMetres() {
    if (!this.cumulative) return 0;
    return this.cumulative[this.cumulative.length - 1];
  }

  /**
   * @returns {{distanceAlong: number, offset: number, remainingMetres: number,
   *            curvesAhead: Array, ageMs: number, valid: boolean}|null}
   */
  locate(position, now = Date.now(), options = {}) {
    if (!this.corridor) return null;
    const track = options.track !== false;
    const target = this.frame.toLocal(position);

    let projection = null;
    if (this.lastDistanceAlong !== null) {
      const elapsedSeconds = this.lastLocatedAt === null
        ? 1
        : Math.max(0, (now - this.lastLocatedAt) / 1000);
      const forward = Math.min(1000, 30 + this.maxAdvanceSpeed * elapsedSeconds);
      projection = projectOntoPolyline(this.localPoints, target, this.cumulative, {
        min: this.lastDistanceAlong - this.searchBackMetres,
        max: this.lastDistanceAlong + forward
      });
      // If the constrained match is poor the vehicle has probably left the
      // corridor (a turn, a GPS jump); fall back to a global search and let the
      // offset check below decide whether the result is usable.
      if (projection && projection.offset > this.maxOffsetMetres) projection = null;
    }
    if (!projection) projection = projectOntoPolyline(this.localPoints, target, this.cumulative);
    if (!projection) return null;

    const ageMs = now - this.receivedAt;
    const valid = projection.offset <= this.maxOffsetMetres && ageMs <= this.maxAgeMs;
    const remainingMetres = this.lengthMetres - projection.distanceAlong;

    // Only a usable match may seed the continuity window, and only when the
    // caller is actually consuming the result -- `needsRefresh` must be able to
    // ask without moving the tracker's state.
    if (track && valid) {
      this.lastDistanceAlong = projection.distanceAlong;
      this.lastLocatedAt = now;
    }

    const curvesAhead = this.corridor.curves
      .map(curve => ({
        ...curve,
        distanceAhead: curve.startDistance - projection.distanceAlong,
        distanceToExit: curve.endDistance - projection.distanceAlong
      }))
      // A curve is still relevant while the vehicle is inside it.
      .filter(curve => curve.distanceToExit > 0)
      .map(curve => ({
        ...curve,
        // Past the entry but before the exit: the driver is committed and the
        // advice that applies is different from the advice on approach.
        inCurve: curve.distanceAhead <= 0,
        distanceAhead: Math.max(0, curve.distanceAhead)
      }));

    return {
      distanceAlong: projection.distanceAlong,
      offset: projection.offset,
      remainingMetres,
      curvesAhead,
      ageMs,
      valid
    };
  }

  /**
   * True when new geometry should be requested.
   *
   * A corridor that is short because the mapped road simply ends must not
   * trigger a refresh on every fix: no amount of re-requesting will produce
   * geometry that does not exist, and the loop would hammer the road service
   * for the rest of the journey. In that case only near-exhaustion of the
   * corridor -- which may mean the vehicle has turned onto a connecting road --
   * is a reason to ask again.
   */
  needsRefresh(position, requiredLookAhead, now = Date.now()) {
    if (!this.corridor) return true;
    const located = this.locate(position, now, { track: false });
    if (!located || !located.valid) return true;
    if (this.corridor.atNetworkEnd) return located.remainingMetres < 50;
    return located.remainingMetres < requiredLookAhead * 0.6;
  }
}

/**
 * Speed and heading estimator.
 *
 * `position.coords.speed` is null on desktop browsers and on many handsets when
 * stationary, which in Part 4 meant the displayed speed sat at 0 and no warning
 * could ever fire during bench testing. Here Doppler speed is used when the
 * device provides it and is otherwise derived from successive fixes, with
 * exponential smoothing on both and an accuracy gate on the input.
 */
export class MotionEstimator {
  constructor(options = {}) {
    this.smoothing = options.smoothing ?? 0.4;
    this.maxAccuracyMetres = options.maxAccuracyMetres ?? 40;
    this.previous = null;
    this.speedKmh = 0;
    this.headingDegrees = null;
  }

  update(coords, timestamp) {
    const accuracy = Number.isFinite(coords.accuracy) ? coords.accuracy : 0;
    const usable = accuracy <= this.maxAccuracyMetres;

    let instantaneous = null;
    if (!usable) {
      // A fix the accuracy gate rejected must not update speed, heading, or the
      // baseline. Storing it as `previous` made the NEXT good fix measure its
      // displacement from a bad position: one 250 m outlier turned a steady
      // 50 km/h into 105 km/h and flipped the heading by 285 degrees, which then
      // built the corridor in the wrong direction of travel.
      return {
        speedKmh: this.speedKmh,
        headingDegrees: this.headingDegrees,
        accuracy,
        usable: false
      };
    }
    if (Number.isFinite(coords.speed) && coords.speed >= 0) {
      instantaneous = coords.speed * 3.6;
    } else if (this.previous) {
      const seconds = (timestamp - this.previous.timestamp) / 1000;
      if (seconds > 0.2 && seconds < 15) {
        const metres = distanceMetres(
          this.previous.latitude, this.previous.longitude,
          coords.latitude, coords.longitude
        );
        // Reject jumps that exceed a plausible acceleration.
        if (metres / seconds < 70) instantaneous = (metres / seconds) * 3.6;
      }
    }

    if (instantaneous !== null) {
      this.speedKmh = this.speedKmh === 0
        ? instantaneous
        : this.speedKmh + this.smoothing * (instantaneous - this.speedKmh);
    }

    let heading = Number.isFinite(coords.heading) ? coords.heading : null;
    if (heading === null && this.previous && this.speedKmh > 5) {
      const metres = distanceMetres(
        this.previous.latitude, this.previous.longitude,
        coords.latitude, coords.longitude
      );
      if (metres > 3) {
        heading = bearingFrom(this.previous, coords);
      }
    }
    // Below walking pace a reported heading is noise, not direction of travel.
    if (this.speedKmh < 3) heading = this.headingDegrees;
    if (heading !== null) this.headingDegrees = heading;

    this.previous = {
      latitude: coords.latitude,
      longitude: coords.longitude,
      timestamp
    };

    return {
      speedKmh: this.speedKmh,
      headingDegrees: this.headingDegrees,
      accuracy,
      usable
    };
  }
}

function bearingFrom(from, to) {
  const toRadians = value => value * Math.PI / 180;
  const phi1 = toRadians(from.latitude);
  const phi2 = toRadians(to.latitude);
  const dLon = toRadians(to.longitude - from.longitude);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
