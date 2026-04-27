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
