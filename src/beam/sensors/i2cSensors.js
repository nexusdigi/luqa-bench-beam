'use strict';

// ── Real hardware I2C adapter — ported from the legacy PMU-60k tooling's
// pmu60k.py register-level sequence (PCA9548 mux select -> MCDC04/MTCS-INT-
// AB4 start -> 256ms integration wait -> read). Structurally faithful to
// the original, using the `i2c-bus` package (lazy-required — only when
// sensor_mode: "i2c" is actually selected, so the simulated-mode path
// never needs native bindings installed).
//
// ⚠ UNVERIFIED: there is no PMU-60k sensor board wired to any bench in this
// deployment yet, so this adapter has not been tested against real
// hardware — only checked for structural/register fidelity against
// pmu60k.py. Treat the first real run as a hardware bring-up, not a given.

const { SENSOR_SELECTION } = require('../beamMath');

const MCDC04_ADR = 0x74;
const REG_OSR = 0x00;
const REG_CREGL = 0x06;
const REG_OUT1 = 0x01;
const REG_OUT2 = 0x02;
const REG_OUT3 = 0x03;
const MCDC04_MODECMD = Buffer.from([0xb7, 0x08, 0x00, 0x20]);

const PCA481_ADR = 0x70;
const PCA482_ADR = 0x71;
const PCA48_CH = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x00];

const INTEGRATION_WAIT_MS = 256;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class I2cSensorAdapter {
  constructor({ busNumber = 1 } = {}) {
    this.busNumber = busNumber;
    this.bus = null;
  }

  async open() {
    const i2c = require('i2c-bus'); // eslint-disable-line global-require
    this.bus = await i2c.openPromisified(this.busNumber);
  }

  async close() {
    if (this.bus) await this.bus.close();
  }

  async _selectMuxChannel(sensorNumber) {
    if (sensorNumber <= 7) {
      await this.bus.writeByte(PCA482_ADR, PCA48_CH[8]); // deselect PCA_2
      await this.bus.writeByte(PCA481_ADR, PCA48_CH[sensorNumber]);
    } else {
      await this.bus.writeByte(PCA481_ADR, PCA48_CH[8]); // deselect PCA_1
      await this.bus.writeByte(PCA482_ADR, PCA48_CH[sensorNumber - 8]);
    }
  }

  async _startMeasurement() {
    await this.bus.writeI2cBlock(MCDC04_ADR, REG_CREGL, MCDC04_MODECMD.length, MCDC04_MODECMD);
    await this.bus.writeByteData(MCDC04_ADR, REG_OSR, 0x83);
  }

  async _readMtcsData() {
    const x = await this.bus.readWord(MCDC04_ADR, REG_OUT1);
    const y = await this.bus.readWord(MCDC04_ADR, REG_OUT2);
    const z = await this.bus.readWord(MCDC04_ADR, REG_OUT3);
    await this.bus.writeByteData(MCDC04_ADR, REG_OSR, 0x02); // stop, return to config mode
    return [x, y, z];
  }

  /** @param {string} aspectRatio @returns {Promise<number[][]>} 9 raw [X,Y,Z] triples */
  async readSensors(aspectRatio) {
    const sensorIds = SENSOR_SELECTION[aspectRatio] || SENSOR_SELECTION['1610'];

    for (const sensorNumber of sensorIds) {
      await this._selectMuxChannel(sensorNumber);
      await this._startMeasurement();
    }

    await sleep(INTEGRATION_WAIT_MS);

    const readings = [];
    for (const sensorNumber of sensorIds) {
      await this._selectMuxChannel(sensorNumber);
      readings.push(await this._readMtcsData());
    }
    return readings;
  }
}

module.exports = { I2cSensorAdapter };
