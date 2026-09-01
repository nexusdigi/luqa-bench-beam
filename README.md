# luqa-bench-beam

The LUQA BEAM agent — runs on a Raspberry Pi (or Windows, as an alternative
runner) wired to a projection test wall. Maintains an outbound-only
connection to LUQA; LUQA's web/desktop/mobile clients never talk to a bench
directly. Full architecture and the API contract this agent implements: see
[`docs/architecture/luqa-benches-architecture.md`](https://github.com/nexusdigi/LUQA/blob/main/docs/architecture/luqa-benches-architecture.md)
in the main LUQA repo (§12).

## Self-update

Between job cycles, the agent checks whether `package.json` on `origin/main`
has a different version than what's currently running (`src/selfUpdate.js`).
If so, it does a `git pull` + `npm install` and exits — the systemd unit's
`Restart=always` brings the new code straight back up. Means a change
pushed to `main` reaches every bench in the fleet within ~10 minutes, no
manual SSH-in-and-pull per bench. Only ever checked/applied between jobs,
never mid-session.

## What this does

Unlike LUQA PIXEL's fire-and-forget automated test sequence, LUQA BEAM is an
**interactive, operator-driven** tool — you aim a projector at the wall and
watch live brightness/color numbers while adjusting focus/zoom, then capture
a snapshot when it looks right. So instead of running a fixed script, the
agent:

- Heartbeats to LUQA every 30s so the bench shows up as "Online".
- Polls for a reserved session, accepts it, then enters a **live-aim loop**:
  every ~1s it reads the 9-point sensor grid for the operator-selected
  aspect ratio (`src/beam/beamMath.js`, ported from the legacy PMU-60k
  tooling's IEC 61947-1 measurement math), applies this bench's calibration
  matrix, and pushes the reading back to LUQA. The operator watches this
  update live in LUQA's UI and can switch aspect ratios (the wall's
  indicator LEDs move to the new 9 measurement points) or capture the
  current reading at any time — both without restarting the loop.
- The loop stops when the UI signals it (`progress.live_control.action ===
  "stop"`, checked every ~1s via `bench-poll-session`) or the session is
  aborted from elsewhere.

## Sensor hardware: real or simulated

`config.json`'s `sensor_mode` picks the hardware adapter:

- **`"simulated"` (default)** — generates plausible fake sensor readings, no
  physical PMU-60k sensor board required. Use this for a bench with no test
  wall wired up yet — the full workflow (aspect ratio selection, live
  numbers, capture, QC embedding) works end to end, exactly like it would
  against real hardware, just with made-up numbers.
- **`"i2c"`** — talks to a real PMU-60k-style sensor board over I2C
  (`src/beam/sensors/i2cSensors.js`, `src/beam/ledMatrix.js`), ported from
  the legacy tooling's register-level protocol (PCA9548 sensor-mux select,
  MCDC04/MTCS-INT-AB4 tristimulus read, PCA9532 LED indicator matrix).
  **Not yet verified against real hardware** — there is no sensor board
  wired to any bench in this deployment yet, only checked for structural
  fidelity against the original Python. Treat the first real run as a
  hardware bring-up.

## Calibration

Each physical wall has its own calibration matrices (15 sensors × 3×3
correction matrix each) — this is managed in LUQA, not locally (`benches
.calibration_matrix`, editable via a calibration flow in the UI). If a
bench has no calibration matrix configured yet, the agent falls back to
identity matrices (raw, uncalibrated numbers) and reports `calibrated:
false` in the live reading so LUQA's UI can show a clear warning instead of
silently presenting numbers as if they were trustworthy.

The actual **derivation** of calibration matrices from raw sensor captures
(comparing against a reference colorimeter) is not implemented anywhere yet
— flagged as an explicitly open item in the architecture doc, not solved by
this agent.

## Setup (Raspberry Pi)

```bash
git clone git@github.com:nexusdigi/luqa-bench-beam.git
cd luqa-bench-beam
npm install
cp config.example.json config.json
```

Edit `config.json`:
- `slug` — the Bench ID you gave it in LUQA (e.g. `luqa-beam-lme01`)
- `token` — the one-time token LUQA shows when you register this bench via
  "Add New LUQA Bench" (Global Admin only)
- `sensor_mode` — leave as `"simulated"` until real sensor hardware is wired up

Then run:

```bash
node agent.js
```

You should see `[heartbeat] ok — availability=available` every 30 seconds,
and the bench should show as **Online** in LUQA's Benches list within a
minute.

## Running as a service (optional)

```bash
sudo cp luqa-bench-beam.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now luqa-bench-beam
journalctl -u luqa-bench-beam -f
```

Edit `luqa-bench-beam.service` first if you didn't clone this into the
default `pi` user's home directory — check `User=`/`WorkingDirectory=`.
