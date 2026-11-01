@echo off
chcp 65001 >nul
title Discord Translator
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js not found.
  echo   Please install Node.js 18 or newer: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

node launcher\start.js %*

echo.
echo   Translator stopped.
pause
