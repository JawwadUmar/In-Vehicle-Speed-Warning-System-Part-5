'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sideFriction, advisorySpeedKmh, advisorySpeedPart4, requiredDeceleration,
  classifyAlert, selectGoverningCurve, requiredLookAheadMetres, MAX_DECELERATION,
  DEFAULT_FRICTION_MODEL, IRC_SIDE_FRICTION, curveUrgency, ALERT_LEVELS, alertLabel
} from '../lib/safespeed.js';
import { CorridorTracker, MotionEstimator } from '../lib/pipeline.js';
import { createLocalFrame } from '../lib/geo.js';

test('the default side-friction model is IRC, f = 0.15 at every speed', () => {
  // The whole model is IRC-derived, so the friction factor is too. Mixing an
  // AASHTO curve into an otherwise IRC model would be a mixed-standard result.
  for (const speed of [20, 50, 85, 120, 200]) {
    assert.equal(sideFriction(speed), IRC_SIDE_FRICTION);
  }
  assert.equal(DEFAULT_FRICTION_MODEL, 'irc');
  assert.equal(sideFriction(85, 'irc'), 0.15);
});

test('the AASHTO model remains available for sensitivity runs', () => {
  assert.ok(sideFriction(30, 'aashto') > sideFriction(60, 'aashto'));
  assert.ok(sideFriction(60, 'aashto') > sideFriction(110, 'aashto'));
  assert.equal(sideFriction(10, 'aashto'), sideFriction(30, 'aashto'));
  assert.equal(sideFriction(200, 'aashto'), sideFriction(120, 'aashto'));
});

test('IRC and AASHTO agree on tight curves and diverge on gentle ones', () => {
  // Below R = 230 m the choice is worth under 2 km/h, which is why it can be
  // reported as a sensitivity rather than argued about.
  for (const radius of [90, 155, 230]) {
    const irc = advisorySpeedKmh(radius, { superelevation: 0.07, frictionModel: 'irc' });
    const aashto = advisorySpeedKmh(radius, { superelevation: 0.07, frictionModel: 'aashto' });
    assert.ok(Math.abs(irc - aashto) < 2,
      `R=${radius}: ${irc.toFixed(1)} vs ${aashto.toFixed(1)} km/h`);
  }
  // On a gentle curve AASHTO is the more conservative of the two.
  const gentle = 500;
  assert.ok(advisorySpeedKmh(gentle, { superelevation: 0.038, frictionModel: 'aashto' }) <
            advisorySpeedKmh(gentle, { superelevation: 0.038, frictionModel: 'irc' }));
});

test('advisory speed increases with radius and with superelevation', () => {
  const flat = advisorySpeedKmh(100, { superelevation: 0 });
  const banked = advisorySpeedKmh(100, { superelevation: 0.07 });
  assert.ok(banked > flat);
  assert.ok(advisorySpeedKmh(200, { superelevation: 0 }) > flat);
});

test('the Part 4 formula advises faster than the revised model on every curve', () => {
  // Part 4 assumed 7% superelevation and a fixed f = 0.15 everywhere, so it is
  // optimistic wherever the real banking is unknown. This is the safety-relevant
  // direction of the difference and is worth locking down.
  for (const radius of [15, 30, 60, 120, 250, 500]) {
    const part4 = advisorySpeedPart4(radius);
    const revised = advisorySpeedKmh(radius, { superelevation: 0 });
    assert.ok(part4 > revised,
      `R=${radius}: Part 4 ${part4.toFixed(1)} should exceed revised ${revised.toFixed(1)}`);
  }
});

test('required deceleration is zero below the advisory speed and rises as distance shrinks', () => {
  assert.equal(requiredDeceleration(40, 60, 200), 0);
  const far = requiredDeceleration(90, 40, 300);
  const near = requiredDeceleration(90, 40, 150);
  assert.ok(near > far && far > 0);
  // Past the point of no return the value is capped at the adhesion limit
  // rather than returned as Infinity, so alerts stay orderable and displayable.
  assert.equal(requiredDeceleration(100, 40, 10), MAX_DECELERATION);
});

test('the deceleration criterion warns earlier than a fixed 200 m gate when it must', () => {
  // 110 km/h into a 40 km/h curve. Part 4 stayed silent until 200 m.
  const advisory = 40;
  const at200 = requiredDeceleration(110, advisory, 200);
  assert.ok(at200 > 1.5,
    `at Part 4's 200 m gate the driver already needs ${at200.toFixed(2)} m/s2, beyond comfortable`);

  // Find where the revised logic first raises a warning: it must be well beyond
  // 200 m, i.e. the fixed gate was structurally too late for this case.
  let firstWarningDistance = 0;
  for (let distance = 600; distance >= 20; distance -= 1) {
    if (classifyAlert(requiredDeceleration(110, advisory, distance), 'none').level === 'warning') {
      firstWarningDistance = distance;
      break;
    }
  }
  assert.ok(firstWarningDistance > 280,
    `warning began at ${firstWarningDistance} m; expected well beyond the fixed 200 m gate`);

  // And geometry must be requested from further out still, or there would be
  // nothing to warn about when the warning is due.
  assert.ok(requiredLookAheadMetres(110) > firstWarningDistance);
});

test('a driver marginally over the advisory speed at a gentle curve is not told to brake', () => {
  // Braking distance diverges as the curve entry arrives, so the raw formula
  // would demand an emergency stop for a 7 km/h exceedance on a 400 m bend.
  const curves = [{ radius: 400, distanceAhead: 30 }];
  const governing = selectGoverningCurve(curves, 85, { superelevation: 0 });
  assert.ok(governing.requiredDeceleration < 1.5,
    `urgency ${governing.requiredDeceleration.toFixed(2)} should stay below warning level`);
  assert.notEqual(classifyAlert(governing.requiredDeceleration, 'none').level, 'brake');
});

test('alert classification has hysteresis', () => {
  const rising = classifyAlert(1.6, 'none');
  assert.equal(rising.level, 'warning');
  // Falling back to 1.2 stays in 'warning' because the release threshold is 1.1.
  assert.equal(classifyAlert(1.2, 'warning').level, 'warning');
  // But from 'none' the same value would only be an advisory.
  assert.equal(classifyAlert(1.2, 'none').level, 'advisory');
  assert.equal(classifyAlert(0.2, 'warning').level, 'none');
});

test('the governing curve is the most demanding one, not the nearest', () => {
  const curves = [
    { radius: 400, distanceAhead: 30 },   // gentle, close
    { radius: 25, distanceAhead: 160 }    // sharp, further
  ];
  const governing = selectGoverningCurve(curves, 85, { superelevation: 0 });
  assert.equal(governing.radius, 25,
    'Part 4 would have picked the nearest (400 m) curve and stayed silent');
  assert.ok(governing.requiredDeceleration > 1.5);
});

test('look-ahead scales with speed', () => {
  assert.ok(requiredLookAheadMetres(100) > requiredLookAheadMetres(50));
  assert.ok(requiredLookAheadMetres(0) >= 300);
  assert.ok(requiredLookAheadMetres(160) <= 1500);
});

test('distance to curve stays live as the vehicle moves along the corridor', () => {
  // The Part 4 bug: distance was frozen at fetch time. Here one corridor is set
  // once, then the vehicle advances and the distance must fall accordingly.
  const points = [];
  for (let i = 0; i <= 100; i += 1) {
    points.push([22.52 + i * 0.000045, 75.92]);      // ~5 m spacing due north
  }
  const tracker = new CorridorTracker();
  tracker.setCorridor({
    points,
    curves: [{ startDistance: 400, endDistance: 460, radius: 50, direction: 'left' }],
    source: 'test',
    truncated: false
  }, 0);

  const atStart = tracker.locate({ latitude: points[0][0], longitude: points[0][1] }, 0);
  const at40 = tracker.locate({ latitude: points[40][0], longitude: points[40][1] }, 1000);

  assert.ok(atStart.curvesAhead[0].distanceAhead > 390);
  assert.ok(at40.curvesAhead[0].distanceAhead < atStart.curvesAhead[0].distanceAhead - 150,
    `distance did not fall: ${atStart.curvesAhead[0].distanceAhead} -> ${at40.curvesAhead[0].distanceAhead}`);
});

test('a curve already passed is dropped, one being driven through is kept', () => {
  const points = [];
  for (let i = 0; i <= 100; i += 1) points.push([22.52 + i * 0.000045, 75.92]);
  const tracker = new CorridorTracker();
  tracker.setCorridor({
    points,
    curves: [
      { startDistance: 20, endDistance: 60, radius: 40, direction: 'left' },
      { startDistance: 300, endDistance: 340, radius: 40, direction: 'right' }
    ],
    source: 'test',
    truncated: false
  }, 0);

  const inside = tracker.locate({ latitude: points[8][0], longitude: points[8][1] }, 0);
  assert.equal(inside.curvesAhead.length, 2, 'the curve being driven through should remain');
  assert.equal(inside.curvesAhead[0].distanceAhead, 0);

  const past = tracker.locate({ latitude: points[20][0], longitude: points[20][1] }, 0);
  assert.equal(past.curvesAhead.length, 1, 'the passed curve should be dropped');
});

test('speed is derived from successive fixes when the device reports none', () => {
  // On desktop and on many handsets coords.speed is null, which in Part 4 meant
  // the readout sat at 0 and no warning could ever fire in testing.
  const estimator = new MotionEstimator();
  let state = estimator.update({ latitude: 22.52, longitude: 75.92, speed: null, heading: null, accuracy: 5 }, 0);
  assert.equal(state.speedKmh, 0);
  for (let i = 1; i <= 12; i += 1) {
    // ~13.9 m per second => 50 km/h
    state = estimator.update({
      latitude: 22.52 + i * 0.000125, longitude: 75.92, speed: null, heading: null, accuracy: 5
    }, i * 1000);
  }
  assert.ok(state.speedKmh > 40 && state.speedKmh < 60, `derived speed ${state.speedKmh.toFixed(1)} km/h`);
  assert.ok(Number.isFinite(state.headingDegrees), 'heading should be derived too');
  assert.ok(state.headingDegrees < 5 || state.headingDegrees > 355, `heading ${state.headingDegrees}`);
});

test('an implausible position jump does not spike the speed', () => {
  const estimator = new MotionEstimator();
  estimator.update({ latitude: 22.52, longitude: 75.92, speed: null, heading: null, accuracy: 5 }, 0);
  const before = estimator.speedKmh;
  const state = estimator.update({ latitude: 23.52, longitude: 76.92, speed: null, heading: null, accuracy: 5 }, 1000);
  assert.equal(state.speedKmh, before, 'a 100+ km jump in one second should be rejected');
});

test('advisory speed is monotone in radius and solves the true root, both models', () => {
  // The fixed-point iteration this replaced entered a limit cycle above about
  // R = 700 m under the speed-dependent model: it returned 107.2 km/h for
  // R = 1000 m against a true root of 113.9, and 85 radii between 100 and
  // 1200 m returned a LOWER advisory speed for a LARGER curve.
  for (const frictionModel of ['irc', 'aashto']) {
    let previous = 0;
    for (let radius = 20; radius <= 2000; radius += 5) {
      const speed = advisorySpeedKmh(radius, { superelevation: 0, frictionModel });
      assert.ok(speed >= previous - 1e-9,
        `${frictionModel} R=${radius}: ${speed.toFixed(2)} below R=${radius - 5}'s ${previous.toFixed(2)}`);
      previous = speed;
    }
    for (const radius of [50, 300, 1000, 1500]) {
      const speed = advisorySpeedKmh(radius, { superelevation: 0, frictionModel });
      const residual = speed - Math.sqrt(127 * radius * sideFriction(speed, frictionModel));
      assert.ok(Math.abs(residual) < 0.05,
        `${frictionModel} R=${radius}: residual ${residual.toFixed(3)} — not a root`);
    }
  }
});

test('under IRC the advisory speed reduces to the closed form', () => {
  for (const [radius, e] of [[90, 0.07], [230, 0.07], [500, 0.038]]) {
    const solved = advisorySpeedKmh(radius, { superelevation: e, frictionModel: 'irc' });
    const closedForm = Math.sqrt(127 * radius * (e + IRC_SIDE_FRICTION));
    assert.ok(Math.abs(solved - closedForm) < 0.05,
      `R=${radius}: solver gave ${solved.toFixed(2)}, closed form ${closedForm.toFixed(2)}`);
  }
});

test('the IRC advisory speed matches IRC restricted speed on a substandard curve', () => {
  // IRC restricts a substandard curve to sqrt(127 R (e_max + 0.15)). With e at
  // the cap, the advisory speed must be exactly that — the model and the code
  // it cites agree by construction.
  for (const radius of [90, 155, 230]) {
    const advisory = advisorySpeedKmh(radius, { superelevation: 0.07, frictionModel: 'irc' });
    const restricted = Math.sqrt(127 * radius * (0.07 + 0.15));
    assert.ok(Math.abs(advisory - restricted) < 0.05,
      `R=${radius}: ${advisory.toFixed(1)} vs IRC restricted ${restricted.toFixed(1)}`);
  }
});

test('a fix rejected by the accuracy gate does not corrupt the next one', () => {
  // Storing a rejected fix as the baseline made the NEXT good fix measure its
  // displacement from a bad position: one 250 m outlier turned a steady
  // 50 km/h into 105 km/h and flipped the heading by 285 degrees, which then
  // built the corridor in the wrong direction of travel.
  const estimator = new MotionEstimator();
  for (let i = 0; i <= 10; i += 1) {
    estimator.update({
      latitude: 22.52 + i * 0.000125, longitude: 75.92, speed: null, heading: null, accuracy: 5
    }, i * 1000);
  }
  const before = estimator.speedKmh;
  const beforeHeading = estimator.headingDegrees;

  // A wild fix, correctly flagged as inaccurate.
  const rejected = estimator.update({
    latitude: 22.52 + 11 * 0.000125, longitude: 75.9245, speed: null, heading: null, accuracy: 300
  }, 11000);
  assert.equal(rejected.usable, false);
  assert.equal(rejected.speedKmh, before, 'a rejected fix must not change speed');

  // The next good fix continues the real track.
  const after = estimator.update({
    latitude: 22.52 + 12 * 0.000125, longitude: 75.92, speed: null, heading: null, accuracy: 5
  }, 12000);
  assert.ok(Math.abs(after.speedKmh - before) < 15,
    `speed jumped from ${before.toFixed(1)} to ${after.speedKmh.toFixed(1)} km/h after one bad fix`);
  assert.ok(Math.abs(((after.headingDegrees - beforeHeading + 540) % 360) - 180) < 30,
    `heading flipped from ${beforeHeading.toFixed(0)} to ${after.headingDegrees.toFixed(0)}`);
});

test('the match cannot jump to the opposite leg of a hairpin', () => {
  // A fixed 400 m forward window was wide enough to contain the returning
  // carriageway, so one sideways GPS excursion latched the match onto it and
  // chainage then ran BACKWARDS while the vehicle moved forward.
  const frame = createLocalFrame({ latitude: 22.52, longitude: 75.92 });
  const local = [];
  for (let y = 0; y <= 300; y += 5) local.push({ x: 0, y });        // out
  for (let a = 0; a <= 180; a += 15) {                               // 10 m U-turn
    local.push({ x: 10 - 10 * Math.cos(a * Math.PI / 180), y: 300 + 10 * Math.sin(a * Math.PI / 180) });
  }
  for (let y = 300; y >= 0; y -= 5) local.push({ x: 20, y });        // back
  const points = local.map(point => {
    const geographic = frame.toGeographic(point);
    return [geographic.latitude, geographic.longitude];
  });

  const tracker = new CorridorTracker();
  tracker.setCorridor({ points, curves: [], source: 'test', truncated: false, atNetworkEnd: false }, 0);

  const at = (y, x, when) => tracker.locate(frame.toGeographic({ x, y }), when);
  at(0, 0, 0);
  const before = at(250, 0, 25000);          // 1 Hz-ish progress out along x=0
  at(255, 20, 26000);                        // one bad fix, 20 m sideways
  const after = at(260, 0, 27000);           // back on the true track

  assert.ok(after.distanceAlong > before.distanceAlong,
    `chainage went backwards: ${before.distanceAlong.toFixed(0)} -> ${after.distanceAlong.toFixed(0)}`);
  assert.ok(Math.abs(after.distanceAlong - 260) < 25,
    `expected ~260 m along, got ${after.distanceAlong.toFixed(0)}`);
});

test('needsRefresh does not move the tracker state', () => {
  const points = [];
  for (let i = 0; i <= 200; i += 1) points.push([22.52 + i * 0.000045, 75.92]);
  const tracker = new CorridorTracker();
  tracker.setCorridor({ points, curves: [], source: 'test', truncated: false, atNetworkEnd: false }, 0);
  tracker.locate({ latitude: points[20][0], longitude: points[20][1] }, 1000);
  const anchored = tracker.lastDistanceAlong;
  tracker.needsRefresh({ latitude: points[150][0], longitude: points[150][1] }, 300, 2000);
  assert.equal(tracker.lastDistanceAlong, anchored,
    'needsRefresh is a query and must not advance the continuity window');
});

test('urgency is continuous and monotone as the curve approaches', () => {
  // A hard switch between the braking and lateral measures made urgency
  // COLLAPSE at the commitment boundary: 8.27 at 50 m became 1.39 at 48 m,
  // downgrading a BRAKE alert to an advisory for a driver 20 km/h over and
  // already entering the curve. Urgency must never fall as distance shrinks.
  for (const radius of [30, 60, 90, 155, 230, 360, 500]) {
    const advisory = advisorySpeedKmh(radius, { superelevation: 0.07 });
    for (const over of [2, 10, 25, 50]) {
      let previous = -1;
      for (let distance = 600; distance >= 0; distance -= 0.5) {
        const urgency = curveUrgency(advisory + over, advisory, distance);
        assert.ok(urgency >= previous - 1e-9,
          `R=${radius}, +${over} km/h: urgency fell from ${previous.toFixed(2)} to ${urgency.toFixed(2)} at ${distance} m`);
        previous = urgency;
      }
    }
  }
});

test('a brake-level alert persists through the curve entry', () => {
  const advisory = advisorySpeedKmh(230, { superelevation: 0.07 });
  const fast = advisory + 20;
  for (const distance of [60, 50, 40, 20, 10, 0]) {
    assert.equal(classifyAlert(curveUrgency(fast, advisory, distance), 'brake').level, 'brake',
      `dropped below brake at ${distance} m`);
  }
});

test('a small exceedance close to a curve is not a brake alert', () => {
  // The reason the clamp exists: without it, 4 km/h over 25 m from a curve
  // demands 12 m/s2 and fires a full BRAKE.
  const advisory = advisorySpeedKmh(155, { superelevation: 0.07 });
  const urgency = curveUrgency(advisory + 4, advisory, 25);
  assert.ok(urgency < ALERT_LEVELS.find(l => l.level === 'warning').trigger,
    `urgency ${urgency.toFixed(2)} reached warning level for a 4 km/h exceedance`);
});

test('the lateral floor only applies once committed, not at any distance', () => {
  // Ungated, it alerted a driver 1500 m from a curve purely because they were
  // above its advisory speed — an advisory that would never clear.
  const advisory = advisorySpeedKmh(90, { superelevation: 0.07 });
  const urgency = curveUrgency(advisory + 15, advisory, 1500);
  assert.equal(classifyAlert(urgency, 'none').level, 'none',
    `alerted ${1500} m from the curve (urgency ${urgency.toFixed(2)})`);
  // But it does engage once there is no braking distance left.
  assert.ok(curveUrgency(advisory + 15, advisory, 5) > 0);
});

test('geometry is always held far enough to raise the alert in time', () => {
  // At a 1.6 margin the look-ahead reached 465 m at 100 km/h while the advisory
  // for a 60 m curve was due at 492 m — the warning would have arrived after
  // the point it was needed.
  const trigger = ALERT_LEVELS.find(l => l.level === 'advisory').trigger;
  let inadequate = 0;
  for (let speed = 40; speed <= 120; speed += 5) {
    for (const radius of [30, 45, 60, 90, 120, 155, 200, 230, 300, 360, 450, 600]) {
      const advisory = advisorySpeedKmh(radius, { superelevation: 0.07 });
      if (speed <= advisory + 0.5) continue;
      let onset = null;
      for (let distance = 2000; distance >= 0; distance -= 1) {
        if (curveUrgency(speed, advisory, distance) >= trigger) { onset = distance; break; }
      }
      if (onset !== null && requiredLookAheadMetres(speed) < onset) inadequate += 1;
    }
  }
  assert.equal(inadequate, 0, `${inadequate} speed/radius cases alert beyond the look-ahead`);
});

test('the alert persists through the curve and uses in-curve wording', () => {
  // The whole point of warning inside the curve: entering too fast does not
  // stop being a problem at the entry point. But "BRAKE" is the wrong
  // instruction mid-corner, so only the wording changes — the urgency value
  // stays continuous across the entry.
  assert.equal(alertLabel('brake', false), 'BRAKE');
  assert.notEqual(alertLabel('brake', true), 'BRAKE');
  assert.ok(alertLabel('brake', true).length > 0);
  assert.equal(alertLabel('none', true), '');
  for (const level of ['advisory', 'warning', 'brake']) {
    assert.notEqual(alertLabel(level, true), alertLabel(level, false),
      `${level} should read differently inside the curve`);
  }
});

test('a curve being driven through is flagged inCurve, one ahead is not', () => {
  const points = [];
  for (let i = 0; i <= 120; i += 1) points.push([22.52 + i * 0.000045, 75.92]);
  const tracker = new CorridorTracker();
  tracker.setCorridor({
    points,
    curves: [{ startDistance: 200, endDistance: 380, radius: 155, direction: 'left' }],
    source: 'test', truncated: false, atNetworkEnd: false
  }, 0);

  const approaching = tracker.locate({ latitude: points[20][0], longitude: points[20][1] }, 0);
  assert.equal(approaching.curvesAhead[0].inCurve, false);
  assert.ok(approaching.curvesAhead[0].distanceAhead > 0);

  const inside = tracker.locate({ latitude: points[60][0], longitude: points[60][1] }, 1000);
  assert.equal(inside.curvesAhead[0].inCurve, true);
  assert.equal(inside.curvesAhead[0].distanceAhead, 0);
  assert.ok(inside.curvesAhead[0].distanceToExit > 0);

  // Past the exit the curve is dropped entirely.
  const past = tracker.locate({ latitude: points[100][0], longitude: points[100][1] }, 2000);
  assert.equal(past.curvesAhead.length, 0);
});

test('urgency does not drop at the moment of entering the curve', () => {
  // Same class of bug as the commitment-boundary collapse: if the in-curve
  // measure differed from the approach measure, the alert would weaken exactly
  // as the driver entered.
  const advisory = advisorySpeedKmh(155, { superelevation: 0.07 });
  const fast = advisory + 19;
  const justBefore = curveUrgency(fast, advisory, 1);
  const atEntry = curveUrgency(fast, advisory, 0);
  assert.ok(atEntry >= justBefore - 1e-9,
    `urgency fell from ${justBefore.toFixed(2)} to ${atEntry.toFixed(2)} on entering`);
  assert.equal(classifyAlert(atEntry, 'brake').level, 'brake');
});
