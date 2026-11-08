# SentinelDrive OS

<p align="center">
  <strong>A local-first driver intelligence and safety operations platform</strong>
  <br />
  Browser-based computer vision · Live telemetry · Session archive · Safety events · SQLite
</p>

<p align="center">
  <img alt="FastAPI" src="https://img.shields.io/badge/API-FastAPI-009688?logo=fastapi&logoColor=white" />
  <img alt="Database" src="https://img.shields.io/badge/Database-SQLite-003B57?logo=sqlite&logoColor=white" />
</p>

SentinelDrive OS is an engineering project that brings browser-based driver-state estimation into a wider operations workspace. The live vision system is one part of the application; driver and vehicle profiles, monitoring sessions, telemetry, safety events, policies, analytics, audit activity and backup/recovery are handled as separate product modules.

> **Safety notice:** SentinelDrive is an educational driver-awareness prototype, not a certified driver-monitoring system, medical device or substitute for rest, driver judgement or legally required safety equipment. Do not rely on it as the sole protection mechanism in a moving vehicle.

## Contents

- [Capabilities](#capabilities)
- [Architecture](#architecture)
- [Technology](#technology)
- [Run locally](#run-locally)
- [Deploy to Vercel and Render](DEPLOYMENT.md)
- [Run tests](#run-tests)
- [Data and privacy](#data-and-privacy)
- [Project structure](#project-structure)
- [Limitations](#limitations)
- [Roadmap](#roadmap)

## Capabilities

### Driver intelligence

- Google MediaPipe **Face Landmarker** in video mode, configured for one face with blendshape output and facial transformation matrices.
- Dense facial landmark mesh overlay (478 landmarks).
- Eye Aspect Ratio (EAR) from both eyes for sustained eye-closure and drowsiness candidates.
- Mouth Aspect Ratio (MAR) for sustained yawning candidates.
- Head-pose estimation from facial transformation data with a landmark-derived fallback.
- Iris-landmark gaze estimation combined with head deviation for a forward-attention estimate.
- Driver-specific guided calibration with low-quality, unstable, closed-eye and mouth-open frames filtered out.
- Four repeating audible alarm patterns: alternating siren, rapid pulses, dual-tone and urgent high-low. Volume is adjustable.

### Operations workspaces

1. **Command Center**: operational overview, activity, KPIs and historical trends.
2. **Live Monitor**: camera, facial mesh, live indicators, session controls and alarm controls.
3. **Driver Registry**: driver profiles and individual calibration baselines.
4. **Vehicle Registry**: fleet asset records and status.
5. **Session Archive**: durable monitoring sessions and per-session telemetry traces.
6. **Event Timeline**: searchable safety events with severity and acknowledgement workflow.
7. **Analytics & Insights**: historical attention/posture trends, event and severity distributions, telemetry coverage.
8. **Safety Policies**: detection thresholds, persistence windows, alarm pattern/volume, sampling interval and retention target.
9. **System Journal**: service/database health, audit activity, offline outbox, backup and restore.

### Persistence and reporting

- SQLite stores drivers, vehicles, sessions, timestamped telemetry, incidents, policies and audit activity.
- Browser `localStorage` retains UI preferences, selected driver/vehicle, last-known workspace cache and an offline write queue.
- Telemetry is captured at the configured interval (one second by default) during a saved session. Samples include EAR, MAR, posture/attention/risk estimates, pose/gaze deltas, tracking-quality estimate, FPS, inference time, face count and state label.
- Full JSON backup and ID-based merge restore.
- Incident CSV and telemetry CSV exports.
- Camera frames and video are not uploaded to the backend.

## Architecture

```text
Browser application
  ├── Workspace UI and navigation
  ├── MediaPipe Face Landmarker / face mesh
  ├── EAR, MAR, pose and gaze estimators
  ├── Calibration and alarm engine
  ├── API client and offline write queue
  └── Session telemetry and event workflows
             │ HTTP / JSON
             ▼
       FastAPI service
             │
             ▼
        SQLite database
  ├── drivers
  ├── vehicles
  ├── sessions
  ├── telemetry samples
  ├── incidents
  ├── safety policies
  └── activity journal
```

The local server binds to `127.0.0.1` by default. The browser camera feed is processed client-side; numeric measurements and event metadata are sent to the local API for persistence.

## Technology

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS, JavaScript modules |
| Face tracking | MediaPipe Face Landmarker |
| Backend | Python, FastAPI, Uvicorn, Pydantic |
| Database | SQLite |
| Tests | Pytest, FastAPI TestClient, HTTPX |
| Local runtime | Python virtual environment |

## Run locally

### Windows

1. Download or clone this repository.
2. Install a supported Python runtime.
3. Open the project folder and double-click `run_windows.bat`.
4. Keep the separate **SentinelDrive OS API** terminal open.
5. Open **http://127.0.0.1:8000** if the browser does not open automatically.
6. In **Live Monitor**, select a driver, enable the camera, calibrate, then start a session to store telemetry.

The Windows launcher creates `.venv`, installs `requirements.txt`, starts the local API and checks the health endpoint before opening the browser. It intentionally uses plain `uvicorn` rather than `uvicorn[standard]` to avoid unnecessary native-build dependencies on Windows.

### macOS / Linux

```bash
chmod +x run_unix.sh
./run_unix.sh
```

Then open **http://127.0.0.1:8000**.

### Manual start

```bash
python -m venv .venv
```

Activate the environment:

```powershell
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
```

```bash
# macOS / Linux
source .venv/bin/activate
```

Install and start:

```bash
pip install -r requirements.txt
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Interactive API documentation: **http://127.0.0.1:8000/docs**.

The app must be served through the local API. Do not open `frontend/index.html` directly. The first vision-engine launch downloads the MediaPipe web runtime and face-landmarker model, so internet access is required for the initial model load unless those assets are provisioned locally. Browser camera permission is available on localhost or HTTPS.

## Run tests

```bash
pip install -r requirements-dev.txt
python -m pytest -q
```

The API integration tests use a temporary SQLite database. They cover workspace bootstrap, driver and vehicle creation, session lifecycle, telemetry persistence, incident acknowledgement, analytics, JSON backup and idempotent restore.

## Data and privacy

- Default database: `data/sentineldrive.db`.
- Override the database location with `SENTINELDRIVE_DB`.
- Runtime databases, virtual environments, logs, caches and local environment files are excluded from Git by `.gitignore`.
- Camera frames and video remain in the browser and are not sent to the backend by the application.
- Numeric telemetry and event metadata are saved in SQLite.
- The local API is intended for single-machine development. Do not expose it to a network without authentication, restrictive CORS, transport security, access control, audit hardening and retention enforcement.

## Project structure

```text
SentinelDrive_OS/
├── .github/
│   └── workflows/ci.yml
├── backend/
│   ├── __init__.py
│   └── main.py
├── data/                  # Local SQLite database is created here
├── docs/
│   ├── ARCHITECTURE.md
│   └── DATA_MODEL.md
├── frontend/
│   ├── js/
│   │   ├── alarm.js
│   │   ├── api.js
│   │   ├── app.js
│   │   └── vision.js
│   ├── index.html
│   ├── manifest.webmanifest
│   ├── styles.css
│   ├── sw.js
│   └── icon.svg
├── logs/                  # Local logs are not committed
├── tests/
│   └── test_api.py
├── .gitignore
├── CHANGELOG.md
├── CONTRIBUTING.md
├── README.md
├── requirements-dev.txt
├── requirements.txt
├── run_unix.sh
├── run_windows.bat
└── run_server_windows.bat
```

## Limitations

The Face Landmarker is a real dense facial-landmark model, but the outputs derived from it are estimates, not guaranteed driver-state classifications. EAR and MAR are geometric proxies; webcam-based gaze is not calibrated optical eye tracking; pose accuracy depends on camera geometry and transform quality. Lighting, camera height, glasses, occlusion, face angle and individual anatomy affect measurements. The tracking-quality value is a geometry/visibility heuristic, not a vendor-provided confidence score.

Before any real-world pilot, validate with labelled recordings, quantify false positives and false negatives, and conduct controlled tests across camera placements and users. This project must not be used as the sole safety mechanism in a moving vehicle.

## Roadmap

- [ ] Add labelled evaluation datasets and repeatable accuracy/latency benchmarks.
- [ ] Add integration tests for browser camera and Face Landmarker lifecycle.
- [ ] Add authenticated multi-user mode before any network deployment.
- [ ] Add database migration/versioning strategy.
- [ ] Add configurable data-retention enforcement and privacy controls.
- [ ] Evaluate packaging as a signed desktop application.

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for the split Vercel frontend + Render API deployment, persistent SQLite storage, environment variables and verification steps.

## Publishing to GitHub

See [GITHUB_SETUP.md](GITHUB_SETUP.md) for creating the remote repository and pushing the initial commit.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports should include the operating system, Python version, browser, launcher output and relevant redacted logs. Never attach camera recordings or personal driver data to public issues.
