## 3.0.5
- Added an in-overlay Exit Expanded View control for the camera viewport.
- Escape exits expanded camera mode.
- Fullscreen control now behaves as a reversible toggle and exposes its state accessibly.

# Changelog

## 3.0.2 - Windows Python 3.15 setup fix

- Replaced `uvicorn[standard]` with base `uvicorn` in the backend requirements.
- The app does not use the optional Uvicorn standard extras; removing them avoids pulling in PyYAML for this local API.
- This avoids a Windows source-build failure for PyYAML on Python 3.15 when a compatible wheel is unavailable.
- No C++ Build Tools installation is required for this dependency path.
- Updated displayed application and API version to 3.0.2.

## 3.0.5
- Fixed splash-screen deadlocks by making secondary workspace requests non-blocking.
- Added request timeouts and no-store fetches for API reads.
- Added startup stages, module-error diagnostics, and a retry action on the splash screen.
- Versioned the service-worker cache and frontend module URL.

## 3.0.5 - Frontend startup reliability
- Main workspace now opens after the core bootstrap payload instead of waiting for optional history and analytics requests.
- Added API request timeouts and deferred offline queue sync until after the interface appears.
- Added startup stages, error diagnostics, retry action, and versioned frontend/service-worker assets.
