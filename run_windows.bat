@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title SentinelDrive OS Setup

cls
echo ============================================================
echo                 SENTINELDRIVE OS 3.0.5
echo                   Windows launcher
echo ============================================================
echo.

set "PYTHON_LAUNCHER="
where py >nul 2>&1
if not errorlevel 1 (
    py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
    if not errorlevel 1 set "PYTHON_LAUNCHER=py -3"
)

if not defined PYTHON_LAUNCHER (
    where python >nul 2>&1
    if not errorlevel 1 (
        python -c "import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
        if not errorlevel 1 set "PYTHON_LAUNCHER=python"
    )
)

if not defined PYTHON_LAUNCHER goto no_python

 echo Using Python:
%PYTHON_LAUNCHER% --version
 echo.

if not exist ".venv\Scripts\python.exe" (
    echo [1/4] Creating the project environment...
    %PYTHON_LAUNCHER% -m venv .venv
    if errorlevel 1 goto venv_failed
) else (
    echo [1/4] Existing project environment found.
)

set "VENV_PY=%CD%\.venv\Scripts\python.exe"

"%VENV_PY%" -c "import fastapi, uvicorn, pydantic" >nul 2>&1
if errorlevel 1 (
    echo [2/4] Installing backend dependencies. This needs internet access...
    if not exist logs mkdir logs
    "%VENV_PY%" -m pip install --disable-pip-version-check --retries 2 --timeout 30 -r requirements.txt > "logs\install.log" 2>&1
    if errorlevel 1 goto install_failed
) else (
    echo [2/4] Backend dependencies are already installed.
)

 echo [3/4] Starting the local API service...
start "SentinelDrive OS API" /D "%~dp0" cmd.exe /k run_server_windows.bat

 echo [4/4] Waiting for the API to become ready...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ready=$false; for($i=0; $i -lt 30; $i++){ try { $r=Invoke-RestMethod -Uri 'http://127.0.0.1:8000/api/health' -TimeoutSec 2; if($r.status -eq 'operational'){ $ready=$true; break } } catch {}; Start-Sleep -Seconds 1 }; if($ready){ exit 0 } else { exit 1 }"
if errorlevel 1 goto api_failed

start "" "http://127.0.0.1:8000"
echo.
echo SentinelDrive OS is running.
echo Keep the separate "SentinelDrive OS API" window open.
echo App: http://127.0.0.1:8000
echo API docs: http://127.0.0.1:8000/docs
echo.
pause
goto end

:no_python
echo ERROR: Python 3.10 or newer was not found.
echo.
echo Install Python from https://www.python.org/downloads/windows/
echo During installation, enable "Add python.exe to PATH".
echo Then close this window and double-click run_windows.bat again.
echo.
pause
goto end

:venv_failed
echo.
echo ERROR: Python could not create the .venv environment.
echo Check that Python is installed correctly and that this folder is writable.
echo.
pause
goto end

:install_failed
echo.
echo ERROR: Dependency installation failed.
echo Check your internet connection and see logs\install.log for details.
echo.
if exist "logs\install.log" type "logs\install.log"
echo.
pause
goto end

:api_failed
echo.
echo ERROR: The API did not become ready on port 8000.
echo Check the separate "SentinelDrive OS API" window for the Python error.
echo If port 8000 is already in use, close the other application using it and retry.
echo.
pause
goto end

:end
endlocal
