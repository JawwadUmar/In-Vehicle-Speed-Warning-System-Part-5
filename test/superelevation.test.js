'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ircSuperelevation, designSpeedKmh, capGovernsBelowRadius, designSpeedSensitivity,
  resolveSuperelevation, measuredSuperelevationNear, MAX_SUPERELEVATION
} from '../lib/superelevation.js';
import { advisorySpeedKmh } from '../lib/safespeed.js';

test('the 225 encodes banking for 75% of the design speed', () => {
  // e = (0.75 Vd)^2 / (127 R). Check the identity rather than the constant.
  for (const [radius, speed] of [[800, 100], [1200, 80], [2000, 65]]) {
    const viaFormula = ircSuperelevation(radius, { designSpeed: speed }).rawSuperelevation;
    const viaDerivation = (0.75 * speed) ** 2 / (127.14 * radius);
    assert.ok(Math.abs(viaFormula - viaDerivation) / viaDerivation < 0.005,
      `R=${radius}, Vd=${speed}: ${viaFormula.toFixed(5)} vs ${viaDerivation.toFixed(5)}`);
  }
});

test('superelevation is capped and the cap threshold is Vd^2 / (225 e_max)', () => {
  for (const speed of [65, 80, 100]) {
    const threshold = capGovernsBelowRadius(speed, 0.07);
    assert.ok(ircSuperelevation(threshold * 0.9, { designSpeed: speed }).capped);
    assert.ok(!ircSuperelevation(threshold * 1.1, { designSpeed: speed }).capped);
    assert.equal(ircSuperelevation(threshold * 0.9, { designSpeed: speed }).superelevation, 0.07);
  }
  // 268 m at the lowest plausible design speed — the claim the method section makes.
  assert.ok(Math.abs(capGovernsBelowRadius(65, 0.07) - 268) < 2,
    `cap threshold at Vd=65 is ${capGovernsBelowRadius(65, 0.07).toFixed(0)} m, expected ~268`);
});

test('below the cap threshold the design speed does not affect the result at all', () => {
  // This is what lets the design speed be assumed rather than known: across the
  // radii where warnings actually fire, every plausible Vd returns e_max.
  for (const radius of [60, 90, 155, 230, 260]) {
    const values = [65, 80, 100].map(speed =>
      ircSuperelevation(radius, { designSpeed: speed }).superelevation);
    assert.ok(Math.max(...values) - Math.min(...values) < 1e-12,
      `R=${radius} gave ${values.map(v => v.toFixed(4)).join(', ')}`);
    assert.equal(values[0], 0.07);
  }
  const sensitivity = designSpeedSensitivity([60, 90, 155, 230, 260]);
  assert.equal(sensitivity.sensitive, 0);
});

test('above the threshold it does vary, and more gently for lower design speeds', () => {
  const at65 = ircSuperelevation(500, { designSpeed: 65 }).superelevation;
  const at80 = ircSuperelevation(500, { designSpeed: 80 }).superelevation;
  const at100 = ircSuperelevation(500, { designSpeed: 100 }).superelevation;
  assert.ok(at65 < at80 && at80 < at100);
  assert.ok(at100 <= 0.07);
  // And the lower design speed is the conservative one: lower e, lower advisory.
  assert.ok(advisorySpeedKmh(500, { superelevation: at65 }) <
            advisorySpeedKmh(500, { superelevation: at100 }));
});

test('substandard curves are flagged and given IRC restricted speeds', () => {
  const tight = ircSuperelevation(155, { designSpeed: 100 });
  assert.ok(tight.substandard, 'R=155 m should be substandard at 100 km/h');
  assert.ok(tight.frictionDemand > 0.15);
  // The restricted speed is sqrt(127 R (e_max + 0.15)).
  assert.ok(Math.abs(tight.restrictedSpeedKmh - Math.sqrt(127 * 155 * 0.22)) < 0.5);

  const gentle = ircSuperelevation(800, { designSpeed: 80 });
  assert.ok(!gentle.substandard);
  assert.ok(gentle.frictionDemand <= 0.15);
});

test('design-implied superelevation sits between the two bounds it replaces', () => {
  // e = 0 is the conservative floor, e = 7% the Part 4 ceiling. Design-implied
  // must never exceed the ceiling, and equals it on the curves that matter.
  for (const radius of [60, 155, 230, 400, 800, 1500]) {
    const e = ircSuperelevation(radius, { designSpeed: 65 }).superelevation;
    assert.ok(e >= 0 && e <= 0.07, `R=${radius} gave e=${e}`);
    const advisory = advisorySpeedKmh(radius, { superelevation: e });
    assert.ok(advisory >= advisorySpeedKmh(radius, { superelevation: 0 }));
    assert.ok(advisory <= advisorySpeedKmh(radius, { superelevation: 0.07 }) + 1e-9);
  }
});

test('mountainous terrain raises the cap to 10%', () => {
  assert.equal(MAX_SUPERELEVATION.plain, 0.07);
  assert.equal(MAX_SUPERELEVATION.mountainous, 0.10);
  const hill = ircSuperelevation(60, { designSpeed: 40, maxSuperelevation: MAX_SUPERELEVATION.mountainous });
  assert.equal(hill.superelevation, 0.10);
});

test('the minimum design-speed basis is the conservative one', () => {
  for (const terrain of ['plain', 'rolling', 'mountainous']) {
    assert.ok(designSpeedKmh('SH', terrain, 'minimum') < designSpeedKmh('SH', terrain, 'ruling'));
  }
  assert.equal(designSpeedKmh('SH', 'plain', 'ruling'), 100);
  assert.equal(designSpeedKmh('SH', 'plain', 'minimum'), 80);
});

test('a measured value always beats the design-implied one', () => {
  const design = resolveSuperelevation(230, { designSpeed: 65 });
  assert.equal(design.source, 'design-implied');
  assert.equal(design.value, 0.07);

  const measured = resolveSuperelevation(230, { designSpeed: 65 }, 0.02);
  assert.equal(measured.source, 'measured');
  assert.equal(measured.value, 0.02);

  // Even a measured zero — an unbanked curve is exactly what must not be
  // silently replaced by the design assumption.
  const flat = resolveSuperelevation(230, { designSpeed: 65 }, 0);
  assert.equal(flat.source, 'measured');
  assert.equal(flat.value, 0);

  const zeroMode = resolveSuperelevation(230, { mode: 'zero' });
  assert.equal(zeroMode.value, 0);
  assert.equal(zeroMode.source, 'assumed-zero');
});

test('measured values match by proximity, so a survey survives a layer rebuild', () => {
  const table = [[22.5210, 75.9230, 0.045], [22.5400, 75.9400, 0.02]];
  // 20 m away from the first entry.
  assert.equal(measuredSuperelevationNear(table, 22.52118, 75.9230), 0.045);
  // Far from both.
  assert.equal(measuredSuperelevationNear(table, 22.6000, 75.9000), null);
  assert.equal(measuredSuperelevationNear([], 22.52, 75.92), null);
});

test('assuming 7% where the curve is flat is the unsafe direction, and by how much', () => {
  // The reason measured values must win: on an unbanked 230 m curve the Part 4
  // assumption advises ~20% fast.
  const assumed = advisorySpeedKmh(230, { superelevation: 0.07 });
  const actual = advisorySpeedKmh(230, { superelevation: 0 });
  assert.ok(assumed > actual);
  assert.ok((assumed / actual - 1) > 0.15 && (assumed / actual - 1) < 0.25,
    `overestimate was ${(100 * (assumed / actual - 1)).toFixed(0)}%`);
});
