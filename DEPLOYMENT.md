# SentinelDrive OS deployment

This repository is configured for a split deployment:

- **Vercel** serves the static frontend from the `frontend/` directory.
- **Render** runs the FastAPI backend using `render_entry.py`.
- A Vercel Function at `frontend/api/[...path].mjs` forwards same-origin `/api/*` requests to Render and adds a server-side API key.
- SQLite is stored on a Render Persistent Disk at `/var/data/sentineldrive.db`.

The existing browser API calls remain relative to `/api`; no backend URL is hardcoded into browser JavaScript.

## 1. Create the shared API key

Generate one long random value locally. For example, in PowerShell:

```powershell
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Keep it private. Enter the exact same value in Render and Vercel. Do not commit it to GitHub or put it in frontend JavaScript.

## 2. Deploy the backend to Render

1. Open the Render Dashboard and create a **Blueprint**.
2. Connect the `sentineldrive-os` GitHub repository.
3. Select the root `render.yaml` Blueprint file.
4. Keep the `starter` instance plan. The SQLite database needs the configured Persistent Disk; Render Persistent Disks require a paid web service.
5. When prompted for `SENTINELDRIVE_API_KEY`, paste the random value from step 1.
6. Create the Blueprint and wait for the service to become live.

The Render service uses:

- Build: `pip install -r requirements.txt`
- Start: `uvicorn render_entry:app --host 0.0.0.0 --port $PORT`
- Health check: `/healthz`
- Database: `/var/data/sentineldrive.db`

Copy the service's HTTPS URL, such as `https://sentineldrive-api.onrender.com`.

## 3. Deploy the frontend to Vercel

1. Import the same GitHub repository into Vercel.
2. Set **Root Directory** to `frontend`.
3. Choose **Other** as the framework preset. There is no frontend build command; the output directory is `.`.
4. Add these **Production** environment variables:

| Variable | Value |
|---|---|
| `SENTINELDRIVE_BACKEND_URL` | Render HTTPS service URL, without a trailing slash |
| `SENTINELDRIVE_API_KEY` | The exact same random value configured in Render |

5. Deploy or redeploy after saving the variables.

Do not add the API key as a `VITE_*` variable or place it in any browser-facing file.

## 4. Verify the deployment

Open the Vercel production URL and check:

- The command center finishes loading.
- Driver and vehicle records load.
- The Live Monitor can request camera access over HTTPS.
- A session can be started and stopped.
- A test incident and telemetry samples appear in the archive and analytics.
- The System Journal reports the API as connected.
- CSV export and JSON backup work.

You can also open `https://YOUR-VERCEL-DOMAIN/api/health`. It should return the backend health JSON through the proxy. Opening the Render service's `/api/health` directly without the proxy key should return `401`.

## Storage and operational notes

- The Render disk is mounted at `/var/data`, and the database path is set through `SENTINELDRIVE_DB`.
- Render's ordinary filesystem is ephemeral. The Persistent Disk is what preserves SQLite data across restarts and deploys.
- A Render Persistent Disk is attached to one service instance and prevents scaling that service to multiple instances. Deployments can involve a short interruption.
- Use the app's JSON backup feature and store exported backups somewhere separate from the Render service.

## Important security limitation

The proxy keeps the shared backend key out of browser code and blocks direct unauthenticated requests to the Render API. **It does not add user login to SentinelDrive.** The public Vercel `/api/*` proxy is still reachable by anyone who can access the website, so visitors can send API requests through it and read or change the app's records.

Until proper user authentication and authorization are implemented, keep the deployment private or use synthetic demonstration data only. Do not enter real driver names, licence references, phone numbers, or other personal records into a public deployment.
