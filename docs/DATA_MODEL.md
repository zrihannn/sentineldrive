# Data model

## Entity relationships

```text
DRIVERS 1 ─────── * SESSIONS * ─────── 1 VEHICLES
                    │  │
                    │  └────────────── * TELEMETRY
                    │
                    └───────────────── * INCIDENTS

POLICIES (single active policy document)
ACTIVITY (append-only operational audit entries)
```

## Core records

### Driver

`id`, `name`, `employee_code`, `license_ref`, `phone`, `email`, `status`, `notes`, `baseline_json`, `created_at`, `updated_at`.

The baseline stores calibrated EAR, gaze, pitch/yaw/roll reference values, accepted sample count, capture timestamp, stability measures and a coarse quality label.

### Vehicle

`id`, `label`, `registration`, `make_model`, `vehicle_type`, `status`, `notes`, `created_at`, `updated_at`.

Registration is unique. Vehicle and driver records referenced by sessions are retained through archival instead of physical deletion.

### Session

`id`, `driver_id`, `vehicle_id`, `status`, `started_at`, `ended_at`, `duration_seconds`, average attention/posture/risk, peak risk, telemetry count, incident count, notes and metadata.

### Telemetry

A session-scoped sample with stable `id`, `recorded_at`, `elapsed_ms`, EAR, MAR, left/right EAR, posture score, attention score, estimated risk score, pitch/yaw/roll/gaze deltas, tracking-quality estimate, FPS, inference time, face count and state label.

The primary sample interval is configurable. The default is one second.

### Incident

`id`, optional `session_id`, optional `driver_id` and `vehicle_id`, `event_type`, `title`, `detail`, `severity`, `occurred_at`, `duration_ms`, acknowledgement state and time, metrics snapshot and source.

### Policy

A single active JSON document is stored in the `policies` table. It contains the active thresholds, persistence delays, alarm configuration, telemetry interval and retention target.

## Important interpretation note

`attention_score`, `posture_score`, `risk_score` and `tracking_confidence` are software-derived estimates. The tracking-quality field estimates face geometry/position quality. It is not a MediaPipe confidence output or a probability that the driver is safe.
