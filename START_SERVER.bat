@echo off
title IPCMO - Pipe Cutting Management System
color 0A
cd /d "%~dp0"
echo.
echo  ============================================================
echo   INTEGRATED PIPE CUTTING MANAGEMENT AND OPTIMIZER (IPCMO)
echo  ============================================================
echo.

:: Check Node version
for /f "tokens=1" %%v in ('node --version 2^>nul') do set NODEVERSION=%%v
echo  Node.js: %NODEVERSION%

:: Install packages if needed
if not exist "node_modules\express" (
    echo  [SETUP] Installing packages - please wait...
    call npm install
    if errorlevel 1 (
        echo  [ERROR] Install failed. Right-click this file ^> Run as Administrator
        pause & exit /b 1
    )
    echo  [OK] Packages installed.
)

:: Init database if needed
if not exist "data\ipcmo.db" (
    echo  [SETUP] Creating database...
    node src/db/setup.js
    if errorlevel 1 (
        echo  [ERROR] Database setup failed.
        pause & exit /b 1
    )
)

:: ── AUTOMATED DAILY BACKUP ────────────────────────────────────────────────────
:: Backs up ipcmo.db to data\backups\ keeping last 30 days.
:: Backup is taken at startup — one backup per calendar day (skips if already done today).
if exist "data\ipcmo.db" (
    set BACKUPDIR=data\backups
    if not exist "%BACKUPDIR%" mkdir "%BACKUPDIR%"

    :: Build today's date string YYYYMMDD (locale-safe via PowerShell)
    for /f "tokens=*" %%d in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set TODAY=%%d
    set BACKUPFILE=%BACKUPDIR%\ipcmo_%TODAY%.db

    if not exist "%BACKUPFILE%" (
        copy /Y "data\ipcmo.db" "%BACKUPFILE%" >nul
        echo  [BACKUP] Database backed up ^→ %BACKUPFILE%
    ) else (
        echo  [BACKUP] Today's backup already exists — skipped.
    )

    :: Prune backups older than 30 days
    forfiles /p "%BACKUPDIR%" /m "*.db" /d -30 /c "cmd /c del @path" >nul 2>&1
    echo  [BACKUP] Backups older than 30 days removed.
)
:: ─────────────────────────────────────────────────────────────────────────────

echo.
echo  [STARTING] IPCMO server...
echo  Open browser: http://localhost:3000
echo  Team access:  http://[see Network URL below]:3000
echo  Login:        admin / Admin@1234
echo  Stop server:  Press Ctrl+C
echo  ============================================================
echo.
node src/server.js
pause
