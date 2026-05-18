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
if not exist "%~dp0backend\retailos.db" (
    echo Seeding demo database...
    python src/seed.py
    echo [OK] Database seeded
)

echo.
echo Starting services...
echo.

:: Start backend in new window
cd /d "%~dp0backend"
start "Cosmopolitan Backend" cmd /k "uvicorn src.main:app --host 0.0.0.0 --port 8080 --reload"

timeout /t 3 /nobreak >nul

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
echo  ------------------------------------------
echo   Login:    suresh@srimurugan.com
echo   Password: admin123
echo  ==========================================
echo.

:: Open browser
start http://localhost:3000

echo Close the terminal windows to stop the services.
pause
