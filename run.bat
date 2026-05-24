@echo off
title Cosmopolitan Pro Launcher
color 0B

echo.
echo  ==========================================
echo       Cosmopolitan Pro -- Launcher
echo   Multi-Branch Retail Management Platform
echo  ==========================================
echo.

:: Check Node
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org ^(v18+^)
    pause
    exit /b 1
)

:: Check Python
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python not found. Install from https://python.org ^(3.10+^)
    pause
    exit /b 1
)

echo [OK] Node.js found
echo [OK] Python found
echo.

:: Install frontend deps
echo Installing frontend dependencies...
cd /d "%~dp0frontend"
call npm install --silent
echo [OK] Frontend ready

:: Install backend deps
echo Installing backend dependencies...
cd /d "%~dp0backend"
pip install -r requirements.txt -q
echo [OK] Backend ready

:: Seed DB if not exists
:: DISABLED: Seed data insertion disabled. To seed the database manually, run:
::   cd backend && python src/seed.py
:: if not exist "%~dp0backend\retailos.db" (
::     echo Seeding demo database...
::     python src/seed.py
::     echo [OK] Database seeded
:: )

echo.
echo Starting services...
echo.

:: Start backend in new window
cd /d "%~dp0backend"
start "Cosmopolitan Backend" cmd /k "uvicorn src.main:app --host 0.0.0.0 --port 8080 --reload"

:: Poll the backend for up to 30s before declaring success.
:: Uses /api/v1/permissions/catalog because it's unauthenticated, cheap,
:: and exercises router import (would have caught ISS-011's missing-symbol
:: ImportError instead of letting the launcher falsely report success).
echo Waiting for backend to come up...
set HEALTH_RETRIES=30
set HEALTH_COUNT=0
:health_check
set /a HEALTH_COUNT+=1
curl -fsS -m 2 http://127.0.0.1:8080/api/v1/permissions/catalog >nul 2>&1
if %errorlevel% equ 0 goto :health_ok
if %HEALTH_COUNT% geq %HEALTH_RETRIES% goto :health_fail
timeout /t 1 /nobreak >nul
goto :health_check
:health_ok
echo [OK] Backend up after %HEALTH_COUNT%s
goto :health_done
:health_fail
echo.
echo  ==========================================
echo  [ERROR] Backend did not respond after %HEALTH_RETRIES%s.
echo  The "Cosmopolitan Backend" window almost certainly has
echo  a traceback. Bring it to the front and read the error.
echo  Common causes:
echo    * ImportError in a route module (see ISS-011)
echo    * Port 8080 still bound by a previous run
echo    * Missing env var (JWT_SECRET_KEY, DATABASE_URL)
echo  ==========================================
pause
exit /b 1
:health_done

:: Start frontend in new window
cd /d "%~dp0frontend"
start "Cosmopolitan Frontend" cmd /k "npm run dev"

timeout /t 4 /nobreak >nul

echo.
echo  ==========================================
echo       Cosmopolitan Pro is running!
echo  ==========================================
echo   App:      http://localhost:3000
echo   API Docs: http://localhost:8080/api/docs
echo.

:: Open browser
start http://localhost:3000

echo Close the terminal windows to stop the services.
pause
