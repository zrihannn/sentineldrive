from __future__ import annotations

import os
import secrets

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.routing import Mount

from backend.main import app


# The Render service exposes the API only. The frontend is hosted on Vercel.
app.router.routes = [
    route
    for route in app.router.routes
    if not (isinstance(route, Mount) and getattr(route, "name", None) == "frontend")
]


@app.get("/healthz", include_in_schema=False)
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.middleware("http")
async def require_vercel_proxy_key(request: Request, call_next):
    if request.url.path.startswith("/api/"):
        expected = os.getenv("SENTINELDRIVE_API_KEY", "")
        supplied = request.headers.get("x-sentineldrive-key", "")

        if not expected:
            return JSONResponse(
                status_code=503,
                content={"detail": "SENTINELDRIVE_API_KEY is not configured."},
            )

        if not secrets.compare_digest(supplied, expected):
            return JSONResponse(
                status_code=401,
                content={"detail": "Unauthorized API request."},
            )

    return await call_next(request)
