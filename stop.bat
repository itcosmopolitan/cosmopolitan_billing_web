@echo off
title Cosmopolitan Pro Stopper
color 0C

echo.
echo  ==========================================
echo       Cosmopolitan Pro -- Stopper
echo   Multi-Branch Retail Management Platform
echo  ==========================================
echo.

set "STOPPED=0"

:: Close run.bat-spawned windows (Backend / Frontend) along with their child trees.
:: taskkill /FI returns 0 even when nothing matches, so we grep its output for SUCCESS
:: to know whether anything was actually killed.
echo Closing launcher windows...
taskkill /F /T /FI "WINDOWTITLE eq Cosmopolitan Backend*"  2>nul | findstr /I /C:"SUCCESS" >nul && (
    echo [OK] Cosmopolitan Backend window closed
    set "STOPPED=1"
)
taskkill /F /T /FI "WINDOWTITLE eq Cosmopolitan Frontend*" 2>nul | findstr /I /C:"SUCCESS" >nul && (
    echo [OK] Cosmopolitan Frontend window closed
    set "STOPPED=1"
)

:: Sweep listeners on backend port 8080 (in case they were started another way)
echo Checking port 8080 (backend)...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8080 " ^| findstr LISTENING') do (
    taskkill /F /T /PID %%P >nul 2>&1
    if not errorlevel 1 (
        echo [OK] Killed PID %%P on :8080
        set "STOPPED=1"
    )
)

:: Sweep listeners on frontend port 3000
echo Checking port 3000 (frontend)...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3000 " ^| findstr LISTENING') do (
    taskkill /F /T /PID %%P >nul 2>&1
    if not errorlevel 1 (
        echo [OK] Killed PID %%P on :3000
        set "STOPPED=1"
    )
)

echo.
if "%STOPPED%"=="0" (
    echo  ==========================================
    echo       Nothing was running.
    echo  ==========================================
) else (
    echo  ==========================================
    echo       Cosmopolitan Pro stopped.
    echo  ==========================================
)
echo.

:: Close this window automatically when invoked from restart.bat
if /I "%~1"=="--quiet" exit /b 0
pause
