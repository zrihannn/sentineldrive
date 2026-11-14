from fastapi.testclient import TestClient
import pytest

from backend import main


@pytest.fixture()
def client(tmp_path, monkeypatch):
    database_path = tmp_path / "sentineldrive-test.db"
    monkeypatch.setattr(main, "DB_PATH", database_path)
    with TestClient(main.app) as test_client:
        yield test_client


def test_workspace_boots_with_default_driver(client):
    response = client.get("/api/bootstrap")
    assert response.status_code == 200
    data = response.json()
    assert len(data["drivers"]) >= 1
    assert "policies" in data
    health = client.get("/api/health").json()
    assert health["status"] == "operational"


def test_driver_vehicle_session_telemetry_and_incident_lifecycle(client):
    driver = client.post("/api/drivers", json={
        "id": "driver-integration-01",
        "name": "Integration Driver",
        "employee_code": "INT-01",
        "status": "active",
        "baseline": {"ear": 0.31, "samples": 90, "quality": "high"},
    })
    assert driver.status_code == 200
    assert driver.json()["baseline"]["samples"] == 90

    vehicle = client.post("/api/vehicles", json={
        "id": "vehicle-integration-01",
        "label": "Integration Unit",
        "registration": "TEST-1001",
        "vehicle_type": "Car",
        "status": "active",
    })
    assert vehicle.status_code == 200

    session = client.post("/api/sessions", json={
        "id": "session-integration-01",
        "driver_id": "driver-integration-01",
        "vehicle_id": "vehicle-integration-01",
        "meta": {"engine": "MediaPipe Face Landmarker"},
    })
    assert session.status_code == 200

    telemetry = client.post("/api/sessions/session-integration-01/telemetry", json={
        "samples": [
            {"id": f"telemetry-{index}", "ear": 0.31, "mar": 0.12,
             "attention_score": 94-index, "posture_score": 96-index,
             "risk_score": 8+index, "tracking_confidence": 92,
             "face_count": 1, "state": "attentive"}
            for index in range(5)
        ]
    })
    assert telemetry.status_code == 200
    assert telemetry.json()["inserted"] == 5
    assert len(client.get("/api/sessions/session-integration-01/telemetry").json()) == 5

    incident = client.post("/api/incidents", json={
        "id": "incident-integration-01",
        "session_id": "session-integration-01",
        "driver_id": "driver-integration-01",
        "vehicle_id": "vehicle-integration-01",
        "event_type": "drowsiness",
        "title": "Sustained eye closure",
        "severity": "critical",
        "metrics": {"ear": 0.12},
    })
    assert incident.status_code == 200
    acknowledged = client.patch("/api/incidents/incident-integration-01/acknowledge")
    assert acknowledged.status_code == 200
    assert acknowledged.json()["acknowledged"] is True

    finished = client.post("/api/sessions/session-integration-01/end", json={
        "duration_seconds": 5,
        "average_attention": 92,
        "average_posture": 94,
        "average_risk": 10,
        "peak_risk": 12,
        "telemetry_count": 5,
        "incident_count": 1,
    })
    assert finished.status_code == 200
    assert finished.json()["status"] == "completed"

    # Preserve the existing endpoint for clients already using it.
    legacy_finished = client.post("/api/sessions/session-integration-01/finish", json={"duration_seconds": 5})
    assert legacy_finished.status_code == 200
    assert legacy_finished.json()["status"] == "completed"

    analytics = client.get("/api/analytics?days=30").json()
    assert analytics["samples"] == 5
    assert analytics["incidents"] == 1
    assert analytics["sessions"] == 1


def test_backup_restore_is_idempotent(client):
    client.post("/api/drivers", json={"id": "driver-backup-01", "name": "Backup Driver"})
    backup = client.get("/api/export/json")
    assert backup.status_code == 200
    first_restore = client.post("/api/import/json", json=backup.json())
    second_restore = client.post("/api/import/json", json=backup.json())
    assert first_restore.status_code == 200
    assert second_restore.status_code == 200
    assert second_restore.json()["total"] == 0
    drivers = client.get("/api/drivers").json()
    assert sum(driver["id"] == "driver-backup-01" for driver in drivers) == 1
