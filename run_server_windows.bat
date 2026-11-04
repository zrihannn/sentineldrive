@echo off
setlocal
cd /d "%~dp0"
title SentinelDrive OS API

if not exist ".venv\Scripts\python.exe" (
    echo The project environment is missing.
    echo Run run_windows.bat first to set up SentinelDrive OS.
    echo.
    pause
    exit /b 1
)

echo Starting SentinelDrive OS API at http://127.0.0.1:8000
".venv\Scripts\python.exe" -u -m uvicorn backend.main:app --host 127.0.0.1 --port 8000

echo.
echo SentinelDrive OS API stopped or failed to start.
echo Read the error above. Common cause: port 8000 is already in use.
echo.
pause
endlocal
