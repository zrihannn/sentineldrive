# SentinelDrive OS architecture

## Runtime topology

```text
┌─────────────────────────────────────────────────────────┐
│ Browser workspace                                       │
│                                                         │
│  UI shell / route modules                                │
│       │                                                 │
│       ├── VisionEngine ── MediaPipe Face Landmarker      │
│       │       └── 478-point face mesh + derived signals  │
│       │                                                 │
│       ├── Driver-state rules ── AlarmEngine              │
│       │       └── incidents / risk estimates            │
│       │                                                 │
│       ├── Analytics renderers                            │
│       │                                                 │
│       └── API client ── localStorage cache + outbox      │
└───────────────────────┬─────────────────────────────────┘
                        │ same-origin HTTP / JSON
┌───────────────────────▼─────────────────────────────────┐
│ FastAPI application                                     │
│                                                         │
│  Driver API · Fleet API · Session API · Telemetry API    │
│  Incident API · Policy API · Analytics · Backup/Restore  │
│  System health · Audit activity                         │
└───────────────────────┬─────────────────────────────────┘
                        │ sqlite3 transactions
┌───────────────────────▼─────────────────────────────────┐
│ SQLite                                                   │
│ drivers · vehicles · sessions · telemetry · incidents   │
│ policies · activity                                      │
└─────────────────────────────────────────────────────────┘
```

## Main processing sequence

1. A user selects a driver and optional vehicle from the registries.
2. The vision module loads the MediaPipe Tasks Vision runtime and Face Landmarker model, then requests camera access.
3. The inference loop processes each new video frame and extracts facial landmarks and the facial transformation matrix.
4. Geometry functions derive EAR, MAR, head-pose deltas and iris displacement. A short temporal window is used by the rule layer to avoid turning a single frame into an event.
5. The policy engine evaluates persistence windows and creates an incident only when a condition remains active for its configured delay.
6. The audio engine runs independently of the telemetry recorder. Drowsiness alerts use a repeating generated tone pattern and can be silenced until the current closure episode clears.
7. Starting a session creates a durable session record. Metric snapshots are batched and written to SQLite at the configured interval.
8. Session completion stores duration, attention/posture averages, average/peak estimated risk and sample/event counts.
9. Analytics queries aggregate the saved numeric time series. The camera image itself is never sent to the backend.

## Storage boundaries

| Data | Storage | Reason |
|---|---|---|
| Driver and vehicle records | SQLite | Durable registry and foreign-key relationships |
| Calibration baseline | SQLite driver profile | Baseline follows the driver across sessions |
| Session metadata | SQLite | Long-term session archive |
| Numeric telemetry | SQLite | Queryable time-series and CSV export |
| Incidents and acknowledgement state | SQLite | Durable event review and audit trail |
| Safety policies | SQLite + localStorage mirror | Server-side record with quick local preference load |
| UI cache and selected records | localStorage | Fast initial render and offline continuity |
| Pending offline writes | localStorage outbox | Ordered retry when API connectivity returns |
| Camera frames | Browser memory only | No backend image transfer |

## Reliability behaviours

- SQLite uses write-ahead logging and indexed time-series columns.
- Telemetry and event records carry client-generated stable IDs. Replayed offline writes are therefore idempotent.
- The offline outbox preserves write order, so queued driver creation precedes queued session creation and queued telemetry precedes session completion.
- A backup restore merges by primary key using `INSERT OR IGNORE`; it does not delete current records.
- Profiles/assets referenced by a session are archived rather than hard-deleted.
- The service worker caches the application shell, not private API responses or camera data.

## Engineering boundaries

The platform is a local single-workspace deployment. The API intentionally binds to loopback in the launcher. Before multi-user or network deployment, add authentication, authorization, restrictive CORS, TLS, hardened audit retention, encrypted backup handling, database migration tooling and operational monitoring. The current risk and attention scores are heuristic indicators, not validated driver fitness classifications.
