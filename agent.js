#!/usr/bin/env node
'use strict';

/**
 * LUQA BEAM agent — runs on the bench (Raspberry Pi) wired to a PMU-60k
 * style projection test wall. Heartbeats to LUQA, polls for reserved test
 * sessions, and runs an interactive "live-aim" loop: repeatedly samples the
 * 9-point sensor grid for the operator-selected aspect ratio and pushes
 * readings back so the operator can watch live numbers while aiming the
 * projector, then capture a snapshot from the LUQA UI when ready.
 *
 * Unlike LUQA PIXEL's fire-and-forget automated sequence, this is operator-
 * driven end to end — the agent has no notion of pass/fail, it just reports
 * numbers. See docs/architecture/luqa-benches-architecture.md §12.
 *
 * Usage:
 *   npm install
 *   cp config.example.json config.json   # fill in slug + token
 *   node agent.js
 */

const { loadConfig, sendHeartbeat, pollJob, respondJob, reportProgress, pollSession, reportAbort } = require('./src/luqaClient');
const { computeReading, ASPECT_RATIOS } = require('./src/beam/beamMath');
const { readSimulated } = require('./src/beam/sensors/simulatedSensors');
const { setLed } = require('./src/beam/ledMatrix');

const HEARTBEAT_INTERVAL_MS = 30_000;
const LIVE_LOOP_INTERVAL_MS = 1_000;
const DEFAULT_ASPECT_RATIO = '1610';

/**
 * Sensor reading is behind a tiny interface so agent.js doesn't care
 * whether it's talking to real hardware or the simulator.
 *   readSensors(aspectRatio) -> Promise<number[][]> (9 raw [X,Y,Z] triples)
 *   applyLed(aspectRatio) -> Promise<void>
 */
function buildSensorAdapter(config) {
  if (config.sensor_mode === 'i2c') {
    const { I2cSensorAdapter } = require('./src/beam/sensors/i2cSensors'); // eslint-disable-line global-require
    const i2c = new I2cSensorAdapter({ busNumber: config.i2c_bus_number });
    return {
      async open() { await i2c.open(); },
      async close() { await i2c.close(); },
      readSensors: (aspectRatio) => i2c.readSensors(aspectRatio),
      applyLed: (aspectRatio) => setLed(i2c.bus, aspectRatio),
    };
  }
  return {
    async open() {},
    async close() {},
    readSensors: async (aspectRatio) => readSimulated(aspectRatio),
    applyLed: async () => {}, // no physical LEDs to drive in simulated mode
  };
}

/**
 * Runs the live-aim loop for one session until the UI signals stop
 * (progress.live_control.action === 'stop') or the session leaves
 * reserved/running (aborted from elsewhere).
 */
async function runLiveLoop(config, sessionId, sensors, initialAspectRatio) {
  let aspectRatio = ASPECT_RATIOS.includes(initialAspectRatio) ? initialAspectRatio : DEFAULT_ASPECT_RATIO;
  await sensors.applyLed(aspectRatio);
  console.log(`[live] ${sessionId} — starting, aspect_ratio=${aspectRatio}, sensor_mode=${config.sensor_mode}`);

  // A live-aim session can run for minutes — the outer loop's heartbeat only
  // fires between job cycles, which this loop blocks for its whole duration.
  // Without a heartbeat of our own in here too, the bench would show
  // "offline" (last_seen_at > 90s old, see isBenchOnline()) mid-session.
  let lastHeartbeatAt = Date.now();

  for (;;) {
    if (Date.now() - lastHeartbeatAt > HEARTBEAT_INTERVAL_MS) {
      await sendHeartbeat(config);
      lastHeartbeatAt = Date.now();
    }

    const poll = await pollSession(config, sessionId);
    if (!poll) {
      await sleep(LIVE_LOOP_INTERVAL_MS);
      continue;
    }
    if (!['reserved', 'running'].includes(poll.status)) {
      console.log(`[live] ${sessionId} — session left reserved/running (status=${poll.status}), stopping loop`);
      return;
    }

    const liveControl = (poll.progress && poll.progress.live_control) || {};
    if (liveControl.action === 'stop') {
      console.log(`[live] ${sessionId} — stop requested by UI`);
      return;
    }
    if (liveControl.aspect_ratio && liveControl.aspect_ratio !== aspectRatio && ASPECT_RATIOS.includes(liveControl.aspect_ratio)) {
      aspectRatio = liveControl.aspect_ratio;
      await sensors.applyLed(aspectRatio);
      console.log(`[live] ${sessionId} — aspect ratio changed to ${aspectRatio}`);
    }

    const calibMatrixSet = (poll.calibration_matrix && poll.calibration_matrix.General && poll.calibration_matrix.General[0]) || {};
    const calibrated = Object.keys(calibMatrixSet).length > 0;

    let reading;
    try {
      const raw = await sensors.readSensors(aspectRatio);
      reading = computeReading(raw, aspectRatio, calibMatrixSet);
    } catch (err) {
      console.error(`[live] ${sessionId} — sensor read failed: ${err.message}`);
      await sleep(LIVE_LOOP_INTERVAL_MS);
      continue;
    }

    const nextProgress = {
      ...(poll.progress || {}),
      live: { ...reading, calibrated, updated_at: new Date().toISOString() },
    };
    await reportProgress(config, sessionId, nextProgress);
    await sleep(LIVE_LOOP_INTERVAL_MS);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollAndRunJob(config, sensors) {
  const poll = await pollJob(config);
  if (!poll || !poll.job) return;

  const job = poll.job;
  console.log(`[job] found ${job.session_code}`);

  const respond = await respondJob(config, job.session_id, true);
  if (!respond) return;

  const initialAspectRatio = job.test_profile?.parameters?.default_aspect_ratio || DEFAULT_ASPECT_RATIO;

  try {
    await runLiveLoop(config, job.session_id, sensors, initialAspectRatio);
  } catch (err) {
    console.error(`[job] ${job.session_id} — live loop crashed: ${err.stack || err.message}`);
    await reportAbort(config, job.session_id, `Agent error: ${err.message}`);
  }
}

async function main() {
  const config = loadConfig();
  console.log(`LUQA BEAM agent starting — bench=${config.slug}, api=${config.api_base_url}, sensor_mode=${config.sensor_mode}`);

  const sensors = buildSensorAdapter(config);
  await sensors.open();

  for (;;) {
    try {
      await sendHeartbeat(config);
      await pollAndRunJob(config, sensors);
    } catch (err) {
      console.error(`[agent] cycle error: ${err.stack || err.message}`);
    }
    await sleep(HEARTBEAT_INTERVAL_MS);
  }
}

main();
