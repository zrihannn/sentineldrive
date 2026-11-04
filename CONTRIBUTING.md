# Contributing to SentinelDrive OS

Thanks for helping improve SentinelDrive. Keep contributions focused, testable and privacy-aware.

## Development setup

1. Install Python 3.10 or newer.
2. Create and activate a virtual environment.
3. Install development dependencies:

   ```bash
   pip install -r requirements-dev.txt
   ```

4. Run the backend:

   ```bash
   python -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
   ```

5. Run tests before submitting changes:

   ```bash
   python -m pytest -q
   ```

## Pull request guidelines

- Explain the user-facing problem and the implementation approach.
- Keep frontend modules and backend responsibilities separated.
- Add or update tests for backend behavior and data migrations.
- Do not commit `.venv`, local databases, logs, API keys, secrets, camera recordings or identifiable driver data.
- Do not add claims of medical or safety certification or unverified accuracy.
- Include screenshots for meaningful UI changes, using synthetic or anonymised data only.

## Reporting issues

Include your OS, Python version, browser, exact steps to reproduce and relevant redacted terminal output. Never include private camera footage, driver identities, tokens or database backups in a public issue.
