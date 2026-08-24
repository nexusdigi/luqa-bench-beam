'use strict';

// ── LUQA BEAM measurement math — ported 1:1 from the legacy PMU-60k
// tooling's pmu60k.py (production/measurement mode). IEC 61947-1 9-point
// ANSI-lumen method with AMS MTCS-INT-AB4 tristimulus (XYZ) sensors.
//
// 15 physical sensors are mounted on the wall; which 9 of them form the
// active measurement grid depends on the selected aspect ratio. Only 4:3
// uses a different (inner) subset — 16:10/16:9/17:9 all share the same
// outer-sensor subset and differ only in the ANSI-lumen area factor.

const AREA = {
  '0403': 1.248798,
  '1610': 1.752006,
  '1609': 1.665377,
  '1709': 1.610885,
};

const SENSOR_SELECTION = {
  '0403': [3, 6, 9, 4, 7, 10, 5, 8, 11],   // 4:3 - inner sensors
  '1610': [0, 6, 12, 1, 7, 13, 2, 8, 14],  // 16:10 - outer sensors
  '1609': [0, 6, 12, 1, 7, 13, 2, 8, 14],  // 16:9 - outer sensors (same subset as 16:10)
  '1709': [0, 6, 12, 1, 7, 13, 2, 8, 14],  // 17:9 - outer sensors (same subset as 16:10)
};

const ASPECT_RATIOS = Object.keys(AREA);

// Physical sensor count on the wall (0..14) — the calibration matrix always
// has one 3x3 entry per physical sensor, regardless of which 9 are active
// for the current aspect ratio.
const SENSOR_COUNT = 15;

// Index into the 9-element active-sensor result array that is the true
// center of the grid, for chromaticity (center-only, matching the legacy
// tooling exactly — chromaticity is not averaged across all 9 points).
const CENTER_INDEX = 7;

// getPhotocurrent() constants — MTCS-INT-AB4 ADC → photocurrent conversion.
const DIVIDER = 1;
const REFCURRENT_nA = 1280.0;
const OFFSET = 16;
const NCLK = 131072.0; // bit = 10 + log2(INTTIME_ms=128) -> nClk = 2^bit

function getPhotocurrent(rawXYZ) {
  return rawXYZ.slice(0, 3).map((v) => ((v * DIVIDER - OFFSET) * REFCURRENT_nA) / NCLK);
}

function matMulVec3(matrix9, vec3) {
  // matrix9: [m00,m01,m02, m10,m11,m12, m20,m21,m22] row-major, matching
  // numpy's .reshape(3,3) of the flat 9-element calibData.json arrays.
  const m = matrix9.map(Number);
  return [
    m[0] * vec3[0] + m[1] * vec3[1] + m[2] * vec3[2],
    m[3] * vec3[0] + m[4] * vec3[1] + m[5] * vec3[2],
    m[6] * vec3[0] + m[7] * vec3[1] + m[8] * vec3[2],
  ];
}

/**
 * Apply the calibration matrix for one physical sensor to its raw XYZ
 * reading, producing a calibrated [X, Y, Z] triple.
 * @param {number[]} rawXYZ - 3 raw ADC values for this sensor
 * @param {number[]} matrix9 - this sensor's 3x3 correction matrix, flat
 */
function calibrateSensor(rawXYZ, matrix9) {
  return matMulVec3(matrix9, getPhotocurrent(rawXYZ));
}

function calcXy(X, Y, Z) {
  if (X <= 0 && Y <= 0 && Z <= 0) return { x: 0, y: 0 };
  const sum = X + Y + Z;
  return { x: round5(X / sum), y: round5(Y / sum) };
}

function calcUv(X, Y, Z) {
  if (X <= 0 && Y <= 0 && Z <= 0) return { u: 0, v: 0 };
  const sum = X + 15.0 * Y + 3.0 * Z;
  return { u: round5((4.0 * X) / sum), v: round5((9.0 * Y) / sum) };
}

// McCamy approximation, valid ~2000K-10000K: CCT = 437n³ + 3601n² + 6831n + 5517, n = (x-0.3320)/(0.1858-y)
function calcCct(x, y) {
  let cct;
  if (x === 0 && y === 0) {
    cct = 5517;
  } else if (y === 0.1858) {
    cct = 5517;
  } else {
    const n = (x - 0.332) / (0.1858 - y);
    cct = 437 * n ** 3 + 3601 * n ** 2 + 6831 * n + 5517;
  }
  return Math.round(Math.max(0, Math.min(15000, cct)));
}

function calcAnsi(yValues, aspectRatio) {
  const sum = yValues.reduce((s, v) => s + v, 0);
  return Math.floor((sum / 9.0) * AREA[aspectRatio]);
}

function calcUniformity(yValues) {
  if (yValues.some((v) => v === 0)) return 0;
  return Math.floor((100 * Math.min(...yValues)) / Math.max(...yValues));
}

function round5(v) {
  return Math.round(v * 1e5) / 1e5;
}

/**
 * Full measurement pipeline for one live reading: 9 raw sensor XYZ triples
 * (in aspect-ratio grid order) + that aspect ratio's 15-sensor calibration
 * matrix set -> the same {points, lumen, cct, uniformity, x, y, u, v} shape
 * pushed over the legacy tooling's WebSocket, now pushed via
 * bench-report-progress's progress.live instead.
 *
 * @param {number[][]} rawReadings - 9 raw [X,Y,Z] triples, in SENSOR_SELECTION[aspectRatio] order
 * @param {string} aspectRatio - one of ASPECT_RATIOS
 * @param {object} calibMatrixSet - {"matrix0": [9 floats], ..., "matrix14": [9 floats]} for the active sensors
 */
function computeReading(rawReadings, aspectRatio, calibMatrixSet) {
  const sensorIds = SENSOR_SELECTION[aspectRatio];
  const calibrated = rawReadings.map((raw, i) => {
    const matrix = calibMatrixSet[`matrix${sensorIds[i]}`] || IDENTITY_MATRIX;
    return calibrateSensor(raw, matrix);
  });

  const points = calibrated.map(([, Y]) => Math.max(0, Math.round(Y)));
  const center = calibrated[CENTER_INDEX];
  const { x, y } = calcXy(center[0], center[1], center[2]);
  const { u, v } = calcUv(center[0], center[1], center[2]);

  return {
    aspect_ratio: aspectRatio,
    points,
    lumen: calcAnsi(points, aspectRatio),
    cct: calcCct(x, y),
    uniformity: calcUniformity(points),
    x,
    y,
    u,
    v,
  };
}

const IDENTITY_MATRIX = ['1.0', '0.0', '0.0', '0.0', '1.0', '0.0', '0.0', '0.0', '1.0'];

module.exports = {
  AREA,
  SENSOR_SELECTION,
  ASPECT_RATIOS,
  SENSOR_COUNT,
  CENTER_INDEX,
  IDENTITY_MATRIX,
  getPhotocurrent,
  calibrateSensor,
  calcXy,
  calcUv,
  calcCct,
  calcAnsi,
  calcUniformity,
  computeReading,
};
