'use strict';

// Fake-but-plausible raw sensor readings, used when no real PMU-60k sensor
// board is wired to this bench (config.json sensor_mode: "simulated").
// Generates raw [X,Y,Z] ADC-shaped values per sensor, run through the exact
// same beamMath.computeReading() pipeline a real reading would use — the
// simulation differs only at this one point, not in the math or the wire
// format, so the rest of the workflow (live view, capture, QC embedding)
// exercises real code paths end-to-end.
//
// Modeled loosely on a ~6500K "daylight white" projector output: Y around a
// nominal brightness with mild per-point falloff toward the edges (typical
// of a real lens/screen) plus small random noise, X/Z chosen to land near
// the D65 white point.

const { SENSOR_SELECTION } = require('../beamMath');

// Raw-ADC-scale nominal photocurrent-producing values (same order of
// magnitude as real MTCS-INT-AB4 readings run through getPhotocurrent()).
const NOMINAL = { X: 620, Y: 650, Z: 700 };

function jitter(base, amountPct = 4) {
  const delta = base * (amountPct / 100) * (Math.random() * 2 - 1);
  return Math.round(base + delta);
}

/** Mild center-brighter falloff so the 9 points aren't perfectly uniform (more realistic + gives uniformity% something to compute). */
function falloffFactor(pointIndex) {
  // Points 0,2,6,8 are the corners of the 3x3 layout in acquisition order,
  // 4 is the center — matches the legacy tooling's row-major point order.
  const CORNER_INDEXES = new Set([0, 2, 6, 8]);
  return CORNER_INDEXES.has(pointIndex) ? 0.9 : 1.0;
}

/**
 * @param {string} aspectRatio
 * @returns {number[][]} 9 raw [X,Y,Z] triples, same order beamMath.computeReading() expects
 */
function readSimulated(aspectRatio) {
  const sensorIds = SENSOR_SELECTION[aspectRatio] || SENSOR_SELECTION['1610'];
  return sensorIds.map((_, i) => {
    const f = falloffFactor(i);
    return [jitter(NOMINAL.X * f), jitter(NOMINAL.Y * f), jitter(NOMINAL.Z * f)];
  });
}

module.exports = { readSimulated };
