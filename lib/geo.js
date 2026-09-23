'use strict';

/**
 * Geodesy helpers shared by the server, the browser client and the offline tools.
 * All distances are metres, all bearings are degrees clockwise from true north.
 */

export const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

export function toRadians(value) {
  return value * DEG;
}

/** Great-circle distance in metres. */
export function distanceMetres(lat1, lon1, lat2, lon2) {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Initial bearing from `from` to `to`, in degrees [0, 360). */
export function bearingDegrees(from, to) {
  const phi1 = toRadians(from.latitude);
  const phi2 = toRadians(to.latitude);
  const dLon = toRadians(to.longitude - from.longitude);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/** Smallest absolute difference between two bearings, in degrees [0, 180]. */
export function bearingDifference(first, second) {
  return Math.abs(((first - second + 540) % 360) - 180);
}

/**
 * A local east-north tangent plane anchored at `origin`.
 *
 * The Part 4 code rebuilt this implicitly from `points[0]`, which meant the
 * frame moved every time new geometry arrived. Making the frame an explicit
 * object lets the corridor keep one stable frame for its whole lifetime, so
 * positions measured at different times are directly comparable.
 */
export function createLocalFrame(origin) {
  const metresPerDegreeLat = 111132.92 - 559.82 * Math.cos(2 * toRadians(origin.latitude)) +
    1.175 * Math.cos(4 * toRadians(origin.latitude));
  const metresPerDegreeLon = 111412.84 * Math.cos(toRadians(origin.latitude)) -
    93.5 * Math.cos(3 * toRadians(origin.latitude));
  return {
    origin,
    metresPerDegreeLat,
    metresPerDegreeLon,
    toLocal(point) {
      return {
        x: (point.longitude - origin.longitude) * metresPerDegreeLon,
        y: (point.latitude - origin.latitude) * metresPerDegreeLat
      };
    },
    toGeographic(point) {
      return {
        latitude: origin.latitude + point.y / metresPerDegreeLat,
        longitude: origin.longitude + point.x / metresPerDegreeLon
      };
    }
  };
}

/** Cumulative arc length along a polyline of {x, y} points. */
export function cumulativeDistances(points) {
  const distances = [0];
  for (let i = 1; i < points.length; i += 1) {
    distances.push(distances[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return distances;
}

export function pathLength(points) {
  if (points.length < 2) return 0;
  const distances = cumulativeDistances(points);
  return distances[distances.length - 1];
}

/**
 * Project a point onto a polyline, returning the closest location on the
 * *segments* rather than the closest vertex.
 *
 * Part 4 measured distance to vertices only, so a coarsely digitised road
 * (OSM node spacing is routinely 50-100 m) looked much further away than it
 * really was, and there was no way to ask "how far along am I now?" — which is
 * what makes a live distance-to-curve possible.
 *
 * @returns {{distanceAlong: number, offset: number, segmentIndex: number, t: number,
 *            point: {x: number, y: number}}|null}
 */
export function projectOntoPolyline(points, target, cumulative, range = null) {
  if (!Array.isArray(points) || points.length === 0) return null;
  if (points.length === 1) {
    return {
      distanceAlong: 0,
      offset: Math.hypot(target.x - points[0].x, target.y - points[0].y),
      segmentIndex: 0,
      t: 0,
      point: { ...points[0] }
    };
  }
  const along = cumulative || cumulativeDistances(points);
  let best = null;
  for (let i = 0; i < points.length - 1; i += 1) {
    // A route that doubles back on itself -- a hairpin, a loop, a road that
    // passes over its own alignment -- has two chainages at the same place, so
    // a global nearest-point search can snap to the wrong leg and report a
    // chainage the vehicle passed minutes ago. Constraining the search to a
    // window around the last known chainage keeps the match continuous.
    if (range && (along[i + 1] < range.min || along[i] > range.max)) continue;
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    let t = 0;
    if (lengthSquared > 1e-9) {
      t = ((target.x - a.x) * dx + (target.y - a.y) * dy) / lengthSquared;
      t = Math.min(1, Math.max(0, t));
    }
    const px = a.x + t * dx;
    const py = a.y + t * dy;
    const offset = Math.hypot(target.x - px, target.y - py);
    if (!best || offset < best.offset) {
      best = {
        offset,
        segmentIndex: i,
        t,
        point: { x: px, y: py },
        distanceAlong: along[i] + t * Math.sqrt(lengthSquared)
      };
    }
  }
  return best;
}

/** Interpolate the point at a given arc length along a polyline. */
export function pointAtDistance(points, distance, cumulative) {
  const along = cumulative || cumulativeDistances(points);
  if (points.length === 0) return null;
  if (distance <= 0) return { ...points[0] };
  const total = along[along.length - 1];
  if (distance >= total) return { ...points[points.length - 1] };
  let i = 1;
  while (i < along.length && along[i] < distance) i += 1;
  const segmentLength = along[i] - along[i - 1];
  const t = segmentLength > 1e-9 ? (distance - along[i - 1]) / segmentLength : 0;
  return {
    x: points[i - 1].x + t * (points[i].x - points[i - 1].x),
    y: points[i - 1].y + t * (points[i].y - points[i - 1].y)
  };
}

/** Heading in degrees of the polyline at a given arc length. */
export function headingAtDistance(points, distance, cumulative) {
  const along = cumulative || cumulativeDistances(points);
  if (points.length < 2) return null;
  let i = 1;
  while (i < along.length - 1 && along[i] < distance) i += 1;
  const dx = points[i].x - points[i - 1].x;
  const dy = points[i].y - points[i - 1].y;
  return (Math.atan2(dx, dy) / DEG + 360) % 360;
}

/**
 * Split a sequence of geographic points wherever the gap between consecutive
 * points exceeds `maxGapMetres`.
 *
 * A collected point table is not necessarily one continuous alignment: a survey
 * often visits several separate stretches, and treating the whole table as a
 * single polyline invents road where there is none — a 500 m "segment" joining
 * two unrelated curves will be analysed as geometry and can produce warnings
 * for a road that does not exist.
 */
export function splitOnGaps(points, maxGapMetres = 40) {
  const segments = [];
  let current = [];
  for (let i = 0; i < points.length; i += 1) {
    if (i > 0) {
      const gap = distanceMetres(
        points[i - 1].latitude, points[i - 1].longitude,
        points[i].latitude, points[i].longitude
      );
      if (gap > maxGapMetres) {
        if (current.length) segments.push(current);
        current = [];
      }
    }
    current.push(points[i]);
  }
  if (current.length) segments.push(current);
  return segments;
}
