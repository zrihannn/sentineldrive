from __future__ import annotations

import csv
import io
import json
import os
import sqlite3
import uuid
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
DB_PATH = Path(os.getenv("SENTINELDRIVE_DB", DATA_DIR / "sentineldrive.db"))
FRONTEND_DIR = ROOT / "frontend"
DATA_DIR.mkdir(parents=True, exist_ok=True)

@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="SentinelDrive API",
    version="3.0.10",
    description="Local-first driver intelligence platform API",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

DEFAULT_POLICIES = {
    "earThreshold": 0.21,
    "marThreshold": 0.42,
    "poseTolerance": 18,
    "gazeTolerance": 0.28,
    "drowsyDelay": 1.5,
    "yawnDelay": 1.1,
    "postureDelay": 2.5,
    "distractionDelay": 2.0,
    "faceLostDelay": 2.0,
    "alarmEnabled": True,
    "alarmTone": "siren",
    "alarmVolume": 90,
    "autoStartMonitoring": False,
    "telemetryInterval": 1000,
    "retentionDays": 365,
}

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS drivers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  employee_code TEXT DEFAULT '',
  license_ref TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT DEFAULT '',
  baseline_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  registration TEXT NOT NULL UNIQUE,
  make_model TEXT DEFAULT '',
  vehicle_type TEXT DEFAULT 'Car',
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  driver_id TEXT,
  vehicle_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_seconds REAL DEFAULT 0,
  average_attention REAL,
  average_posture REAL,
  average_risk REAL,
  peak_risk REAL,
  telemetry_count INTEGER DEFAULT 0,
  incident_count INTEGER DEFAULT 0,
  notes TEXT DEFAULT '',
  meta_json TEXT,
  FOREIGN KEY(driver_id) REFERENCES drivers(id) ON DELETE SET NULL,
  FOREIGN KEY(vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS telemetry (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  elapsed_ms INTEGER DEFAULT 0,
  ear REAL,
  mar REAL,
  left_ear REAL,
  right_ear REAL,
  posture_score REAL,
  attention_score REAL,
  risk_score REAL,
  pitch_delta REAL,
  yaw_delta REAL,
  roll_delta REAL,
  gaze_delta REAL,
  tracking_confidence REAL,
  fps REAL,
  inference_ms REAL,
  face_count INTEGER DEFAULT 1,
  state TEXT DEFAULT 'attentive',
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_telemetry_session_time ON telemetry(session_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  driver_id TEXT,
  vehicle_id TEXT,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'medium',
  occurred_at TEXT NOT NULL,
  duration_ms INTEGER DEFAULT 0,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  acknowledged_at TEXT,
  metrics_json TEXT,
  source TEXT DEFAULT 'vision-engine',
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY(driver_id) REFERENCES drivers(id) ON DELETE SET NULL,
  FOREIGN KEY(vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_incidents_time ON incidents(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_type ON incidents(event_type, occurred_at DESC);
CREATE TABLE IF NOT EXISTS policies (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  policy_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT DEFAULT '',
  level TEXT DEFAULT 'info',
  created_at TEXT NOT NULL,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_time ON activity(created_at DESC);
"""


@contextmanager
def db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=15000")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def make_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:14]}"


def as_dict(row: Optional[sqlite3.Row]) -> Optional[dict[str, Any]]:
    return dict(row) if row else None


def json_value(value: Any, fallback: Any = None) -> Any:
    if value is None:
        return fallback
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return fallback
    return value


def activity_log(conn: sqlite3.Connection, category: str, title: str, detail: str = "", level: str = "info", metadata: Any = None) -> None:
    conn.execute(
        "INSERT INTO activity(id,category,title,detail,level,created_at,metadata_json) VALUES(?,?,?,?,?,?,?)",
        (make_id("act"), category, title, detail, level, now_iso(), json.dumps(metadata or {}, separators=(",", ":"))),
    )


def clean_driver(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    item["baseline"] = json_value(item.pop("baseline_json", None))
    return item


def clean_vehicle(row: sqlite3.Row) -> dict[str, Any]:
    return dict(row)


def clean_session(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    item["meta"] = json_value(item.pop("meta_json", None), {})
    return item


def clean_incident(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    item["metrics"] = json_value(item.pop("metrics_json", None), {})
    item["acknowledged"] = bool(item["acknowledged"])
    return item


def init_db() -> None:
    with db() as conn:
        conn.executescript(SCHEMA)
        conn.execute(
            "INSERT OR IGNORE INTO policies(id,policy_json,updated_at) VALUES(1,?,?)",
            (json.dumps(DEFAULT_POLICIES), now_iso()),
        )
        count = conn.execute("SELECT COUNT(*) AS c FROM drivers").fetchone()["c"]
        if count == 0:
            stamp = now_iso()
            conn.execute(
                "INSERT INTO drivers(id,name,employee_code,status,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                ("driver_primary", "Primary Driver", "SD-001", "active", "Default local driver profile. Edit this profile with your own details.", stamp, stamp),
            )
        activity_log(conn, "system", "SentinelDrive initialised", "Local database is ready.", "success")


class DriverPayload(BaseModel):
    id: Optional[str] = None
    name: str = Field(min_length=2, max_length=100)
    employee_code: str = Field(default="", max_length=60)
    license_ref: str = Field(default="", max_length=80)
    phone: str = Field(default="", max_length=40)
    email: str = Field(default="", max_length=120)
    status: str = Field(default="active", pattern="^(active|inactive|restricted)$")
    notes: str = Field(default="", max_length=1000)
    baseline: Optional[dict[str, Any]] = None


class VehiclePayload(BaseModel):
    id: Optional[str] = None
    label: str = Field(min_length=2, max_length=100)
    registration: str = Field(min_length=3, max_length=30)
    make_model: str = Field(default="", max_length=100)
    vehicle_type: str = Field(default="Car", max_length=40)
    status: str = Field(default="active", pattern="^(active|maintenance|inactive)$")
    notes: str = Field(default="", max_length=1000)


class SessionPayload(BaseModel):
    id: Optional[str] = None
    driver_id: Optional[str] = None
    vehicle_id: Optional[str] = None
    started_at: Optional[str] = None
    notes: str = Field(default="", max_length=1000)
    meta: dict[str, Any] = Field(default_factory=dict)


class TelemetryBatch(BaseModel):
    samples: list[dict[str, Any]] = Field(default_factory=list, max_length=1000)


class IncidentPayload(BaseModel):
    id: Optional[str] = None
    session_id: Optional[str] = None
    driver_id: Optional[str] = None
    vehicle_id: Optional[str] = None
    event_type: str = Field(min_length=2, max_length=50)
    title: str = Field(min_length=2, max_length=160)
    detail: str = Field(default="", max_length=1000)
    severity: str = Field(default="medium", pattern="^(low|medium|high|critical)$")
    occurred_at: Optional[str] = None
    duration_ms: int = Field(default=0, ge=0)
    metrics: dict[str, Any] = Field(default_factory=dict)
    source: str = Field(default="vision-engine", max_length=60)


class PolicyPayload(BaseModel):
    policies: dict[str, Any]


class FinishSessionPayload(BaseModel):
    ended_at: Optional[str] = None
    duration_seconds: float = Field(default=0, ge=0)
    average_attention: Optional[float] = None
    average_posture: Optional[float] = None
    average_risk: Optional[float] = None
    peak_risk: Optional[float] = None
    telemetry_count: int = Field(default=0, ge=0)
    incident_count: int = Field(default=0, ge=0)
    notes: str = Field(default="", max_length=1000)


@app.get("/api/health")
def health() -> dict[str, Any]:
    with db() as conn:
        counts = {
            "drivers": conn.execute("SELECT COUNT(*) c FROM drivers").fetchone()["c"],
            "vehicles": conn.execute("SELECT COUNT(*) c FROM vehicles").fetchone()["c"],
            "sessions": conn.execute("SELECT COUNT(*) c FROM sessions").fetchone()["c"],
            "telemetry": conn.execute("SELECT COUNT(*) c FROM telemetry").fetchone()["c"],
            "incidents": conn.execute("SELECT COUNT(*) c FROM incidents").fetchone()["c"],
        }
    return {"status": "operational", "version": "3.0.10", "database": "sqlite", "database_path": str(DB_PATH), "counts": counts, "timestamp": now_iso()}


@app.get("/api/bootstrap")
def bootstrap() -> dict[str, Any]:
    with db() as conn:
        drivers = [clean_driver(r) for r in conn.execute("SELECT * FROM drivers ORDER BY name COLLATE NOCASE").fetchall()]
        vehicles = [clean_vehicle(r) for r in conn.execute("SELECT * FROM vehicles ORDER BY label COLLATE NOCASE").fetchall()]
        sessions = [clean_session(r) for r in conn.execute("SELECT * FROM sessions ORDER BY started_at DESC LIMIT 20").fetchall()]
        incidents = [clean_incident(r) for r in conn.execute("SELECT * FROM incidents ORDER BY occurred_at DESC LIMIT 50").fetchall()]
        activity = [dict(r) for r in conn.execute("SELECT id,category,title,detail,level,created_at FROM activity ORDER BY created_at DESC LIMIT 30").fetchall()]
        policy_row = conn.execute("SELECT policy_json,updated_at FROM policies WHERE id=1").fetchone()
        policies = json_value(policy_row["policy_json"], DEFAULT_POLICIES)
    return {"drivers": drivers, "vehicles": vehicles, "sessions": sessions, "incidents": incidents, "activity": activity, "policies": policies}


@app.get("/api/drivers")
def list_drivers() -> list[dict[str, Any]]:
    with db() as conn:
        return [clean_driver(r) for r in conn.execute("SELECT * FROM drivers ORDER BY name COLLATE NOCASE").fetchall()]


@app.post("/api/drivers")
def create_driver(payload: DriverPayload) -> dict[str, Any]:
    stamp, driver_id = now_iso(), (payload.id or make_id("drv"))
    with db() as conn:
        conn.execute(
            "INSERT INTO drivers(id,name,employee_code,license_ref,phone,email,status,notes,baseline_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (driver_id, payload.name.strip(), payload.employee_code, payload.license_ref, payload.phone, payload.email, payload.status, payload.notes, json.dumps(payload.baseline) if payload.baseline else None, stamp, stamp),
        )
        activity_log(conn, "drivers", "Driver profile created", payload.name, "success", {"driver_id": driver_id})
        row = conn.execute("SELECT * FROM drivers WHERE id=?", (driver_id,)).fetchone()
    return clean_driver(row)


@app.put("/api/drivers/{driver_id}")
def update_driver(driver_id: str, payload: DriverPayload) -> dict[str, Any]:
    with db() as conn:
        exists = conn.execute("SELECT id FROM drivers WHERE id=?", (driver_id,)).fetchone()
        if not exists:
            raise HTTPException(404, "Driver profile not found")
        conn.execute(
            "UPDATE drivers SET name=?,employee_code=?,license_ref=?,phone=?,email=?,status=?,notes=?,baseline_json=?,updated_at=? WHERE id=?",
            (payload.name.strip(), payload.employee_code, payload.license_ref, payload.phone, payload.email, payload.status, payload.notes, json.dumps(payload.baseline) if payload.baseline else None, now_iso(), driver_id),
        )
        activity_log(conn, "drivers", "Driver profile updated", payload.name, "info", {"driver_id": driver_id})
        return clean_driver(conn.execute("SELECT * FROM drivers WHERE id=?", (driver_id,)).fetchone())


@app.delete("/api/drivers/{driver_id}")
def delete_driver(driver_id: str) -> dict[str, Any]:
    with db() as conn:
        row = conn.execute("SELECT name FROM drivers WHERE id=?", (driver_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Driver profile not found")
        used = conn.execute("SELECT COUNT(*) c FROM sessions WHERE driver_id=?", (driver_id,)).fetchone()["c"]
        if used:
            conn.execute("UPDATE drivers SET status='inactive',updated_at=? WHERE id=?", (now_iso(), driver_id))
            activity_log(conn, "drivers", "Driver profile archived", row["name"], "warning", {"driver_id": driver_id})
            return {"status": "archived", "message": "Profile is referenced by saved sessions and was archived instead of deleted."}
        conn.execute("DELETE FROM drivers WHERE id=?", (driver_id,))
        activity_log(conn, "drivers", "Driver profile deleted", row["name"], "warning", {"driver_id": driver_id})
    return {"status": "deleted"}


@app.get("/api/vehicles")
def list_vehicles() -> list[dict[str, Any]]:
    with db() as conn:
        return [clean_vehicle(r) for r in conn.execute("SELECT * FROM vehicles ORDER BY label COLLATE NOCASE").fetchall()]


@app.post("/api/vehicles")
def create_vehicle(payload: VehiclePayload) -> dict[str, Any]:
    stamp, vehicle_id = now_iso(), (payload.id or make_id("veh"))
    with db() as conn:
        try:
            conn.execute(
                "INSERT INTO vehicles(id,label,registration,make_model,vehicle_type,status,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (vehicle_id, payload.label.strip(), payload.registration.strip().upper(), payload.make_model, payload.vehicle_type, payload.status, payload.notes, stamp, stamp),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(409, "That vehicle registration is already registered")
        activity_log(conn, "fleet", "Vehicle registered", f"{payload.label} · {payload.registration}", "success", {"vehicle_id": vehicle_id})
        return clean_vehicle(conn.execute("SELECT * FROM vehicles WHERE id=?", (vehicle_id,)).fetchone())


@app.put("/api/vehicles/{vehicle_id}")
def update_vehicle(vehicle_id: str, payload: VehiclePayload) -> dict[str, Any]:
    with db() as conn:
        if not conn.execute("SELECT id FROM vehicles WHERE id=?", (vehicle_id,)).fetchone():
            raise HTTPException(404, "Vehicle not found")
        try:
            conn.execute(
                "UPDATE vehicles SET label=?,registration=?,make_model=?,vehicle_type=?,status=?,notes=?,updated_at=? WHERE id=?",
                (payload.label.strip(), payload.registration.strip().upper(), payload.make_model, payload.vehicle_type, payload.status, payload.notes, now_iso(), vehicle_id),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(409, "That vehicle registration is already registered")
        activity_log(conn, "fleet", "Vehicle record updated", payload.label, "info", {"vehicle_id": vehicle_id})
        return clean_vehicle(conn.execute("SELECT * FROM vehicles WHERE id=?", (vehicle_id,)).fetchone())


@app.delete("/api/vehicles/{vehicle_id}")
def delete_vehicle(vehicle_id: str) -> dict[str, Any]:
    with db() as conn:
        row = conn.execute("SELECT label FROM vehicles WHERE id=?", (vehicle_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Vehicle not found")
        used = conn.execute("SELECT COUNT(*) c FROM sessions WHERE vehicle_id=?", (vehicle_id,)).fetchone()["c"]
        if used:
            conn.execute("UPDATE vehicles SET status='inactive',updated_at=? WHERE id=?", (now_iso(), vehicle_id))
            activity_log(conn, "fleet", "Vehicle archived", row["label"], "warning", {"vehicle_id": vehicle_id})
            return {"status": "archived", "message": "Vehicle is referenced by sessions and was archived instead of deleted."}
        conn.execute("DELETE FROM vehicles WHERE id=?", (vehicle_id,))
        activity_log(conn, "fleet", "Vehicle record deleted", row["label"], "warning", {"vehicle_id": vehicle_id})
    return {"status": "deleted"}


@app.get("/api/sessions")
def list_sessions(limit: int = Query(100, ge=1, le=1000), offset: int = Query(0, ge=0), status: Optional[str] = None) -> list[dict[str, Any]]:
    query = "SELECT * FROM sessions"
    params: list[Any] = []
    if status:
        query += " WHERE status=?"
        params.append(status)
    query += " ORDER BY started_at DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])
    with db() as conn:
        return [clean_session(r) for r in conn.execute(query, params).fetchall()]


@app.post("/api/sessions")
def create_session(payload: SessionPayload) -> dict[str, Any]:
    session_id = payload.id or make_id("ses")
    started = payload.started_at or now_iso()
    with db() as conn:
        if conn.execute("SELECT id FROM sessions WHERE id=?", (session_id,)).fetchone():
            return clean_session(conn.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone())
        conn.execute(
            "INSERT INTO sessions(id,driver_id,vehicle_id,status,started_at,notes,meta_json) VALUES(?,?,?,?,?,?,?)",
            (session_id, payload.driver_id, payload.vehicle_id, "active", started, payload.notes, json.dumps(payload.meta)),
        )
        activity_log(conn, "sessions", "Monitoring session started", f"Driver: {payload.driver_id or 'Unassigned'} · Vehicle: {payload.vehicle_id or 'Unassigned'}", "success", {"session_id": session_id})
        return clean_session(conn.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone())


@app.post("/api/sessions/{session_id}/finish")
@app.post("/api/sessions/{session_id}/end")
def finish_session(session_id: str, payload: FinishSessionPayload) -> dict[str, Any]:
    with db() as conn:
        row = conn.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Session not found")
        conn.execute(
            "UPDATE sessions SET status='completed',ended_at=?,duration_seconds=?,average_attention=?,average_posture=?,average_risk=?,peak_risk=?,telemetry_count=?,incident_count=?,notes=? WHERE id=?",
            (payload.ended_at or now_iso(), payload.duration_seconds, payload.average_attention, payload.average_posture, payload.average_risk, payload.peak_risk, payload.telemetry_count, payload.incident_count, payload.notes, session_id),
        )
        activity_log(conn, "sessions", "Monitoring session completed", f"Duration {payload.duration_seconds:.0f}s · {payload.telemetry_count} samples · {payload.incident_count} events", "success", {"session_id": session_id})
        return clean_session(conn.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone())


@app.post("/api/sessions/{session_id}/telemetry")
def append_telemetry(session_id: str, payload: TelemetryBatch) -> dict[str, Any]:
    if not payload.samples:
        return {"inserted": 0}
    with db() as conn:
        if not conn.execute("SELECT id FROM sessions WHERE id=?", (session_id,)).fetchone():
            raise HTTPException(404, "Session not found")
        rows = []
        for item in payload.samples:
            rows.append((
                str(item.get("id") or make_id("tel")), session_id, item.get("recorded_at") or now_iso(),
                int(item.get("elapsed_ms") or 0), item.get("ear"), item.get("mar"), item.get("left_ear"), item.get("right_ear"),
                item.get("posture_score"), item.get("attention_score"), item.get("risk_score"), item.get("pitch_delta"),
                item.get("yaw_delta"), item.get("roll_delta"), item.get("gaze_delta"), item.get("tracking_confidence"),
                item.get("fps"), item.get("inference_ms"), int(item.get("face_count") or 1), item.get("state") or "attentive",
            ))
        conn.executemany(
            "INSERT OR IGNORE INTO telemetry(id,session_id,recorded_at,elapsed_ms,ear,mar,left_ear,right_ear,posture_score,attention_score,risk_score,pitch_delta,yaw_delta,roll_delta,gaze_delta,tracking_confidence,fps,inference_ms,face_count,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            rows,
        )
        conn.execute("UPDATE sessions SET telemetry_count=(SELECT COUNT(*) FROM telemetry WHERE session_id=?) WHERE id=?", (session_id, session_id))
    return {"inserted": len(rows)}


@app.get("/api/sessions/{session_id}/telemetry")
def get_telemetry(session_id: str, limit: int = Query(5000, ge=1, le=50000)) -> list[dict[str, Any]]:
    with db() as conn:
        if not conn.execute("SELECT id FROM sessions WHERE id=?", (session_id,)).fetchone():
            raise HTTPException(404, "Session not found")
        rows = conn.execute("SELECT * FROM telemetry WHERE session_id=? ORDER BY recorded_at ASC LIMIT ?", (session_id, limit)).fetchall()
        return [dict(row) for row in rows]


@app.get("/api/incidents")
def list_incidents(limit: int = Query(500, ge=1, le=5000), offset: int = Query(0, ge=0), event_type: Optional[str] = None, severity: Optional[str] = None, acknowledged: Optional[bool] = None, q: Optional[str] = None) -> list[dict[str, Any]]:
    clauses, params = [], []
    if event_type and event_type != "all":
        clauses.append("event_type=?")
        params.append(event_type)
    if severity and severity != "all":
        clauses.append("severity=?")
        params.append(severity)
    if acknowledged is not None:
        clauses.append("acknowledged=?")
        params.append(1 if acknowledged else 0)
    if q:
        clauses.append("(title LIKE ? OR detail LIKE ? OR event_type LIKE ?)")
        params.extend([f"%{q}%"] * 3)
    sql = "SELECT * FROM incidents" + (" WHERE " + " AND ".join(clauses) if clauses else "") + " ORDER BY occurred_at DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])
    with db() as conn:
        return [clean_incident(r) for r in conn.execute(sql, params).fetchall()]


@app.post("/api/incidents")
def create_incident(payload: IncidentPayload) -> dict[str, Any]:
    incident_id = payload.id or make_id("evt")
    with db() as conn:
        if conn.execute("SELECT id FROM incidents WHERE id=?", (incident_id,)).fetchone():
            return clean_incident(conn.execute("SELECT * FROM incidents WHERE id=?", (incident_id,)).fetchone())
        conn.execute(
            "INSERT INTO incidents(id,session_id,driver_id,vehicle_id,event_type,title,detail,severity,occurred_at,duration_ms,metrics_json,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (incident_id, payload.session_id, payload.driver_id, payload.vehicle_id, payload.event_type, payload.title, payload.detail, payload.severity, payload.occurred_at or now_iso(), payload.duration_ms, json.dumps(payload.metrics), payload.source),
        )
        if payload.session_id:
            conn.execute("UPDATE sessions SET incident_count=(SELECT COUNT(*) FROM incidents WHERE session_id=?) WHERE id=?", (payload.session_id, payload.session_id))
        activity_log(conn, "safety", payload.title, payload.detail, payload.severity, {"incident_id": incident_id, "session_id": payload.session_id})
        return clean_incident(conn.execute("SELECT * FROM incidents WHERE id=?", (incident_id,)).fetchone())


@app.patch("/api/incidents/{incident_id}/acknowledge")
def acknowledge_incident(incident_id: str) -> dict[str, Any]:
    with db() as conn:
        row = conn.execute("SELECT * FROM incidents WHERE id=?", (incident_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Incident not found")
        conn.execute("UPDATE incidents SET acknowledged=1,acknowledged_at=? WHERE id=?", (now_iso(), incident_id))
        activity_log(conn, "safety", "Incident acknowledged", row["title"], "info", {"incident_id": incident_id})
        return clean_incident(conn.execute("SELECT * FROM incidents WHERE id=?", (incident_id,)).fetchone())


@app.get("/api/policies")
def get_policies() -> dict[str, Any]:
    with db() as conn:
        row = conn.execute("SELECT policy_json,updated_at FROM policies WHERE id=1").fetchone()
        return {"policies": json_value(row["policy_json"], DEFAULT_POLICIES), "updated_at": row["updated_at"]}


@app.put("/api/policies")
def update_policies(payload: PolicyPayload) -> dict[str, Any]:
    merged = {**DEFAULT_POLICIES, **payload.policies}
    with db() as conn:
        stamp = now_iso()
        conn.execute("UPDATE policies SET policy_json=?,updated_at=? WHERE id=1", (json.dumps(merged), stamp))
        activity_log(conn, "configuration", "Safety policy updated", "Detection thresholds and alert behaviour were saved.", "info", merged)
    return {"policies": merged, "updated_at": stamp}


@app.get("/api/activity")
def list_activity(limit: int = Query(100, ge=1, le=1000)) -> list[dict[str, Any]]:
    with db() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM activity ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()]


@app.get("/api/analytics")
def analytics(days: int = Query(30, ge=1, le=365)) -> dict[str, Any]:
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    with db() as conn:
        session_rows = conn.execute("SELECT * FROM sessions WHERE started_at>=? ORDER BY started_at ASC", (since,)).fetchall()
        incident_rows = conn.execute("SELECT event_type,severity,occurred_at,acknowledged FROM incidents WHERE occurred_at>=?", (since,)).fetchall()
        telemetry_agg = conn.execute(
            "SELECT COUNT(*) samples,AVG(attention_score) attention,AVG(posture_score) posture,AVG(risk_score) risk,MAX(risk_score) peak_risk FROM telemetry WHERE recorded_at>=?", (since,)
        ).fetchone()
        daily = conn.execute(
            "SELECT substr(recorded_at,1,10) day,COUNT(*) samples,AVG(attention_score) attention,AVG(posture_score) posture,AVG(risk_score) risk FROM telemetry WHERE recorded_at>=? GROUP BY substr(recorded_at,1,10) ORDER BY day", (since,)
        ).fetchall()
        by_type = conn.execute("SELECT event_type,COUNT(*) count FROM incidents WHERE occurred_at>=? GROUP BY event_type ORDER BY count DESC", (since,)).fetchall()
        by_severity = conn.execute("SELECT severity,COUNT(*) count FROM incidents WHERE occurred_at>=? GROUP BY severity", (since,)).fetchall()
    durations = [float(r["duration_seconds"] or 0) for r in session_rows if r["status"] == "completed"]
    return {
        "days": days,
        "sessions": len(session_rows),
        "completed_sessions": sum(1 for r in session_rows if r["status"] == "completed"),
        "total_duration_seconds": sum(durations),
        "average_session_seconds": (sum(durations) / len(durations)) if durations else 0,
        "incidents": len(incident_rows),
        "unacknowledged_incidents": sum(1 for r in incident_rows if not r["acknowledged"]),
        "samples": int(telemetry_agg["samples"] or 0),
        "average_attention": round(telemetry_agg["attention"], 1) if telemetry_agg["attention"] is not None else None,
        "average_posture": round(telemetry_agg["posture"], 1) if telemetry_agg["posture"] is not None else None,
        "average_risk": round(telemetry_agg["risk"], 1) if telemetry_agg["risk"] is not None else None,
        "peak_risk": round(telemetry_agg["peak_risk"], 1) if telemetry_agg["peak_risk"] is not None else None,
        "daily": [dict(r) for r in daily],
        "incidents_by_type": [dict(r) for r in by_type],
        "incidents_by_severity": [dict(r) for r in by_severity],
    }


@app.get("/api/export/json")
def export_json() -> dict[str, Any]:
    with db() as conn:
        payload = {
            "exported_at": now_iso(),
            "application": "SentinelDrive 3.0.10",
            "drivers": [clean_driver(r) for r in conn.execute("SELECT * FROM drivers").fetchall()],
            "vehicles": [clean_vehicle(r) for r in conn.execute("SELECT * FROM vehicles").fetchall()],
            "sessions": [clean_session(r) for r in conn.execute("SELECT * FROM sessions ORDER BY started_at DESC").fetchall()],
            "incidents": [clean_incident(r) for r in conn.execute("SELECT * FROM incidents ORDER BY occurred_at DESC").fetchall()],
            "telemetry": [dict(r) for r in conn.execute("SELECT * FROM telemetry ORDER BY recorded_at DESC LIMIT 100000").fetchall()],
            "activity": [dict(r) for r in conn.execute("SELECT * FROM activity ORDER BY created_at DESC").fetchall()],
            "policies": json_value(conn.execute("SELECT policy_json FROM policies WHERE id=1").fetchone()[0], DEFAULT_POLICIES),
        }
    return payload


@app.get("/api/storage")
def storage_info() -> dict[str, Any]:
    size = DB_PATH.stat().st_size if DB_PATH.exists() else 0
    with db() as conn:
        counts = {
            "drivers": conn.execute("SELECT COUNT(*) c FROM drivers").fetchone()["c"],
            "vehicles": conn.execute("SELECT COUNT(*) c FROM vehicles").fetchone()["c"],
            "sessions": conn.execute("SELECT COUNT(*) c FROM sessions").fetchone()["c"],
            "telemetry": conn.execute("SELECT COUNT(*) c FROM telemetry").fetchone()["c"],
            "incidents": conn.execute("SELECT COUNT(*) c FROM incidents").fetchone()["c"],
            "activity": conn.execute("SELECT COUNT(*) c FROM activity").fetchone()["c"],
        }
    return {"database_size_bytes": size, "database_path": str(DB_PATH), "counts": counts}


@app.post("/api/import/json")
def import_backup(payload: dict[str, Any]) -> dict[str, Any]:
    imported = {"drivers": 0, "vehicles": 0, "sessions": 0, "telemetry": 0, "incidents": 0}
    with db() as conn:
        for item in payload.get("drivers", []):
            driver_id = str(item.get("id") or make_id("drv"))
            baseline = item.get("baseline") or item.get("baseline_json")
            conn.execute(
                "INSERT OR IGNORE INTO drivers(id,name,employee_code,license_ref,phone,email,status,notes,baseline_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (driver_id, item.get("name") or "Imported driver", item.get("employee_code") or "", item.get("license_ref") or "", item.get("phone") or "", item.get("email") or "", item.get("status") or "active", item.get("notes") or "", json.dumps(baseline) if isinstance(baseline, dict) else baseline, item.get("created_at") or now_iso(), item.get("updated_at") or now_iso()),
            )
            imported["drivers"] += conn.execute("SELECT changes()").fetchone()[0]
        for item in payload.get("vehicles", []):
            vehicle_id = str(item.get("id") or make_id("veh"))
            try:
                conn.execute(
                    "INSERT OR IGNORE INTO vehicles(id,label,registration,make_model,vehicle_type,status,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                    (vehicle_id, item.get("label") or "Imported vehicle", item.get("registration") or f"IMPORT-{vehicle_id[-6:]}", item.get("make_model") or "", item.get("vehicle_type") or "Car", item.get("status") or "active", item.get("notes") or "", item.get("created_at") or now_iso(), item.get("updated_at") or now_iso()),
                )
                imported["vehicles"] += conn.execute("SELECT changes()").fetchone()[0]
            except sqlite3.IntegrityError:
                pass
        for item in payload.get("sessions", []):
            session_id = str(item.get("id") or make_id("ses"))
            conn.execute(
                "INSERT OR IGNORE INTO sessions(id,driver_id,vehicle_id,status,started_at,ended_at,duration_seconds,average_attention,average_posture,average_risk,peak_risk,telemetry_count,incident_count,notes,meta_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (session_id, item.get("driver_id"), item.get("vehicle_id"), item.get("status") or "completed", item.get("started_at") or now_iso(), item.get("ended_at"), item.get("duration_seconds") or 0, item.get("average_attention"), item.get("average_posture"), item.get("average_risk"), item.get("peak_risk"), item.get("telemetry_count") or 0, item.get("incident_count") or 0, item.get("notes") or "", json.dumps(item.get("meta") or {})),
            )
            imported["sessions"] += conn.execute("SELECT changes()").fetchone()[0]
        for item in payload.get("telemetry", []):
            session_id = item.get("session_id")
            if not session_id or not conn.execute("SELECT id FROM sessions WHERE id=?", (session_id,)).fetchone():
                continue
            columns = ["id","session_id","recorded_at","elapsed_ms","ear","mar","left_ear","right_ear","posture_score","attention_score","risk_score","pitch_delta","yaw_delta","roll_delta","gaze_delta","tracking_confidence","fps","inference_ms","face_count","state"]
            values = [item.get("id") or make_id("tel"), session_id, item.get("recorded_at") or now_iso(), item.get("elapsed_ms") or 0, item.get("ear"), item.get("mar"), item.get("left_ear"), item.get("right_ear"), item.get("posture_score"), item.get("attention_score"), item.get("risk_score"), item.get("pitch_delta"), item.get("yaw_delta"), item.get("roll_delta"), item.get("gaze_delta"), item.get("tracking_confidence"), item.get("fps"), item.get("inference_ms"), item.get("face_count") or 1, item.get("state") or "imported"]
            conn.execute(f"INSERT OR IGNORE INTO telemetry({','.join(columns)}) VALUES({','.join('?' for _ in columns)})", values)
            imported["telemetry"] += conn.execute("SELECT changes()").fetchone()[0]
        for item in payload.get("incidents", []):
            incident_id = str(item.get("id") or make_id("evt"))
            metrics = item.get("metrics") or item.get("metrics_json") or {}
            conn.execute(
                "INSERT OR IGNORE INTO incidents(id,session_id,driver_id,vehicle_id,event_type,title,detail,severity,occurred_at,duration_ms,acknowledged,acknowledged_at,metrics_json,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (incident_id, item.get("session_id"), item.get("driver_id"), item.get("vehicle_id"), item.get("event_type") or item.get("type") or "imported", item.get("title") or "Imported event", item.get("detail") or "", item.get("severity") or "medium", item.get("occurred_at") or item.get("timestamp") or now_iso(), item.get("duration_ms") or 0, 1 if item.get("acknowledged") else 0, item.get("acknowledged_at"), json.dumps(metrics) if isinstance(metrics, dict) else metrics, item.get("source") or "backup-import"),
            )
            imported["incidents"] += conn.execute("SELECT changes()").fetchone()[0]
        policies = payload.get("policies")
        if isinstance(policies, dict):
            conn.execute("UPDATE policies SET policy_json=?,updated_at=? WHERE id=1", (json.dumps({**DEFAULT_POLICIES, **policies}), now_iso()))
        activity_log(conn, "system", "Backup restore completed", f"Merged {sum(imported.values())} records from a JSON backup.", "success", imported)
    return {"status": "merged", "imported": imported, "total": sum(imported.values())}


@app.get("/api/export/incidents.csv")
def export_incidents_csv() -> StreamingResponse:
    with db() as conn:
        rows = conn.execute("SELECT id,session_id,driver_id,vehicle_id,event_type,title,detail,severity,occurred_at,duration_ms,acknowledged,metrics_json FROM incidents ORDER BY occurred_at DESC").fetchall()
    stream = io.StringIO()
    writer = csv.writer(stream)
    writer.writerow(["id", "session_id", "driver_id", "vehicle_id", "event_type", "title", "detail", "severity", "occurred_at", "duration_ms", "acknowledged", "metrics_json"])
    writer.writerows([tuple(row) for row in rows])
    return StreamingResponse(iter([stream.getvalue()]), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=sentineldrive-incidents.csv"})


@app.get("/api/export/telemetry.csv")
def export_telemetry_csv(session_id: Optional[str] = None) -> StreamingResponse:
    with db() as conn:
        if session_id:
            rows = conn.execute("SELECT * FROM telemetry WHERE session_id=? ORDER BY recorded_at", (session_id,)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM telemetry ORDER BY recorded_at DESC LIMIT 100000").fetchall()
    stream = io.StringIO()
    columns = ["id", "session_id", "recorded_at", "elapsed_ms", "ear", "mar", "left_ear", "right_ear", "posture_score", "attention_score", "risk_score", "pitch_delta", "yaw_delta", "roll_delta", "gaze_delta", "tracking_confidence", "fps", "inference_ms", "face_count", "state"]
    writer = csv.writer(stream)
    writer.writerow(columns)
    writer.writerows([[row[column] for column in columns] for row in rows])
    suffix = f"-{session_id}" if session_id else ""
    return StreamingResponse(iter([stream.getvalue()]), media_type="text/csv", headers={"Content-Disposition": f"attachment; filename=sentineldrive-telemetry{suffix}.csv"})


app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
