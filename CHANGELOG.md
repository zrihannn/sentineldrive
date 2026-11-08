# Changelog

## Driver monitoring and workspace controls

- Added an in-overlay Exit Expanded View control for the camera viewport.
- Escape exits expanded camera mode.
- The fullscreen control behaves as a reversible toggle and exposes its state accessibly.

## Windows setup and dependency handling

- Replaced optional Uvicorn standard extras with the base Uvicorn package.
- Removed an unused optional dependency path that could trigger unnecessary native-build requirements on Windows.
- Kept the local API installation focused on the runtime components used by the application.

## Frontend startup reliability

- Made secondary workspace requests non-blocking so the main workspace can open after core bootstrap data loads.
- Added API request timeouts and deferred offline queue synchronization until after the interface appears.
- Added startup stages, module-error diagnostics, and a retry action on the splash screen.
- Updated frontend and service-worker asset caching when application resources change.
