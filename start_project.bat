@echo off
setlocal
title VFS Booking Bot - Industrial Setup

echo ============================================================
echo   VFS GLOBAL BOOKING BOT - QUICK START ENGINE
echo ============================================================
echo.

:: Check for .env file
if not exist .env (
    echo [! ] Root .env file not found.
    echo [* ] Creating .env from .env.example...
    copy .env.example .env
    echo [SUCCESS] .env created.
    echo [! ] IMPORTANT: Open .env and add your TELEGRAM_BOT_TOKEN and other keys.
    timeout /t 5
)

:: Check for backend/.env file
if not exist backend\.env (
    echo [! ] Backend .env file not found.
    echo [* ] Creating backend/.env...
    copy .env.example backend\.env
)

:: Check for Docker
docker --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Docker is not installed or not running.
    echo [!] Please install Docker Desktop to run this project.
    pause
    exit /b
)

echo [OK] Docker detected.
echo [* ] Starting project in development mode...
echo [* ] This will build containers and start PostgreSQL, Redis, Backend, and Frontend.
echo.

docker-compose -f docker-compose.dev.yml up --build

echo.
echo [DONE] Project is shutting down.
pause
