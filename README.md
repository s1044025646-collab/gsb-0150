# Discrete Control-Loop Response & PID Evaluation Backend

A Windows-local, dependency-free backend for evaluating discrete PID control on a
**first-order inertial plant with integer sample delay**. It provides only an HTTP
API, a CLI, fictional plant/disturbance fixtures and automated tests. There is no
web UI, no digital gate-level simulation and no real-device I/O.

Everything runs on Node.js built-ins only:

- `node:sqlite` for persistence (no npm install required)
- `node:http` for the loopback API
- `node:test` for the automated tests
- native TypeScript execution (type stripping), so no build step is needed

## Requirements

- Windows with Node.js **>= 22.18** (developed on Node 25). The SQLite global is
  enabled with `--experimental-sqlite`.
- No third-party packages are installed.

## Layout

- `src/plant.ts` — zero-order-hold first-order recursion and integer delay line
- `src/pid.ts` — positional PID, measurement derivative, derivative filter, anti-windup
- `src/engine.ts` — documented per-sample ordering and divergence detection
- `src/metrics.ts` — overshoot, steady-state error, IAE, settling time (enter-and-hold)
- `src/db.ts`, `src/repo.ts`, `src/service.ts` — repeatable migrations, repository, services
- `src/server.ts` — HTTP API (validation, error codes, pagination, idempotency)
- `src/cli.ts` — command line interface
- `src/fixtures.ts` — fictional plants/PIDs/disturbances
- `src/demo.ts` — repeatable end-to-end demo over real HTTP
- `tests/` — discrete analytic values, accumulation, anti-windup, no-derivative-kick,
  checkpoint continuation, history reproduction, failure paths, rollback and restart

## Model and sample ordering

Plant: `T·dy/dt + y = K·(u + d)` with sampling period `Ts`, held input and an integer
delay of whole samples. With `a = exp(-Ts/T)`:

```
x[k+1] = a*x[k] + (1-a)*K*(uDelayed[k] + d[k])
```

The controller is a positional PID with **derivative on measurement**:

```
e[k]  = sp - y[k]
dRaw  = kd*(y[k-1] - y[k]) / Ts        (no setpoint kick)
dFilt = first-order low pass, time constant tdFilter
v     = kp*e + I + dFilt
u     = sat(v)                          (uMin/uMax actuator bounds)
```

Anti-windup is explicit and selectable per PID version:

- `freeze` — while saturated, an error that would wind the integrator further is frozen;
  integrating toward de-saturation stays allowed, so recovery leaves no stale integral.
- `backcalc` — conditional back-calculation removes the excess demand created by the
  integral, clamped so it can never push deeper into saturation.

Sample timing (enforced in `src/engine.ts`, matching `applyDelay` in `src/plant.ts`):

1. read measurement `y[k]`,
2. resolve setpoint/disturbance at `k`,
3. PID computes `u[k]`,
4. apply the integer delay (consume/queue),
5. advance the ZOH plant by exactly one step to `y[k+1]`.

`delaySteps = 0` applies `u[k]` during that same advance; `delaySteps = 1` queues it,
so the first command cannot affect the output until the next advance. The two are
never conflated (covered by a test).

Checkpoint state (integrator, previous measurement, filter state, previous command,
plant lag state and delay queue) is serialized per version. A run split into any
chunks, including across process restart, is sample-for-sample identical to one
continuous run (covered by tests).

## Reports

- overshoot relative to the commanded change,
- steady-state error of the final sample,
- IAE (sum of `|e|`),
- settling time in seconds for the earliest index after which `|e| <= band` for **all**
  remaining samples; a first crossing is never settling, and a response that never
  enters-and-holds the band is reported as `settled:false`, `settlingTime:null`.

Non-finite values or `|value| > 1e12` stop the run with `status=stopped`,
`stop_reason=diverged` and a human-readable `last_error`; already produced history is
retained. Invalid parameters are rejected with a stable error code before any run.

## Install / test / run / stop

No install step is required. From the project root:

```powershell
# automated tests
npm test

# repeatable end-to-end demo (real HTTP, fixed injected clock, restart check)
npm run demo

# start the API on 127.0.0.1 with an OS-assigned ephemeral port
npm start
# or pin a loopback port:
node --experimental-sqlite src/cli.ts serve --port=8080

# stop the server: Ctrl+C in its console (SIGINT/SIGTERM close it cleanly).
```

The server binds **only** to `127.0.0.1`. The database and all exports stay inside the
project (`data/` by default; override with `PID_DB_PATH`). `serve` only starts this
project's own Node process, and Ctrl+C stops only that process.

## CLI

```powershell
node --experimental-sqlite src/cli.ts create '<scenario-json>'
node --experimental-sqlite src/cli.ts show <scenarioId>
node --experimental-sqlite src/cli.ts add-pid <sid> '<pid-json>' [label] [--active]
node --experimental-sqlite src/cli.ts step <sid> <k> <setpoint>
node --experimental-sqlite src/cli.ts disturb <sid> <startK> <amp> [endK]
node --experimental-sqlite src/cli.ts run <versionId> [steps]
node --experimental-sqlite src/cli.ts pause <versionId>
node --experimental-sqlite src/cli.ts resume <versionId> [steps]
node --experimental-sqlite src/cli.ts components <versionId> [limit]
node --experimental-sqlite src/cli.ts export <versionId> [file]
node --experimental-sqlite src/cli.ts report <versionId> [band]
node --experimental-sqlite src/cli.ts compare <scenarioId> [band]
node --experimental-sqlite src/cli.ts demo
```

Each state-changing CLI command prints the key state before and after the operation.

Example scenario JSON:

```json
{
  "name": "tank",
  "plant": { "gain": 2, "tau": 5, "ts": 0.5, "delaySteps": 1, "uMin": -2, "uMax": 2 },
  "setpoint": 1, "y0": 0, "maxSamples": 60
}
```

Example PID JSON:

```json
{ "kp": 1.2, "ki": 0.4, "kd": 0.3, "tdFilter": 0.5, "antiWindup": "backcalc", "tt": 1 }
```

## HTTP API

JSON only. Errors use `{ "error": { "code", "message", "details?" } }` with codes such as
`INVALID_PARAM`, `BAD_JSON`, `NOT_FOUND`, `RUN_STOPPED`, `RUN_FINISHED`,
`NUMERIC_DIVERGED`, `INVALID_STATE_TRANSITION`, `CONFLICT`,
`INVALID_IDEMPOTENCY_KEY`.

- `GET  /health`
- `POST /scenarios`, `GET /scenarios?limit=&offset=`, `GET /scenarios/:id`
- `POST /scenarios/:id/versions` (body PID fields, optional `label`, `active`)
- `GET  /scenarios/:id/versions`
- `POST /scenarios/:id/setpoints` `{step,setpoint}`
- `POST /scenarios/:id/disturbances` `{startStep,endStep?,amplitude}`
- `GET  /versions/:id`
- `POST /versions/:id/run` `{steps}`, `POST /versions/:id/pause`, `POST /versions/:id/resume` `{steps}`
- `GET  /versions/:id/samples?limit=&offset=`, `GET  /versions/:id/export`
- `GET  /versions/:id/report?band=0.05`

List endpoints return `{ data, pagination: { limit, offset, total, hasMore } }`.
Send an `Idempotency-Key` header on a `POST` to make repeated submissions return the
stored response; reusing the key with a different body returns
`409 INVALID_IDEMPOTENCY_KEY`.

## Migrations and persistence

Migrations are ordered and idempotent; each records itself in `schema_migrations`
inside a transaction, so re-running on startup applies nothing new. Restarting a
process reuses the same database file and resumes from the serialized loop state.
