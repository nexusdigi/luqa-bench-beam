'use strict';

// PCA9532 LED driver (16 LEDs on the wall, 4 lit per aspect ratio to show
// the operator which of the 9 grid points are active). Ported from
// pmu60k.py's setLed() — same "⚠ UNVERIFIED against real hardware" caveat
// as i2cSensors.js.

const PCA32_ADR = 0x60;
const PCA32_REG = 0x14;

const LED_PATTERN = {
  '0403': Buffer.from([0x00, 0x20, 0xc0, 0xc0, 0x03, 0x03]),
  '1610': Buffer.from([0x00, 0x20, 0x03, 0x03, 0xc0, 0xc0]),
  '1609': Buffer.from([0x00, 0x20, 0x0c, 0x0c, 0x30, 0x30]),
  '1709': Buffer.from([0x00, 0x20, 0x30, 0x30, 0x0c, 0x0c]),
};

/** No-op unless a real i2c-bus instance is passed — the simulated agent never calls this with a bus. */
async function setLed(bus, aspectRatio) {
  if (!bus) return;
  const pattern = LED_PATTERN[aspectRatio];
  if (!pattern) return;
  await bus.writeI2cBlock(PCA32_ADR, PCA32_REG, pattern.length, pattern);
}

module.exports = { setLed, LED_PATTERN };
