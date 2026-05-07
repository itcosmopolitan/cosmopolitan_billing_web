@echo off
title Cosmopolitan Pro Restarter
color 0E

echo.
echo  ==========================================
echo       Cosmopolitan Pro -- Restarter
echo   Multi-Branch Retail Management Platform
echo  ==========================================
echo.

:: Stop any running instance silently
call "%~dp0stop.bat" --quiet

:: Give Windows a moment to release the ports (TIME_WAIT can linger)
echo Waiting for ports to free up...
timeout /t 3 /nobreak >nul

echo.
echo Relaunching...
echo.

:: Hand off to run.bat (does prereq checks, deps, seed if needed, starts services)
call "%~dp0run.bat"
